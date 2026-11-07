// P6-R10-CLOSE reproduction probe (2026-11-05). Run from the repository root with the real runtime modules:
//   node docs/reviews/evidence/2026-11-05-r10/r10-probe.mjs
//   node --disallow-code-generation-from-strings docs/reviews/evidence/2026-11-05-r10/r10-probe.mjs
// It stands in for the entry point (runner.mjs) by binding a trusted builder to a stub Engine, then plays the role of
// a repairable subject that reaches protected modules only by reflection. It touches no Store, Host or installation.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import * as staticConsumer from '../../../../runtime/core/p6Consumer.mjs';
import { buildAndAttestEnginePackage as staticBuilderFn } from '../../../../runtime/core/p6Builder.mjs';

const root = resolve('.');
const consumerUrl = pathToFileURL(resolve(root, 'runtime/core/p6Consumer.mjs')).href;
const builderUrl = pathToFileURL(resolve(root, 'runtime/core/p6Builder.mjs')).href;
const flags = process.execArgv.join(' ') || '(default)';
const out = [];
const log = (level, text) => out.push(`${level.padEnd(12)} ${text}`);
const stubStore = { get: () => undefined };

// Entry-point stand-in: the trusted binding the real runner.mjs makes after construction.
const trustedEngine = { store: stubStore };
staticConsumer.bindTrustedP6Builder(trustedEngine, { buildAndAttestEnginePackage: staticBuilderFn });

// R10 expression, copied from docs/reviews/evidence/2026-11-05-dynamic-keys/reflection-routes-probe.txt.
let F = null;
try {
  const d = Object.getOwnPropertyDescriptors(Object.getPrototypeOf(() => {}));
  const vals = Object.values(d);
  F = vals[4].value;
  log('reach-fn', `Function reached by reflection: ${typeof F} ${F?.name}`);
} catch (error) { log('reach-fn', `reflection refused: ${error.name}: ${error.message}`); }

let reflectedConsumer = null;
if (F) {
  try {
    const load = F('u', 'return import(u)');
    reflectedConsumer = await load(consumerUrl);
    log('R10-0/1', `module resolved and evaluated through reflected Function: keys=${Object.keys(reflectedConsumer).length}`);
    log('R10-1', `same module instance as the entry point: ${reflectedConsumer === staticConsumer}`);
    log('R10-1', `reflected consumer shares the trusted registry: ${reflectedConsumer.hasTrustedP6Builder(trustedEngine)}`);
  } catch (error) { log('R10-0/1', `dynamic import refused: ${error.code || error.name}: ${error.message}`); }
} else {
  log('R10-0/1', 'not reached: Function unavailable (route closed by the flag)');
}

// R10-2: a reflected instance can bind a builder to any object, because the registry is keyed only by object identity.
if (reflectedConsumer) {
  const attacker = { store: stubStore };
  const spy = async () => { throw new Error('spy builder invoked'); };
  try {
    reflectedConsumer.bindTrustedP6Builder(attacker, { buildAndAttestEnginePackage: spy });
    log('R10-2', `second Engine-like object bound with a candidate builder: ${reflectedConsumer.hasTrustedP6Builder(attacker)}`);
  } catch (error) { log('R10-2', `bind refused: ${error.code}`); }
  try {
    reflectedConsumer.bindTrustedP6Builder(trustedEngine, { buildAndAttestEnginePackage: spy });
    log('R10-2', 'rebind of the trusted Engine: accepted (unexpected)');
  } catch (error) { log('R10-2', `rebind of the trusted Engine refused: ${error.code}`); }

  // R10-3: an unaccepted run cannot reach the builder. The refusal is the consumer's P5 acceptance check, not the import rule.
  try {
    await reflectedConsumer.executeP6Activation({ engine: attacker, repairRunId: 'unaccepted-run' });
    log('R10-3', 'activation returned without refusal (unexpected)');
  } catch (error) { log('R10-3', `unaccepted activation refused before the builder: ${error.code}`); }
}

// R10-2 (builder export): the protected builder module is reachable and its export is callable with no caller check.
if (F) {
  try {
    const load = F('u', 'return import(u)');
    const builderModule = await load(builderUrl);
    log('R10-2', `builder export reached: ${typeof builderModule.buildAndAttestEnginePackage} same instance=${builderModule.buildAndAttestEnginePackage === staticBuilderFn}`);
    await builderModule.buildAndAttestEnginePackage({});
  } catch (error) { log('R10-2', `builder export invoked; it refused its own input: ${error.code}`); }
}

// Routes that do not use the Function constructor, for the flag control.
try {
  const vm = globalThis.process.getBuiltinModule('node:vm');
  const value = vm.runInThisContext('1 + 41');
  log('vm-route', `vm.runInThisContext string evaluation: ${value}`);
} catch (error) { log('vm-route', `vm string evaluation refused: ${error.code || error.name}`); }
try {
  const req = globalThis.process.getBuiltinModule('node:module').createRequire(import.meta.url);
  const viaRequire = req(resolve(root, 'runtime/core/p6Consumer.mjs'));
  log('req-route', `require(esm) of the protected consumer: same instance=${viaRequire === staticConsumer}`);
} catch (error) { log('req-route', `require(esm) refused: ${error.code || error.name}: ${error.message}`); }

console.log(`R10 probe, Node ${process.version}, flags: ${flags}`);
for (const line of out) console.log(line);
