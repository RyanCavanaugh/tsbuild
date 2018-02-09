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
