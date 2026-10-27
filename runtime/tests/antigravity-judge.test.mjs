import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravityJudgeAdapter } from '../core/antigravityJudgeAdapter.mjs';
import { ownedDir } from './test-roots.mjs';

const registration={provider:'antigravity',model:'gemini-3.8-flash-high',effort:'high',ownership:'dedicated',billing:'subscription_only',nativeSessionId:randomUUID()};
function proposal(){
  const attention={attentionId:randomUUID(),judgeSessionId:randomUUID(),runId:randomUUID()},invocationId=randomUUID(),readId=randomUUID();
  const decision={schemaVersion:1,kind:'JudgeDecision',decisionId:randomUUID(),...attention,invocationId,ownerGeneration:1,workflowRevision:1,workflowSnapshotSha256:'a'.repeat(64),subjectDigest:'b'.repeat(64),candidateDigest:'',evidenceDigest:'c'.repeat(64),evidenceReadIds:[readId],verdict:'REVISE',rationale:'Failing verification needs revision.'};
  const envelope={status:'SUCCESS',conversation_id:registration.nativeSessionId,structured_output:decision,denied_actions:[],num_turns:2,usage:{input_tokens:100,output_tokens:20,thinking_tokens:5,total_tokens:120}};
  return {attention,invocationId,readId,decision,envelope,context:{registration,attention,invocationId,requiredReadIds:[readId]},result:{exitCode:0,stdout:JSON.stringify(envelope),terminationConfirmed:true}};
}
async function settings(value,bytes){const root=ownedDir(join(tmpdir(),'deszo-judge-settings-')),path=join(root,'settings.json');await writeFile(path,bytes??JSON.stringify(value));return path;}
const authenticated=async()=>({verified:true,authMethod:'consumer',subscriptionEligible:true,quotaProject:''});

test('Antigravity Judge refuses real launch without an installed trusted launcher and cannot convert a managed role',async()=>{
  const adapter=new AntigravityJudgeAdapter({cliPath:'unused'});
  await assert.rejects(()=>adapter.startTurn({}),e=>e.code==='judge_native_launch_unavailable');
  assert.throws(()=>adapter.buildInvocation({registration,prompt:'x',schemaPath:'schema',cwd:'.',env:{DESZO_MANAGED_INVOCATION:'runtime-marker'}}),e=>e.code==='managed_invocation_denied');
  assert.deepEqual(await adapter.reconcileUncertainTurn({}),{outcome:'unknown',retryAllowed:false,reason:'No authoritative external/native turn reconciliation is available.'});
});
test('Antigravity Judge preserves explicit model/effort/session, stdin and native JSON schema without bypass flags',()=>{
  const adapter=new AntigravityJudgeAdapter({cliPath:'agy.exe'});
  const invocation=adapter.buildInvocation({registration,prompt:'Untrusted text: $(not a shell command)',schemaPath:'schema.json',cwd:'.',env:{}});
  assert.equal(invocation.stdin,'Untrusted text: $(not a shell command)');assert.ok(!invocation.args.includes(invocation.stdin));
  assert.equal(invocation.args[invocation.args.indexOf('--effort')+1],'high');assert.equal(invocation.args[invocation.args.indexOf('--model')+1],registration.model);
  assert.equal(invocation.args[invocation.args.indexOf('--conversation')+1],registration.nativeSessionId);
  assert.ok(!invocation.args.some(a=>a.includes('dangerously')));assert.ok(invocation.timeoutMs<=600000);
});
test('Antigravity subscription gate rejects API keys, credits, custom quota and malformed/BOM configuration',async()=>{
  const clean=await settings({useG1Credits:false});
  const adapter=new AntigravityJudgeAdapter({settingsPath:clean,authenticationInspector:authenticated});
  for(const key of ['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_CLOUD_QUOTA_PROJECT','GOOGLE_APPLICATION_CREDENTIALS'])await assert.rejects(()=>adapter.verifyBillingMode({env:{[key]:'fixture-only'}}),e=>e.code==='judge_api_override');
  for(const value of [{},{useG1Credits:true},{useG1Credits:false,modelProvider:'external'},{useG1Credits:false,quotaProject:'metered'}]){
    adapter.settingsPath=await settings(value);await assert.rejects(()=>adapter.verifyBillingMode({env:{}}),e=>e.code==='judge_billing_forbidden');
  }
  for(const bytes of [Buffer.from([239,187,191,123,125]),Buffer.from('{invalid')]){
    adapter.settingsPath=await settings(null,bytes);await assert.rejects(()=>adapter.verifyBillingMode({env:{}}),e=>e.code==='judge_settings_invalid');
  }
});
test('Antigravity historical configuration is not authoritative current entitlement or a zero-cost proof',async()=>{
  const path=await settings({useG1Credits:false}),adapter=new AntigravityJudgeAdapter({settingsPath:path});
  await assert.rejects(()=>adapter.verifyBillingMode({env:{}}),e=>e.code==='judge_subscription_unverified');
  adapter.authenticationInspector=authenticated;const value=await adapter.verifyBillingMode({env:{}});
  assert.equal(value.configurationVerified,true);assert.match(value.exactBillingAttribution,/unavailable/);assert.equal(value.cost,undefined);
});
test('Antigravity successful-looking denied tool result, missing evidence and wrong conversation are rejected',()=>{
  const adapter=new AntigravityJudgeAdapter(),p=proposal();
  assert.throws(()=>adapter.parseResult({...p.result,stdout:JSON.stringify({...p.envelope,denied_actions:[{action:'command'}]})},p.context),e=>e.code==='judge_tool_denied');
  assert.throws(()=>adapter.parseResult(p.result,{...p.context,requiredReadIds:[]}),e=>e.code==='judge_tool_evidence_missing');
  assert.throws(()=>adapter.parseResult({...p.result,stdout:JSON.stringify({...p.envelope,conversation_id:randomUUID()})},p.context),e=>e.code==='judge_session_mismatch');
});
test('Antigravity schema and execution completeness are checked beyond exit/status/JSON parsing',()=>{
  const adapter=new AntigravityJudgeAdapter(),p=proposal();
  for(const envelope of [{...p.envelope,structured_output:null},{...p.envelope,structured_output:{...p.decision,resource_adjustments:{turns:50}}},{...p.envelope,structured_output:{...p.decision,attentionId:randomUUID()}}])assert.throws(()=>adapter.parseResult({...p.result,stdout:JSON.stringify(envelope)},p.context));
  assert.throws(()=>adapter.parseResult({...p.result,terminationConfirmed:false},p.context),e=>e.code==='judge_provider_incomplete');
  assert.throws(()=>adapter.parseResult({...p.result,stdout:'{"status":"SUCCESS","status":"SUCCESS"}'},p.context),e=>e.code==='judge_output_invalid');
  const value=adapter.parseResult(p.result,p.context);assert.deepEqual(value.usage,p.envelope.usage);assert.equal(value.usageScope,'cumulative_session');
});
