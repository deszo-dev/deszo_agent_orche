// Immutable build staging is owned by the protected service. The candidate can supply bytes, not a promotion
// decision. A routine build must preserve the installed authority/dependency closure captured by the operator.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, constants } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalHash, canonicalize, parseStrictJson, sha256 } from '../core/canonical.mjs';
import { createBuildManifest, verifyBuildDirectory } from './lifecycle.mjs';
import { HostError } from './authority.mjs';
import { authorityImportClosure, sourceInventory, SOURCE_INVENTORY_PATH } from './sourceProvenance.mjs';
import { ALLOWED_BUILD_COMMANDS, verifyBuildAttestation } from './buildAttestation.mjs';

const fail = message => { throw new HostError(403, 'build_promotion_refused', message); };
export function plainFiles(root) {
  root = resolve(root);
  if (lstatSync(root).isSymbolicLink() || resolve(realpathSync(root)).toLowerCase() !== root.toLowerCase()) fail('A source/build root cannot traverse a reparse point.');
  const files = []; function walk(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isSymbolicLink()) fail('A build/dependency closure cannot contain a reparse point.'); if (entry.isDirectory()) walk(path); else if (entry.isFile()) files.push(path); else fail('Unsupported build object.'); } }
  walk(root); return files.sort();
}
export async function securityClosure(sourceRoot,gitTool,readGit=null) {
  const root = resolve(sourceRoot);
  const inventory=await sourceInventory(root,gitTool,readGit),tracked=inventory.files.map(file=>file.path);
  const selected=tracked.filter(p => /^(runtime\/(?!tests\/)|mcp\/|src-tauri\/|scripts\/|shared\/|docs\/(schemas|storage|authoring)\/|package[^/]*\.json$|[^/]*lock[^/]*$|vite\.config\.|tsconfig[^/]*\.json$|src\/transport\.ts$)/.test(p));
  const graph=authorityImportClosure(root,selected.filter(p=>/^(runtime\/(?!tests\/)|mcp\/)/.test(p)&&/\.(mjs|cjs|js|ts)$/.test(p)&&existsSync(join(root,p))).concat(['vite.config.ts','src/transport.ts','scripts/bundle-runtime.mjs','scripts/build-shim.mjs'].filter(p=>existsSync(join(root,p)))));
  const names=[...new Set([...selected,...graph.files.map(file=>file.path)])].sort();
  const inputs = [];
  for (const name of names) {
    const path = resolve(root, name), rel = relative(root, path); if (isAbsolute(rel) || rel.startsWith('..')) fail('Source inventory escaped its root.');
    // Hash deletion as well as replacement. An untracked authority file is part of the closure too.
    if (!existsSync(path)) inputs.push({ path: name, absent: true });
    else { if (lstatSync(path).isSymbolicLink() || resolve(realpathSync(path)).toLowerCase() !== path.toLowerCase()) fail('Source authority uses a reparse point.'); inputs.push({ path: name, sha256: sha256(readFileSync(path)) }); }
  }
  const dependencies = existsSync(join(root, 'node_modules')) ? plainFiles(join(root, 'node_modules')).map(path => ({ path: relative(root, path).split(sep).join('/'), sha256: sha256(readFileSync(path)) })) : [];
  return { digest: canonicalHash({ inputs, dependencies, importGraph:graph.digest,metadataTool:inventory.gitTool }), inputs, importGraph:graph, dependencyDigest: canonicalHash(dependencies), dependencyFiles: dependencies.length,source:inventory };
}

export class InstalledBuilds {
  constructor({ host, buildRoot, sealDirectory, gitTool=null,readGit=null, allowedBuildCommands=ALLOWED_BUILD_COMMANDS }) {
    // A production installation fixes its build commands; only a fixture host may substitute a test allowlist.
    if (host.assurance !== 'fixture' && allowedBuildCommands !== ALLOWED_BUILD_COMMANDS) throw new Error('Production build commands are fixed by the protected installation.');
    this.allowedBuildCommands = allowedBuildCommands; if (typeof sealDirectory !== 'function') throw new Error('Native immutability sealing is required.'); if(host.assurance!=='fixture'&&typeof readGit!=='function')throw new Error('Installed Git metadata must run in the restricted native user session, never as LocalService.'); Object.assign(this, { host, buildRoot: resolve(buildRoot), sealDirectory,gitTool,readGit }); }
  async inspectSource(sourceRoot){const closure=await securityClosure(sourceRoot,this.gitTool,this.readGit);return{sourceCommit:closure.source.sourceCommit,sourceDigest:closure.source.sourceDigest,tcbDigest:closure.digest,graphFiles:closure.importGraph.files.length,dependencyFiles:closure.dependencyFiles,inputs:closure.inputs.length,metadataProcess:closure.source.metadataProcess};}
  get(buildId) { const row = this.host.get('SELECT * FROM installed_builds WHERE build_id=?', buildId); if (!row) throw new HostError(404, 'not_found', 'Build is not installed.'); return { ...row, manifest: JSON.parse(row.manifest_json), verification: JSON.parse(row.verification_json) }; }
  async stage({ buildId, sourceDir, sourceRoot, sourceCommit, inputsDigest, protocolVersion, storeSchemaVersion, launchEntry, expectedTcbDigest = null, operatorBaseline = false, diagnosticOnly = false, sourceBuildAttestation = null }) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(buildId)) fail('A simple build identity is required.');
    const closure = await securityClosure(sourceRoot,this.gitTool,this.readGit);
    if(sourceCommit!==closure.source.sourceCommit)fail('The claimed source commit differs from the independently observed Git HEAD.');
    const baselineKey=`build-tcb-baseline:${closure.source.projectId}`,baseline=this.host.get('SELECT value FROM host_meta WHERE key=?',baselineKey);
    if(diagnosticOnly&&!operatorBaseline)fail('Only the installation operator may stage a verification-only build.');
    const existing = this.host.get('SELECT * FROM installed_builds WHERE build_id=?', buildId);
    if (existing && (JSON.parse(existing.verification_json).diagnosticOnly === true) !== diagnosticOnly)
      fail('A diagnostic build cannot be promoted by reusing its identity.');
    if(!diagnosticOnly&&!operatorBaseline&&(!baseline||JSON.parse(baseline.value).tcbDigest!==closure.digest))fail('The actual authority/dependency closure differs from the protected operator baseline.');
    if(expectedTcbDigest&&expectedTcbDigest!==closure.digest)fail('The expected closure does not match the actual source/dependencies.');
    if(!diagnosticOnly&&baseline&&JSON.parse(baseline.value).tcbDigest!==closure.digest)fail('Replacing the trusted baseline requires a separate verified trust update; a caller flag cannot widen it.');
    if(!diagnosticOnly&&!sourceBuildAttestation)fail('A routine compilation attestation is required.');
    const observedInputs=canonicalHash({sourceCommit,sourceDigest:closure.source.sourceDigest,authorityClosureDigest:closure.digest,dependencyDigest:closure.dependencyDigest,gitTool:closure.source.gitTool});
    if(inputsDigest&&inputsDigest!==observedInputs)fail('The supplied input digest differs from the independently captured inputs.');
    let sourceInventoryRef = null;
    if (!diagnosticOnly) {
      const sourceInventoryPath = join(sourceDir, SOURCE_INVENTORY_PATH);
      let inventoryBytes, inventory;
      try {
        const info = lstatSync(sourceInventoryPath);
        if (!info.isFile() || info.isSymbolicLink() || resolve(realpathSync(sourceInventoryPath)).toLowerCase() !== resolve(sourceInventoryPath).toLowerCase()
          || info.size <= 0 || info.size > 32 * 1024 * 1024) fail('The packaged source inventory must be a bounded plain file.');
        inventoryBytes = readFileSync(sourceInventoryPath);
        if (inventoryBytes.length !== info.size || inventoryBytes.length > 32 * 1024 * 1024) fail('The packaged source inventory changed while it was read.');
        inventory = parseStrictJson(inventoryBytes.toString('utf8'));
      } catch (error) { if (error instanceof HostError) throw error; fail('A valid source-to-build inventory artifact is required for a routine build.'); }
      if (inventory?.schemaVersion !== 1 || inventory.kind !== 'DeszoBuildSourceInventory'
        || inventory.sourceCommit !== closure.source.sourceCommit || inventory.sourceDigest !== closure.source.sourceDigest
        || canonicalHash(inventory.files) !== closure.source.sourceDigest
        || canonicalHash(inventory.files) !== canonicalHash(closure.source.files))
        fail('The packaged source inventory differs from the independently captured build source.');
      sourceInventoryRef = { path: SOURCE_INVENTORY_PATH, sha256: sha256(inventoryBytes) };
    }
    const manifest = createBuildManifest({ buildDir: sourceDir, buildId, sourceCommit, inputsDigest:observedInputs, protocolVersion, storeSchemaVersion,
      launchEntry, dirtySourceDigest: closure.source.sourceDigest, createdAt: new Date(this.host.time.wallNow()).toISOString(),
      ...(sourceInventoryRef ? { sourceInventory: sourceInventoryRef } : {}) });
    if (existing) {
      const old = JSON.parse(existing.manifest_json); const { createdAt: a, ...oldSemantic } = old, { createdAt: b, ...newSemantic } = manifest;
      if (canonicalHash(oldSemantic) !== canonicalHash(newSemantic)) fail('A staged build identity cannot be replaced.');
      if (!verifyBuildDirectory(old, existing.build_dir).verified) fail('The installed build no longer matches its receipt.'); return this.get(buildId);
    }
    // A routine build needs the compilation attestation of its actual commands, bound to this closure and this manifest.
    if (!diagnosticOnly) verifyBuildAttestation(sourceBuildAttestation, { closure, manifest, allowedCommands: this.allowedBuildCommands, requireNative: this.host.assurance !== 'fixture' });
    const destination = join(this.buildRoot, buildId); if (existsSync(destination)) fail('The destination already exists and will not be replaced.');
    mkdirSync(destination); // No recursive overwrite or cleanup of pre-existing destinations.
    try {
      for (const artifact of manifest.artifacts) { const path = join(destination, artifact.path); mkdirSync(resolve(path, '..'), { recursive: true }); copyFileSync(join(sourceDir, artifact.path), path, constants.COPYFILE_EXCL); }
      const finalClosure=await securityClosure(sourceRoot,this.gitTool,this.readGit);
      if (finalClosure.digest !== closure.digest || finalClosure.source.sourceDigest!==closure.source.sourceDigest || finalClosure.source.sourceCommit!==sourceCommit || !verifyBuildDirectory(manifest, sourceDir).verified || !verifyBuildDirectory(manifest, destination).verified) fail('Source, dependencies or artifacts changed while staging.');
      const sealed = await this.sealDirectory(destination); if (!sealed?.immutable) fail('Native artifact immutability was not established.');
      if (!verifyBuildDirectory(manifest, destination).verified) fail('The sealed build differs from the manifest.');
      const verification = { complete: true, diagnosticOnly, sourceBuildAttestation: diagnosticOnly ? null : sourceBuildAttestation, closure, sealed, operatorBaseline, sourceRoot: resolve(sourceRoot), migrations: manifest.artifacts.filter(a => /^runtime\/m[0-9]+\.sql$/.test(a.path)).sort((a,b) => Number(a.path.match(/m(\d+)\.sql$/)[1]) - Number(b.path.match(/m(\d+)\.sql$/)[1])).map(a => a.sha256) };
      this.host.transaction(() => { if(operatorBaseline&&!diagnosticOnly&&!baseline)this.host.run('INSERT INTO host_meta(key,value) VALUES(?,?)',baselineKey,canonicalize({projectId:closure.source.projectId,tcbDigest:closure.digest,buildId,sourceCommit})); this.host.run('INSERT INTO installed_builds(build_id,build_dir,manifest_json,manifest_digest,tcb_digest,verification_json,staged_at) VALUES(?,?,?,?,?,?,?)', buildId, destination, canonicalize(manifest), canonicalHash(manifest), closure.digest, canonicalize(verification), manifest.createdAt); this.host.audit('build.staged', { buildId, destination, manifestDigest: canonicalHash(manifest), tcbDigest: closure.digest, operatorBaseline, diagnosticOnly }); });
      return this.get(buildId);
    } catch (error) { this.host.audit('build.stage_failed', { buildId, destination, reason: error.message, partialDestinationRetained: true }); throw error; }
  }
}
