// Bundles the Node runtime (with Ajv and the documented JSON Schemas) for the Tauri release.
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
copyFileSync(resolve(root, 'docs/storage/m1.sql'), resolve(out, 'm1.sql'));
copyFileSync(resolve(root, 'docs/storage/m2.sql'), resolve(out, 'm2.sql'));
copyFileSync(resolve(root, 'docs/storage/m3.sql'), resolve(out, 'm3.sql'));
copyFileSync(resolve(root, 'docs/storage/m4.sql'), resolve(out, 'm4.sql'));
copyFileSync(resolve(root, 'docs/storage/m5.sql'), resolve(out, 'm5.sql'));
copyFileSync(resolve(root, 'docs/storage/m6.sql'), resolve(out, 'm6.sql'));
copyFileSync(resolve(root, 'docs/storage/m7.sql'), resolve(out, 'm7.sql'));
copyFileSync(resolve(root, 'docs/storage/m8.sql'), resolve(out, 'm8.sql'));
copyFileSync(resolve(root, 'docs/storage/m9.sql'), resolve(out, 'm9.sql'));
copyFileSync(resolve(root, 'docs/storage/m10.sql'), resolve(out, 'm10.sql'));
copyFileSync(resolve(root, 'docs/storage/m11.sql'), resolve(out, 'm11.sql'));
console.log(`Runtime bundled into ${out}`);
