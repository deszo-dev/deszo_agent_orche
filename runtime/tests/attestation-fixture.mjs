// Shared fixture for compilation-attestation tests. It writes one allowed fixture build script into a source repository and
// attests a real child-process run of it. The fixture executor is accepted only by fixture hosts; the attestation records it.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAttestedBuild, fixtureProcessExecutor } from '../host/buildRunner.mjs';
import { toolIdentity } from '../host/buildAttestation.mjs';

export const FIXTURE_BUILD = Object.freeze(['node', 'scripts/build-fixture.mjs']);
export const FIXTURE_ARTIFACT = 'fixture artifact, not a native proof';
const SCRIPT = `import { mkdirSync, writeFileSync } from 'node:fs';
const out = process.env.DESZO_BUILD_OUT;
if (!out) process.exit(2);
mkdirSync(out, { recursive: true });
writeFileSync(out + '/deszo.exe', ${JSON.stringify(FIXTURE_ARTIFACT)});
`;

// Attests one run of the fixture build. Returns the attestation; the script is written once if it is absent.
export async function attestFixtureBuild({ sourceRoot, gitTool, outputsDir, executor = null, allowedCommands = [FIXTURE_BUILD] }) {
  mkdirSync(join(sourceRoot, 'scripts'), { recursive: true });
  if (!existsSync(join(sourceRoot, 'scripts', 'build-fixture.mjs'))) writeFileSync(join(sourceRoot, 'scripts', 'build-fixture.mjs'), SCRIPT);
  mkdirSync(outputsDir, { recursive: true });
  const runner = executor ?? fixtureProcessExecutor({ env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', DESZO_BUILD_OUT: outputsDir } });
  const toolIdentities = [toolIdentity({ name: 'node', path: process.execPath, version: process.version })];
  return runAttestedBuild({ sourceRoot, gitTool, commands: [[...FIXTURE_BUILD]], executor: runner, outputsDir, toolIdentities, allowedCommands, createdAt: new Date().toISOString() });
}
