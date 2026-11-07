// The trust boundary of the P6 builder. The builder is bound to one Engine instance by the entry point (runtime/runner.mjs) through a
// module-private registry of the protected consumer. It is never imported by the Self-Repair subject closure, and it is not an Engine
// property a repair could set. Protected P5/P6 control code cannot be changed by an autonomous repair. These tests pin the boundary.
// Limitation (recorded as a residual, not tested as closed): the resolver is syntactic. It refuses loader and realm names written as
// identifiers, as string literals, as constant concatenations or templates, and it refuses with-statements, dynamic import, loaders,
// cluster, test, child builtins with subpaths, and reflection indexed through Object.values/getOwnPropertyDescriptors. It cannot
// resolve a key whose value is computed at run time (obj[key] where key is a variable or an array element), and the Engine's subject
// closure contains about 250 such accesses. Closing that class needs a runtime containment design (docs/adr/0011).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { importSpecifiers } from '../core/p5Gate.mjs';
import { P5_TRUSTED_CONTROL_PATHS, P6_PROTECTED_CONTROL_PATHS, assertP5HostBoundary } from '../core/p5HostBoundary.mjs';
import { bindTrustedP6Builder, hasTrustedP6Builder } from '../core/p6Consumer.mjs';

const repo = resolve(import.meta.dirname, '../..');
const read = path => readFileSync(join(repo, path), 'utf8');
const relativePath = path => path.split('\\').join('/');

// Every relative import reachable from a module, checked with the same strict resolver the Gate uses.
function subjectClosure(entry) {
  const closure = new Set();
  const queue = [entry];
  while (queue.length) {
    const path = queue.shift();
    if (closure.has(path)) continue;
    closure.add(path);
    for (const specifier of importSpecifiers(read(path), path)) {
      if (!specifier.startsWith('.')) continue;
      queue.push(relativePath(normalize(join(dirname(path), specifier))));
    }
  }
  return closure;
}

function runtimeSources(directory, found = []) {
  for (const name of readdirSync(join(repo, directory))) {
    const path = relativePath(join(directory, name));
    if (statSync(join(repo, path)).isDirectory()) runtimeSources(path, found);
    else if (/\.m?js$/.test(name) && !/\.test\.m?js$/.test(name)) found.push(path);
  }
  return found;
}

const refusal = source => {
  try { importSpecifiers(source, 'runtime/core/candidate-module.mjs'); return null; }
  catch (error) { return error.code ?? error.message; }
};

test('the builder and its control closure are in the attested trusted control set, and the protected subset is inside it', () => {
  for (const path of ['runtime/runner.mjs', 'runtime/core/p6Builder.mjs', 'runtime/core/p6Consumer.mjs', 'runtime/core/testFaultPolicy.mjs'])
    assert.ok(P5_TRUSTED_CONTROL_PATHS.includes(path), `${path} is in the trusted control closure the Host attests`);
  for (const path of P6_PROTECTED_CONTROL_PATHS) assert.ok(P5_TRUSTED_CONTROL_PATHS.includes(path), `${path} (protected) is attested`);
});

test('the Engine subject closure passes the strict P5 resolver and does not reach the builder', () => {
  const closure = subjectClosure('runtime/core/engine.mjs');
  assert.ok(closure.size > 10, 'the closure is the real Engine import graph');
  assert.equal(closure.has('runtime/core/p6Builder.mjs'), false, 'the builder is never in the subject closure');
  assert.equal(closure.has('runtime/runner.mjs'), false, 'the entry point is never in the subject closure');
});

test('the builder is bound only by the entry point; no Engine property supplies or is read for it', () => {
  const sources = runtimeSources('runtime').filter(path => !path.startsWith('runtime/tests/'));
  const binders = sources.filter(path => /\bbindTrustedP6Builder\s*\(/.test(read(path)) && !/export function bindTrustedP6Builder/.test(read(path)));
  assert.deepEqual(binders, ['runtime/runner.mjs'], 'only the entry point binds the builder');
  const importers = sources.filter(path => /from\s+['"][^'"]*p6Builder\.mjs['"]/.test(read(path)));
  assert.deepEqual(importers, ['runtime/runner.mjs'], 'no subject module imports the builder module');
  const propertyUse = sources.filter(path => /\.p6Builder\b|\bp6Builder\s*[:=]/.test(read(path)));
  assert.deepEqual(propertyUse, [], 'no source reads or writes an Engine p6Builder property');
});

test('a missing, duplicate or substituted builder binding is refused and an Engine property is never a builder', () => {
  const engine = { p6Builder: { buildAndAttestEnginePackage() {} } };
  assert.equal(hasTrustedP6Builder(engine), false, 'an Engine property with a builder is not a binding');
  assert.throws(() => bindTrustedP6Builder(engine, {}), { code: 'p6_builder_bind_invalid' }, 'a binding needs a builder function');
  bindTrustedP6Builder(engine, { buildAndAttestEnginePackage() {} });
  assert.equal(hasTrustedP6Builder(engine), true);
  assert.throws(() => bindTrustedP6Builder(engine, { buildAndAttestEnginePackage() {} }), { code: 'p6_builder_already_bound' }, 'a second binding is refused');
});

test('a missing builder is refused before the operation intent, the build and any staging', () => {
  const source = read('runtime/core/p6Consumer.mjs');
  const start = source.indexOf('export async function executeP6Activation(');
  const guard = source.indexOf("'p6_builder_unavailable'", start);
  assert.ok(start > 0 && guard > start, 'the guard is inside executeP6Activation');
  const beforeGuard = source.slice(start, guard);
  assert.doesNotMatch(beforeGuard, /store\.run\(|putJson\(|writeJson\(|getOrCreateP6Operation\(|persistP6SwitchAdmission\(|ensureCommandArtifact\(/,
    'nothing durable is written before the builder is checked');
  assert.doesNotMatch(beforeGuard, /\bawait\b/, 'no Host or Store round trip precedes the builder check');
  const intent = source.indexOf('getOrCreateP6Operation({', guard);
  const build = source.indexOf('buildAndAttestEnginePackage({', guard);
  assert.ok(intent > guard && build > guard, 'the operation intent and the build come after the guard');
  assert.match(source.slice(guard - 300, guard), /typeof buildAndAttestEnginePackage !== 'function'/, 'the guard tests the bound function itself');
});

test('a subject module cannot import the P6 consumer, the builder or the entry point (direct imports only; reflection is ADR-0011 residual R10)', () => {
  for (const specifier of ['./p6Consumer.mjs', '../core/p6Consumer.mjs', './core/p6Builder.mjs', './runner.mjs']) {
    assert.equal(refusal(`import { bindTrustedP6Builder } from '${specifier}';\nexport const x = bindTrustedP6Builder;\n`), 'p5_subject_resolver_unsupported',
      `${specifier} is refused as a subject import`);
  }
  assert.equal(refusal("export { bindTrustedP6Builder } from './p6Consumer.mjs';\n"), 'p5_subject_resolver_unsupported', 'a re-export of the consumer is refused');
  // node:test stays accepted: the P5 reproducer tests of a candidate import it, and the Gate applies this resolver to them.
  assert.equal(refusal("import t from 'node:test';\nexport const x = t;\n"), null, 'node:test is accepted');
  assert.equal(refusal("import { executeP6Activation } from './p6Scope.mjs';\nexport const x = executeP6Activation;\n"), null, 'an ordinary P6 helper is not a protected entry');
});

test('the Engine receives its P6 activation from the entry point and never imports the consumer', () => {
  const engine = read('runtime/core/engine.mjs');
  assert.doesNotMatch(engine, /from\s+['"][^'"]*p6Consumer\.mjs['"]/, 'engine.mjs has no import of the consumer');
  assert.match(engine, /p6_activation_unbound/, 'an unbound activation is a typed refusal');
  assert.match(read('runtime/runner.mjs'), /engine\.p6Activation = \(repairRunId, targetEngineBuildId\) => executeP6Activation\(/,
    'the entry point binds the activation');
});

test('the P6 scope refuses protected control paths under case variants, deletions included', async () => {
  const { classifyP6CandidateScope } = await import('../core/p6Scope.mjs');
  for (const path of ['runtime/core/p6Consumer.mjs', 'Runtime/Core/P6Consumer.mjs', 'runtime/runner.mjs']) {
    const verdict = classifyP6CandidateScope({ changes: [{ path, operation: 'modify' }] });
    assert.equal(verdict.supported, false, `${path} is not a supported P6 candidate change`);
    assert.equal(verdict.reason, 'p6_scope_protected_control', path);
  }
  const deletion = classifyP6CandidateScope({ changes: [{ path: 'runtime/runner.mjs', operation: 'delete' }] });
  assert.equal(deletion.reason, 'p6_scope_protected_control', 'a deletion of the entry point is refused');
  // A Windows 8.3 short name names the same file; the source path language refuses it before any scope or boundary check runs.
  const { validateP5SourcePath } = await import('../core/protectedSelfRepair.mjs');
  assert.throws(() => validateP5SourcePath('runtime/core/P6CONS~1.MJS'), { code: 'p5_path_unsupported' }, 'a short name is not a source path');
  assert.equal(validateP5SourcePath('runtime/core/p6Consumer.mjs'), 'runtime/core/p6Consumer.mjs');
});

test('the host boundary refuses protected paths under case variants, and the Engine stays repairable', () => {
  // The reason must be the protected one: a case variant must not be reported through another rule that happens to refuse it first.
  for (const variant of ['runtime/CORE/P6Consumer.mjs', 'Runtime/Core/P6Consumer.mjs', 'runtime/RUNNER.MJS']) {
    assert.throws(() => assertP5HostBoundary({ changes: [variant] }), (error) => error.code === 'p5_host_boundary_violation'
      && /protected_control_module/.test(error.message), `${variant} is refused as protected`);
  }
  assert.equal(assertP5HostBoundary({ changes: ['runtime/core/engine.mjs'] }).checked, 1, 'engine.mjs remains repairable');
});

test('the protected control modules cannot be changed by a Self-Repair candidate; the repairable Engine can', () => {
  for (const path of P6_PROTECTED_CONTROL_PATHS) {
    assert.throws(() => assertP5HostBoundary({ changes: [path] }), { code: 'p5_host_boundary_violation' }, `${path} is refused`);
  }
  assert.throws(() => assertP5HostBoundary({ changes: [{ path: 'runtime/core/p6Consumer.mjs' }] }), { code: 'p5_host_boundary_violation' },
    'a change object is refused as well as a path');
  assert.deepEqual(assertP5HostBoundary({ changes: ['runtime/core/engine.mjs', 'runtime/core/linkedRepair.mjs'] }).checked, 2,
    'the Engine source that repairs may change is accepted');
});

test('the builder dependencies on the activation path are protected or attested policy, nothing else', () => {
  const allowed = new Set([...P6_PROTECTED_CONTROL_PATHS, 'runtime/core/engineRoot.mjs', 'runtime/core/p5HostBoundary.mjs', 'runtime/core/p5Support.mjs']);
  const closure = new Set();
  const queue = ['runtime/core/p6Consumer.mjs', 'runtime/core/p6Builder.mjs'];
  while (queue.length) {
    const path = queue.shift();
    if (closure.has(path) || !path.startsWith('runtime/core/')) continue;
    closure.add(path);
    // The builder itself is outside the subject closure and may use the loader, so its imports are read as text, not resolved.
    for (const [, specifier] of read(path).matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) queue.push(relativePath(normalize(join(dirname(path), specifier))));
  }
  const unlisted = [...closure].filter(path => !allowed.has(path));
  assert.deepEqual(unlisted, [], 'every runtime/core module the builder or consumer depends on is protected or attested policy');
});

test('the strict resolver refuses module-loader, realm and reflective constructs in any subject module', () => {
  const cases = {
    'a loader import': "import { createRequire } from 'node:module';\nexport const r = createRequire(import.meta.url);\n",
    'a dynamic import': "export const load = async () => await import('./p6Builder.mjs');\n",
    'import.meta.resolve': "export const where = import.meta.resolve('./p6Builder.mjs');\n",
    'import.meta resolve by computed name': "export const where = import.meta['resolve'];\n",
    'an alias of import.meta': "const meta = import.meta;\nexport const where = meta.resolve;\n",
    'an alias of import.meta by a second name': "const m = import.meta;\nexport const r = m.resolve;\n",
    'a code evaluator': "export const run = () => eval('1');\n",
    'the Function constructor': "export const make = () => new Function('return 1');\n",
    'the main-module loader': "export const loader = process.mainModule;\n",
    'an optional constructor': "export const F = (() => {})?.constructor;\n",
    'a destructured constructor': "export const { constructor: F } = () => {};\n",
    'a constructor key in a binding pattern as a string': "export const { 'constructor': F } = () => {};\n",
    'a constructor key assembled from constants': "export const F = (() => {})['con' + 'structor'];\n",
    'a template key assembled from constants': "export const F = (() => {})[`con${''}structor`];\n",
    'a constructor name held in a constant': "const k = 'constructor';\nexport const F = (() => {})[k];\n",
    'an array element naming the constructor': "export const F = (() => {})[['constructor'][0]];\n",
    'a descriptor read of constructor': "export const F = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => {}), 'constructor').value;\n",
    'a reflective index into Object.values': "export const F = Object.values(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(() => {})))[4].value;\n",
    'a reflective index into Object.entries': "export const F = Object.entries(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(() => {})))[4][1].value;\n",
    'a with statement': "export const F = () => { with ({}) { return 1; } };\n",
    'a default import of the process builtin': "import p from 'node:process';\nexport const b = p.binding;\n",
    'a namespace import of the inspector builtin': "import * as i from 'node:inspector';\nexport const s = i;\n",
    'a subpath of the inspector builtin': "import { Session } from 'node:inspector/promises';\nexport const s = Session;\n",
    'the cluster builtin': "import c from 'node:cluster';\nexport const x = c;\n",
    'a CommonJS source label': null,
    'a constructor chain to Function': "export const make = () => (() => {}).constructor(\"return process.getBuiltinModule('node:module')\")();\n",
    'an evaluator named by a string on a realm alias': "const g = globalThis;\nexport const G = g['Function'];\n",
    'an alias of globalThis': "const g = globalThis;\nexport const p = g.process;\n",
    'an alias of process': "const p = process;\nexport const b = p.binding;\n",
    'process destructured to a loader': "const { binding } = process;\nexport const b = binding;\n",
    'Reflect': "export const r = Reflect.construct;\n",
    'the stack-trace hook': "Error.prepareStackTrace = (error, frames) => frames[0].getThis();\n",
    'CommonJS module binding': "export const m = module;\n",
  };
  for (const [description, source] of Object.entries(cases)) {
    if (source === null) {
      assert.throws(() => importSpecifiers('x', 'runtime/core/probe.cjs'), { code: 'p5_subject_resolver_unsupported' }, description);
      continue;
    }
    assert.equal(refusal(source), 'p5_subject_resolver_unsupported', `${description} is refused by the subject resolver`);
  }
  const accepted = {
    'ordinary builtin import': "import { EventEmitter } from 'node:events';\nexport const e = new EventEmitter();\n",
    'the process members the Engine reads': "export const env = process.env.PATH, platform = process.platform, code = process.exit;\n",
    'import.meta url, dirname and filename': "export const here = [import.meta.url, import.meta.dirname, import.meta.filename];\n",
    'a local binding named process': "export const read = process => process.binding;\n",
    'a directory name as a string': "export const dir = 'exports';\n",
    'safe loader bindings': "import { builtinModules, isBuiltin } from 'node:module';\nexport const s = [builtinModules, isBuiltin];\n",
    'a class constructor method': "export class A { constructor(x) { this.x = x; } }\n",
  };
  for (const [description, source] of Object.entries(accepted)) assert.equal(refusal(source), null, `${description} stays accepted`);
});
