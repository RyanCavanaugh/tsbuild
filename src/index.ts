#!/usr/bin/env node

import fs = require('fs');
import { normalize, relative } from 'path';
import path = require('path');

import mkdirp = require('mkdirp');
import minimist = require('minimist');
import ts = require('@ryancavanaugh/typescript');
import chokidar = require('chokidar');
import glob = require('glob');

import { createDependencyMapper, Mapper, __ } from './dependency-map';
import { wrapSingle, removeDuplicatesFromBuildQueue, friendlyNameOfFile, throwIfReached, resolvePathRelativeToCwd, veryFriendlyName, clone2DArray, flatten, getCanonicalFileName, parseConfigFile } from './utils';
import { yargsSetup, parseCommandline, TsBuildCommandLine } from './command-line';
import { renderGraphVisualization } from './visualizer';
import FileMap from './file-map';

const host = ts.createCompilerHost({});
const watchers: chokidar.FSWatcher[] = [];
let beVerbose = false;
let beQuiet = false;

interface WatchCallbacks {
    rebuildProject(configFileName: string, changedFile: string): void;
    rebuildGraph(): void;
}

interface BuildOptions {
    quiet?: boolean;
}

interface BuildContext {
    unchangedOutputs: FileMap<number>;
}

function processBuildQueue(graph: DependencyGraph, buildCallback: (configFileName: string, status: UpToDateStatus, opts: BuildOptions, ctx: BuildContext) => boolean, opts: BuildOptions = {}) {
    const context = createBuildContext();
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

            let keepGoing: boolean;
            const utd = checkUpToDateRelativeToInputs(parseConfigFile(proj), proj, context);
            keepGoing = buildCallback(proj, utd, opts, context);
            if (utd.result !== "up-to-date") {
                projectsNeedingBuild[proj] = true;
            }

            if (!keepGoing) {
                return;
            }
        }
    }
}

function createBuildContext(): BuildContext {
    return ({
        unchangedOutputs: new FileMap()
    });
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
            // File ${file} is already watched by a directory watch
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

enum BuildResultFlags {
    None = 0,
    ConfigFileErrors = 1 << 0,
    SyntaxErrors = 1 << 1,
    TypeErrors = 1 << 2,
    DeclarationEmitErrors = 1 << 3,
    DeclarationOutputUnchanged = 1 << 4,

    Errors = ConfigFileErrors | SyntaxErrors | TypeErrors | DeclarationEmitErrors
}

function tryPseudoBuild(proj: string, timestamp: Date, context: BuildContext): boolean {
    const configFile = parseConfigFile(proj);
    // TODO throw or something
    if (!configFile) return false;

    const refs = configFile.options.references;
    if (refs && refs.some(r => !!(r && r.prepend))) {
        const couldReuse = tryReusePrependedBuild(proj, configFile, timestamp, context);
        if (couldReuse) {
            unquiet(`Fast-rebuilt ${proj} from its prior output`);
            
            // If we successfully rebuilt, we do need to touch the .d.ts output - it will be unchanged, but appear out-of-date
            const dtsFileName = getAllOutputFilenames(proj).filter(f => /\.d\.ts$/i.test(f))[0];
            if (dtsFileName !== undefined) {
                const oldTime = updateTimestamp(dtsFileName, new Date());
                context.unchangedOutputs.setValue(dtsFileName, oldTime);
            }
            return true;
        } else {
            // Need to issue a rebuild for this output to be correct
            return false;
        }
    }

    const outputs = getAllOutputFilenames(proj);
    const now = new Date();
    for (const output of outputs) {
        const oldTime = updateTimestamp(output, now);
        context.unchangedOutputs.setValue(output, oldTime);
    }
    return true;
}

// Returns the prior modified timestamp value (in milliseconds)
function updateTimestamp(fileName: string, date: Date): number {
    verbose(` * Update timestamp of ${fileName} to ${toShortTime(date)}`)
    const oldTime = fs.statSync(fileName).mtimeMs;
    fs.utimesSync(fileName, date, date);
    return oldTime;
}

// A pseudobuild of an outFile compilation with prepends is actually incorrect; the prior
// JS content of the file will be the 'old' content from the upstream project.
// If we detect this situation, we need to fish out the original downstream project output
// from the output file using the bundle_info file, then reconstruct a new concatenation
// of the output file.
// But if any of this wizardry fails, we can just fall back to a vanilla build
function tryReusePrependedBuild(proj: string, configFile: ts.ParsedCommandLine, timestamp: Date, context: BuildContext): boolean {
    const outFilePath = getOutFileName(proj, configFile);
    if (!fs.existsSync(outFilePath)) return false;
    const bundleInfoPath = getOutFileName(proj, configFile, ".bundle_info");
    if (!fs.existsSync(bundleInfoPath)) return false;

    const bundleInfo = JSON.parse(fs.readFileSync(bundleInfoPath, { encoding: 'utf-8' }));
    const outFileContent = fs.readFileSync(outFilePath, { encoding: 'utf-8' });
    if (outFileContent.length !== bundleInfo.totalLength) {
        unquiet(`WARNING: Fast re-use of ${outFilePath} skipped because its saved length ${bundleInfo.totalLength} didn't match its actual length ${outFileContent.length}`);
        return false;
    }

    // Get the non-prepend content from the outFile
    const originalContent = outFileContent.substr(bundleInfo.originalOffset);
    // Read all the prior outFiles from disk
    // TODO: We could save them in-memory since we know (?) they recently happened?
    let output = "";
    for (const ref of configFile.options.references!) {
        const refPath = resolveReferenceToConfigFileName(proj, ref);
        const refConfigFile = parseConfigFile(refPath);
        const referenceOutFile = getOutFileName(refPath, refConfigFile!);
        output = fs.readFileSync(referenceOutFile, { encoding: 'utf-8'}) + output;
    }
    // Compute the updated bundle info
    const newBundleInfo: any = { originalOffset: output.length };
    output = output + originalContent;
    writeFileWithNotification(outFilePath, output);
    newBundleInfo.totalLength = output.length;
    writeFileWithNotification(bundleInfoPath, JSON.stringify(newBundleInfo, undefined, 2));

    return true;
}

function writeFileWithNotification(fileName: string, content: string, indent = 1, unchanged = false) {
    fs.writeFileSync(fileName, content, { encoding: 'utf-8'});
    unquiet(`${new Array(indent).join('  ')}* Wrote ${content.length} characters to ${path.basename(fileName)}${unchanged ? " (unchanged)" : ""}`);
}

function resolveReferenceToConfigFileName(referencingConfigFileName: string, reference: ts.ProjectReference): string {
    const expectedLocationBase = path.join(referencingConfigFileName, "..", reference.path);
    const withTsConfig = path.join(expectedLocationBase, "tsconfig.json");
    if (fs.existsSync(withTsConfig)) {
        return withTsConfig;
    }
    return expectedLocationBase;
}

function getOutFileName(configFilePath: string, configFile: ts.ParsedCommandLine, extensionWithLeadingDot?: string): string {
    const result = path.resolve(configFilePath, configFile.options.outFile!);
    if (extensionWithLeadingDot === undefined) {
        return result;
    }
    return changeExtension(result, extensionWithLeadingDot);
}

function changeExtension(fileName: string, extensionWithLeadingDot: string) {
    return fileName.substr(0, fileName.lastIndexOf('.')) + extensionWithLeadingDot;
}

function buildProject(proj: string, context: BuildContext): BuildResultFlags {
    let resultFlags = BuildResultFlags.None;
    resultFlags |= BuildResultFlags.DeclarationOutputUnchanged;

    const configFile = parseConfigFile(proj);
    if (!configFile) {
        unquiet(`Failed to read config file ${proj}`);
        resultFlags |= BuildResultFlags.ConfigFileErrors;
        return resultFlags;
    }

    if (configFile.fileNames.length === 0) {
        // Nothing to build - must be a solution file, basically
        return BuildResultFlags.None;
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
    unquiet(`Building ${veryFriendlyName(proj)} to ${outputName}...`);

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
        let priorChangeTime = -1;
        if (isDeclarationFile(fileName) && (resultFlags & BuildResultFlags.DeclarationEmitErrors)) {
            // Don't emit invalid .d.ts files
            return;
        }

        if (isDeclarationFile(fileName) && fs.existsSync(fileName)) {
            if (fs.readFileSync(fileName, 'utf-8') === content) {
                resultFlags &= ~BuildResultFlags.DeclarationOutputUnchanged;
                isUnchangedDeclFile = true;
                priorChangeTime = fs.statSync(fileName).mtimeMs;
            }
        }

        fs.writeFileSync(fileName, content, 'utf-8');
        unquiet(`    * Wrote ${content.length} bytes to ${path.basename(fileName)}${isUnchangedDeclFile ? " (unchanged)" : ""}`);
        if (isUnchangedDeclFile) {
            context.unchangedOutputs.setValue(fileName, priorChangeTime);
        }
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
        console.error(ts.formatDiagnostic(err, host));
    }
}

function printBuildQueue(queue: string[][]) {
    unquiet('== Build Order ==')
    for (let i = queue.length - 1; i >= 0; i--) {
        unquiet(` * ${queue[i].map(friendlyNameOfFile).join(', ')}`);
    }
}

type UpToDateStatus =
    // Something (e.g. missing file or syntax error) has blocked build
    { result: "unbuildable" } |
    // The project does not need to be built.
    // "timestamp" is the time of the newest input file
    { result: "up-to-date", timestamp: Date } |
    // The project is up-to-date relative to prior output-identical builds of its dependencies.
    // "timestamp" is the time of the newest upstream output.
    { result: "pseudo-up-to-date", timestamp: Date } |
    // An expected output of this project is missing
    { result: "missing", missingFile: string } |
    // An output file is older than an input file
    { result: "out-of-date", newerFile: string, newerTimestamp: Date, olderFile: string, olderTimestamp: Date } |
    // An output file is older than a dependent project's output file
    { result: "older-than-dependency", dependency: string };

function isDeclarationFile(fileName: string) {
    return /\.d\.ts$/.test(fileName);
}

function getOutputDeclarationFilenames(configFileName: string) {
    return getAllOutputFilenames(configFileName).filter(fn => /\.d\.ts$/.test(fn));
}

function getAllOutputFilenames(configFileName: string) {
    const outputs: string[] = [];
    const dependencyConfigFile = parseConfigFile(configFileName)!;
    // Note: We do not support mixed global+module compilations.
    // TODO: Error if this occurs (in tsc under referenceTarget: true)
    if (dependencyConfigFile.options.outFile) {
        if (dependencyConfigFile.options.declaration) {
            return [dependencyConfigFile.options.outFile, changeExtension(dependencyConfigFile.options.outFile, ".d.ts")];
        } else {
            return [dependencyConfigFile.options.outFile];
        }
    }

    for (const inputFile of dependencyConfigFile.fileNames) {
        if (!isDeclarationFile(inputFile)) {
            outputs.push(getOutputDeclarationFileName(inputFile, dependencyConfigFile, configFileName));
            outputs.push(getOutputJavaScriptFileName(inputFile, dependencyConfigFile, configFileName));
        }
    }
    return outputs;
}

function toShortTime(time: number | Date) {
    const d = new Date(+time);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

function checkUpToDateRelativeToInputs(configFile: ts.ParsedCommandLine | undefined, configFileName: string, context: BuildContext): UpToDateStatus {
    if (!configFile) throw new Error("No config file");

    verbose(`Checking up-to-date status of ${configFileName}`);

    // Compute the outputs of this project and its "newest own" input file
    const allOutputs: string[] = [];
    let newestInputFileTime = -Infinity;
    let newestInputFileName = "????";
    let missingFile = false;
    for (const inputFile of configFile.fileNames) {
        if (!fs.existsSync(inputFile)) {
            console.error(`Listed input file ${inputFile} from ${configFileName} does not exist`);
            missingFile = true;
            continue;
        }
        const inputTime = fs.statSync(inputFile).mtimeMs;
        verbose(`Source input file ${inputFile} last updated at ${toShortTime(inputTime)}`);
        if (inputTime > newestInputFileTime) {
            newestInputFileTime = inputTime;
            newestInputFileName = inputFile;
        }
        // .d.ts files do not have output files or JS file outputs
        if (!configFile.options.outFile && !isDeclarationFile(inputFile)) {
            if (configFile.options.declaration) {
                allOutputs.push(getOutputDeclarationFileName(inputFile, configFile, configFileName));
            }
            allOutputs.push(getOutputJavaScriptFileName(inputFile, configFile, configFileName));
        }
    }
    if (missingFile) {
        return {
            result: "unbuildable"
        };
    }

    // Potential outFile outputs
    if (configFile.options.outFile) {
        if (configFile.options.declaration) {
            allOutputs.push(configFile.options.outFile.replace(/\.js$/, '.d.ts'));
        }
        allOutputs.push(configFile.options.outFile);
    }

    // If any output file doesn't exist, or is older than a direct input, then this project is out of date
    // and we don't need to compute any information about its references
    let oldestOutputFileTime = Infinity;
    let oldestOutputFileName = "";
    for (const expectedOutputFile of allOutputs) {
        if (!ts.sys.fileExists(expectedOutputFile)) {
            return {
                result: "missing",
                missingFile: expectedOutputFile
            };
        }
        // Keep track of the oldest output file we've seen
        const outputFileTime = fs.statSync(expectedOutputFile).mtimeMs;
        if (outputFileTime < oldestOutputFileTime) {
            oldestOutputFileTime = outputFileTime;
            oldestOutputFileName = expectedOutputFile;
        }
        // We can bail early if the newest input is newer than the oldest output
        if (newestInputFileTime > oldestOutputFileTime) {
            return {
                result: "out-of-date",
                newerFile: newestInputFileName,
                newerTimestamp: new Date(newestInputFileTime),
                olderFile: oldestOutputFileName,
                olderTimestamp: new Date(oldestOutputFileTime)
            };
        }
    }

    // Compute the reference inputs of this project
    const referenceInputs: string[] = [];
    // Collect the .d.ts outputs of all referenced projects as additional input files
    for (const ref of ts.getProjectReferenceFileNames(host, configFile.options) || []) {
        for (const output of getOutputDeclarationFilenames(ref)) {
            // If this project isn't using outFile, then we can ignore the .js
            // outputs of referenced projects. Otherwise we may be concating and
            // do need to rebuild if a JS output changed.
            // TODO: This logic should be different for a concat-only project,
            // which doesn't need downstream typechecking
            if (configFile.options.outFile || /\.d\.ts$/.test(output)) {
                referenceInputs.push(output);
            }
        }
    }

    // This tracks if we've relied the "new file is identical to an older version of itself"
    // to compute an up-to-date result
    let usedPseudoTimestamp = false;

    // Compute up-to-dateness relative to the reference
    let newestPseudoInput = -1;
    for (const dependentFile of referenceInputs) {
        const dependentFileTime = fs.statSync(dependentFile).mtimeMs;
        verbose(`Reference input file ${dependentFile} last updated at ${toShortTime(dependentFileTime)}`);

        const pseduoInputFileTime = context.unchangedOutputs.getValueOrUndefined(dependentFile);
        // A prior unchanged version of this file exists
        if (pseduoInputFileTime !== undefined) {
            // If the oldest output is still newer than this pseudotime, then
            // we can skip it and go for a pseudobuild.
            if (oldestOutputFileTime >= pseduoInputFileTime) {
                usedPseudoTimestamp = true;
                newestPseudoInput = Math.max(newestPseudoInput, dependentFileTime);
                continue;
            }
        }

        if (dependentFileTime > newestInputFileTime) {
            newestInputFileTime = dependentFileTime;
            newestInputFileName = dependentFile;
        }

        // Bail early if we're already out of date
        if (newestInputFileTime > oldestOutputFileTime) {
            return {
                result: "out-of-date",
                newerFile: newestInputFileName,
                newerTimestamp: new Date(newestInputFileTime),
                olderFile: oldestOutputFileName,
                olderTimestamp: new Date(oldestOutputFileTime)
            };
        }
    }

    if (usedPseudoTimestamp) {
        return {
            result: "pseudo-up-to-date",
            timestamp: new Date(Math.max(newestInputFileTime, newestPseudoInput))
        };
    } else {
        return {
            result: "up-to-date",
            timestamp: new Date(newestInputFileTime)
        };
    }
}

function getOutputDeclarationFileName(inputFileName: string, configFile: ts.ParsedCommandLine, configFileName: string) {
    return getRelativeOutputFileName(inputFileName, configFile, configFileName).replace(/\.tsx?$/, '.d.ts');
}

function getOutputJavaScriptFileName(inputFileName: string, configFile: ts.ParsedCommandLine, configFileName: string) {
    // TODO handle JSX: Preserve
    return getRelativeOutputFileName(inputFileName, configFile, configFileName).replace(/\.tsx?$/, '.js');
}

function getRelativeOutputFileName(inputFileName: string, configFile: ts.ParsedCommandLine, configFileName: string) {
    const relativePath = path.relative(rootDirOfOptions(configFile.options, configFileName), inputFileName);
    if (!configFile.options.outDir) {
        throw new Error(`${configFileName} must set 'outDir'`);
    }
    const outputPath = path.resolve(configFile.options.outDir!, relativePath);
    return outputPath;
}

function rootDirOfOptions(opts: ts.CompilerOptions, configFileName: string) {
    return opts.rootDir || path.dirname(configFileName);
}

function getFriendlyOutputName(opts: ts.CompilerOptions): string {
    if (!opts.outFile && !opts.outDir) {
        throw new Error(`Did not expect to find neither outFile nor outDir here`);
    }

    if (opts.outFile) {
        return friendlyNameOfFile(opts.outFile);
    } else {
        return friendlyNameOfFile(opts.outDir!);
    }
}

function verbose(message: string) {
    if (beVerbose) {
        console.log(message);
    }
}

function unquiet(message: string) {
    if (!beQuiet) {
        console.log(message);
    }
}

namespace main {
    // console.log(`tsbuild@${require('../package.json').version} + typescript@${ts.version}`);
    const whatToDo = parseCommandline(yargsSetup.parse());
    beVerbose = whatToDo.verbose;
    beQuiet = whatToDo.quiet;
    main(whatToDo);

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
            unquiet('Rebuilding project graph due to an edit in a config file');
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

        function handleBuildStatus(configFileName: string, status: UpToDateStatus, opts: BuildOptions, context: BuildContext): boolean {
            const projectName = friendlyNameOfFile(configFileName);
            let shouldBuild: boolean = true;
            let pseudoBuildTime: false | Date = false;
            switch (status.result) {
                case "older-than-dependency":
                    unquiet(`Project ${projectName} is out-to-date with respect to its dependency ${friendlyNameOfFile(status.dependency)}`);
                    break;
                case "missing":
                    unquiet(`Project ${projectName} has not built output file ${friendlyNameOfFile(status.missingFile)}`);
                    break;
                case "out-of-date":
                    unquiet(`Project ${projectName} has input file ${friendlyNameOfFile(status.newerFile)}@${toShortTime(status.newerTimestamp)} newer than output file ${friendlyNameOfFile(status.olderFile)}@${toShortTime(status.olderTimestamp)}`);
                    break;
                case "up-to-date":
                    unquiet(`Project ${projectName} is up-to-date with respect to its inputs`);
                    shouldBuild = whatToDo.force;
                    break;
                case "pseudo-up-to-date":
                    unquiet(`Project ${projectName}'s dependencies were rebuilt, but didn't change .d.ts`);
                    pseudoBuildTime = status.timestamp;
                    break;
                case "unbuildable":
                    console.error(`Cannot continue build due to a fatal error`);
                    return false;
                default:
                    throwIfReached(status, "Unknown up-to-date return value");
            }
            if (shouldBuild && !whatToDo.dry) {
                if (pseudoBuildTime && !whatToDo.force) {
                    if (tryPseudoBuild(configFileName, pseudoBuildTime, context)) {
                        return true;
                    }
                
                }
                const result = buildProject(configFileName, context);
                return (result & BuildResultFlags.Errors) === BuildResultFlags.None;
            }
            return true;
        }
    }
}

