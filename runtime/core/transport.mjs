// Native structured-output transport (pilot PILOT-01).
//
// Provider CLIs accept only a subset of JSON Schema for their native structured-output flags
// (Codex: OpenAI strict Structured Outputs; Claude: tool input schemas without root composition).
// The engine therefore sends a derived *transport schema* and keeps validating every answer
// against the complete contract. The transport form is deterministic:
//   - local $refs are inlined; $defs, $schema, $id, title and comments are dropped;
//   - allOf refinements are folded into their object; if/then/else, not, dependent* and
//     unevaluated* keywords are dropped (enforced only by the engine);
//   - a oneOf/anyOf whose branches are all objects is merged into one object (union of
//     properties, enums merged); other unions stay a nested anyOf (never at the root);
//   - every object is closed (additionalProperties: false) with every property required;
//     properties the contract leaves optional become nullable and are removed again when null;
//   - const becomes a one-value enum; only strict-subset keywords are kept;
//   - only string enum values travel natively: Gemini function schemas reject numeric/null
//     enum members. Other enum restrictions remain in the complete engine contract;
//   - the root must be an object. Anything else is refused before a model request.
const KEEP = new Set(['type', 'properties', 'required', 'items', 'additionalProperties', 'enum', 'anyOf', 'description', 'pattern', 'format', 'minimum', 'maximum', 'minItems', 'maxItems']);
const FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid']);

export class TransportSchemaError extends Error {
  constructor(message) { super(message); this.code = 'output_contract'; }
}

const isObjectSchema = node => node && (node.type === 'object' || (!node.type && node.properties));
const canonical = value => JSON.stringify(value, Object.keys(value || {}).sort());

export function transportSchema(contract) {
  const root = contract;
  const resolve = (node, seen) => {
    if (node === true || node === undefined) return {};
    if (node === false) throw new TransportSchemaError('A false schema cannot be transported.');
    if (typeof node.$ref !== 'string') return node;
    if (!node.$ref.startsWith('#/')) throw new TransportSchemaError(`Only local references can be transported (${node.$ref}).`);
    if (seen.has(node.$ref)) throw new TransportSchemaError(`Recursive reference ${node.$ref} cannot be transported.`);
    const target = node.$ref.slice(2).split('/').reduce((value, key) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
    if (target === undefined) throw new TransportSchemaError(`Reference ${node.$ref} does not resolve.`);
    const { $ref, ...rest } = node;
    return resolve({ ...target, ...rest }, new Set([...seen, node.$ref]));
  };

  // Fold allOf refinements into one node (properties merged per key, required united).
  const fold = (base, extra) => {
    const out = { ...base };
    for (const [key, value] of Object.entries(extra)) {
      if (key === 'properties') {
        out.properties = { ...(out.properties || {}) };
        for (const [name, schema] of Object.entries(value)) out.properties[name] = out.properties[name] ? fold(out.properties[name], schema) : schema;
      } else if (key === 'required') out.required = [...new Set([...(out.required || []), ...value])];
      else if (!(key in out)) out[key] = value;
    }
    return out;
  };

  // Merge object alternatives into one object: properties united, enums merged, required intersected.
  const mergeObjects = list => {
    const properties = {};
    for (const item of list) for (const [name, schema] of Object.entries(item.properties || {})) {
      const known = properties[name];
      if (!known) properties[name] = schema;
      else if (known.enum && schema.enum) properties[name] = { ...known, enum: [...new Set([...known.enum, ...schema.enum].map(v => JSON.stringify(v)))].map(v => JSON.parse(v)) };
      else if (canonical(known) !== canonical(schema)) properties[name] = { anyOf: [known, schema] };
    }
    const required = list.map(item => new Set(item.required || [])).reduce((a, b) => new Set([...a].filter(x => b.has(x))));
    return { type: 'object', properties, required: [...required] };
  };

  // Returns { schema, plan } where plan guides decoding (optional keys to drop when null).
  const convert = (input, seen = new Set(), depth = 0) => {
    if (depth > 32) throw new TransportSchemaError('The schema is nested too deeply to transport.');
    let node = resolve(input, seen);
    if (Array.isArray(node.allOf)) {
      const { allOf, ...rest } = node;
      node = allOf.map(branch => resolve(branch, seen)).reduce(fold, rest);
    }
    if ('const' in node) { const { const: value, ...rest } = node; node = { ...rest, enum: [value] }; }
    const union = node.oneOf || node.anyOf;
    if (union) {
      const branches = union.map(branch => resolve(branch, seen));
      const { oneOf, anyOf, ...rest } = node;
      if (branches.every(isObjectSchema)) node = fold(mergeObjects(branches.map(branch => convert(branch, seen, depth + 1).schema)), rest);
      else {
        const converted = branches.map(branch => convert(branch, seen, depth + 1));
        return { schema: { anyOf: converted.map(item => item.schema) }, plan: { anyOf: converted.map(item => item.plan) } };
      }
    }
    const schema = {};
    for (const [key, value] of Object.entries(node)) if (KEEP.has(key)) schema[key] = value;
    if (schema.format && !FORMATS.has(schema.format)) delete schema.format;
    if (schema.enum && !schema.type) {
      const types = [...new Set(schema.enum.map(value => (value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value)))];
      if (types.every(type => ['string', 'integer', 'number', 'boolean', 'null'].includes(type))) schema.type = types.length === 1 ? types[0] : types;
    }
    if (schema.enum?.some(value => typeof value !== 'string')) delete schema.enum;
    if (isObjectSchema(node)) {
      if (!node.properties || !Object.keys(node.properties).length) throw new TransportSchemaError('A free-form object cannot be transported; declare its properties.');
      if (node.additionalProperties && node.additionalProperties !== false) throw new TransportSchemaError('An object with additional properties cannot be transported; declare every property.');
      const required = new Set(node.required || []);
      const properties = {}, plans = {}, optional = [];
      for (const [name, child] of Object.entries(node.properties)) {
        const converted = convert(child, seen, depth + 1);
        plans[name] = converted.plan;
        properties[name] = required.has(name) ? converted.schema : nullable(converted.schema);
        if (!required.has(name)) optional.push(name);
      }
      return { schema: { type: 'object', ...(schema.description ? { description: schema.description } : {}), properties, required: Object.keys(properties), additionalProperties: false },
        plan: { optional, properties: plans } };
    }
    if (node.type === 'array' || node.items) {
      const items = convert(node.items ?? {}, seen, depth + 1);
      return { schema: { ...schema, items: items.schema }, plan: { items: items.plan } };
    }
    return { schema, plan: null };
  };

  const converted = convert(contract);
  if (converted.schema.type !== 'object') throw new TransportSchemaError('The answer contract must be a JSON object to use native structured output.');
  return { schema: converted.schema, decode: value => decode(value, converted.plan) };
}

function nullable(schema) {
  if (schema.anyOf) return { anyOf: [...schema.anyOf, { type: 'null' }] };
  // Gemini's function-schema conversion can discard null in a type array. A nested
  // anyOf preserves the null alternative and keeps enums inside their string branch.
  return { anyOf: [schema, { type: 'null' }] };
}

// Transport answer → contract value: drop optional keys sent as null, recursively.
function decode(value, plan) {
  if (!plan || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return plan.items ? value.map(item => decode(item, plan.items)) : value;
  if (plan.anyOf) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null && plan.optional?.includes(key)) continue;
    out[key] = decode(item, plan.properties?.[key]);
  }
  return out;
}

// Validate a transport schema against the provider rules the engine targets (used by tests and preflight).
export function nativeSchemaProblems(schema) {
  const problems = [];
  if (schema?.type !== 'object') problems.push('root type must be object');
  for (const key of ['oneOf', 'anyOf', 'allOf', 'enum', 'not']) if (schema && key in schema) problems.push(`root has ${key}`);
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) if (!KEEP.has(key)) problems.push(`${path || '/'} uses unsupported keyword ${key}`);
    if (node.enum?.some(value => typeof value !== 'string')) problems.push(`${path || '/'} enum members must be strings for the shared native transport`);
    if (node.type === 'object') {
      if (node.additionalProperties !== false) problems.push(`${path || '/'} must set additionalProperties: false`);
      const keys = Object.keys(node.properties || {});
      if (keys.some(key => !(node.required || []).includes(key))) problems.push(`${path || '/'} must require every property`);
      for (const key of keys) walk(node.properties[key], `${path}/${key}`);
    }
    if (node.items) walk(node.items, `${path}/items`);
    (node.anyOf || []).forEach((branch, i) => walk(branch, `${path}/anyOf/${i}`));
  };
  walk(schema, '');
  return problems;
}
