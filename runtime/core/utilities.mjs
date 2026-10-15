import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { canonicalize } from './canonical.mjs';
import { assertValid, compileOutputSchema } from './schemas.mjs';
import { normalizedRelative } from './validate.mjs';

export const FILE_LIMIT = 16 * 1024 * 1024;
export const SET_LIMIT = 64 * 1024 * 1024;

export class UtilityError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const ref = artifact => ({ artifactId: artifact.artifactId, sha256: artifact.sha256 });
export const textValue = artifact => ({ type: 'Text', artifact: ref(artifact), encoding: 'utf-8' });
export const jsonValue = artifact => ({ type: 'JsonValue', artifact: ref(artifact) });
export const setValue = artifact => ({ type: 'ArtifactSet', artifact: ref(artifact) });

export function resolvePointer(value, pointer) {
  if (pointer === '') return { found: true, value };
  let current = value;
  for (const raw of pointer.slice(1).split('/')) {
    const part = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(part) || Number(part) >= current.length) return { found: false };
      current = current[Number(part)];
    } else if (current && typeof current === 'object' && Object.hasOwn(current, part)) current = current[part];
    else return { found: false };
  }
  return { found: true, value: current };
}

// Value helpers bound to one store.
export function values(store) {
  const readValue = value => {
    store.verifyRef(value.artifact);
    if (value.type === 'Text') return store.readText(value.artifact.artifactId);
    if (value.type === 'JsonValue') return store.readJson(value.artifact.artifactId);
    return readManifest(value.artifact);
  };
  const readManifest = artifact => {
    store.verifyRef(artifact);
    const manifest = store.readJson(artifact.artifactId);
    assertValid('value.schema.json', 'artifactSetManifest', manifest, 'ArtifactSet manifest');
    return manifest;
  };
  const putSet = (entries, sources = []) => {
    const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const manifest = { schemaVersion: 1, kind: 'ArtifactSet', entries: sorted, ...(sources.length ? { sources } : {}) };
    assertValid('value.schema.json', 'artifactSetManifest', manifest, 'ArtifactSet manifest');
    return setValue(store.putJson(manifest));
  };
  const make = (type, data) => {
    if (type === 'Text') return textValue(store.putText(data));
    if (type === 'JsonValue') return jsonValue(store.putJson(data));
    throw new UtilityError('output_contract', `Cannot create ${type} from data.`);
  };
  return { readValue, readManifest, putSet, make };
}

// Reads normalized relative paths from a directory, rejecting escapes after symlink resolution.
export function captureFiles(store, cwd, paths, missingCode) {
  const root = realpathSync.native(cwd);
  const fold = value => (process.platform === 'win32' ? value.toLowerCase() : value);
  const base = fold(root);
  const entries = []; let total = 0;
  for (const path of paths) {
    const normalized = normalizedRelative(path);
    if (!normalized) throw new UtilityError('output_contract', `"${path}" is not a normalized relative path.`);
    const absolute = join(root, ...normalized.split('/'));
    let real;
    try { lstatSync(absolute); real = realpathSync.native(absolute); }
    catch { throw new UtilityError(missingCode, `File "${normalized}" does not exist in the workspace.`); }
    const target = fold(real);
    if (!(target === base || target.startsWith(base.endsWith(sep) ? base : base + sep))) throw new UtilityError(missingCode, `"${normalized}" resolves outside the workspace.`);
    const stat = statSync(real);
    if (!stat.isFile()) throw new UtilityError(missingCode, `"${normalized}" is not a regular file.`);
    if (stat.size > FILE_LIMIT) throw new UtilityError(missingCode, `"${normalized}" exceeds the 16 MiB file limit.`);
    total += stat.size;
    if (total > SET_LIMIT) throw new UtilityError(missingCode, 'The selected files exceed the 64 MiB set limit.');
    const bytes = readFileSync(real);
    const artifact = store.putBytes(bytes, 'application/octet-stream');
    entries.push({ path: normalized, artifact: ref(artifact), byteSize: bytes.length, mediaType: 'application/octet-stream' });
  }
  return entries;
}

// Deterministic, side-effect-free utilities. `inputs` maps port IDs to committed value references.
export function runUtility({ store, node, inputs, cwd }) {
  const { readValue, readManifest, putSet, make } = values(store);
  const config = node.config;
  switch (node.type) {
    case 'file-input': {
      if (config.mode === 'files') return { value: putSet(captureFiles(store, cwd, config.paths, 'input_unavailable')) };
      const row = store.artifactRow(config.artifact.artifactId);
      if (!row || row.sha256 !== config.artifact.sha256) throw new UtilityError('input_unavailable', 'The pinned artifact is not available with the recorded digest.');
      store.verifyRef(config.artifact);
      if (config.valueType === 'Text') {
        if (!row.media_type.startsWith('text/')) throw new UtilityError('input_unavailable', `The pinned artifact is ${row.media_type}, not text.`);
        return { value: textValue(config.artifact) };
      }
      if (row.media_type !== 'application/json') throw new UtilityError('input_unavailable', `The pinned artifact is ${row.media_type}, not JSON.`);
      if (config.valueType === 'ArtifactSet') { readManifest(config.artifact); return { value: setValue(config.artifact) }; }
      store.readJson(config.artifact.artifactId);
      return { value: jsonValue(config.artifact) };
    }
    case 'merge': {
      if (config.mode === 'text') return { value: make('Text', config.inputs.map(input => readValue(inputs[input.id])).join(config.separator)) };
      if (config.mode === 'artifacts') {
        const byPath = new Map(), sources = [];
        for (const input of config.inputs) {
          const manifest = readManifest(inputs[input.id].artifact);
          sources.push({ input: input.id, manifest: ref(inputs[input.id].artifact) });
          for (const entry of manifest.entries) {
            const existing = byPath.get(entry.path);
            if (existing && existing.artifact.sha256 !== entry.artifact.sha256) throw new UtilityError('output_contract', `Path "${entry.path}" has different content in two inputs; no last-writer-wins.`);
            if (!existing) byPath.set(entry.path, entry);
          }
        }
        return { value: putSet([...byPath.values()], sources) };
      }
      const record = {};
      for (const field of config.fields) {
        if ('literal' in field.source) { record[field.name] = structuredClone(field.source.literal); continue; }
        const input = config.inputs.find(item => item.id === field.source.input);
        const value = inputs[input.id];
        let data;
        if (input.type === 'ArtifactSet') { readManifest(value.artifact); data = { kind: 'ArtifactSet', manifest: ref(value.artifact) }; }
        else data = readValue(value);
        if (field.source.pointer !== undefined) {
          const found = resolvePointer(data, field.source.pointer);
          if (!found.found) throw new UtilityError('output_contract', `Field "${field.name}": pointer ${field.source.pointer} does not exist in input "${input.id}".`);
          data = found.value;
        }
        record[field.name] = data;
      }
      if (config.schema) {
        const issues = compileOutputSchema(config.schema)(record);
        if (issues.length) throw new UtilityError('output_contract', `The record does not match its schema: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`);
      }
      return { value: make('JsonValue', record) };
    }
    case 'json-select': {
      const data = readValue(inputs.value);
      const found = resolvePointer(data, config.pointer);
      if (!found.found) throw new UtilityError('output_contract', `Pointer ${config.pointer || '(root)'} does not exist in the input.`);
      const selected = found.value;
      if (config.outputType === 'Text') {
        if (config.render === 'raw-string') {
          if (typeof selected !== 'string') throw new UtilityError('output_contract', `Pointer ${config.pointer} selects ${selected === null ? 'null' : typeof selected}, not a string.`);
          return { value: make('Text', selected) };
        }
        return { value: make('Text', canonicalize(selected)) };
      }
      if (config.outputType === 'JsonValue') return { value: make('JsonValue', selected) };
      if (selected === null) {
        if (config.nullAs === 'empty') return { value: putSet([]) };
        throw new UtilityError('output_contract', `Pointer ${config.pointer} selects null; configure nullAs "empty" to allow an empty set.`);
      }
      const manifest = selected?.manifest;
      if (!selected || selected.kind !== 'ArtifactSet' || !manifest?.artifactId || !manifest?.sha256 || Object.keys(selected).some(key => key !== 'kind' && key !== 'manifest'))
        throw new UtilityError('output_contract', 'The selected value is not an ArtifactSet reference.');
      readManifest(manifest);
      return { value: setValue(manifest) };
    }
    case 'condition': {
      const data = readValue(inputs.value);
      const found = resolvePointer(data, config.doneWhen.pointer);
      if (!found.found) throw new UtilityError('output_contract', `Condition pointer ${config.doneWhen.pointer} does not exist.`);
      const actual = found.value, op = config.doneWhen.op;
      let done;
      if (op === 'is-true' || op === 'is-false') {
        if (typeof actual !== 'boolean') throw new UtilityError('output_contract', `Condition expects a Boolean at ${config.doneWhen.pointer}; found ${JSON.stringify(actual)}.`);
        done = op === 'is-true' ? actual : !actual;
      } else {
        const equal = canonicalize(actual) === canonicalize(config.doneWhen.value);
        done = op === 'equals' ? equal : !equal;
      }
      const text = source => {
        if ('literal' in source) return source.literal;
        const item = resolvePointer(data, source.pointer);
        if (!item.found || typeof item.value !== 'string') throw new UtilityError('output_contract', `Pointer ${source.pointer} must select a string.`);
        return item.value;
      };
      const decision = { continue: !done, reason: text(config.reason), feedback: text(config.feedback) };
      assertValid('loop-decision.schema.json', null, decision, 'Loop decision');
      return { decision: make('JsonValue', decision) };
    }
    default: throw new UtilityError('output_contract', `No utility for ${node.type}.`);
  }
}
