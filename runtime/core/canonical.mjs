import { createHash } from 'node:crypto';

// Stable UTF-16 ordering, matching canonical object keys without consulting the host locale.
export const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export class StrictJsonError extends Error {
  constructor(message, position) { super(position === undefined ? message : `${message} at position ${position}`); this.code = 'invalid_json'; }
}

// JSON.parse silently keeps the last duplicate key; contracts require rejecting duplicates
// and lone surrogates (I-JSON) before a value can be hashed or trusted.
export function parseStrictJson(text) {
  if (typeof text !== 'string') throw new StrictJsonError('JSON input must be text');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let index = 0;
  const fail = message => { throw new StrictJsonError(message, index); };
  const space = () => { while (index < text.length && ' \t\n\r'.includes(text[index])) index++; };
  const literal = (word, value) => { if (text.startsWith(word, index)) { index += word.length; return value; } return fail('Unexpected token'); };
  const string = () => {
    index++;
    let result = '';
    while (true) {
      if (index >= text.length) fail('Unterminated string');
      const char = text[index++];
      if (char === '"') break;
      if (char < ' ') fail('Control character in string');
      if (char !== '\\') { result += char; continue; }
      const escape = text[index++];
      if (escape === 'u') {
        const hex = text.slice(index, index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('Invalid unicode escape');
        result += String.fromCharCode(parseInt(hex, 16)); index += 4;
      } else {
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (!(escape in map)) fail('Invalid escape');
        result += map[escape];
      }
    }
    if (!result.isWellFormed()) fail('Lone surrogate in string');
    return result;
  };
  const number = () => {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(index));
    if (!match) fail('Invalid number');
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail('Non-finite number');
    return value;
  };
  const value = () => {
    space();
    const char = text[index];
    if (char === '{') {
      index++; const result = {}; const keys = new Set(); space();
      if (text[index] === '}') { index++; return result; }
      while (true) {
        space(); if (text[index] !== '"') fail('Expected object key');
        const key = string();
        if (keys.has(key)) fail(`Duplicate JSON key "${key}"`);
        keys.add(key); space();
        if (text[index++] !== ':') fail('Expected colon');
        Object.defineProperty(result, key, { value: value(), enumerable: true, writable: true, configurable: true });
        space();
        if (text[index] === ',') { index++; continue; }
        if (text[index] === '}') { index++; return result; }
        fail('Expected comma or closing brace');
      }
    }
    if (char === '[') {
      index++; const result = []; space();
      if (text[index] === ']') { index++; return result; }
      while (true) {
        result.push(value()); space();
        if (text[index] === ',') { index++; continue; }
        if (text[index] === ']') { index++; return result; }
        fail('Expected comma or closing bracket');
      }
    }
    if (char === '"') return string();
    if (char === 't') return literal('true', true);
    if (char === 'f') return literal('false', false);
    if (char === 'n') return literal('null', null);
    return number();
  };
  const result = value(); space();
  if (index !== text.length) fail('Trailing content');
  return result;
}

// RFC 8785 JCS: ECMAScript number/string serialization with keys sorted by UTF-16 code units.
export function canonicalize(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new StrictJsonError('Non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new StrictJsonError('Lone surrogate in string');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
    return `{${keys.map(key => `${canonicalize(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new StrictJsonError(`Unsupported JSON value: ${typeof value}`);
}

export const canonicalBytes = value => Buffer.from(canonicalize(value), 'utf8');
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonicalHash = value => sha256(canonicalBytes(value));
