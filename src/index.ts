import fs = require('fs');
import { normalize } from 'path';
import path = require('path');

import minimist = require('minimist');
import ts = require('typescript');
import chokidar = require('chokidar');

import { createDependencyMapper, Mapper } from './dependency-map';
import { wrapSingle, removeDuplicates, friendlyNameOfFile, throwIfReached, resolvePathRelativeToCwd, veryFriendlyName } from './utils';
import { yargsSetup, parseCommandline, TsBuildCommandLine } from './command-line';
import { renderGraphVisualization } from './visualizer';

const whatToDo = parseCommandline(yargsSetup.parse());
const host = ts.createCompilerHost({});
main(whatToDo);

function main(whatToDo: TsBuildCommandLine) {
    // This is a list of list of projects that need to be built.
    // The ordering here is "backwards", i.e. the first entry in the array is the last set of projects that need to be built;
    //   and the last entry is the first set of projects to be built.
    // Each subarray is unordered.
    // We traverse the reference graph from each root, then "clean" the list by removing
    //   any entry that is duplicated to its right.

    let dependentThreshold = 0;
    const projectsNeedingBuild: { [projFilename: string]: true } = {};

    const graph = createDependencyGraph(whatToDo.roots);
    const { buildQueue, dependencyMap } = graph;


    if (whatToDo.viz) {
        renderGraphVisualization(whatToDo.roots, graph, 'project-graph.svg');
        return;
    }

    while (buildQueue.length > 0) {
        const nextSet = buildQueue.pop()!;
        for (const proj of nextSet) {
            const dependsOnUnbuiltProject = dependencyMap.getReferencesOf(proj).some(p => projectsNeedingBuild[p]);
            const utd = checkUpToDate(parseConfigFile(proj), proj);
            const projectName = friendlyNameOfFile(proj);
            if (dependsOnUnbuiltProject) {
                console.log(`Project ${projectName} is out-to-date with respect to a project it depends on`);
            } else if (utd.result === "up-to-date") {
                console.log(`Project ${projectName} is up-to-date with respect to its inputs`);
                if (!whatToDo.force) continue;
            } else if (utd.result === "missing") {
                console.log(`Project ${projectName} has not built output file ${friendlyNameOfFile(utd.missingFile)}`);
            } else if (utd.result === "out-of-date") {
                console.log(`Project ${projectName} has input file ${friendlyNameOfFile(utd.newerFile)} newer than output file ${friendlyNameOfFile(utd.olderFile)}`);
            } else {
                return throwIfReached(utd, "Unknown up-to-date return value");
            }

            projectsNeedingBuild[proj] = true;
            if (whatToDo.dry) continue;

            if (!buildProject(proj)) {
                console.log('Aborting build due to errors');
                return;
            }
        }
    }
}

export interface DependencyGraph {
    buildQueue: string[][];
    dependencyMap: Mapper;
}

function createDependencyGraph(roots: string[]): DependencyGraph {
    const buildQueue: string[][] = [];
    const dependencyMap = createDependencyMapper();
    let buildQueuePosition = 0;
    for (const root of whatToDo.roots) {
        const config = parseConfigFile(root);
        if (config === undefined) {
            throw new Error(`Could not parse ${root}`);
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

    removeDuplicates(buildQueue);

    return ({
        buildQueue,
        dependencyMap
    });
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

function printBuildQueue(queue: string[][]) {
    console.log('== Build Order ==')
    for (let i = queue.length - 1; i >= 0; i--) {
        console.log(` * ${queue[i].map(friendlyNameOfFile).join(', ')}`);
    }
}

type UpToDateResult =
    { result: "up-to-date", timestamp: number } |
    { result: "missing", missingFile: string } |
    { result: "out-of-date", newerFile: string, olderFile: string };

function checkUpToDate(configFile: ts.ParsedCommandLine | undefined, configFileName: string): UpToDateResult {
    if (!configFile) throw new Error("No config file");

    let newestInputFileTime = -Infinity;
    let newestInputFileName = "????";
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
