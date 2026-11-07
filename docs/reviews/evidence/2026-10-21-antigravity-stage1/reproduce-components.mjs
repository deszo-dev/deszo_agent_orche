// Exercises actual production modules. Provider turns, native launch and consent are EXPLICIT FIXTURES.
// No installed service/profile, Google authentication store or historical PoC validator is used.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { canonicalHash } from '../../../../runtime/core/canonical.mjs';
import { stage1Fixture,data } from '../../../../runtime/tests/judge-stage1-support.mjs';
import { stage1WorkerFixture } from '../../../../runtime/tests/judge-worker-support.mjs';
const directory=fileURLToPath(new URL('.',import.meta.url));
const output=async(name,value)=>writeFile(join(directory,name),JSON.stringify(value,null,2)+'\n');
const c=await stage1Fixture(),toolCalls=[],measurements=[],proposals=[];
try{
  let invocationCount=0;
  const w=await stage1WorkerFixture(c,{onEvidence:async({bridge,e,decision,invocation})=>{
    const number=++invocationCount,started=performance.now(),detailCount=number-1;
    toolCalls.push({invocationId:invocation.invocationId,tool:'read_judge_evidence',artifactId:e.artifactId,digest:e.evidenceDigest,readId:e.evidenceReadId,untrusted:e.untrusted});
    let detailBytes=0;
    const refs=e.package.modelClaims.detailReferences;
    for(const ref of refs.slice(0,detailCount)){
      const result=data(await bridge.call('read_judge_artifact',{artifactId:ref.artifact.artifactId,length:1024}));
      detailBytes+=result.length;toolCalls.push({invocationId:invocation.invocationId,tool:'read_judge_artifact',artifactId:result.artifactId,digest:result.sha256,readId:result.evidenceReadId,offset:result.offset,length:result.length,rangeSha256:result.rangeSha256,untrusted:result.untrusted});
    }
    // Even a malicious value cannot invoke an authority tool through the model's scoped Bridge.
    await assert.rejects(()=>bridge.call('submit_judge_decision',{decision}),/not found/);
    const invalid=await c.submit({...decision,decisionId:randomUUID(),resource_adjustments:{turns:50}},invocation);
    assert.equal(invalid.status,400);
    proposals.push({invocationId:invocation.invocationId,decisionId:decision.decisionId,invalidBudgetProposal:{status:invalid.status,code:invalid.body.code},decision});
    measurements.push({invocationId:invocation.invocationId,scenario:['minimal_package','one_detail','multiple_details'][number-1],packageJsonBytes:Buffer.byteLength(JSON.stringify(e)),detailCount,detailBytes,componentReadMilliseconds:Math.round((performance.now()-started)*100)/100,providerCalls:0,inputTokens:null,outputTokens:null,thinkingTokens:null,cachedTokens:null,retries:0,qualification:'Component measurements only; explicit provider/native fixtures. Not model latency, live token or billing evidence.'});
  }});
  const starts=[],startTurn=w.runtime.adapter.startTurn.bind(w.runtime.adapter);
  w.runtime.adapter.startTurn=async(input,options)=>{
    starts.push({promptBytes:Buffer.byteLength(input.prompt),model:input.registration.model,effort:input.registration.effort,activeTurnBoundMs:input.timeoutMs,providerVersion:'fixture-provider-not-executed'});
    return startTurn(input,options);
  };
  const bridgeFor=w.runtime.bridgeForInvocation;
  w.runtime.bridgeForInvocation=async invocation=>{
    const bridge=await bridgeFor(invocation),call=bridge.call;
    bridge.call=async(name,args)=>{
      const result=await call(name,args);
      toolCalls.push({invocationId:invocation.invocationId,tool:name,caller:'authenticated_worker',isError:result.isError===true,receiptDigest:result.isError?null:canonicalHash(result.structuredContent.data)});
      return result;
    };
    return bridge;
  };
  const before=c.engine.requireRun(c.runId).state,receipts=[];
  for(let index=0;index<3;index++){
    const attention=await c.attention(),t0=performance.now();w.enqueue(attention);
    const claim=w.queue.claim(c.policyId,'fixture-native-worker',c.connectionId);assert.ok(claim);
    const result=await w.execute(claim);assert.equal(result.outcome,'succeeded',JSON.stringify(result));
    w.queue.finish({...claim,result},'fixture-native-worker');receipts.push(result.decision);
    Object.assign(measurements[index],starts[index],{attentionId:attention.attentionId,queueWaitMilliseconds:0,componentDeliveryMilliseconds:Math.round((performance.now()-t0)*100)/100,executedMcpTools:2+index,explicitModelProfileRpcDenials:1,finalEngineTransition:result.decision.transition,runStatePreserved:result.decision.runStatePreserved});
  }
  assert.equal(c.engine.requireRun(c.runId).state,before);
  assert.equal(c.engine.store.get('SELECT COUNT(*) AS n FROM judge_decisions').n,3);
  const last=proposals.at(-1),row=c.engine.store.get('SELECT * FROM judge_invocations WHERE id=?',last.invocationId);
  // The scoped token itself is intentionally never persisted in this evidence. Inspect the receipt through worker auth.
  const fetched=await c.api.callExternal('GET',`/api/v2/judge-decisions/${last.decisionId}`,undefined,{headers:c.headers});
  assert.deepEqual(fetched.body,receipts.at(-1));assert.equal(row.state,'completed');
  const events=c.engine.store.readEvents(c.runId).filter(e=>e.type.startsWith('judge.')).map(e=>({envelope:e,record:c.engine.store.readJson(e.payload.record.artifactId)}));
  const hostEvents=c.host.all("SELECT sequence,event_type,payload_json,event_sha256,recorded_at FROM audit_events WHERE event_type LIKE 'judge.%' OR event_type LIKE 'worker.%' ORDER BY sequence").map(r=>({sequence:r.sequence,eventType:r.event_type,payload:JSON.parse(r.payload_json),sha256:r.event_sha256,recordedAt:r.recorded_at}));
  const ledger=c.host.status(c.policyId);assert.equal(ledger.used.providerInvocations,3);assert.equal(ledger.used.workerModelCalls,3);
  const summary={schemaVersion:1,kind:'Stage1ProductionComponentFixtureReceipt',recordedAt:new Date().toISOString(),assurance:'SOFTWARE_CONSENT_AND_NATIVE_PROVIDER_FIXTURES',actualComponents:['Engine','SQLite Store and m13','authenticated runner HTTP','MCP Bridge','ControlHost shared ledger and audit','ControllerQueue lease','judge.review service action'],providerCalls:0,nativeLaunches:0,softwareFixtureTurns:w.launches(),workflowId:c.workflow.workflowId,runId:c.runId,runStateBefore:before,runStateAfter:c.engine.requireRun(c.runId).state,decisionCount:receipts.length,receiptIds:receipts.map(r=>r.decisionId),sharedBudget:{providerInvocations:ledger.used.providerInvocations,workerModelCalls:ledger.used.workerModelCalls},hostAuditIntact:c.host.verifyAudit().intact,candidateAccepted:false,readyForMerge:false,productionPathE2E:'BLOCKED',why:'No protected native Judge launcher/custody or current consumer-subscription inspector is installed.'};
  for(const value of [summary,events,hostEvents,receipts,toolCalls,measurements,proposals]){
    const serialized=JSON.stringify(value);
    for(const secret of [c.controller.controllerToken,c.api.runner.connection.token,c.api.runner.connection.firstPartyToken])assert.ok(!serialized.includes(secret),'Refuse credential leakage into public fixture evidence.');
  }
  await output('component-receipt.json',summary);await output('engine-transition-receipts.json',receipts);await output('engine-judge-journal.json',events);
  await output('worker-delivery-trace.json',hostEvents);await output('bridge-tool-evidence.json',toolCalls);await output('component-performance.json',measurements);await output('untrusted-proposals.json',proposals);
  console.log(JSON.stringify(summary,null,2));
}finally{await c.close();}
