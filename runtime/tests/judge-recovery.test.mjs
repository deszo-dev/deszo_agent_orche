import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { openBridge } from '../../mcp/stdio-client.mjs';
import { stage1Fixture } from './judge-stage1-support.mjs';
import { startTestRunner } from './helpers.mjs';

test('Judge durable pending requests survive runtime crash/restart; uncertain turns are never re-dispatched',async()=>{
  for(const phase of ['before_delivery','after_admission','after_start','after_evidence','after_decision']){
    const c=await stage1Fixture({paused:false});let reopened,closed=false;
    try{
      const a=await c.attention();let i,d;
      if(phase!=='before_delivery')i=await c.admit(a);
      if(['after_start','after_evidence','after_decision'].includes(phase))await c.started(i);
      if(['after_evidence','after_decision'].includes(phase)){const e=await c.evidence(i);d=c.decision(a,i,e);}
      if(phase==='after_decision')assert.equal((await c.submit(d,i)).status,200);
      const oldRuntime=c.engine.runtimeInstanceId;await c.api.close();closed=true;
      reopened=await startTestRunner({root:c.api.root,runner:{judgeAttentionEnabled:true}});
      assert.notEqual(reopened.runner.engine.runtimeInstanceId,oldRuntime);
      assert.equal(reopened.runner.engine.requireRun(c.runId).state,'succeeded');
      assert.equal(reopened.runner.engine.store.get('SELECT COUNT(*) AS n FROM judge_attention').n,1);
      if(i)assert.equal(reopened.runner.engine.store.get('SELECT state FROM judge_invocations WHERE id=?',i.invocationId).state,'unknown');
      const stale=await reopened.callExternal('GET',`/api/v2/judge-sessions/${c.sessionId}/attention`,undefined,{headers:c.headers});
      assert.equal(stale.status,403);assert.equal(stale.body.code,'judge_runtime_reregistration_required');
      if(d&&phase==='after_decision'){
        const receipt=await reopened.callExternal('GET',`/api/v2/judge-decisions/${d.decisionId}`,undefined,{headers:c.headers});assert.equal(receipt.status,200);assert.equal(receipt.body.disposition,'revision_requested');
        assert.equal(reopened.runner.engine.store.get('SELECT COUNT(*) AS n FROM judge_decisions').n,1);
      }
    }finally{await reopened?.close();if(!closed)await c.api.close();c.host.close();}
  }
});

test('Judge concurrent admission race consumes only one Engine slot and retains correct shared charges',async()=>{
  const c=await stage1Fixture();try{
    const a=await c.attention(),b=await c.attention(),r=await Promise.allSettled([c.admit(a),c.admit(b)]);
    assert.equal(c.engine.store.get('SELECT COUNT(*) AS n FROM judge_invocations').n,1);
    assert.equal(c.engine.store.get('SELECT invocations FROM judge_sessions WHERE id=?',c.sessionId).invocations,1);
    assert.equal(c.host.status(c.policyId).used.workerModelCalls,1);
    assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
  }finally{await c.close();}
});

test('Judge scoped Bridge retains the managed-invocation refusal for evidence and decisions',async()=>{
  const c=await stage1Fixture();let bridge;try{
    const a=await c.attention(),i=await c.admit(a);
    bridge=await openBridge({script:resolve(import.meta.dirname,'../../mcp/bridge.mjs'),args:['--connection-file',c.api.runner.connection.connectionFile,'--client-provider','other','--judge-invocation',i.invocationId],env:{...process.env,DESZO_MANAGED_INVOCATION:randomUUID(),DESZO_JUDGE_INVOCATION_TOKEN:i.invocationToken,DESZO_JUDGE_WORKER_TOKEN:c.controller.controllerToken}});
    const r=await bridge.call('read_judge_evidence',{});assert.equal(r.isError,true);assert.equal(r.structuredContent.error.code,'managed_invocation_denied');
    assert.equal(c.engine.store.get('SELECT COUNT(*) AS n FROM judge_evidence_reads').n,0);
  }finally{await bridge?.close();await c.close();}
});

test('Judge queue and response expiry preserve barriers and refuse delayed starts without changing terminal history',async()=>{
  for(const kind of ['queue','wake','response']){
    const c=await stage1Fixture({paused:false});try{
      const a=await c.attention();let i;
      if(kind!=='queue')i=await c.admit(a);
      if(kind==='response')await c.started(i);
      const past=new Date(Date.now()-1).toISOString();
      if(kind==='queue')c.engine.store.run('UPDATE judge_attention SET queue_due_at=? WHERE id=?',past,a.attentionId);
      if(kind==='wake')c.engine.store.run('UPDATE judge_invocations SET wake_due_at=? WHERE id=?',past,i.invocationId);
      if(kind==='response')c.engine.store.run('UPDATE judge_attention SET response_due_at=? WHERE id=?',past,a.attentionId);
      c.engine.expireJudgeAttention();assert.equal(c.engine.judgeAttentionView(a.attentionId).state,'stale');assert.equal(c.engine.requireRun(c.runId).state,'succeeded');assert.equal(c.engine.hasJudgeBarrier(c.runId),true);
      assert.equal(c.engine.judgeAttentionView(a.attentionId).reason,kind==='response'?'attention_response_timeout':'attention_delivery_timeout');
      if(kind==='wake')assert.throws(()=>c.engine.recordJudgeStarted(i.invocationId,{nativeSessionId:c.registration.nativeSessionId,turnId:'late'},{controllerToken:c.controller.controllerToken}),/stale/);
    }finally{await c.close();}
  }
});
