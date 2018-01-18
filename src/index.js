"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var minimist = require("minimist");
var fs = require("fs");
var path = require("path");
var glob = require("glob");
function wrapSingle(itemOrArray) {
    if (itemOrArray === undefined) {
        return [];
    }
    else if (Array.isArray(itemOrArray)) {
        return itemOrArray;
    }
    else {
        return [itemOrArray];
    }
}
function main() {
    var cmdLine = minimist(process.argv.slice(2));
    var whatToDo = parseCommandline(cmdLine);
}
function parseCommandline(cmdLine) {
    var roots = [];
    var anythingHappened = false;
    for (var _i = 0, _a = wrapSingle(cmdLine.project); _i < _a.length; _i++) {
        var project = _a[_i];
        addInferred(resolvePath(project));
        anythingHappened = true;
    }
    for (var _b = 0, _c = cmdLine._; _b < _c.length; _b++) {
        var unknown = _c[_b];
        addInferred(resolvePath(unknown));
        anythingHappened = true;
    }
    function addInferred(unknown) {
        var unknownResolved = resolvePath(unknown);
        if (!fs.existsSync(unknownResolved)) {
            return {
                error: "File " + unknown + " doesn't exist"
            };
        }
        if (fs.lstatSync(unknownResolved).isDirectory()) {
            // Directory - recursively look for tsconfig.json files
            var configs = glob.sync(path.join(unknownResolved, '**', 'tsconfig.json'));
            for (var _i = 0, configs_1 = configs; _i < configs_1.length; _i++) {
                var cfg = configs_1[_i];
                addRootProject(cfg);
            }
        }
        else if (fs.existsSync(unknownResolved)) {
            addRootProject(unknownResolved);
        }
    }
    return {
        roots: roots,
        dry: cmdLine.dry || false
    };
    function addRootProject(fileName) {
        roots.push(fileName);
    }
}
function resolvePath(fileName) {
    return path.resolve(process.cwd(), fileName);
}
main();
