import path = require('path');

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
export function removeDuplicates(queue: string[][]): void {
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

export function throwIfReached(x: never, message: string): never {
    throw new Error(message);
}

export function resolvePathRelativeToCwd(fileName: string) {
    return path.resolve(process.cwd(), fileName);
}
