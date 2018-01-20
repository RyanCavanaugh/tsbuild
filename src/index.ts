import minimist = require('minimist');
import fs = require('fs');
import path = require('path');
import glob = require('glob');
import ts = require('typescript');
import yargs = require('yargs');
import viz = require('viz.js');
import { normalize } from 'path';

type CommandLine = yargs.Arguments & {
    _: string[];
    dry?: boolean;
    watch?: boolean;
    force?: boolean;
    viz?: string;
    project?: string | string[];
};

const args = yargs
    .usage('$0 [options] [proj1] [dir1] ...')
    .option('watch', {
        alias: 'w',
        default: false,
        describe: 'Watch mode'
    })
    .option('dry', {
        alias: 'd',
        default: false,
        description: "Dry mode: Show what would be built and exit"
    })
    .option('force', {
        alias: 'f',
        default: false,
        description: "Force rebuild of all projects"
    })
    .options('viz', {
        default: false,
        description: "Render a project dependency graph"
    })
    .strict()
    .parse() as CommandLine;

main(args);

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

function createDependencyMapper() {
    const childToParents: { [key: string]: string[] } = {};
    const parentToChildren: { [key: string]: string[] } = {};
    const allKeys: string[] = [];

    function addReference(childConfigFileName: string, parentConfigFileName: string): void {
        addEntry(childToParents, childConfigFileName, parentConfigFileName);
        addEntry(parentToChildren, parentConfigFileName, childConfigFileName);
    }

    function getReferencesTo(parentConfigFileName: string): string[] {
        return parentToChildren[normalize(parentConfigFileName)] || [];
    }

    function getReferencesOf(childConfigFileName: string): string[] {
        return childToParents[normalize(childConfigFileName)] || [];
    }

    function getKeys(): ReadonlyArray<string> {
        return allKeys;
    }

    function addEntry(mapToAddTo: typeof childToParents | typeof parentToChildren, key: string, element: string) {
        key = normalize(key);
        element = normalize(element);
        const arr = (mapToAddTo[key] = mapToAddTo[key] || []);
        if (arr.indexOf(element) < 0) {
            arr.push(element);
        }
        if (allKeys.indexOf(key) < 0) allKeys.push(key);
        if (allKeys.indexOf(element) < 0) allKeys.push(element);
    }

    return {
        addReference,
        getReferencesTo,
        getReferencesOf,
        getKeys
    };
}

function veryFriendlyName(configFileName: string) {
    return path.basename(path.dirname(configFileName));
}

function main(cmdLine: CommandLine) {
    const whatToDo = parseCommandline(cmdLine);

    const host = ts.createCompilerHost({});

    // This is a list of list of projects that need to be built.
    // The ordering here is "backwards", i.e. the first entry in the array is the last set of projects that need to be built;
    //   and the last entry is the first set of projects to be built.
    // Each subarray is unordered.
    // We traverse the reference graph from each root, then "clean" the list by removing
    //   any entry that is duplicated to its right.
    const buildQueue: string[][] = [];
    const dependencyMap = createDependencyMapper();
    let buildQueuePosition = 0;
    for (const root of whatToDo.roots) {
        const config = parseConfigFile(root);
        if (config === undefined) {
            // TODO: Error
            return;
        }
        enumerateReferences(path.resolve(root), config);
    }

    function enumerateReferences(fileName: string, root: ts.ParsedCommandLine): void {
        const myBuildLevel = buildQueue[buildQueuePosition] = buildQueue[buildQueuePosition] || [];
        if (myBuildLevel.indexOf(fileName) < 0) {
            myBuildLevel.push(fileName);
        }

        const refs = ts.getProjectReferences(host, root.options);
        if (refs === undefined) return;
        buildQueuePosition++;
        for (const ref of refs) {
            dependencyMap.addReference(fileName, ref);
            const resolvedRef = parseConfigFile(ref);
            if (resolvedRef === undefined) continue;
            enumerateReferences(path.resolve(ref), resolvedRef);
        }
        buildQueuePosition--;
    }

    if (whatToDo.viz) {
        const lines: string[] = [];
        lines.push(`digraph project {`);
        for (const key of whatToDo.roots) {
            lines.push(`    \"${veryFriendlyName(key)}\"`);
            for (const dep of dependencyMap.getReferencesOf(key)) {
                lines.push(`    \"${veryFriendlyName(key)}\" -> \"${veryFriendlyName(dep)}\"`);
            }
        }
        lines.push(`}`);
        const filename = `project-graph.svg`;
        fs.writeFile(filename, viz(lines.join('\r\n'), { y: -1 }), { encoding: 'utf-8' }, err => {
            console.log(`Wrote ${lines.length} lines to ${filename}`);
            if (err) throw err;
            process.exit(0);
        });
        return;
    }

    removeDuplicates(buildQueue);
    let dependentThreshold = 0;
    while (buildQueue.length > 0) {
        const nextSet = buildQueue.pop()!;
        let nextDependentThreshold = dependentThreshold;
        for (const proj of nextSet) {
            const utd = checkUpToDate(parseConfigFile(proj), proj, dependentThreshold);
            const projectName = friendlyNameOfFile(proj);
            if (utd.result === "up-to-date") {
                console.log(`Project ${projectName} is up-to-date with respect to its inputs`);
                nextDependentThreshold = Math.max(nextDependentThreshold, utd.timestamp);
                if (!whatToDo.force) continue;
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

            if (cmdLine.dry) continue;

            if (!buildProject(proj)) {
                console.log('Aborting build due to errors');
                return;
            }
        }
        dependentThreshold = nextDependentThreshold;
    }
}

function buildProject(proj: string): boolean {
    const configFile = parseConfigFile(proj);
    if (!configFile) throw new Error(`Failed to read config file ${proj}`);
    const program = ts.createProgram(configFile.fileNames, configFile.options);
    console.log(`Building ${veryFriendlyName(proj)} to ${program.getCompilerOptions().outDir}...`);
    program.emit(undefined, (fileName, content) => {
        const dir = path.dirname(fileName);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir);
        }
        fs.writeFileSync(fileName, content, 'utf-8');
        console.log(`    * Wrote ${content.length} bytes to ${path.basename(fileName)}`);
    });
    return true;
}

function friendlyNameOfFile(fileName: string) {
    return path.relative(process.cwd(), fileName);
}

function throwIfReached(x: never, message: string): never {
    throw new Error(message);
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
function removeDuplicates(queue: string[][]): void {
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

function checkUpToDate(configFile: ts.ParsedCommandLine | undefined, configFileName: string, dependentThreshold: number): UpToDateResult {
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
            const expectedOutputFile = getOutputDeclarationFileName(inputFile, configFile, configFileName);
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

function getOutputDeclarationFileName(inputFileName: string, configFile: ts.ParsedCommandLine, configFileName: string) {
    const relativePath = path.relative(configFile.options.rootDir || path.dirname(configFileName), inputFileName);
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
        dry: cmdLine.dry || false,
        watch: cmdLine.watch || false,
        force: cmdLine.force || false,
        viz: cmdLine.viz
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

