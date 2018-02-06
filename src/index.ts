#!/usr/bin/env node

import fs = require('fs');
import { normalize, relative } from 'path';
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

const host = ts.createCompilerHost({});
const watchers: chokidar.FSWatcher[] = [];

namespace main {
    const whatToDo = parseCommandline(yargsSetup.parse());
    setImmediate(() => main(whatToDo));

    function main(whatToDo: TsBuildCommandLine) {
        let graph = createDependencyGraph(whatToDo.roots);

        if (whatToDo.viz) {
            renderGraphVisualization(whatToDo.roots, graph, 'project-graph.svg', whatToDo.viz === 'deep');
            return;
        }

        processBuildQueue(graph, handleBuildStatus);

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
            // We can just rerun the whole build queue; the right thing will happen
            processBuildQueue(graph, handleBuildStatus, { quiet: true });
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

        function handleBuildStatus(configFileName: string, status: UpToDateStatus, opts: BuildOptions): boolean {
            const projectName = friendlyNameOfFile(configFileName);
            let shouldBuild: boolean = true;
            switch (status.result) {
                case "older-than-dependency":
                    opts.quiet || console.log(`Project ${projectName} is out-to-date with respect to its dependency ${friendlyNameOfFile(status.dependency)}`);
                    break;
                case "missing":
                    opts.quiet || console.log(`Project ${projectName} has not built output file ${friendlyNameOfFile(status.missingFile)}`);
                    break;
                case "out-of-date":
                    opts.quiet || console.log(`Project ${projectName} has input file ${friendlyNameOfFile(status.newerFile)} newer than output file ${friendlyNameOfFile(status.olderFile)}`);
                    break;
                case "up-to-date":
                    opts.quiet || console.log(`Project ${projectName} is up-to-date with respect to its inputs`);
                    shouldBuild = whatToDo.force;
                    break;
                default:
                    throwIfReached(status, "Unknown up-to-date return value");
            }
            if (shouldBuild && !whatToDo.dry) {
                const result = buildProject(configFileName);
                return (result & BuildResultFlags.Errors) === BuildResultFlags.None;
            }
            return true;
        }
    }
}

interface WatchCallbacks {
    rebuildProject(configFileName: string, changedFile: string): void;
    rebuildGraph(): void;
}

interface BuildOptions {
    quiet?: boolean;
}

function processBuildQueue(graph: DependencyGraph, buildCallback: (configFileName: string, status: UpToDateStatus, opts: BuildOptions) => boolean, opts: BuildOptions = {}) {
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
                keepGoing = buildCallback(proj, { result: "older-than-dependency", dependency: unbuiltRefs[0] }, opts);
            } else {
                const utd = checkUpToDateRelativeToInputs(parseConfigFile(proj), proj);
                keepGoing = buildCallback(proj, utd, opts);
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

        const refs = ts.getProjectReferenceFileNames(host, root.options);
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

export function parseConfigFile(fileName: string): ts.ParsedCommandLine | undefined {
    const rawFileContent = ts.sys.readFile(fileName, 'utf-8');
    if (rawFileContent === undefined) {
        return undefined;
    }
    const parsedFileContent = ts.parseJsonText(fileName, rawFileContent);
    const configParseResult = ts.parseJsonSourceFileConfigFileContent(parsedFileContent, ts.sys, path.dirname(fileName), /*optionsToExtend*/ undefined, fileName);
    return configParseResult;
}

enum BuildResultFlags {
    None = 0,
    ConfigFileErrors = 1 << 0,
    SyntaxErrors = 1 << 1,
    TypeErrors  = 1 << 2,
    DeclarationEmitErrors = 1 << 3,
    DeclarationOutputUnchanged = 1 << 4,

    Errors = ConfigFileErrors | SyntaxErrors | TypeErrors | DeclarationEmitErrors
}

function buildProject(proj: string): BuildResultFlags {
    let resultFlags = BuildResultFlags.None;
    resultFlags |= BuildResultFlags.DeclarationOutputUnchanged;

    const configFile = parseConfigFile(proj);
    if (!configFile) {
        console.log(`Failed to read config file ${proj}`);
        resultFlags |= BuildResultFlags.ConfigFileErrors;
        return resultFlags;
    }

    const diagHost: ts.FormatDiagnosticsHost = {
        getCanonicalFileName(fileName) {
            return path.relative(path.dirname(proj), fileName);
        },
        getCurrentDirectory() {
            return rootDirOfOptions(configFile.options, proj);
        },
        getNewLine() {
            return '\r\n';
        }
    };

    const program = ts.createProgram(configFile.fileNames, configFile.options);

    const outputName = getFriendlyOutputName(configFile.options);
    console.log(`Building ${veryFriendlyName(proj)} to ${outputName}...`);

    // Don't emit anything in the presence of syntactic errors or options diagnostics
    const syntaxDiagnostics = [...program.getOptionsDiagnostics(), ...program.getSyntacticDiagnostics()];
    if (syntaxDiagnostics.length) {
        resultFlags |= BuildResultFlags.SyntaxErrors;
        console.error(`Syntax/options errors in project ${veryFriendlyName(proj)}`);
        printErrors(syntaxDiagnostics, diagHost);
        return resultFlags;
    }

    // Don't emit .d.ts if there are decl file errors
    if (program.getCompilerOptions().declaration) {
        const declDiagnostics = program.getDeclarationDiagnostics();
        if (declDiagnostics.length) {
            resultFlags |= BuildResultFlags.DeclarationEmitErrors;
            console.error(`.d.ts emit errors in project ${veryFriendlyName(proj)}`);
            printErrors(declDiagnostics, diagHost);
        }
    }

    const emitResult = program.emit(undefined, (fileName, content) => {
        mkdirp.sync(path.dirname(fileName));
        let isUnchangedDeclFile = false;
        if (isDeclarationFile(fileName) && (resultFlags & BuildResultFlags.DeclarationEmitErrors)) {
            // Don't emit invalid .d.ts files
            return;
        }
        if (isDeclarationFile(fileName) && fs.existsSync(fileName)) {
            if (fs.readFileSync(fileName, 'utf-8') === content) {
                resultFlags &= ~BuildResultFlags.DeclarationOutputUnchanged;
                isUnchangedDeclFile = true;
            }
        }
        fs.writeFileSync(fileName, content, 'utf-8');
        console.log(`    * Wrote ${content.length} bytes to ${path.basename(fileName)}${isUnchangedDeclFile ? " (unchanged)" : ""}`);
    });

    const semanticDiagnostics = [...program.getSemanticDiagnostics()];
    if (semanticDiagnostics.length) {
        resultFlags |= BuildResultFlags.TypeErrors;
        console.error(`Type errors in project ${veryFriendlyName(proj)}`);
        printErrors(semanticDiagnostics, diagHost);
    }

    return resultFlags;
}

function printErrors(arr: ReadonlyArray<ts.Diagnostic>, host: ts.FormatDiagnosticsHost) {
    for (const err of arr) {
        console.log(ts.formatDiagnostic(err, host));
    }
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

function isDeclarationFile(fileName: string) {
    return /\.d\.ts$/.test(fileName);
}

function getOutputFilenames(configFileName: string) {
    const outputs: string[] = [];
    const dependencyConfigFile = parseConfigFile(configFileName)!;
    // Note: We do not support mixed global+module compilations.
    // TODO: Error if this occurs
    if (dependencyConfigFile.options.outFile) {
        return [dependencyConfigFile.options.outFile];
    }

    for (const inputFile of dependencyConfigFile.fileNames) {
        if (!isDeclarationFile(inputFile)) {
            outputs.push(getOutputDeclarationFileName(inputFile, dependencyConfigFile, configFileName));
        }
    }
    return outputs;
}

function checkUpToDateRelativeToInputs(configFile: ts.ParsedCommandLine | undefined, configFileName: string): UpToDateStatus {
    if (!configFile) throw new Error("No config file");

    let newestInputFileTime = -Infinity;
    let newestInputFileName = "????";
    let oldestOutputFileTime = Infinity;
    let oldestOutputFileName = "";
    let newestOutputFileTime = -1;

    const allInputs = [...configFile.fileNames];
    for (const ref of ts.getProjectReferenceFileNames(host, configFile.options) || []) {
        for (const output of getOutputFilenames(ref)) {
            allInputs.push(output);
        }
    }

    for (const inputFile of allInputs) {
        const inputFileTime = fs.statSync(inputFile).mtimeMs;
        if (inputFileTime > newestInputFileTime) {
            newestInputFileTime = inputFileTime;
            newestInputFileName = inputFile;
        }

        // .d.ts files do not have output files
        if (!isDeclarationFile(inputFile)) {
            const expectedOutputFile = configFile.options.outFile || getOutputDeclarationFileName(inputFile, configFile, configFileName);
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
    const relativePath = path.relative(rootDirOfOptions(configFile.options, configFileName), inputFileName);
    if (!configFile.options.outDir) {
        throw new Error(`${configFileName} must set 'outDir'`);
    }
    const outputPath = path.resolve(configFile.options.outDir!, relativePath);
    return outputPath.replace(/\.tsx?$/, '.d.ts');
}

function rootDirOfOptions(opts: ts.CompilerOptions, configFileName: string) {
    return opts.rootDir || path.dirname(configFileName);
}

function getFriendlyOutputName(opts: ts.CompilerOptions): string {
    if (opts.outFile) {
        return friendlyNameOfFile(opts.outFile);
    } else {
        return friendlyNameOfFile(opts.outDir!);
    }
}
