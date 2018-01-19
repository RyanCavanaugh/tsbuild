import minimist = require('minimist');
import fs = require('fs');
import path = require('path');
import glob = require('glob');
import ts = require('typescript');

type CommandLine = minimist.ParsedArgs & {
    dry?: boolean;
    project?: string | string[];
};

function wrapSingle<T>(itemOrArray: T | T[] | undefined): T[] {
    if (itemOrArray === undefined) {
        return [];
    } else if (Array.isArray(itemOrArray)) {
        return itemOrArray;
    } else {
        return [itemOrArray];
    }
}

function parseConfigFile(fileName: string): ts.ParsedCommandLine | undefined {
    const rawFileContent = ts.sys.readFile(fileName, 'utf-8');
    if (rawFileContent === undefined) {
        return undefined;
    }
    const parsedFileContent = ts.parseJsonText(fileName, rawFileContent);
    const configParseResult = ts.parseJsonSourceFileConfigFileContent(parsedFileContent, ts.sys, path.dirname(fileName), /*optionsToExtend*/ undefined, fileName);
    return configParseResult;
}

function main() {
    const cmdLine = minimist(process.argv.slice(2)) as CommandLine;
    const whatToDo = parseCommandline(cmdLine);

    const host = ts.createCompilerHost({});

    // This is a list of list of projects that need to be built.
    // The ordering here is "backwards", i.e. the first entry in the array is the last set of projects that need to be built;
    //   and the last entry is the first set of projects to be built.
    // Each subarray is unordered.
    // We traverse the reference graph from each root, then "clean" the list by removing
    //   any entry that is duplicated to its right.
    const buildQueue: string[][] = [];
    let buildQueuePosition = 0;
    for (const root of whatToDo.roots) {
        const config = parseConfigFile(root);
        if (config === undefined) {
            // TODO: Error
            return;
        }
        enumerateReferences(path.resolve(root), config);
    }
    function enumerateReferences(fileName: string, root: ts.ParsedCommandLine) {
        const myBuildLevel = buildQueue[buildQueuePosition] = buildQueue[buildQueuePosition] || [];
        if (myBuildLevel.indexOf(fileName) < 0) {
            myBuildLevel.push(fileName);
        }

        const refs = ts.getProjectReferences(host, root.options);
        if (refs === undefined) return;
        buildQueuePosition++;
        for (const ref of refs) {
            const resolvedRef = parseConfigFile(ref);
            if (resolvedRef === undefined) continue;
            enumerateReferences(path.resolve(ref), resolvedRef);
        }
        buildQueuePosition--;
    }
    cleanBuildQueue(buildQueue);
    printBuildQueue(buildQueue);
    let dependentThreshold = 0;
    while (buildQueue.length > 0) {
        const nextSet = buildQueue.pop()!;
        let nextDependentThreshold = dependentThreshold;
        for (const proj of nextSet) {
            const utd = checkUpToDate(parseConfigFile(nextSet[0]), dependentThreshold);
            const projectName = friendlyNameOfFile(proj);
            if (utd.result === "up-to-date") {
                console.log(`Project ${projectName} is up-to-date with respect to its inputs`);
                nextDependentThreshold = Math.max(nextDependentThreshold, utd.timestamp);
                continue;
            } else if (utd.result === "missing") {
                console.log(`Project ${projectName} has not built output file ${friendlyNameOfFile(utd.missingFile)}`);
                nextDependentThreshold = Date.now();
            } else if (utd.result === "out-of-date") {
                console.log(utd.olderFile);
                console.log(`Project ${projectName} has input file ${friendlyNameOfFile(utd.newerFile)} newer than output file ${friendlyNameOfFile(utd.olderFile)}`);
                nextDependentThreshold = Date.now();
            } else {
                return throwIfReached(utd, "Unknown up-to-date return value");
            }

            if (!cmdLine.dry) {
                if (!buildProject(proj)) {
                    console.log('Aborting build due to errors');
                    return;
                }
            }
        }
        dependentThreshold = nextDependentThreshold;
    }
}

function buildProject(proj: string): boolean {
    console.log(`> tsc -p ${proj}`);
    const configFile = parseConfigFile(proj);
    if (!configFile) throw new Error(`Failed to read config file ${proj}`);
    const program = ts.createProgram(configFile.fileNames, configFile.options);
    program.emit();
    return true;
}

function friendlyNameOfFile(fileName: string) {
    return path.relative(process.cwd(), fileName);
}

function throwIfReached(x: never, message: string): never {
    throw new Error(message)
}

function printBuildQueue(queue: string[][]) {
    console.log('== Build Order ==')
    for (let i = queue.length - 1; i >= 0; i--) {
        console.log(` * ${queue[i].map(friendlyNameOfFile).join(', ')}`);
    }
}

/**
 * Removes entries from arrays which appear in later arrays.
 * TODO: Make not O(n^2)
 */
function cleanBuildQueue(queue: string[][]): void {
    // No need to check the last array
    for (let i = 0; i < queue.length - 1; i++) {
        queue[i] = queue[i].filter(fn => !occursAfter(fn, i + 1));
    }

    function occursAfter(s: string, start: number) {
        for (let i = start; i < queue.length; i++) {
            if (queue[i].indexOf(s) >= 0) return true;
        }
        return false;
    }
}

type UpToDateResult =
    { result: "up-to-date", timestamp: number } |
    { result: "missing", missingFile: string } |
    { result: "out-of-date", newerFile: string, olderFile: string };

function checkUpToDate(configFile: ts.ParsedCommandLine | undefined, dependentThreshold: number): UpToDateResult {
    if (!configFile) throw new Error("No config file");

    let newestInputFileTime = dependentThreshold;
    let newestInputFileName = "a dependent project output";
    let oldestOutputFileTime = Infinity;
    let oldestOutputFileName = "";
    let newestOutputFileTime = -1;
    for (const inputFile of configFile.fileNames) {
        const inputFileTime = fs.statSync(inputFile).mtimeMs;
        if (inputFileTime > newestInputFileTime) {
            newestInputFileTime = inputFileTime;
            newestInputFileName = inputFile;
        }

        // .d.ts files do not have output files
        if (!/\.d\.ts$/.test(inputFile)) {
            const expectedOutputFile = getOutputDeclarationFileName(inputFile, configFile);
            // If the output file doesn't exist, the project is out of date
            if (!ts.sys.fileExists(expectedOutputFile)) {
                return {
                    result: "missing",
                    missingFile: expectedOutputFile
                };
            }

            const outputFileTime = fs.statSync(expectedOutputFile).mtimeMs;
            if (outputFileTime < oldestOutputFileTime) {
                oldestOutputFileTime = outputFileTime;
                oldestOutputFileName = expectedOutputFile;
            }
            newestOutputFileTime = Math.max(newestOutputFileTime, outputFileTime);
        }

        if (newestInputFileTime > oldestOutputFileTime) {
            return {
                result: "out-of-date",
                newerFile: newestInputFileName,
                olderFile: oldestOutputFileName
            };
        }
    }

    return {
        result: "up-to-date",
        timestamp: newestInputFileTime
    };
}

function getOutputDeclarationFileName(inputFileName: string, configFile: ts.ParsedCommandLine) {
    const relativePath = path.relative(configFile.options.rootDir!, inputFileName);
    const outputPath = path.resolve(configFile.options.outDir!, relativePath);
    return outputPath.replace(/\.tsx?$/, '.d.ts');
}

function parseCommandline(cmdLine: CommandLine) {
    const roots: string[] = [];

    let anythingHappened = false;
    for (const project of wrapSingle(cmdLine.project)) {
        addInferred(resolvePath(project));
        anythingHappened = true;
    }

    for (const unknown of cmdLine._) {
        addInferred(resolvePath(unknown));
        anythingHappened = true;
    }

    if (!anythingHappened) {
        addInferred('.');
    }

    return {
        roots,
        dry: cmdLine.dry || false
    };

    function addInferred(unknown: string) {
        const unknownResolved = resolvePath(unknown);
        if (!fs.existsSync(unknownResolved)) {
            return {
                error: `File ${unknown} doesn't exist`
            };
        }
        if (fs.lstatSync(unknownResolved).isDirectory()) {
            // Directory - recursively look for tsconfig.json files
            const configs = glob.sync(path.join(unknownResolved, '**', 'tsconfig.json'));
            for (const cfg of configs) {
                addRootProject(cfg);
            }
        } else if (fs.existsSync(unknownResolved)) {
            addRootProject(unknownResolved);
        }
    }

    function addRootProject(fileName: string) {
        roots.push(fileName);
    }
}

function resolvePath(fileName: string) {
    return path.resolve(process.cwd(), fileName);
}

main();
