import { normalize } from 'path';

export const __ = createDependencyMapper();
export type Mapper = typeof __;

export function createDependencyMapper() {
    const childToParents: { [key: string]: string[] } = {};
    const parentToChildren: { [key: string]: string[] } = {};
    const allKeys: string[] = [];

    function addReference(childConfigFileName: string, parentConfigFileName: string): void {
        addEntry(childToParents, childConfigFileName, parentConfigFileName);
        addEntry(parentToChildren, parentConfigFileName, childConfigFileName);
    }

    function getReferencesTo(parentConfigFileName: string): string[] {
        return parentToChildren[normalize(parentConfigFileName)] || [];
    }

    function getReferencesOf(childConfigFileName: string): string[] {
        return childToParents[normalize(childConfigFileName)] || [];
    }

    function getKeys(): ReadonlyArray<string> {
        return allKeys;
    }

    function addEntry(mapToAddTo: typeof childToParents | typeof parentToChildren, key: string, element: string) {
        key = normalize(key);
        element = normalize(element);
        const arr = (mapToAddTo[key] = mapToAddTo[key] || []);
        if (arr.indexOf(element) < 0) {
            arr.push(element);
        }
        if (allKeys.indexOf(key) < 0) allKeys.push(key);
        if (allKeys.indexOf(element) < 0) allKeys.push(element);
    }

    return {
        addReference,
        getReferencesTo,
        getReferencesOf,
        getKeys
    };
}
