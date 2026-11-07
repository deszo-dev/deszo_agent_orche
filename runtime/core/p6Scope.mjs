// P6 Candidate Scope Classifier (ADR-0010 Section 2).
// P6 v1 supports compatible Engine-owned changes.
// It strictly rejects automatic updates touching:
// - Embedded Tauri UI (`src/`, `index.html`, etc.)
// - Rust Lifecycle Host (`lifecycle-host/`, `src-tauri/`)
// - Shell native resources (`runtime/bridge.mjs`, `runtime/deszo-launch-shim.exe`)
// - Pinned toolchain or dependency policy (`package.json`, `package-lock.json`, `Cargo.toml`, etc.)
// - SQLite migrations (`docs/storage/`, `schema_migrations`, `runtime/core/migrations.mjs`)
// - Maintainer release scripts (`scripts/desktop-release.mjs`, etc.)
// - Host entry points or native files (`runtime/host/`, `.rs`, `.sql`, etc.)
// Any candidate containing unsupported changes is rejected as a whole. No silent cherry-picking.

import { P6_PROTECTED_CONTROL_PATHS, p5HostStaticReason } from './p5HostBoundary.mjs';
import { validateP5SourcePath } from './protectedSelfRepair.mjs';

export class P6ScopeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'P6ScopeError';
    this.code = code;
    this.details = details;
  }
}

export const P6_FORBIDDEN_PREFIXES = Object.freeze([
  'lifecycle-host/',
  'src-tauri/',
  'src/',
  'docs/storage/',
  'dist/',
  'dist-runtime/',
  'runtime/host/',
  'scripts/',
]);

export const P6_FORBIDDEN_EXACT_FILES = Object.freeze([
  'index.html',
  'runtime/bridge.mjs',
  'runtime/deszo-launch-shim.exe',
  'runtime/core/migrations.mjs',
  'package.json',
  'package-lock.json',
  'Cargo.toml',
  'Cargo.lock',
  'tauri.conf.json',
  'vite.config.ts',
  'vite.config.mjs',
  'vite.config.js',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.app.json',
]);

export const P6_FORBIDDEN_EXTENSIONS = Object.freeze([
  '.sql',
  '.rs',
  '.vue',
  '.cs',
  '.ps1',
  '.psm1',
  '.cmd',
  '.bat',
  '.wxs',
  '.nsi',
]);

export const P6_ALLOWED_RUNTIME_PREFIXES = Object.freeze([
  'runtime/core/',
  'runtime/verification/',
  'runtime/',
  'shared/',
  'mcp/',
  'docs/examples/',
  'docs/authoring/',
]);

/**
 * Normalizes and extracts change path strings from a change manifest entry.
 */
function extractChangePaths(changeManifest) {
  if (!changeManifest || typeof changeManifest !== 'object') {
    throw new P6ScopeError('p6_scope_invalid_manifest', 'changeManifest is missing or malformed.');
  }
  const paths = [];
  if (Array.isArray(changeManifest.changes)) {
    for (const item of changeManifest.changes) {
      const p = typeof item === 'string' ? item : item?.path;
      if (typeof p === 'string' && p.length > 0) {
        paths.push({ path: p, kind: item.operation || 'modify' });
      }
    }
  }
  for (const key of ['additions', 'modifications', 'deletions']) {
    const list = changeManifest[key];
    if (Array.isArray(list)) {
      for (const item of list) {
        const p = typeof item === 'string' ? item : item?.path;
        if (typeof p === 'string' && p.length > 0) {
          paths.push({ path: p, kind: key });
        }
      }
    }
  }
  return paths;
}

/**
 * Classifies a candidate change set.
 * Returns { supported: true, paths } or { supported: false, reason, path, details }.
 */
export function classifyP6CandidateScope(changeManifest) {
  const changes = extractChangePaths(changeManifest);
  if (changes.length === 0) {
    return { supported: false, reason: 'p6_scope_empty', path: null, details: 'Candidate has no changes.' };
  }
  // Protected P5/P6 control code is never a candidate change, under any spelling of its path (second review, MAJOR-2). A deletion is
  // listed under its old path, so it is refused by the same rule.
  const protectedPaths = new Set(P6_PROTECTED_CONTROL_PATHS.map(path => path.toLowerCase()));
  const protectedChange = changes.find(({ path }) => protectedPaths.has(String(path).toLowerCase()));
  if (protectedChange) {
    return { supported: false, reason: 'p6_scope_protected_control', path: protectedChange.path, details: 'Protected P5/P6 control code is not a candidate change.' };
  }

  for (const { path } of changes) {
    try {
      validateP5SourcePath(path);
    } catch (err) {
      return {
        supported: false,
        reason: 'p6_scope_invalid_path',
        path,
        details: `Invalid portable source path: ${err.message}`,
      };
    }

    const folded = path.toLowerCase().replaceAll('\\', '/');

    // ADR-0010 §3 excludes MCP bridge behavior from autonomous P6 updates.
    if (folded.startsWith('mcp/')) {
      return {
        supported: false,
        reason: 'p6_scope_mcp_bridge_modification',
        path,
        details: `Changes to MCP bridge behavior are excluded from P6 v1: ${path}`,
      };
    }

    // 1. Rust Lifecycle Host / Tauri Shell
    if (folded.startsWith('lifecycle-host/') || folded.startsWith('src-tauri/')) {
      return {
        supported: false,
        reason: 'p6_scope_host_modification',
        path,
        details: `Changes to Lifecycle Host or Tauri Shell are prohibited: ${path}`,
      };
    }

    // 2. Embedded Tauri UI
    if (folded.startsWith('src/') || folded === 'index.html' || folded.endsWith('.vue')) {
      return {
        supported: false,
        reason: 'p6_scope_ui_modification',
        path,
        details: `Changes to embedded UI or UI assets are prohibited in P6 v1: ${path}`,
      };
    }

    // 3. SQLite migrations & Store storage
    if (folded.startsWith('docs/storage/') || folded === 'runtime/core/migrations.mjs' || folded.endsWith('.sql')) {
      return {
        supported: false,
        reason: 'p6_scope_migration_attempt',
        path,
        details: `Changes to SQLite migrations or migration engine are prohibited: ${path}`,
      };
    }

    // 4. Frozen Shell / Host resources
    if (folded === 'runtime/bridge.mjs' || folded === 'runtime/deszo-launch-shim.exe' || folded.startsWith('runtime/host/')) {
      return {
        supported: false,
        reason: 'p6_scope_shell_resource_modification',
        path,
        details: `Changes to frozen Shell resources or Host bridge are prohibited: ${path}`,
      };
    }

    // 5. Build scripts & packaging
    if (folded.startsWith('scripts/')) {
      return {
        supported: false,
        reason: 'p6_scope_build_script_modification',
        path,
        details: `Changes to packaging/maintainer scripts are prohibited: ${path}`,
      };
    }

    // 6. Toolchain and package configuration
    const base = folded.split('/').at(-1);
    if (P6_FORBIDDEN_EXACT_FILES.some(f => f.toLowerCase() === folded || f.toLowerCase() === base)) {
      return {
        supported: false,
        reason: 'p6_scope_toolchain_modification',
        path,
        details: `Changes to pinned toolchain/configuration are prohibited: ${path}`,
      };
    }

    // 7. Forbidden native extensions
    if (P6_FORBIDDEN_EXTENSIONS.some(ext => base.endsWith(ext))) {
      return {
        supported: false,
        reason: 'p6_scope_native_or_script_extension',
        path,
        details: `Native or installer extensions are prohibited: ${path}`,
      };
    }

    // 8. General P5 Host boundary check
    const hostReason = p5HostStaticReason(path);
    if (hostReason) {
      return {
        supported: false,
        reason: `p6_scope_host_protected_${hostReason}`,
        path,
        details: `Path is protected under P5 Host boundary (${hostReason}): ${path}`,
      };
    }

    // 9. Must be within allowed runtime prefixes
    const allowed = P6_ALLOWED_RUNTIME_PREFIXES.some(prefix => folded.startsWith(prefix));
    if (!allowed) {
      return {
        supported: false,
        reason: 'p6_scope_unsupported_prefix',
        path,
        details: `Path is not within supported Engine runtime prefixes: ${path}`,
      };
    }
  }

  return { supported: true, changes };
}

/**
 * Asserts candidate change scope; throws P6ScopeError if unsupported.
 */
export function assertP6CandidateScope(changeManifest) {
  const result = classifyP6CandidateScope(changeManifest);
  if (!result.supported) {
    throw new P6ScopeError(result.reason, result.details, { path: result.path });
  }
  return result;
}
