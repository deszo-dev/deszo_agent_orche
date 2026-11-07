// The installed control root P5 attests and verifies against. A runtime-bootstrap release runs its source layout directly,
// so the root is the release itself. A bundled desktop release runs `runtime/runner.mjs` (one esbuild file) and ships the
// same attested source layout and dependency closure beside it as its P5 support payload, `p5/`.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENGINE_PACKAGED = typeof __DESZO_PACKAGED__ !== 'undefined' && __DESZO_PACKAGED__;
export const P5_SUPPORT_ROOT_NAME = 'p5';
// In the bundle every inlined module shares the bundle's URL, `<release>/runtime/runner.mjs`.
export const RUNNING_ENGINE_FILE = fileURLToPath(import.meta.url);
const here = dirname(RUNNING_ENGINE_FILE);
/** The installed release directory (the Host's `versions/<build>`), which no repair workspace may overlap. */
export const ENGINE_RELEASE_ROOT = resolve(here, ENGINE_PACKAGED ? '..' : '../..');
export const ENGINE_ROOT = ENGINE_PACKAGED ? resolve(ENGINE_RELEASE_ROOT, P5_SUPPORT_ROOT_NAME) : ENGINE_RELEASE_ROOT;
