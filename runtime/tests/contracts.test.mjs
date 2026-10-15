import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { check } from '../core/schemas.mjs';
import { semanticIssues, capabilityIssues } from '../core/validate.mjs';
import { mapIssues, sectionIssues } from '../core/map.mjs';
import { parseStrictJson, canonicalize } from '../core/canonical.mjs';

const root = resolve(import.meta.dirname, '../..');
const read = file => parseStrictJson(readFileSync(resolve(root, file), 'utf8'));
const pointer = (value, path) => !path ? value : path.slice(1).split('/').reduce((current, part) => {
  part = part.replaceAll('~1', '/').replaceAll('~0', '~');
  return Array.isArray(current) ? current[Number(part)] : current[part];
}, value);

function materialize(item) {
  const value = structuredClone(pointer(read(item.source.file), item.source.pointer || ''));
  for (const change of item.mutations || []) {
    const at = change.path.lastIndexOf('/');
    const parent = pointer(value, change.path.slice(0, at));
    const key = change.path.slice(at + 1).replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(parent)) {
      if (change.op === 'add') parent.splice(key === '-' ? parent.length : Number(key), 0, structuredClone(change.value));
      else if (change.op === 'remove') parent.splice(Number(key), 1);
      else parent[Number(key)] = structuredClone(change.value);
    } else if (change.op === 'remove') delete parent[key];
    else parent[key] = structuredClone(change.value);
  }
  return value;
}

// Map and section fixtures run through the runtime validators against the round-recovery index and role fixtures.
const INDEX = read('docs/examples/round-recovery/spec-index.json');
const ROLES = read('docs/fixtures/roles.json');
function semantic(item, value) {
  if (item.semantic === undefined) return [];
  if (item.semantic === 'workflow') return semanticIssues(value, { maximumAgentTimeoutSeconds: item.maximumAgentTimeoutSeconds ?? 600 }).map(issue => issue.code);
  if (item.semantic === 'capabilities') return capabilityIssues(value).map(issue => issue.code);
  if (item.semantic === 'sections') return sectionIssues(value).map(issue => issue.code);
  if (item.semantic === 'map') return [...sectionIssues(INDEX), ...mapIssues(value, INDEX, [], { registry: ROLES })].map(issue => issue.code);
  throw new Error(`Fixture ${item.id} names unsupported semantic validator "${item.semantic}".`);
}

const manifest = read('docs/fixtures/manifest.json');
const cases = [...manifest.valid, ...read(manifest.invalidFixture)];
const supported = new Set(['workflow', 'capabilities', 'sections', 'map', undefined]);

for (const item of cases) {
  test(`fixture ${item.id}`, () => {
    const value = materialize(item);
    const structural = check(item.schema, item.definition, value);
    if (item.expected === 'valid') {
      assert.deepEqual(structural, [], 'structurally valid');
      if (supported.has(item.semantic)) assert.deepEqual(semantic(item, value), []);
    } else if (item.phase === 'schema') {
      assert.ok(structural.length > 0, 'expected a structural rejection');
    } else {
      assert.ok(supported.has(item.semantic) && item.semantic !== undefined, `semantic fixture ${item.id} needs a runtime validator`);
      assert.deepEqual(structural, [], 'semantic cases must pass the schema first');
      const codes = semantic(item, value);
      assert.ok(codes.includes(item.code), `expected ${item.code}, got ${JSON.stringify(codes)}`);
    }
  });
}

test('strict JSON rejects duplicate keys and lone surrogates; JCS sorts keys', () => {
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), /Duplicate/);
  assert.throws(() => parseStrictJson('"\\ud800"'), /surrogate/);
  assert.throws(() => parseStrictJson('[1,]'));
  assert.equal(canonicalize({ b: 1, a: [true, null, 'x'], c: { z: 1.5, y: -0 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":1.5}}');
});
