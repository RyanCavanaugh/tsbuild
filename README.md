# tsbuild: A Reference Implementation for TypeScript Composite Project Build Orchestration

## Installation

> `npm install -g @ryancavanaugh/tsbuild`

## Usage Examples

> `tsbuild`

Recursively look for `tsconfig.json` files in the current directory and build all of them.

> `tsbuild --dry`

Show what would be built.

> `tsbuild -p tsconfig_src.json -p tsconfig_tests.json` 

Build exactly these two projects.

## Options

```
  --help       Show help                                  
  --version    Show version number                        
  --watch, -w  Watch mode                                 
  --dry, -d    Dry mode: Show what would be built and exit
  --force, -f  Force rebuild of all projects              
  --viz        Render a project dependency graph
```

# Dogfooding Instructions

### Installation

 > `npm install -g @ryancavanaugh/tsbuild`

### Running

Once you've `npm install`ed, you can run `tsbuild` from the commandline.
See usage info above.

### Language Service Dogfooding

This is a bit more involved. You can do the following:

> ```
> git clone https://github.com/RyanCavanaugh/TypeScript.git
> cd TypeScript
> git checkout projectReferences
> npm install
> npm install -g jake
> jake local
> ```

Once this is done, you can point VS Code's TypeScript install to the /built/local folder of the enlistment root:
```
    "typescript.tsdk": "C:/github/TypeScript/built/local/",
    "typescript.tsdk_version": "2.6.0", 
```
Then select this version using the "TypeScript: Select TypeScript Version" command while a .ts file is open.

### Setup

The main thing to do is to add a 'references' block to your tsconfig file:
```ts
    "references": [
      { "path": "../otherProj" }
    ]
```
Each element in the array points to a `tsconfig` file or a folder containing a file named `tsconfig.json`.

The demo repo https://github.com/RyanCavanaugh/project-references-demo-2 is a buildable example that uses project references to set up a dozen projects in a complex graph.

You'll also need to set `{ "composite": true }` in any referenced tsconfig file.

### Feedback

Please include the full version number (printed at the top of every invocation) with any bug reports. I'll be publishing updates to the NPM package as I fix things / add features, so you may want to run 'npm update -g @ryancavanaugh/tsbuild' every so often to pick up the latest build.

# Changelog and Backlog

### Upcoming work

 * [ ] Reduce I/O on tsconfig.json files - current implementation reads these from disk more than once per build
 * [ ] (TS) remove restriction on zero-input-file compilations
 * [ ] Figure out what to do with `stripInternal`
 * [ ] Figure out what to do with declaration bundling in `prepend`+`outFile` combinations

### Release Log

 * 0.1.5
   * Implements pseduobuilds
     * A pseudobuild (PB) occurs when an upstream project is rebuilt but doesn't change its .d.ts. When this happens, downstream projects' outputs are 'touched' to the current time.
     * PBs are not enabled for `outFile` compilations because the output JS file still needs to be updated (TODO: we can allow this if there are no `prepend` references)
 * 0.1.4
     * Initial release
