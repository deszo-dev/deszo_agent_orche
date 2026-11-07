import test from 'node:test';
import assert from 'node:assert/strict';
import { executeJudgeReview } from '../host/judgeDelivery.mjs';
import { stage1Fixture } from './judge-stage1-support.mjs';
import { stage1WorkerFixture as setupWorker } from './judge-worker-support.mjs';


test('Existing Host queue + actual Engine/Bridge commit review under real shared ledger; provider/native are explicit fixtures',async()=>{
  const c=await stage1Fixture();try{
    const w=await setupWorker(c),a=await c.attention(),b=await c.attention();w.enqueue(a);w.enqueue(b);
    const first=w.queue.claim(c.policyId,'fixture-native-worker',c.connectionId);assert.ok(first);assert.equal(w.queue.claim(c.policyId,'other-worker',c.connectionId),null);
    const r1=await w.execute(first);assert.equal(r1.outcome,'succeeded',JSON.stringify(r1));w.queue.finish({...first,result:r1},'fixture-native-worker');
    const second=w.queue.claim(c.policyId,'fixture-native-worker',c.connectionId);assert.ok(second);const r2=await w.execute(second);assert.equal(r2.outcome,'succeeded');w.queue.finish({...second,result:r2},'fixture-native-worker');
    assert.equal(w.launches(),2);assert.equal(c.host.status(c.policyId).used.workerModelCalls,2);assert.equal(c.host.status(c.policyId).used.providerInvocations,2);
    assert.equal(c.engine.store.get('SELECT COUNT(*) AS n FROM judge_decisions').n,2);assert.equal(c.host.verifyAudit().intact,true);
    assert.match(r1.qualification,/fixtures/);
  }finally{await c.close();}
});

test('Existing Host queue fences a crashed worker and preserves unknown invocation charges without replay',async()=>{
  const c=await stage1Fixture();try{
    const w=await setupWorker(c,{fault:'after-start'}),a=await c.attention();w.enqueue(a);
    const first=w.queue.claim(c.policyId,'fixture-native-worker',c.connectionId),result=await w.execute(first);
    assert.equal(result.outcome,'reconciling');assert.equal(w.launches(),1);assert.equal(c.engine.store.get('SELECT COUNT(*) AS n FROM judge_decisions').n,0);
    assert.equal(w.queue.status(first.itemId).state,'reconciling');assert.equal(c.engine.store.get('SELECT state FROM judge_invocations').state,'unknown');
    assert.equal(c.host.status(c.policyId).used.workerModelCalls,1);assert.equal(w.queue.claim(c.policyId,'replacement',c.connectionId),null);
  }finally{await c.close();}
});

test('Existing worker refuses missing Judge runtime before charging or calling any provider',async()=>{
  const c=await stage1Fixture();try{
    const w=await setupWorker(c),a=await c.attention();w.enqueue(a);const first=w.queue.claim(c.policyId,'fixture-native-worker',c.connectionId);
    const result=await executeJudgeReview({host:c.host,queue:w.queue,connection:{controller:{connectionId:c.connectionId}},policyId:c.policyId,requestId:first.requestId,step:first.step,itemId:first.itemId,workerId:'fixture-native-worker',lease:first.lease,runtime:null});
    assert.equal(result.reason,'judge_native_delivery_unavailable');assert.equal(w.launches(),0);assert.equal(c.host.status(c.policyId).used.workerModelCalls,0);
  }finally{await c.close();}
});

test('Non-fixture Host refuses Judge delivery without independent native custody before any charge',async()=>{
  const c=await stage1Fixture();try{
    const w=await setupWorker(c),a=await c.attention();w.enqueue(a);const first=w.queue.claim(c.policyId,'fixture-native-worker',c.connectionId);
    // Override only the fixture object's label to exercise the guard; no native proof is asserted.
    c.host.assurance='production';
    const result=await w.execute(first);
    assert.equal(result.reason,'judge_native_custody_unavailable');assert.equal(w.launches(),0);assert.equal(c.host.status(c.policyId).used.workerModelCalls,0);
    assert.equal(c.engine.store.get('SELECT COUNT(*) AS n FROM judge_invocations').n,0);
  }finally{await c.close();}
});
