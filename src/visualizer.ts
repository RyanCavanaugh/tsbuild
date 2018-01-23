import fs = require('fs');
import path = require('path');
import viz = require('viz.js');
import { DependencyGraph } from './index';
import { veryFriendlyName } from './utils';


export function renderGraphVisualization(roots: string[], graph: DependencyGraph, fileName: string) {
    const { buildQueue, dependencyMap } = graph;
    const lines: string[] = [];
    lines.push(`digraph project {`);
    for (const key of roots) {
        lines.push(`    \"${veryFriendlyName(key)}\"`);
        for (const dep of dependencyMap.getReferencesOf(key)) {
            lines.push(`    \"${veryFriendlyName(key)}\" -> \"${veryFriendlyName(dep)}\"`);
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

