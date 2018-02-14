import path = require('path');

function normalize(fn: string) {
    return path.normalize(path.resolve(fn));
}

export default class FileMap<T> {
    private lookup: {[key: string]: T} = Object.create(null);

    setValue(fileName: string, value: T) {
        this.lookup[normalize(fileName)] = value;
    }

    getValue(fileName: string): T | never {
        const f = normalize(fileName);
        if (f in this.lookup) {
            return this.lookup[f];
        } else {
            throw new Error(`No value corresponding to ${fileName} exists in this map`);
        }
    }

    getValueOrUndefined(fileName: string): T | undefined {
        const f = normalize(fileName);
        if (f in this.lookup) {
            return this.lookup[f];
        } else {
            return undefined;
        }
    }

    getValueOrDefault(fileName: string, defaultValue: T): T {
        const f = normalize(fileName);
        if (f in this.lookup) {
            return this.lookup[f];
        } else {
            return defaultValue;
        }
    }

    tryGetValue(fileName: string): [false, undefined] | [true, T] {
        const f = normalize(fileName);
        if (f in this.lookup) {
            return [true as true, this.lookup[f]];
        } else {
            return [false as false, undefined];
        }
    }
}
