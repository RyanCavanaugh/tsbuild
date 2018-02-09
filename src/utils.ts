import path = require('path');
import ts = require('@ryancavanaugh/typescript');

export function parseConfigFile(fileName: string): ts.ParsedCommandLine | undefined {
    const rawFileContent = ts.sys.readFile(fileName, 'utf-8');
    if (rawFileContent === undefined) {
        return undefined;
    }
    const parsedFileContent = ts.parseJsonText(fileName, rawFileContent);
    const configParseResult = ts.parseJsonSourceFileConfigFileContent(parsedFileContent, ts.sys, path.dirname(fileName), /*optionsToExtend*/ undefined, fileName);
    return configParseResult;
}

export function getCanonicalFileName(fileName: string) {
    fileName = path.resolve(fileName);
    if (fileName[1] === ':') {
        return fileName[0].toUpperCase() + ':' + fileName.substr(2);
    }
    return fileName;
}

export function flatten<T>(arr: ReadonlyArray<ReadonlyArray<T>>): T[] {
    return Array.prototype.concat.apply([], arr);
}

export function clone2DArray<T>(arr: ReadonlyArray<ReadonlyArray<T>> | T[][]): T[][] {
    return (arr as T[][]).map(subArr => subArr.slice());
}

export function wrapSingle<T>(itemOrArray: T | T[] | undefined): T[] {
    if (itemOrArray === undefined) {
        return [];
    } else if (Array.isArray(itemOrArray)) {
        return itemOrArray;
    } else {
        return [itemOrArray];
    }
}

/**
 * Removes entries from arrays which appear in later arrays.
 * TODO: Make not O(n^2)
 */
export function removeDuplicatesFromBuildQueue(queue: string[][]): void {
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

export function friendlyNameOfFile(fileName: string) {
    return path.relative(process.cwd(), fileName);
}

export function veryFriendlyName(configFileName: string) {
    return path.basename(path.dirname(configFileName));
}

export function throwIfReached(_: never, message: string): never {
    throw new Error(message);
}

export function resolvePathRelativeToCwd(fileName: string) {
    return path.resolve(process.cwd(), fileName);
}
