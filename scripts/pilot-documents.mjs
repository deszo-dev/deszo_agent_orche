// Read-only checks for the documents authored in the live pilot workspace.
import assert from 'node:assert/strict';
import { check } from '../runtime/core/schemas.mjs';
import { parseSections } from '../runtime/core/gate.mjs';
import { sectionIssues, mapIssues } from '../runtime/core/map.mjs';

export function validatePilotDocuments(text, index, map, roles) {
  for (const [name, data] of [['spec-section-index.schema.json', index], ['implementation-map.schema.json', map]]) {
    const problems = check(name, null, data);
    assert.equal(problems.length, 0, JSON.stringify(problems));
  }
  const headings = parseSections(text);
  const indexed = new Set(index.sections.map(section => section.id));
  for (const id of indexed) assert.ok(headings.has(id), `Missing heading ${id}`);
  for (const id of headings.keys()) assert.ok(indexed.has(id), `Unindexed heading ${id}`);
  const problems = [...sectionIssues(index), ...mapIssues(map, index, roles)];
  assert.equal(problems.length, 0, JSON.stringify(problems));
}

export function pilotValidatorSource(roles) {
  return [
    "import {readFileSync} from 'node:fs';",
    `import {parseStrictJson} from ${JSON.stringify(new URL('../runtime/core/canonical.mjs', import.meta.url).href)};`,
    `import {validatePilotDocuments} from ${JSON.stringify(import.meta.url)};`,
    `validatePilotDocuments(readFileSync('SPEC.md','utf8'),parseStrictJson(readFileSync('spec-index.json','utf8')),parseStrictJson(readFileSync('implementation-map.json','utf8')),${JSON.stringify(roles)});`,
    "console.log('Pilot documentation contracts passed.');",
    '',
  ].join('\n');
}
