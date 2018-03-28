import yargs = require('yargs');
import path = require('path');
import fs = require('fs');
import { wrapSingle, resolvePathRelativeToCwd } from "./utils";
import glob = require('glob');

export type YargsCommandLine = yargs.Arguments & {
    _: string[];
    dry?: boolean;
    watch?: boolean;
    force?: boolean;
    viz?: boolean;
    verbose?: boolean;
    project?: string | string[];
};

export interface TsBuildCommandLine {
    roots: string[];
    dry: boolean;
    watch: boolean;
    force: boolean;
    verbose: boolean;
    quiet: boolean;
    viz: false | true | "deep";
}

export const yargsSetup = yargs
    .usage('tsbuild [options] [proj1] [dir1] ...')
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
    .option('quiet', {
        default: false,
        description: "Shhhhh"
    })
    .option('verbose', {
        default: false,
        description: "Enable verbose logging"
    })
    .options('viz', {
        default: false,
        description: "Render a project dependency graph"
    })
    .strict();

export function parseCommandline(cmdLine: YargsCommandLine): TsBuildCommandLine {
    const roots: string[] = [];

    let anythingHappened = false;
    for (const project of wrapSingle(cmdLine.project)) {
        addInferred(resolvePathRelativeToCwd(project));
        anythingHappened = true;
    }

    for (const unknown of cmdLine._) {
        addInferred(resolvePathRelativeToCwd(unknown));
        anythingHappened = true;
    }

    if (!anythingHappened) {
        if (fs.existsSync("./tsconfig.json")) {
            anythingHappened = true;
            addInferred("./tsconfig.json");
        }
    }

    if (!anythingHappened) {
        addInferred('.');
    }

    return {
        roots,
        dry: cmdLine.dry || false,
        watch: cmdLine.watch || false,
        force: cmdLine.force || false,
        viz: cmdLine.viz || false,
        quiet: cmdLine.quiet || false,
        verbose: cmdLine.verbose || false
    };

    function addInferred(unknown: string) {
        const unknownResolved = resolvePathRelativeToCwd(unknown);
        if (!fs.existsSync(unknownResolved)) {
            // Wildcard - recursively look for matched files
            const configs = glob.sync(path.join(unknownResolved));
            for (const cfg of configs) {
                addRootProject(cfg);
            }
            return;
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

