// Control: which reflection-free routes survive --disallow-code-generation-from-strings. Run from the repository root.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import * as direct from './flag-target.mjs';
const target = resolve('docs/reviews/evidence/2026-11-05-r10/flag-target.mjs');
const lines = [`Node ${process.version} flags: ${process.execArgv.join(' ') || '(default)'}`];
try {
  const F = Object.values(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(() => {})))[4].value;
  lines.push(`R10 Function route: ${F('return 1 + 1')()}`);
} catch (error) { lines.push(`R10 Function route refused: ${error.name}`); }
try {
  const vm = globalThis.process.getBuiltinModule('node:vm');
  lines.push(`vm.runInThisContext: ${vm.runInThisContext('1 + 41')}`);
} catch (error) { lines.push(`vm.runInThisContext refused: ${error.code || error.name}`); }
try {
  const req = globalThis.process.getBuiltinModule('node:module').createRequire(import.meta.url);
  const viaRequire = req(target);
  lines.push(`require(esm) same instance: ${viaRequire === direct}; ping=${viaRequire.ping()}`);
} catch (error) { lines.push(`require(esm) refused: ${error.code || error.name}`); }
try {
  const load = globalThis.process.getBuiltinModule('node:module').createRequire(import.meta.url);
  lines.push(`createRequire available: ${typeof load}`);
} catch (error) { lines.push(`createRequire refused: ${error.name}`); }
console.log(lines.join('\n'));
