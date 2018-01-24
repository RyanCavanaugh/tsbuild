import fs = require('fs');
import { normalize } from 'path';
import path = require('path');

import mkdirp = require('mkdirp');
import minimist = require('minimist');
import ts = require('typescript');
import chokidar = require('chokidar');
import glob = require('glob');

import { createDependencyMapper, Mapper, __ } from './dependency-map';
import { wrapSingle, removeDuplicatesFromBuildQueue, friendlyNameOfFile, throwIfReached, resolvePathRelativeToCwd, veryFriendlyName, clone2DArray, flatten, getCanonicalFileName } from './utils';
import { yargsSetup, parseCommandline, TsBuildCommandLine } from './command-line';
import { renderGraphVisualization } from './visualizer';
import { callbackify } from 'util';

const host = ts.createCompilerHost({});
const watchers: chokidar.FSWatcher[] = [];

namespace main {
    const whatToDo = parseCommandline(yargsSetup.parse());
    main(whatToDo);

    function main(whatToDo: TsBuildCommandLine) {
        let graph = createDependencyGraph(whatToDo.roots);

        processBuildQueue(graph, handleBuildStatus);

        if (whatToDo.viz) {
            renderGraphVisualization(whatToDo.roots, graph, 'project-graph.svg');
            return;
        }

        if (whatToDo.watch) {
            console.log("Watching for file changes...");
            for (const proj of flatten(graph.buildQueue)) {
                watchFilesForProject(proj, {
                    rebuildProject,
                    rebuildGraph
                });
            }
        }

        function rebuildProject(projectName: string) {
            buildProject(projectName);
        }

        function rebuildGraph() {
            console.log('Rebuilding project graph due to an edit in a config file');
            graph = createDependencyGraph(whatToDo.roots);
            for (const w of watchers) {
                w.close();
            }
            watchers.length = 0;
            for (const proj of flatten(graph.buildQueue)) {
                watchFilesForProject(proj, {
                    rebuildProject,
                    rebuildGraph
                });
            }
            processBuildQueue(graph, handleBuildStatus);
        }

        function handleBuildStatus(configFileName: string, status: UpToDateStatus): boolean {
            const projectName = friendlyNameOfFile(configFileName);
            let shouldBuild: boolean = true;
            switch (status.result) {
                case "older-than-dependency":
                    console.log(`Project ${projectName} is out-to-date with respect to its dependency ${friendlyNameOfFile(status.dependency)}`);
                    break;
                case "missing":
                    console.log(`Project ${projectName} has not built output file ${friendlyNameOfFile(status.missingFile)}`);
                    break;
                case "out-of-date":
                    console.log(`Project ${projectName} has input file ${friendlyNameOfFile(status.newerFile)} newer than output file ${friendlyNameOfFile(status.olderFile)}`);
                    break;
                case "up-to-date":
                    console.log(`Project ${projectName} is up-to-date with respect to its inputs`);
                    shouldBuild = whatToDo.force;
                    break;
                default:
                    throwIfReached(status, "Unknown up-to-date return value");
            }
            if (shouldBuild && !whatToDo.dry) {
                return buildProject(configFileName);
            }
            return true;
        }
    }
}

interface WatchCallbacks {
    rebuildProject(configFileName: string, changedFile: string): void;
    rebuildGraph(): void;
}

function processBuildQueue(graph: DependencyGraph, buildCallback: (configFileName: string, status: UpToDateStatus) => boolean) {
    const buildQueue = clone2DArray<string>(graph.buildQueue);
    const dependencyMap = graph.dependencyMap;

    // A list of projects which needed to be built at some point.
    // This is stored rather than observing the filestamps because a "dry"
    //   build needs to correctly identify downstream projects that need
    //   to be built when their upstream projects changed.
    const projectsNeedingBuild: { [projFilename: string]: true } = {};

    while (buildQueue.length > 0) {
        const nextSet = buildQueue.pop()!;
        for (const proj of nextSet) {
            const refs = dependencyMap.getReferencesOf(proj);
            const unbuiltRefs = refs.filter(p => projectsNeedingBuild[p]);

            let keepGoing: boolean;
            if (unbuiltRefs.length > 0) {
                keepGoing = buildCallback(proj, { result: "older-than-dependency", dependency: unbuiltRefs[0] });
            } else {
                const utd = checkUpToDateRelativeToInputs(parseConfigFile(proj), proj);
                keepGoing = buildCallback(proj, utd);
                if (utd.result !== "up-to-date") {
                    projectsNeedingBuild[proj] = true;
                }
            }

            if (!keepGoing) {
                return;
            }
        }
    }
}

function performRebuild(changedProject: string) {
    const succeeded = buildProject(changedProject);
    if (succeeded) {
        // Build downstream projects
        // 
    }
}

function watchFilesForProject(configFile: string, callbacks: WatchCallbacks) {
    // Watch the config file itself
    const projWatch = chokidar.watch(configFile, undefined);
    watchers.push(projWatch);
    projWatch.on('change', () => {
        callbacks.rebuildGraph();
    });
    const cfg = parseConfigFile(configFile)!;

    const watchedDirs: string[] = [];
    if (cfg.wildcardDirectories) {
        for (const dir of Object.keys(cfg.wildcardDirectories)) {
            watchedDirs.push(getCanonicalFileName(dir));
            const opts: chokidar.WatchOptions = {
                depth: cfg.wildcardDirectories[dir] === ts.WatchDirectoryFlags.Recursive ? 100 : 0,
                ignoreInitial: true
            };
            const dirWatch = chokidar.watch(dir, opts);
            watchers.push(dirWatch);
            dirWatch.on('all', (event, path) => {
                callbacks.rebuildProject(configFile, path);
            });
        }
    }

    for (const file of cfg.fileNames.map(getCanonicalFileName)) {
        if (watchedDirs.some(d => file.indexOf(d) === 0)) {
            // console.log(`File ${file} is already watched by a directory watch`);
            continue;
        }
        const fileWatch = chokidar.watch(file, { ignoreInitial: true });
        fileWatch.on('all', (event, path) => {
            callbacks.rebuildProject(configFile, path);
        });
    }
}

export interface DependencyGraph {
    buildQueue: ReadonlyArray<ReadonlyArray<string>>;
    dependencyMap: Mapper;
}

function createDependencyGraph(roots: string[]): DependencyGraph {
    // This is a list of list of projects that need to be built.
    // The ordering here is "backwards", i.e. the first entry in the array is the last set of projects that need to be built;
    //   and the last entry is the first set of projects to be built.
    // Each subarray is unordered.
    // We traverse the reference graph from each root, then "clean" the list by removing
    //   any entry that is duplicated to its right.
    const buildQueue: string[][] = [];
    const dependencyMap = createDependencyMapper();
    let buildQueuePosition = 0;
    for (const root of roots) {
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

    removeDuplicatesFromBuildQueue(buildQueue);

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
            mkdirp.sync(dir);
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

type UpToDateStatus =
    // The project does not need to be built
    { result: "up-to-date", timestamp: number } |
    // An expected output of this project is missing
    { result: "missing", missingFile: string } |
    // An output file is older than an input file
    { result: "out-of-date", newerFile: string, olderFile: string } |
    // An output file is older than a dependent project's output file
    { result: "older-than-dependency", dependency: string };

function checkUpToDateRelativeToInputs(configFile: ts.ParsedCommandLine | undefined, configFileName: string): UpToDateStatus {
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
