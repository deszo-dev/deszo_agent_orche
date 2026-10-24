// Bundles the Node runtime (with Ajv and the documented JSON Schemas) for the Tauri release.
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MIGRATION_FILES } from '../runtime/core/migrations.mjs';
import { writeRuntimeManifest } from './deszo-artifacts.mjs';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'dist-runtime');
// The launch shim is built by `npm run shim:build` and is not part of this bundle. Keep it across the rebuild, so
// running this script alone cannot leave a packaged app without the shim it refuses to start without.
const shimPath = resolve(out, 'deszo-launch-shim.exe');
const keptShim = existsSync(shimPath) ? readFileSync(shimPath) : null;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
if (keptShim) writeFileSync(shimPath, keptShim);
else console.warn('dist-runtime has no launch shim: run `npm run shim:build` before packaging, or the app will refuse to start.');
await build({
  entryPoints: [resolve(root, 'runtime/runner.mjs')], outfile: resolve(out, 'runner.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  define: { __DESZO_PACKAGED__: 'true' },
});
await build({
  entryPoints: [resolve(root, 'mcp/bridge.mjs')], outfile: resolve(out, 'bridge.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
// ADR-0006 Local Control Host: a separate entry with its own store migration, never part of the application store.
await build({
  entryPoints: [resolve(root, 'runtime/host/main.mjs')], outfile: resolve(out, 'host.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
copyFileSync(resolve(root, 'docs/storage/host-h1.sql'), resolve(out, 'host-h1.sql'));
copyFileSync(resolve(root, 'docs/storage/host-h2.sql'), resolve(out, 'host-h2.sql'));
copyFileSync(resolve(root, 'docs/storage/host-h3.sql'), resolve(out, 'host-h3.sql'));
copyFileSync(resolve(root, 'docs/storage/host-h4.sql'), resolve(out, 'host-h4.sql'));
copyFileSync(resolve(root, 'docs/storage/host-h5.sql'), resolve(out, 'host-h5.sql'));
await build({
  entryPoints: [resolve(root, 'runtime/host/worker.mjs')], outfile: resolve(out, 'worker.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
await build({
  entryPoints: [resolve(root, 'runtime/host/serviceRuntime.mjs')], outfile: resolve(out, 'service-runtime.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; import {fileURLToPath as __hostFileURLToPath} from 'node:url'; import {dirname as __hostDirname} from 'node:path'; const require = __createRequire(import.meta.url); const __filename=__hostFileURLToPath(import.meta.url), __dirname=__hostDirname(__filename);" },
});
for (const file of MIGRATION_FILES) copyFileSync(resolve(root, 'docs/storage', file), resolve(out, file));
// Importing the private backend with EOF initializes no installation/store. This catches bundled dependency/ESM
// failures before an updater can replace the working authority with a non-starting artifact.
const serviceImport=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',resolve(out,'service-runtime.mjs')],{input:'',encoding:'utf8',windowsHide:true,timeout:15000});
if(serviceImport.status!==0)throw new Error(`The bundled protected backend cannot initialize: ${serviceImport.stderr}`);
console.log(`Runtime bundled into ${out}`);
writeRuntimeManifest(out);
