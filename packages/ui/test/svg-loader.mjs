// Registers the SVG stub hooks for `node --import tsx --import ./test/svg-loader.mjs`.
// Vite serves `*.svg?react` as a React component; plain Node cannot load an
// `.svg` at all (ERR_UNKNOWN_FILE_EXTENSION), which took the render-smoke loop
// down the moment a checked component tree reached the registry icons.
import { register } from "node:module";
register("./svg-loader-hooks.mjs", import.meta.url);
