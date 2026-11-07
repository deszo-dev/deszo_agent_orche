// Compilation attestation (ADR-0006 section 5). It records what produced a staged build: the exact build commands and their
// results, the tools that ran them, the source closure before and after the build, and the digests of the outputs. The
// verifier is pure: it checks an attestation against the closure captured by the protected host and against the manifest
// the staging step built. It does not run anything.
//
// What it establishes: the build was run from the captured closure, nothing in that closure changed while it ran, only an
// allowed command was run, every command succeeded, and every manifest artifact is an attested output. It does not prove
// that the tool itself was uncompromised, and it is not an adversarial guarantee against an administrator. Production
// acceptance additionally requires the native bounded-command executor (see runtime/host/native/BoundedCommand.cs), whose
// observations are captured by the protected service rather than by the candidate.
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalHash, sha256 } from '../core/canonical.mjs';
import { HostError } from './authority.mjs';

const refuse = message => { throw new HostError(403, 'build_attestation_refused', message); };

// The repository's own build commands. Exact argv only: no shell and no caller-supplied script or flag.
export const ALLOWED_BUILD_COMMANDS = Object.freeze([
  Object.freeze(['npm', 'run', 'runtime:bundle']),
  Object.freeze(['npm', 'run', 'shim:build']),
  Object.freeze(['npm', 'run', 'build']),
  Object.freeze(['node', 'scripts/build-control-host.mjs']),
  Object.freeze(['cargo', 'build', '--release']),
]);

export function sameArgv(a, b) { return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((part, index) => part === b[index]); }

export function commandAllowed(argv, allowedCommands = ALLOWED_BUILD_COMMANDS) {
  return allowedCommands.some(allowed => sameArgv(allowed, argv));
}

// The identity of a tool that ran a command: its resolved path, its file digest and the version it reports.
export function toolIdentity({ name, path, version }) {
  if (!isAbsolutePath(path) || !existsSync(path) || lstatSync(path).isSymbolicLink()) refuse(`The tool ${name} is not a plain installed file.`);
  return { name, path: resolve(path), sha256: sha256(readFileSync(path)), version: String(version ?? '') };
}

const isAbsolutePath = path => typeof path === 'string' && isAbsolute(path);

// One command as the executor observed it. stdout and stderr are digested, not stored in the attestation.
export function commandRecord({ argv, cwd = '.', exitCode, timedOut = false, stdout = '', stderr = '', startedAt, endedAt, executor }) {
  return { argv: [...argv], cwd, exitCode, timedOut: Boolean(timedOut), stdoutSha256: sha256(Buffer.from(String(stdout))), stderrSha256: sha256(Buffer.from(String(stderr))), startedAt, endedAt, executor };
}

// The sealed attestation body plus its own digest. The closure before and after the commands must be the same closure.
export function createBuildAttestation({ closure, closureAfterDigest, commands, outputs, toolIdentities, executor, createdAt }) {
  const body = {
    schemaVersion: 1, kind: 'BuildAttestation', sourceCommit: closure.source.sourceCommit, sourceDigest: closure.source.sourceDigest,
    closureDigest: closure.digest, dependencyDigest: closure.dependencyDigest, closureAfterDigest, executor, toolIdentities, commands, outputs, createdAt,
  };
  return { ...body, attestationDigest: canonicalHash(body) };
}

export function verifyBuildAttestation(attestation, { closure, manifest, allowedCommands = ALLOWED_BUILD_COMMANDS, requireNative = true }) {
  if (!attestation || attestation.kind !== 'BuildAttestation' || attestation.schemaVersion !== 1) refuse('A compilation attestation is required for a routine build; a diagnostic build has none and cannot be promoted.');
  const { attestationDigest, ...body } = attestation;
  if (canonicalHash(body) !== attestationDigest) refuse('The compilation attestation digest does not verify.');
  if (attestation.sourceCommit !== closure.source.sourceCommit) refuse('The attested source commit differs from the captured source.');
  if (attestation.sourceDigest !== closure.source.sourceDigest || attestation.closureDigest !== closure.digest || attestation.dependencyDigest !== closure.dependencyDigest) {
    refuse('The attested source closure differs from the captured closure.');
  }
  if (attestation.closureAfterDigest !== closure.digest) refuse('The source closure changed while the build ran.');
  if (requireNative && attestation.executor !== 'native-bounded-command') refuse('Only the native bounded-command executor can establish production provenance.');
  if (!Array.isArray(attestation.commands) || attestation.commands.length === 0) refuse('The attestation records no build command.');
  for (const command of attestation.commands) {
    if (!commandAllowed(command.argv, allowedCommands)) refuse(`The build command is not allowed: ${command.argv.join(' ')}`);
    if (command.timedOut || command.exitCode !== 0) refuse(`A build command did not succeed: ${command.argv.join(' ')} (exit ${command.exitCode}${command.timedOut ? ', timed out' : ''}).`);
    if (command.executor !== attestation.executor) refuse('A command was observed by a different executor.');
  }
  if (!Array.isArray(attestation.toolIdentities) || attestation.toolIdentities.length === 0) refuse('Tool identities are required.');
  for (const tool of attestation.toolIdentities) {
    if (!tool || typeof tool.name !== 'string' || !isAbsolutePath(tool.path) || !/^[a-f0-9]{64}$/.test(tool.sha256)) refuse('A tool identity is incomplete.');
  }
  // Every manifest artifact must be an attested output with the same digest, and every attested output must be an artifact.
  const attested = new Map((attestation.outputs ?? []).map(output => [output.path, output.sha256]));
  if (attested.size !== (attestation.outputs ?? []).length) refuse('The attestation lists an output twice.');
  for (const artifact of manifest.artifacts) {
    if (attested.get(artifact.path) !== artifact.sha256) refuse(`Manifest artifact ${artifact.path} is not an attested output with the same digest.`);
  }
  if (attested.size !== manifest.artifacts.length) refuse('The attestation lists outputs that are not manifest artifacts.');
  return { verified: true, attestationDigest };
}

// Files of an output directory, for attestation of what a build wrote. Reparse points are refused.
export function outputFiles(root) {
  const base = resolve(root), files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) refuse('An output directory cannot contain a reparse point.');
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push({ path: relative(base, path).split(sep).join('/'), sha256: sha256(readFileSync(path)) });
    }
  };
  walk(base);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
