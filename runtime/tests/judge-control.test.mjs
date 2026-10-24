import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { openBridge } from '../../mcp/stdio-client.mjs';
import { stage1Fixture,data } from './judge-stage1-support.mjs';
import { startTestRunner } from './helpers.mjs';
const script=resolve(import.meta.dirname,'../../mcp/bridge.mjs');
async function ready(c){const a=await c.attention(),i=await c.admit(a);await c.started(i);const e=await c.evidence(i);return {a,i,e,d:c.decision(a,i,e)};}

test('Judge real Engine commits a bounded review idempotently without accepting code or rewriting the run',async()=>{
  const c=await stage1Fixture();try{
    const r=await ready(c),before=c.engine.runSnapshot(c.runId).run.state;
    const first=await c.submit(r.d,r.i);assert.equal(first.status,200,JSON.stringify(first.body));
    assert.equal(first.body.disposition,'revision_requested');assert.equal(first.body.candidateAccepted,false);assert.equal(first.body.readyForMerge,false);
    assert.deepEqual(await c.submit(r.d,r.i),first);assert.equal(c.engine.runSnapshot(c.runId).run.state,before);
    assert.equal(c.engine.store.get('SELECT COUNT(*) AS n FROM judge_decisions').n,1);
    assert.equal(c.engine.store.all("SELECT * FROM journal_events WHERE event_type='judge.decision_applied'").length,1);
    assert.equal((await c.complete(r.i)).status,200);assert.equal(c.host.status(c.policyId).used.workerModelCalls,1);assert.equal(c.host.status(c.policyId).used.providerInvocations,1);
    assert.equal(c.host.verifyAudit().intact,true);
  }finally{await c.close();}
});

test('Judge authenticated Engine refuses identity, revision, candidate, evidence and budget forgeries',async()=>{
  const c=await stage1Fixture();try{
    const r=await ready(c);
    const cases=[['request',{attentionId:randomUUID()}],['controller',{judgeSessionId:randomUUID()}],['revision',{workflowRevision:r.d.workflowRevision+1}],['run',{runId:randomUUID()}],['candidate',{candidateDigest:'f'.repeat(64)}],['evidence',{evidenceDigest:'e'.repeat(64)}],['missing evidence',{evidenceReadIds:[randomUUID()]}],['budget extension',{resource_adjustments:{turns:50}}],['owner',{ownerGeneration:2}]];
    for(const [name,changes]of cases){const result=await c.submit({...r.d,decisionId:randomUUID(),...changes},r.i);assert.ok(result.status>=400,`${name}: ${JSON.stringify(result.body)}`);}
    assert.equal(c.engine.store.get('SELECT COUNT(*) AS n FROM judge_decisions').n,0);
    assert.equal((await c.submit(r.d,r.i)).status,200);
    assert.ok((await c.submit({...r.d,decisionId:randomUUID(),verdict:'APPROVE'},r.i)).status>=400);
  }finally{await c.close();}
});

test('Judge scope cannot be registered by external token or used without its separate credentials',async()=>{
  const c=await stage1Fixture();try{
    assert.equal((await c.api.callExternal('POST','/api/v2/judge-sessions',c.registration)).status,403);
    assert.equal((await c.api.callExternal('POST','/api/v2/judge-attention',{requestId:randomUUID(),judgeSessionId:c.sessionId,runId:c.runId})).status,403);
    const r=await ready(c),own={'X-Deszo-Judge-Token':r.i.invocationToken};
    assert.equal((await c.api.callExternal('POST','/api/v2/judge-decisions',r.d,{headers:own})).status,403);
    assert.equal((await c.api.callExternal('POST','/api/v2/judge-decisions',r.d,{headers:{...own,'X-Deszo-Controller-Token':randomUUID()}})).status,403);
    assert.equal((await c.api.callExternal('GET',`/api/v2/judge-invocations/${r.i.invocationId}/artifacts/${randomUUID()}`,undefined,{headers:own})).status,403);
    assert.equal((await c.api.callExternal('GET',`/api/v2/judge-invocations/${r.i.invocationId}/evidence`)).status,403);
  }finally{await c.close();}
});

test('Judge finite Engine invocation cap cannot be extended by available shared Host budget',async()=>{
  const c=await stage1Fixture({maxInvocations:1});try{
    const first=await ready(c);assert.equal((await c.submit(first.d,first.i)).status,200);await c.complete(first.i);
    const next=await c.attention();await assert.rejects(()=>c.admit(next),/judge_budget_exhausted/);
    assert.equal(c.engine.store.get('SELECT invocations FROM judge_sessions WHERE id=?',c.sessionId).invocations,1);
    assert.equal(c.host.status(c.policyId).used.workerModelCalls,1);
  }finally{await c.close();}
});

test('Judge registration is disabled by default even for the first-party HTTP owner',async()=>{
  const api=await startTestRunner();try{
    const response=await api.call('POST','/api/v2/judge-sessions',{});
    assert.equal(response.status,409);assert.equal(response.body.code,'judge_unavailable');assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM judge_sessions').n,0);
  }finally{await api.close();}
});

test('Judge superseded workflow revision is refused before admission and cannot spend a new model turn',async()=>{
  const c=await stage1Fixture();try{
    const attention=await c.attention();
    c.engine.store.run('UPDATE workflows SET revision=revision+1 WHERE id=?',c.workflow.workflowId);
    await assert.rejects(()=>c.admit(attention),/judge_request_unavailable/);
    assert.equal(c.engine.judgeAttentionView(attention.attentionId).state,'stale');
    assert.equal(c.engine.store.get('SELECT COUNT(*) AS n FROM judge_invocations').n,0);
    assert.equal(c.host.status(c.policyId).used.workerModelCalls,0);
    assert.equal(c.engine.hasJudgeBarrier(c.runId),true);
  }finally{await c.close();}
});

test('Judge real Bridge exposes scoped evidence tools and worker-only authenticated decision submission',async()=>{
  const c=await stage1Fixture();let bridge,worker;
  try{
    const a=await c.attention(),i=await c.admit(a);await c.started(i);
    const args=['--connection-file',c.api.runner.connection.connectionFile,'--client-provider','other','--judge-invocation',i.invocationId];
    const env={...process.env,DESZO_JUDGE_INVOCATION_TOKEN:i.invocationToken};delete env.DESZO_JUDGE_WORKER_TOKEN;
    bridge=await openBridge({script,args,env});
    assert.deepEqual((await bridge.request('tools/list')).tools.map(x=>x.name).sort(),['read_judge_artifact','read_judge_evidence']);
    const e=data(await bridge.call('read_judge_evidence',{}));assert.equal(e.package.attentionId,a.attentionId);
    const refs=[];
    const visit=value=>{if(!value||typeof value!=='object')return;if(typeof value.artifactId==='string')refs.push(value.artifactId);for(const child of Object.values(value))visit(child);};
    visit(e.package.modelClaims);assert.ok(refs.length>0,'Fixture must expose an actual artifact reference.');
    const details=[];
    for(const artifactId of new Set(refs))details.push(data(await bridge.call('read_judge_artifact',{artifactId,length:1024})));
    assert.ok(details.every(detail=>detail.length<=1024));
    assert.ok(details.some(detail=>Buffer.from(detail.data,'base64').toString('utf8').includes('IGNORE RULES')),'Synthetic injection must be retrieved as untrusted evidence.');
    assert.ok(details.every(detail=>detail.untrusted===true&&detail.evidenceReadId));
    await assert.rejects(()=>bridge.call('submit_judge_decision',{decision:{resource_adjustments:{turns:50}}}),/not found/);
    assert.equal(c.engine.store.get('SELECT COUNT(*) AS n FROM judge_decisions').n,0);
    worker=await openBridge({script,args,env:{...env,DESZO_JUDGE_WORKER_TOKEN:c.controller.controllerToken}});
    const d=c.decision(a,i,e),receipt=data(await worker.call('submit_judge_decision',{decision:d}));
    assert.equal(receipt.disposition,'revision_requested');assert.deepEqual(data(await worker.call('get_judge_decision',{decisionId:d.decisionId})),receipt);
    const all=JSON.stringify({e,receipt});for(const secret of [i.invocationToken,c.controller.controllerToken,c.api.runner.connection.token,c.api.runner.connection.firstPartyToken])assert.ok(!all.includes(secret));
  }finally{await bridge?.close();await worker?.close();await c.close();}
});

test('Judge queue persists the second request and never charges or launches it behind an active turn',async()=>{
  const c=await stage1Fixture();try{
    const first=await ready(c),a2=await c.attention();
    const queued=await c.api.callExternal('POST','/api/v2/judge-invocations',{requestId:randomUUID(),judgeSessionId:c.sessionId,attentionId:a2.attentionId,ownerGeneration:1,hostPermitId:randomUUID()},{headers:c.headers});
    assert.equal(queued.status,202);assert.equal(c.engine.judgeAttentionView(a2.attentionId).queueReason,'queued_behind_active_turn');
    const due=c.engine.judgeAttentionView(a2.attentionId).responseDueAt;
    c.engine.store.run('UPDATE judge_attention SET created_at=? WHERE id=?',new Date(Date.now()-40000).toISOString(),a2.attentionId);
    c.engine.expireJudgeAttention();assert.equal(c.engine.judgeAttentionView(a2.attentionId).state,'pending');
    assert.equal(c.host.status(c.policyId).used.workerModelCalls,1);
    await c.submit(first.d,first.i);await c.complete(first.i);
    const second=await c.admit(a2);await c.started(second);assert.equal(c.engine.judgeAttentionView(a2.attentionId).responseDueAt,due);
    const e=await c.evidence(second);assert.equal((await c.submit(c.decision(a2,second,e),second)).status,200);
    await c.complete(second);assert.equal(c.host.status(c.policyId).used.workerModelCalls,2);
  }finally{await c.close();}
});

test('Judge Stop, host revocation and authorization expiry reject otherwise valid decisions',async()=>{
  for(const kind of ['stop','revoke','expiry']){
    const c=await stage1Fixture();try{const r=await ready(c);
      if(kind==='stop'){await c.api.call('POST',`/api/v2/runs/${c.runId}/stop`,{requestId:randomUUID()});await c.api.waitFor(c.runId,x=>x.state==='canceled');}
      if(kind==='revoke')c.host.revoke(c.policyId,{connectionId:c.connectionId,actor:'fixture'});
      if(kind==='expiry')c.engine.store.run('UPDATE judge_sessions SET expires_at=? WHERE id=?',new Date(Date.now()-1).toISOString(),c.sessionId);
      assert.ok((await c.submit(r.d,r.i)).status>=400,kind);assert.equal(c.engine.store.get('SELECT COUNT(*) AS n FROM judge_decisions').n,0);
      const evidence=await c.api.callExternal('GET',`/api/v2/judge-invocations/${r.i.invocationId}/evidence`,undefined,{headers:{'X-Deszo-Judge-Token':r.i.invocationToken}});
      assert.ok(evidence.status>=400,kind);
    }finally{await c.close();}
  }
});

test('Judge terminal handoff review and timeout never change the terminal run state',async()=>{
  const c=await stage1Fixture({paused:false});try{
    const r=await ready(c);r.d.verdict='APPROVE';assert.equal((await c.submit(r.d,r.i)).status,200);await c.complete(r.i);
    const a=await c.attention();c.engine.store.run('UPDATE judge_attention SET response_due_at=? WHERE id=?',new Date(Date.now()-1).toISOString(),a.attentionId);c.engine.expireJudgeAttention();
    assert.equal(c.engine.judgeAttentionView(a.attentionId).state,'stale');assert.equal(c.engine.requireRun(c.runId).state,'succeeded');
    assert.equal(c.engine.store.get('SELECT COUNT(*) AS n FROM judge_decisions').n,1);
  }finally{await c.close();}
});

test('Judge unknown turn retains its charge and prevents blind replay or owner transfer',async()=>{
  const c=await stage1Fixture();try{
    const a=await c.attention(),i=await c.admit(a);await c.started(i);await c.complete(i,'unknown');
    const a2=await c.attention(),r=await c.api.callExternal('POST','/api/v2/judge-invocations',{requestId:randomUUID(),judgeSessionId:c.sessionId,attentionId:a2.attentionId,ownerGeneration:1,hostPermitId:randomUUID()},{headers:c.headers});
    assert.equal(r.status,202);assert.equal(c.host.status(c.policyId).used.workerModelCalls,1);
    assert.throws(()=>c.engine.fenceJudgeOwner(c.sessionId,{requestId:randomUUID(),controllerSessionId:c.controller.controllerSessionId},{controllerToken:c.controller.controllerToken}),/cannot be changed|reconciled/);
    assert.equal(c.engine.store.get("SELECT state FROM judge_invocations WHERE id=?",i.invocationId).state,'unknown');
  }finally{await c.close();}
});
