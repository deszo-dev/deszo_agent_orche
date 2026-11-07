// Captured-source tests. These do not claim that matching source bytes prove a compiler's output.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {sha256} from '../core/canonical.mjs';
import {ControlHost} from '../host/authority.mjs';
import {sourceInventory,authorityImportClosure} from '../host/sourceProvenance.mjs';
import {InstalledBuilds,securityClosure} from '../host/installedBuilds.mjs';
import {InstalledEnablement,REQUIRED_NATIVE_CHECKS} from '../host/installedEnablement.mjs';
import {FIXTURE_BUILD,attestFixtureBuild} from './attestation-fixture.mjs';
import { ownedDir } from './test-roots.mjs';

const gitPath=process.platform==='win32'?execFileSync('where.exe',['git.exe'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/)[0]:execFileSync('which',['git'],{encoding:'utf8'}).trim();
const gitTool={path:gitPath,sha256:sha256(readFileSync(gitPath))};
function fixture(){
  const base=ownedDir(join(tmpdir(),'deszo-provenance-')),root=join(base,'source');mkdirSync(root);
  const write=(name,text)=>{mkdirSync(dirname(join(root,name)),{recursive:true});writeFileSync(join(root,name),text);};
  write('runtime/main.mjs',"export { allow } from '../config/rules.mjs';\n");write('config/rules.mjs','export const allow = true;\n');write('src/Panel.tsx','export const Panel = () => <button>Before</button>;\n');
  const git=args=>execFileSync(gitPath,['-c','core.autocrlf=false','-C',root,...args],{encoding:'utf8',windowsHide:true,timeout:10000});
  git(['init','--quiet']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','fixture baseline']);
  return{base,root,write,git,head:git(['rev-parse','HEAD']).trim()};
}
test('ADR6 authority closure follows real shared imports outside its path prefixes while allowing unrelated UI changes',async()=>{
  const c=fixture(),before=await securityClosure(c.root,gitTool);
  assert.ok(before.importGraph.files.some(file=>file.path==='config/rules.mjs'));
  c.write('src/Panel.tsx','export const Panel = () => <button>After</button>;\n');
  const ui=await securityClosure(c.root,gitTool);assert.equal(ui.digest,before.digest);assert.notEqual(ui.source.sourceDigest,before.source.sourceDigest);
  c.write('config/rules.mjs','export const allow = false;\n');assert.notEqual((await securityClosure(c.root,gitTool)).digest,before.digest);
});
test('ADR6 import analysis ignores prose, follows exports/createRequire and refuses unknown or escaped imports',()=>{
  const c=fixture();c.write('runtime/main.mjs',"import { createRequire } from 'node:module'; const local = createRequire(import.meta.url); local('../config/rules.mjs'); const prose = \"import 'fake'\";\n");
  assert.ok(authorityImportClosure(c.root,['runtime/main.mjs']).files.some(file=>file.path==='config/rules.mjs'));
  c.write('runtime/main.mjs','const target = process.env.IMPORT_TARGET; await import(target);');
  assert.throws(()=>authorityImportClosure(c.root,['runtime/main.mjs']),/dynamic authority import/);
  c.write('runtime/main.mjs',"import '../../outside.mjs';");writeFileSync(join(c.base,'outside.mjs'),'export {};');
  assert.throws(()=>authorityImportClosure(c.root,['runtime/main.mjs']),/escaped/);
});
test('ADR6 source inventory uses actual Git HEAD and refuses an unpinned tool or omitted build configuration',async()=>{
  const c=fixture();assert.equal((await sourceInventory(c.root,gitTool)).sourceCommit,c.head);
  await assert.rejects(sourceInventory(c.root,{...gitTool,sha256:'a'.repeat(64)}),/tool identity/);
  c.write('.gitignore','.env\n');c.write('.env','BUILD_MODE=other\n');await assert.rejects(sourceInventory(c.root,gitTool),/Uncaptured build configuration/);
});
test('ADR6 stage refuses invented source identity and caller-supplied baseline widening before touching a destination',async()=>{
  const c=fixture(),host=new ControlHost({root:join(c.base,'host')}),sourceDir=join(c.base,'artifacts'),buildRoot=join(c.base,'builds');mkdirSync(sourceDir);mkdirSync(buildRoot);writeFileSync(join(sourceDir,'deszo.exe'),'fixture artifact, not a native proof');
  const builds=new InstalledBuilds({host,buildRoot,gitTool,sealDirectory:async()=>({immutable:true,assurance:'fixture'}),allowedBuildCommands:[FIXTURE_BUILD]});
  const args={sourceRoot:c.root,sourceDir,sourceCommit:c.head,protocolVersion:1,storeSchemaVersion:11,launchEntry:'deszo.exe'};
  try{
    await assert.rejects(builds.stage({...args,buildId:'wrong-head',sourceCommit:'0'.repeat(40),operatorBaseline:true}),/actual|independently observed/);
    assert.equal(existsSync(join(buildRoot,'wrong-head')),false);
    const initial=await builds.stage({...args,buildId:'baseline',operatorBaseline:true,sourceBuildAttestation:await attestFixtureBuild({sourceRoot:c.root,gitTool,outputsDir:sourceDir,allowedCommands:[FIXTURE_BUILD]})});assert.equal(initial.verification.closure.source.sourceCommit,c.head);
    c.write('config/rules.mjs','export const allow = false;\n');const changed=await securityClosure(c.root,gitTool);
    await assert.rejects(builds.stage({...args,buildId:'injected',expectedTcbDigest:changed.digest}),/protected operator baseline/);
    await assert.rejects(builds.stage({...args,buildId:'replacement',operatorBaseline:true,expectedTcbDigest:changed.digest}),/separate verified trust update/);
    assert.equal(existsSync(join(buildRoot,'injected')),false);assert.equal(existsSync(join(buildRoot,'replacement')),false);
  }finally{host.close();}
});

test('ADR6 enablement invalidates receipts when trusted configuration/tools change even if installed file hashes are identical',()=>{
  const root=ownedDir(join(tmpdir(),'deszo-gate-source-')),host=new ControlHost({root});
  try{
    const installation={files:{'service-runtime.mjs':'a'.repeat(64)},tools:{git:gitTool},profileRoot:'profile-A'};
    const original=new InstalledEnablement({host,installation}),sourceDigest=original.sourceDigest;
    original.record({capability:'protectedService',sourceDigest,evidence:{assurance:'native',sourceDigest,recordedAt:new Date().toISOString(),probeSourceSha256:'b'.repeat(64),checks:REQUIRED_NATIVE_CHECKS.protectedService.map(id=>({id,passed:true,evidence:{fixtureRecord:true}}))}});
    assert.equal(original.missing().includes('protectedService'),false);
    for(const changed of [{...installation,profileRoot:'profile-B'},{...installation,tools:{git:{...gitTool,sha256:'c'.repeat(64)}}}]){
      const gate=new InstalledEnablement({host,installation:changed});assert.notEqual(gate.sourceDigest,sourceDigest);assert.equal(gate.missing().includes('protectedService'),true);assert.equal(gate.restore(),false);
    }
    assert.throws(()=>original.enable(),/Fixture authority cannot be promoted/);
  }finally{host.close();}
});

test('ADR6 diagnostic staging cannot establish a routine trust baseline or promote the same build identity',async()=>{
  const c=fixture(),host=new ControlHost({root:join(c.base,'host')}),sourceDir=join(c.base,'artifacts'),buildRoot=join(c.base,'builds');mkdirSync(sourceDir);mkdirSync(buildRoot);writeFileSync(join(sourceDir,'deszo.exe'),'diagnostic-only fixture');
  const builds=new InstalledBuilds({host,buildRoot,gitTool,sealDirectory:async()=>({immutable:true,assurance:'fixture'}),allowedBuildCommands:[FIXTURE_BUILD]});
  const args={buildId:'diagnostic',sourceRoot:c.root,sourceDir,sourceCommit:c.head,protocolVersion:1,storeSchemaVersion:11,launchEntry:'deszo.exe',operatorBaseline:true};
  try{
    const staged=await builds.stage({...args,diagnosticOnly:true});assert.equal(staged.verification.diagnosticOnly,true);assert.equal(staged.verification.sourceBuildAttestation,null);
    assert.equal(host.all("SELECT key FROM host_meta WHERE key LIKE 'build-tcb-baseline:%'").length,0);
    await assert.rejects(builds.stage({...args,diagnosticOnly:false}),/cannot be promoted/);
    await assert.rejects(builds.stage({...args,buildId:'routine',operatorBaseline:false}),/protected operator baseline/);
  }finally{host.close();}
});
