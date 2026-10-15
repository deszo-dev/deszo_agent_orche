// A bounded real-provider TaskReturn probe, using the production adapters and full validation.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {startRunner} from '../runtime/runner.mjs';
import {outputSchema} from '../runtime/core/map.mjs';
import {singleAgent} from '../runtime/tests/helpers.mjs';

const root=resolve(process.argv[2]);
assert.ok(!existsSync(join(root,'store/state.sqlite')),'Use a fresh probe root.');
mkdirSync(root,{recursive:true});
const runner=await startRunner({root});
const api=async(method,path,body,extraHeaders={})=>{
  const response=await fetch(`http://127.0.0.1:${runner.connection.port}/api/v2${path}`,{
    method,headers:{Authorization:`Bearer ${runner.connection.firstPartyToken}`,...(body?{'Content-Type':'application/json'}:{}),...extraHeaders},body:body?JSON.stringify(body):undefined
  });
  const result=await response.json();
  assert.ok(response.ok,`${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
};
try{
  await api('PUT','/workspaces/main',{cwd:join(runner.connection.scratchRoot,'main')});
  const workflow=singleAgent({id:'task-return-probe',provider:'antigravity',model:'gemini-3.8-flash-low',context:null,timeoutSeconds:90,
    output:{format:'json',schema:outputSchema('taskReturn')}});
  workflow.nodes.find(n=>n.id==='request').config.value='This is only an output-encoding probe; no tools or file changes are needed. Return a TaskReturn with kind candidate and summary OK. Encode fields forbidden by the candidate branch as null in the native finish object. Return the identical encoded object as the final response. Do not report specification_revision_required or invent any issues.';
  const saveResponse=await fetch(`http://127.0.0.1:${runner.connection.port}/api/v3/workflows/${workflow.workflowId}`,{
    method:'PUT',headers:{Authorization:`Bearer ${runner.connection.firstPartyToken}`,'Content-Type':'application/json','If-None-Match':'*'},
    body:JSON.stringify({requestId:randomUUID(),expectedEtag:null,workflow})
  });
  const saved=await saveResponse.json();assert.ok(saveResponse.ok,`workflow save: ${saveResponse.status} ${JSON.stringify(saved)}`);
  const created=await api('POST','/runs',{workflowId:workflow.workflowId,workflowSnapshotSha256:saved.snapshotSha256,workspaceId:'main',requestId:randomUUID()});
  if(created.outcome==='confirmation_pending')throw new Error(`Run request ${created.requestId} is pending; the isolated probe expected first-party direct execution.`);
  if(created.outcome!=='created'||!created.run?.runId)throw new Error('The runtime returned an unsupported run outcome.');
  let snapshot;
  const stop=Date.now()+120_000;
  do{
    snapshot=await api('GET','/runs/'+created.run.runId);
    if(['succeeded','failed','canceled','interrupted','waiting_for_user'].includes(snapshot.run.state))break;
    await new Promise(done=>setTimeout(done,500));
  }while(Date.now()<stop);
  const events=runner.engine.store.readEvents(created.run.runId,0);
  writeFileSync(join(root,'probe.json'),JSON.stringify({snapshot,events},null,2));
  console.log(JSON.stringify({root,state:snapshot.run.state,runId:snapshot.run.runId,errors:events.filter(e=>e.type==='attempt.error').map(e=>e.payload)}));
  assert.equal(snapshot.run.state,'succeeded');
}finally{await runner.close();}
