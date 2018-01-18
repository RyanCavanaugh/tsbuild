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
    console.log(JSON.stringify(whatToDo));

    for (const proj of whatToDo.roots) {
        console.log(`Building ${proj}`);
    }
    const host = ts.createCompilerHost({});
    const root1 = whatToDo.roots[0];
    const config = parseConfigFile(root1);
    if (config === undefined) {
        console.log(`Could not find or read file ${root1}`);
        return process.exit(-1);
    }

    // This is a list of list of projects that need to be built.
    // The ordering here is "backwards", i.e. the first entry in the array is the last set of projects that need to be built;
    //   and the last entry is the first set of projects to be built.
    // Each subarray is unordered.
    // We traverse the reference graph from each root, then "clean" the list by removing
    //   any entry that is duplicated to its right.
    const buildQueue: string[][] = [];
    let buildQueuePosition = 0;
    enumerateReferences(path.resolve(root1), config);
    function enumerateReferences(fileName: string, root: ts.ParsedCommandLine) {
        const myBuildLevel = buildQueue[buildQueuePosition] = buildQueue[buildQueuePosition] || [];
        if (myBuildLevel.indexOf(fileName) < 0) {
            myBuildLevel.push(fileName);
        }

        const refs = ts.getProjectReferences(host, root.options);
        if (refs === undefined) return;
        buildQueuePosition++;
        for (const ref of refs) {
            console.log(`ref: ${ref}`);
            const resolvedRef = parseConfigFile(ref);
            if (resolvedRef === undefined) continue;
            enumerateReferences(path.resolve(ref), resolvedRef);
        }
        buildQueuePosition--;
    }
    cleanBuildQueue(buildQueue);
    printBuildQueue(buildQueue);
    while (buildQueue.length > 0) {
        const nextSet = buildQueue.pop()!;
        for (const proj of nextSet) {
            const utd = checkUpToDate(parseConfigFile(nextSet[0]));
            const projectName = friendlyNameOfFile(proj);
            if (utd === true) {
                console.log(`Project ${projectName} is up-to-date with respect to its inputs`);
                continue;
            } else if (utd.reason === "missing") {
                console.log(`Project ${projectName} has not built output file ${friendlyNameOfFile(utd.missingFile)}`);
            } else if (utd.reason === "out-of-date") {
                console.log(utd.oldestFile);
                console.log(`Project ${projectName} has input file ${friendlyNameOfFile(utd.newestFile)} newer than output file ${friendlyNameOfFile(utd.oldestFile)}`);
            } else {
                return throwIfReached(utd, "Unknown up-to-date return value");
            }

            buildProject(proj);
        }
    }
}

function buildProject(proj: string) {
    console.log(`> tsc -p ${proj}`);
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
        console.log(` * ${queue[i].map(f => path.relative(process.cwd(), f)).join(', ')}`);
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

type UpToDateResult = true |
    { reason: "missing", missingFile: string } |
    { reason: "out-of-date", newestFile: string, oldestFile: string };

function checkUpToDate(configFile: ts.ParsedCommandLine | undefined): UpToDateResult {
    if (!configFile) throw new Error("No config file");

    let newestInputFileTime = -1;
    let newestInputFileName = "";
    let oldestOutputFileTime = Infinity;
    let oldestOutputFileName = "";
    for (const inputFile of configFile.fileNames) {
        // .d.ts files do not have output files
        if (/\.d\.ts$/.test(inputFile)) continue;
        const expectedOutputFile = getOutputDeclarationFileName(inputFile, configFile);
        // If the output file doesn't exist, the project is out of date
        if (!ts.sys.fileExists(expectedOutputFile)) {
           return { reason: "missing", missingFile: expectedOutputFile };
        }

        // Update noticed timestamps
        const inputFileTime = fs.statSync(inputFile).mtimeMs;
        const outputFileTime = fs.statSync(expectedOutputFile).mtimeMs;
        if (inputFileTime > newestInputFileTime) {
            newestInputFileTime = inputFileTime;
            newestInputFileName = inputFile;
        }
        if (outputFileTime < oldestOutputFileTime) {
            oldestOutputFileTime = outputFileTime;
            oldestOutputFileName = expectedOutputFile;
        }

        if (newestInputFileTime > oldestOutputFileTime) {
            return {
                reason: "out-of-date",
                newestFile: newestInputFileName,
                oldestFile: oldestOutputFileName
            }
        }
    }
    return true;
}

function getOutputDeclarationFileName(inputFileName: string, configFile: ts.ParsedCommandLine) {
    const relativePath = path.relative(configFile.options.rootDir!, inputFileName);
    // console.log(`Relative path of ${inputFileName} to ${configFile.options.rootDir} is ${relativePath}`);
    const outputPath = path.resolve(configFile.options.outDir!, relativePath);
    // console.log(`Resolved ${relativePath} via outDir ${configFile.options.outDir} to ${outputPath}`);
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
