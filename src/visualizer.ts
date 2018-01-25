import fs = require('fs');
import path = require('path');
import viz = require('viz.js');
import { DependencyGraph, parseConfigFile } from './index';
import { veryFriendlyName } from './utils';


export function renderGraphVisualization(roots: string[], graph: DependencyGraph, fileName: string, deep: boolean = false) {
    const { buildQueue, dependencyMap } = graph;
    const lines: string[] = [];
    lines.push(`digraph project {`);
    lines.push("    rankdir = BT;");

    for (const key of roots) {
        const friendlyName = veryFriendlyName(key);
        lines.push(`    \"${friendlyName}\"`);
        for (const dep of dependencyMap.getReferencesOf(key)) {
            lines.push(`    \"${friendlyName}\" -> \"${veryFriendlyName(dep)}\"`);
        }
        if (deep) {
            const cfg = parseConfigFile(key)!;
            for (const file of cfg.fileNames) {
                const relativePath = path.relative(path.dirname(key), file);
                lines.push(`    \"${relativePath}\"`);
                lines.push(`    \"${relativePath}\" -> \"${friendlyName}\"`);
            }
        }
    }

    lines.push(`}`);
    fs.writeFile(fileName, viz(lines.join('\r\n'), { y: -1 }), { encoding: 'utf-8' }, err => {
        console.log(`Wrote ${lines.length} lines to ${fileName}`);
        if (err)
            throw err;
        process.exit(0);
    });
}

