// P5-GIT-2 immutable Lifecycle Host boundary. Self-Repair may never change Host source, protocol, trust,
// build, packaging or installation inputs. The boundary combines a conservative static rule set with the
// Host's actual import closure derived from the candidate repository; unknown impact is treated as protected.
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { canonicalHash, compareText } from './canonical.mjs';
import { ProtectedSelfRepairError, validateP5Contract, validateP5SourcePath } from './protectedSelfRepair.mjs';
// Static, so the Gate's protected subject resolver can follow the boundary's closure; the parser is Host-owned code.
import { authorityImportClosure } from '../host/sourceProvenance.mjs';

export const P5_HOST_BOUNDARY_POLICY = 'immutable-host-v1';
const fail = (code, message) => { throw new ProtectedSelfRepairError(code, message); };

// Host implementation, Node/C# Host service, desktop shell, packaging/installation scripts, and the storage migrations
// the Host service and Store read from the filesystem (runtime/host/authority.mjs, scripts/bundle-runtime.mjs).
// `dist-runtime/` and `dist/` are generated release outputs the packager rebuilds from source; a candidate never supplies them.
const HOST_PREFIXES = Object.freeze(['lifecycle-host/', 'runtime/host/', 'src-tauri/', 'scripts/', 'docs/storage/', 'dist-runtime/', 'dist/']);
// The active trusted control closure: the installed v1 code the Gate attests against the running release before and after
// every run (p5Gate.mjs). Candidate bytes are never loaded into it. A candidate change to one of these files is future trust
// logic: repairable, and always verified at the strictest tier (review F5).
export const P5_TRUSTED_CONTROL_PATHS = Object.freeze([
  'runtime/verification/p5Verifier.mjs', 'runtime/verification/p5CandidateSyntaxCheck.test.mjs',
  'runtime/core/p5Gate.mjs', 'runtime/core/p5GitCandidate.mjs', 'runtime/core/p5HostBoundary.mjs', 'runtime/core/engineRoot.mjs',
  'runtime/core/p5Support.mjs', 'runtime/host/sourceProvenance.mjs', 'runtime/host/hostError.mjs', 'runtime/core/engine.mjs',
  'runtime/core/custody.mjs', 'runtime/core/linkedRepair.mjs', 'runtime/core/workflowJudge.mjs', 'runtime/core/store.mjs',
  'runtime/core/utilities.mjs', 'runtime/core/validate.mjs', 'runtime/core/protectedSelfRepair.mjs', 'runtime/core/canonical.mjs',
  'runtime/core/schemas.mjs', 'runtime/runner.mjs', 'docs/schemas/protected-self-repair.schema.json', 'runtime/core/p5Provisioning.mjs',
  'runtime/core/workspaceIsolation.mjs',
]);
// Engine verification tiers (P5-FINAL §5.2). Engine source is repairable; what the path decides is only how strictly the
// candidate is verified. Rules are ordered most sensitive first; a path takes the first tier whose prefix or exact path
// matches. Every shipped Engine input outside the trusted closure is at least engine-core, including code outside runtime/
// the Engine imports (shared/, mcp/, docs/examples, docs/authoring); an unknown runtime path is engine-core, never ordinary.
export const P5_MUTATION_TIER_POLICY = 'engine-tiers-v1';
export const P5_MUTATION_TIER_RULES = Object.freeze([
  Object.freeze({ tierId: 'repair-authority', paths: Object.freeze([...P5_TRUSTED_CONTROL_PATHS, 'runtime/core/p5Provisioning.mjs',
    'runtime/verification/', 'runtime/core/judgeAttention.mjs', 'runtime/core/failureOutcomes.mjs', 'runtime/core/migrations.mjs',
    'runtime/core/gate.mjs', 'docs/schemas/']) }),
  Object.freeze({ tierId: 'engine-custody', paths: Object.freeze(['runtime/core/processes.mjs', 'runtime/core/supervision.mjs',
    'runtime/core/supervisor-client.mjs', 'runtime/core/managed-isolation.mjs',
    'runtime/core/hostAutonomy.mjs', 'runtime/core/adapters.mjs']) }),
  Object.freeze({ tierId: 'engine-core', paths: Object.freeze(['runtime/', 'shared/', 'mcp/', 'docs/examples/', 'docs/authoring/']) }),
]);
export const P5_SENSITIVE_TIERS = Object.freeze(P5_MUTATION_TIER_RULES.map(rule => rule.tierId));

// Build, dependency, toolchain, Git-metadata and packaging inputs anywhere in the tree.
const HOST_BASENAMES = Object.freeze(['Cargo.toml', 'Cargo.lock', 'build.rs', 'rust-toolchain', 'rust-toolchain.toml',
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', '.npmrc', '.yarnrc', '.yarnrc.yml',
  'tauri.conf.json', '.gitattributes', '.gitmodules', '.deszo-source-inventory.json']);
// node_modules anywhere would let candidate bytes shadow the installed dependencies the Gate serves to protected checks.
const HOST_SEGMENTS = Object.freeze(['.cargo', '.github', 'node_modules', '.pnpm', 'bower_components']);
const HOST_EXTENSIONS = Object.freeze(['.ps1', '.psm1', '.cmd', '.bat', '.cs', '.rs', '.wxs', '.nsi', '.sql']);
const HOST_ROOT_FILES = Object.freeze(['vite.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.app.json']);
// Roots whose effect on the Host is understood to be Engine/UI only, subject to the derived closure below.
const ENGINE_UI_ROOTS = Object.freeze(['runtime/', 'src/', 'shared/', 'docs/', 'mcp/', 'skills/']);
const ENGINE_UI_ROOT_FILES = Object.freeze(['README.md', 'index.html']);
// Roots that hold the Host service's import closure in this repository; without a derivable closure they are not repairable.
const CLOSURE_ROOTS = Object.freeze(['runtime/', 'shared/', 'docs/', 'mcp/']);
const HOST_ENTRY_PATTERN = /^runtime\/host\/.+\.(mjs|cjs|js|ts)$/;
const RUST_REFERENCE = /\b(?:include_str|include_bytes|include)!\s*\(\s*"([^"]+)"|#\[path\s*=\s*"([^"]+)"\]/g;
const CARGO_PATH = /\bpath\s*=\s*"([^"]+)"/g;

/** Static classification of one portable path; returns a reason when the path is Host-protected or of unknown impact. */
const lower = values => values.map(value => value.toLowerCase());
const HOST_PREFIXES_FOLDED = lower(HOST_PREFIXES), HOST_BASENAMES_FOLDED = lower(HOST_BASENAMES);
const HOST_SEGMENTS_FOLDED = lower(HOST_SEGMENTS), HOST_ROOT_FILES_FOLDED = lower(HOST_ROOT_FILES);

export function p5HostStaticReason(path) {
  validateP5SourcePath(path);
  // Windows filesystems and Node module resolution there are case-insensitive, so every protected rule matches the
  // case-folded path: Node_Modules/, Package.json or LIFECYCLE-HOST/ are the protected inputs they alias.
  const folded = path.toLowerCase();
  const segments = folded.split('/'), base = segments.at(-1);
  if (HOST_PREFIXES_FOLDED.some(prefix => folded.startsWith(prefix))) return 'host_source_or_packaging';
  if (HOST_BASENAMES_FOLDED.includes(base) || base.startsWith('.env')) return 'build_or_dependency_input';
  if (segments.slice(0, -1).some(segment => HOST_SEGMENTS_FOLDED.includes(segment))) return 'build_or_dependency_input';
  if (HOST_EXTENSIONS.some(extension => base.endsWith(extension))) return 'native_or_installer_input';
  if (HOST_ROOT_FILES_FOLDED.includes(folded) || /^tsconfig(\..+)?\.json$/.test(base) && !folded.includes('/')) return 'build_or_dependency_input';
  if (!ENGINE_UI_ROOTS.some(prefix => path.startsWith(prefix)) && !ENGINE_UI_ROOT_FILES.includes(path)) return 'host_impact_unknown';
  return null;
}

function portable(root, absolute) { return relative(root, absolute).split(sep).join('/'); }

function listTree(root, prefix) {
  const start = join(root, ...prefix.split('/'));
  if (!existsSync(start)) return [];
  const out = [];
  const visit = directory => {
    for (const name of readdirSync(directory).sort(compareText)) {
      const path = join(directory, name), info = lstatSync(path);
      if (info.isSymbolicLink()) fail('p5_host_closure_unsafe', `The Host closure refuses a reparse point at "${portable(root, path)}".`);
      if (info.isDirectory()) { if (name !== 'target' && name !== '.git') visit(path); }
      else if (info.isFile()) out.push(portable(root, path));
    }
  };
  visit(start);
  return out;
}

function rustReferences(root, files) {
  const references = new Set();
  for (const file of files) {
    const absolute = join(root, ...file.split('/'));
    const text = readFileSync(absolute, 'utf8');
    const pattern = file.endsWith('Cargo.toml') ? CARGO_PATH : RUST_REFERENCE;
    for (const match of text.matchAll(pattern)) {
      const target = match[1] ?? match[2];
      const resolved = resolve(absolute, '..', target);
      const rel = portable(root, resolved);
      if (rel.startsWith('..') || rel === '') fail('p5_host_closure_unsafe', `A Host build reference escapes the source root in "${file}".`);
      references.add(rel);
    }
  }
  return [...references].sort(compareText);
}

/**
 * Derive the Host-protected closure from an actual checked-out source tree: every Host entry point, the
 * transitive Node import closure of the Host service (parsed as data, never loaded), and Rust include/path
 * references. A parse failure refuses the derivation instead of returning a partial closure.
 */
export async function deriveP5HostProtection({ sourceRoot, sourceCommit }) {
  const root = resolve(sourceRoot);
  const hostEntries = listTree(root, 'runtime/host').filter(path => HOST_ENTRY_PATTERN.test(path));
  let nodeClosure = { files: [], edges: [] };
  try { if (hostEntries.length) nodeClosure = authorityImportClosure(root, hostEntries); }
  catch (error) { fail('p5_host_closure_underivable', `The Host import closure cannot be established: ${error.message}`); }
  const rustFiles = listTree(root, 'lifecycle-host').filter(path => path.endsWith('.rs') || path.endsWith('Cargo.toml'));
  const rustRefs = rustReferences(root, rustFiles);
  const derived = [...new Set([...nodeClosure.files.map(file => file.path), ...rustRefs])].sort(compareText);
  const packages = [...new Set(nodeClosure.edges.filter(edge => edge.package).map(edge => edge.package))].sort(compareText);
  const body = { schemaVersion: 1, kind: 'ProtectedSelfRepairHostProtection', policy: P5_HOST_BOUNDARY_POLICY, sourceCommit,
    staticRules: { prefixes: HOST_PREFIXES, basenames: HOST_BASENAMES, segments: HOST_SEGMENTS, extensions: HOST_EXTENSIONS,
      rootFiles: HOST_ROOT_FILES, engineUiRoots: ENGINE_UI_ROOTS, engineUiRootFiles: ENGINE_UI_ROOT_FILES },
    hostEntryPoints: hostEntries, derivedPaths: derived, hostPackages: packages,
    derivation: { nodeImportClosure: 'authorityImportClosure', nodeClosureDigest: canonicalHash(nodeClosure.files.map(file => file.path)),
      rustReferenceFiles: rustFiles.length } };
  const protection = { ...body, protectionId: canonicalHash(body) };
  validateP5Contract('hostProtection', protection);
  return protection;
}

/** Refuse any candidate change that touches the static Host rules or the derived Host closure. */
export function assertP5HostBoundary({ changes, protection = null, candidateClosure = null }) {
  const derived = new Set([...(protection?.derivedPaths ?? []), ...(candidateClosure?.derivedPaths ?? [])]);
  // A tree without the Host entry points (a partial path policy) cannot establish the closure: unknown impact is protected.
  const underivable = [protection, candidateClosure].some(value => value && value.hostEntryPoints.length === 0);
  const refused = [];
  for (const change of changes) {
    const path = typeof change === 'string' ? change : change.path;
    const reason = p5HostStaticReason(path) ?? (derived.has(path) ? 'host_import_closure'
      : underivable && CLOSURE_ROOTS.some(root => path.startsWith(root)) ? 'host_closure_underivable' : null);
    if (reason) refused.push({ path, reason });
  }
  if (refused.length) {
    const first = refused[0];
    fail('p5_host_boundary_violation', `P5 Self-Repair may not change Lifecycle Host source, trust or build inputs: "${first.path}" (${first.reason})${refused.length > 1 ? ` and ${refused.length - 1} more` : ''}.`);
  }
  return { checked: changes.length, policy: P5_HOST_BOUNDARY_POLICY };
}

const matchesRule = (path, rule) => rule.endsWith('/') ? path.startsWith(rule) : path === rule;

/** The verification tier of one Engine/UI source path; Host-protected paths never reach this classification. */
export function p5MutationTier(path) {
  validateP5SourcePath(path);
  const folded = path.toLowerCase();
  return P5_MUTATION_TIER_RULES.find(rule => rule.paths.some(item => matchesRule(folded, item.toLowerCase())))?.tierId ?? 'ordinary';
}

/**
 * Classify a candidate's changes into verification tiers under the captured, enrolled verification policy. Tier membership
 * comes from this installed code and the check sets from the captured policy; Developer and Judge output never select either.
 * A sensitive tier the policy does not configure is unclassified and fails closed. The required check set is the union of
 * the policy's required checks and every applicable tier's checks (assertP5VerificationPolicy keeps tier checks required).
 */
export function classifyP5Mutation({ changes, policy }) {
  const configured = new Map((policy.mutationTiers ?? []).map(tier => [tier.tierId, tier]));
  const entries = changes.map(change => {
    const path = typeof change === 'string' ? change : change.path;
    return { path, tier: p5MutationTier(path) };
  }).sort((left, right) => compareText(left.path, right.path));
  const tiers = [...new Set(entries.map(entry => entry.tier))].sort(compareText);
  const missing = entries.find(entry => entry.tier !== 'ordinary' && !configured.has(entry.tier));
  if (missing) fail('p5_mutation_tier_unclassified', `The captured verification policy has no "${missing.tier}" tier for "${missing.path}"; sensitive Engine source stays refused until the enrolled policy classifies it.`);
  const requiredCheckIds = [...new Set([...policy.requiredCheckIds, ...tiers.flatMap(tier => configured.get(tier)?.requiredCheckIds ?? [])])].sort(compareText);
  return { policy: P5_MUTATION_TIER_POLICY, tiers, requiredCheckIds, entries };
}

/** Recompute a recorded classification from the change manifest and captured policy; any difference is refused. */
export function verifyP5MutationClassification({ changeManifest, policy }) {
  const expected = classifyP5Mutation({ changes: changeManifest.changes, policy });
  if (canonicalHash(changeManifest.mutationClassification ?? null) !== canonicalHash(expected))
    fail('p5_mutation_classification_mismatch', 'The recorded candidate verification tiers differ from the captured policy classification.');
  return expected;
}

export function readP5HostProtection(store, ref) {
  store.verifyRef(ref);
  const value = store.readJson(ref.artifactId);
  validateP5Contract('hostProtection', value);
  const { protectionId, ...body } = value;
  if (canonicalHash(value) !== ref.sha256 || protectionId !== canonicalHash(body))
    fail('p5_host_protection_invalid', 'The recorded Host protection closure is not the exact immutable derivation.');
  return value;
}
