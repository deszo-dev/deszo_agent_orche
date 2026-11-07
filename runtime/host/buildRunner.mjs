// Runs allowed build commands and produces their compilation attestation. The executor is injected: production uses the
// native bounded-command reporter, whose observations are captured by the protected service; the fixture executor below
// runs plain child processes and is accepted only by fixture hosts. Both record the same attestation shape.
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalHash, canonicalize } from '../core/canonical.mjs';
import { ALLOWED_BUILD_COMMANDS, commandAllowed, commandRecord, createBuildAttestation, outputFiles } from './buildAttestation.mjs';
import { securityClosure } from './installedBuilds.mjs';
import { SOURCE_INVENTORY_PATH } from './sourceProvenance.mjs';
import { HostError } from './authority.mjs';

const refuse = message => { throw new HostError(403, 'build_attestation_refused', message); };

// Fixture only: plain child processes with a minimal environment, no shell. Its name is recorded in every attestation.
export function fixtureProcessExecutor({ env = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' }, timeoutMs = 120000 } = {}) {
  return {
    name: 'fixture-child-process',
    async run({ argv, cwd }) {
      const program = argv[0] === 'node' ? process.execPath : argv[0];
      const result = spawnSync(program, argv.slice(1), { cwd, env, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, shell: false });
      return { exitCode: result.status ?? 1, timedOut: result.error?.code === 'ETIMEDOUT', stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
  };
}

// Runs exactly the allowed commands, in order, from the captured source root. The closure must be identical before the
// first command and after the last one; a source change during the build refuses the attestation.
export async function runAttestedBuild({ sourceRoot, gitTool, readGit = null, commands, executor, outputsDir, toolIdentities, allowedCommands = ALLOWED_BUILD_COMMANDS, createdAt }) {
  if (!executor || typeof executor.run !== 'function' || typeof executor.name !== 'string') refuse('A build executor is required.');
  if (!Array.isArray(commands) || commands.length === 0) refuse('At least one build command is required.');
  for (const argv of commands) {
    if (!Array.isArray(argv) || !commandAllowed(argv, allowedCommands)) refuse(`The build command is not allowed: ${Array.isArray(argv) ? argv.join(' ') : String(argv)}`);
  }
  const before = await securityClosure(sourceRoot, gitTool, readGit);
  const records = [];
  for (const argv of commands) {
    const startedAt = new Date().toISOString();
    const result = await executor.run({ argv: [...argv], cwd: sourceRoot });
    records.push(commandRecord({ argv, cwd: '.', ...result, startedAt, endedAt: new Date().toISOString(), executor: executor.name }));
    if (result.timedOut || result.exitCode !== 0) break;
  }
  const after = await securityClosure(sourceRoot, gitTool, readGit);
  if (after.digest !== before.digest) refuse('The source closure changed during the build; the attestation is refused.');
  const sourceInventory = { schemaVersion: 1, kind: 'DeszoBuildSourceInventory', sourceCommit: before.source.sourceCommit,
    sourceDigest: before.source.sourceDigest, files: before.source.files };
  if (canonicalHash(sourceInventory.files) !== sourceInventory.sourceDigest) refuse('The captured source inventory digest is inconsistent.');
  const sourceInventoryPath = join(outputsDir, SOURCE_INVENTORY_PATH);
  if (existsSync(sourceInventoryPath)) refuse('The build output already contains the reserved source-inventory path.');
  writeFileSync(sourceInventoryPath, canonicalize(sourceInventory), { flag: 'wx' });
  const outputs = outputFiles(outputsDir);
  return createBuildAttestation({ closure: before, closureAfterDigest: after.digest, commands: records, outputs, toolIdentities, executor: executor.name, createdAt: createdAt ?? new Date().toISOString() });
}
