// Checks existing evidence and input hashes; no model, Host lifecycle operation or consent action.
import assert from 'node:assert/strict';
import { readFile,writeFile,readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory=fileURLToPath(new URL('.',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=async name=>JSON.parse(await readFile(join(directory,name),'utf8'));
const log=async name=>readFile(join(directory,name),'utf8');
const counts=text=>Object.fromEntries(['tests','pass','fail','cancelled','skipped'].map(key=>[key,Number(text.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]??NaN)]));
const full=counts(await log('full-runtime-tests.log')),targeted=counts(await log('targeted-tests.log'));
for(const result of [full,targeted]){assert.ok(result.tests>0);assert.equal(result.fail,0);assert.equal(result.cancelled,0);}
assert.equal(targeted.tests,25);
const docsText=await log('docs-check.log'),docs=JSON.parse(docsText.slice(docsText.indexOf('{')));assert.deepEqual(docs.errors,[]);
assert.match(await log('runtime-bundle.log'),/Runtime bundled into/);
const start=await json('source-inputs-at-full-suite-start.json'),final=await json('source-inputs.json');
const before=new Map(start.files.map(x=>[x.path,x.sha256])),after=new Map(final.files.map(x=>[x.path,x.sha256]));
assert.deepEqual([...before.keys()],[...after.keys()]);
const delta=[...after].filter(([path,digest])=>before.get(path)!==digest).map(([path])=>path);
assert.deepEqual(delta,['runtime/core/antigravityJudgeAdapter.mjs']);
const currentAdapter=await readFile(new URL('../../../../runtime/core/antigravityJudgeAdapter.mjs',import.meta.url),'utf8');
const reconstructed=currentAdapter
  .replace("    // The installed 1.4.4 prints successful --help to stderr (exit 0).\n    const helpText=help.code===0?`${help.stdout}\\n${help.stderr}`:'';\n",'')
  .replaceAll('helpText.includes(', 'help.stdout.includes(');
assert.equal(sha(reconstructed),before.get(delta[0]),'The sole late delta must be exactly the documented read-only help parser fix.');
for(const entry of final.files){
  assert.equal(sha(await readFile(new URL(`../../../../${entry.path}`,import.meta.url))),entry.sha256,`${entry.path} changed after final targeted checks.`);
}
const baselineExpected={
  'baseline.json':'d18fa3e2657345ce1cae97a9ba381609d72547f2b9a4d21bf975ecd102634d68',
  'baseline.mjs':'e6f3f274f962b0cc2b0aa7dc2133bd003ea532d1a4ccdefe34a98409af5e7de3',
  'legacy-grant.json':'d4b7ece36c9118075bfccd025aa174c92223e5aa34f549dc496c4187231bc507',
  'saved-observations.json':'c90f8dfa85941ab9108a9bbefd640d864c3392a9916dfc5206fef9029fcfd153',
  'source-journal.json':'934e30de7e3de863ea903342ebf08f80459c0634f242625cf13e151363817296'
};
const baselineHashes=[];
for(const [suffix,expected]of Object.entries(baselineExpected)){
  const path=`../2026-10-21-adr-0007-${suffix}`,actual=sha(await readFile(new URL(path,import.meta.url)));
  assert.equal(actual,expected,`Historical ${suffix} changed.`);baselineHashes.push({path,sha256:actual});
}
const provider=await json('provider-readonly-inspection.json');
for(const key of ['available','structuredOutput','resume','explicitModel','explicitEffort'])assert.equal(provider.capabilities[key],true);
assert.equal(provider.providerInferenceCalls,0);assert.equal(provider.capabilities.productionLaunchAvailable,false);
const component=await json('component-receipt.json');assert.equal(component.providerCalls,0);assert.equal(component.decisionCount,3);assert.equal(component.hostAuditIntact,true);
const processHygiene=await json('process-hygiene.json');assert.equal(processHygiene.remaining,0);assert.equal(processHygiene.backgroundMonitorInstalled,false);
const summary={schemaVersion:1,kind:'Stage1VerificationSummary',recordedAt:new Date().toISOString(),fullRuntimeSuite:full,targetedFinalSource:targeted,docsErrors:0,runtimeBundle:'PASS',baselineHashes,
  fullSuiteStartFingerprint:start.fingerprint,finalSourceFingerprint:final.fingerprint,
  lateSourceDelta:{paths:delta,exactReconstructionVerified:true,scope:'Successful --help stderr metadata parsing only; no admission, decision, parser, billing, execution or recovery logic changed.',supplementalChecks:['25 targeted tests on final source','installed CLI read-only capability inspection','runtime bundle on final source']},
  realProviderCalls:0,componentDecisionCount:component.decisionCount,processHygiene:{scope:processHygiene.scope,remaining:processHygiene.remaining},productionPathE2E:'BLOCKED',readiness:{adapter:'PARTIAL_PASS',bridge:'PARTIAL_PASS',engineBoundedHandoffReview:'PASS',hostWorker:'PARTIAL_PASS',subscription:'INCONCLUSIVE',operational:'BLOCKED'}};
await writeFile(join(directory,'verification-summary.json'),JSON.stringify(summary,null,2)+'\n');
const files=[];
for(const path of (await readdir(directory)).sort()){
  if(path==='artifact-manifest.json')continue;
  const bytes=await readFile(join(directory,path));files.push({path,byteSize:bytes.length,sha256:sha(bytes)});
}
await writeFile(join(directory,'artifact-manifest.json'),JSON.stringify({schemaVersion:1,kind:'Stage1EvidenceManifest',recordedAt:new Date().toISOString(),files},null,2)+'\n');
console.log(JSON.stringify({full,targeted,docsErrors:0,baselineFilesUnchanged:baselineHashes.length,sourceDeltaVerified:true,realProviderCalls:0,productionPathE2E:'BLOCKED'},null,2));
