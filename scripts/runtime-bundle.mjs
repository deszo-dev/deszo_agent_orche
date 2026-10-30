// The packaged Engine bundle (`dist-runtime/runner.mjs`). Kept free of side effects so the desktop release packager can
// rebuild the bundle from the attested P5 support payload and require byte equality with the shipped one (P5-CLOSURE §5.3).
import { build } from 'esbuild';

// The bundled TypeScript pre-processor (P5 Gate import scanning) reads __filename at module initialization.
export const RUNNER_BANNER = "import { createRequire as __createRequire } from 'node:module'; import {fileURLToPath as __runnerFileURLToPath} from 'node:url'; import {dirname as __runnerDirname} from 'node:path'; const require = __createRequire(import.meta.url); const __filename=__runnerFileURLToPath(import.meta.url), __dirname=__runnerDirname(__filename);";

// TypeScript is used only by P5 subject and Host-closure analysis. The bundle loads it on first use from the release's
// attested P5 support payload (`<release>/p5/node_modules/typescript`) instead of carrying a second copy of it, so a desktop
// release without a payload never loads it and P5 stays closed there (verifyP5PackageLayout).
const TYPESCRIPT_FROM_P5_SUPPORT = `import { createRequire as __p5CreateRequire } from 'node:module';
import { fileURLToPath as __p5FileURLToPath } from 'node:url';
import { dirname as __p5Dirname, join as __p5Join } from 'node:path';
let loaded = null;
const load = () => loaded ??= __p5CreateRequire(__p5Join(__p5Dirname(__p5FileURLToPath(import.meta.url)), '..', 'p5', 'package.json'))('typescript');
export default new Proxy({}, { get: (_target, key) => load()[key] });
`;

const packagedRunner = root => ({
  name: 'deszo-packaged-runner',
  setup(builder) {
    builder.onResolve({ filter: /^typescript$/ }, () => ({ path: 'typescript', namespace: 'deszo-p5-support' }));
    builder.onLoad({ filter: /.*/, namespace: 'deszo-p5-support' }, () => ({ contents: TYPESCRIPT_FROM_P5_SUPPORT, loader: 'js', resolveDir: root }));
    // The fixture adapters are reachable only with --fixture-state, which a packaged runtime refuses; they never ship.
    builder.onResolve({ filter: /[\\/]fixture-adapters\.mjs$/ }, args => ({ path: args.path, external: true }));
  },
});

export async function bundleRunner({ root, outfile }) {
  await build({
    entryPoints: [`${root}/runtime/runner.mjs`], outfile, absWorkingDir: root,
    bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none',
    banner: { js: RUNNER_BANNER }, define: { __DESZO_PACKAGED__: 'true' }, plugins: [packagedRunner(root)],
  });
}
