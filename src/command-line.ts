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
    project?: string | string[];
};

export interface TsBuildCommandLine {
    roots: string[];
    dry: boolean;
    watch: boolean;
    force: boolean;
    viz: boolean;
}

export const yargsSetup = yargs
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
        addInferred('.');
    }

    return {
        roots,
        dry: cmdLine.dry || false,
        watch: cmdLine.watch || false,
        force: cmdLine.force || false,
        viz: cmdLine.viz || false
    };

    function addInferred(unknown: string) {
        const unknownResolved = resolvePathRelativeToCwd(unknown);
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

