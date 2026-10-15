// RERUN-04 check after the fix: replays the captured Map-issued blocker through the corrected Gate.
// Read-only: the source store is opened read-only; counterfactual decisions exist only in memory.
// Synthetic decisions exist only in memory; no approvals, journal rows or source artifacts are written.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {parseStrictJson,canonicalBytes} from '../runtime/core/canonical.mjs';
import {evaluate} from '../runtime/core/gate.mjs';

const root=resolve(process.argv[2]);
const prefix=process.argv[3]||'delivery/2/specification/1';
const reportPath=resolve(process.argv[4]||join(root,'evidence/issue-resolution-probe.json'));
const db=new DatabaseSync(join(root,'store/state.sqlite'),{readOnly:true});
const memory=new Map();
const bytes=id=>{
  if(memory.has(id))return memory.get(id);
  const row=db.prepare('SELECT * FROM artifacts WHERE id=?').get(id);
  assert.ok(row,`Missing artifact ${id}`);
  const value=readFileSync(join(root,'store',row.relative_path));
  assert.equal(value.length,row.byte_size);
  assert.equal(createHash('sha256').update(value).digest('hex'),row.sha256);
  return value;
};
const store={
  verifyRef(reference){assert.equal(createHash('sha256').update(bytes(reference.artifactId)).digest('hex'),reference.sha256);},
  readJson(id){return parseStrictJson(bytes(id).toString('utf8'));},
  readBytes(id){return {bytes:bytes(id),row:{}};}
};
const json=value=>{
  const data=canonicalBytes(value),artifactId=randomUUID();
  memory.set(artifactId,data);
  return {type:'JsonValue',artifact:{artifactId,sha256:createHash('sha256').update(data).digest('hex')}};
};
const attempt=node=>{
  const row=db.prepare('SELECT * FROM attempts WHERE node_instance_id=? ORDER BY rowid DESC LIMIT 1').get(node);
  assert.ok(row?.outputs_artifact_id,`Missing committed output for ${node}`);
  return {row,values:store.readJson(row.outputs_artifact_id).values};
};
try{
  const prepared=attempt(prefix+'/prepare');
  const plan=store.readJson(prepared.values.plan.artifact.artifactId);
  const workflow=JSON.parse(readFileSync(join(root,'evidence/workflow.json'),'utf8'));
  const body=workflow.nodes.find(n=>n.id==='delivery').config.body.nodes.find(n=>n.id==='specification').config.body;
  const config=body.nodes.find(n=>n.id==='evaluate').config;
  const inputs={subject:prepared.values.subject,plan:prepared.values.plan},reviewers={};
  const original={};
  for(const slot of config.policy.slots){
    const review=attempt(prefix+'/'+slot.id+'-review');
    original[slot.id]=store.readJson(review.values.json.artifact.artifactId);
    inputs[slot.id]=review.values.json;
    reviewers[slot.id]={nodeInstanceId:review.row.node_instance_id,attemptId:review.row.id,requestedModel:store.readJson(review.row.invocation_artifact_id).requestedModel,observedModel:null};
  }
  const issue=plan.openIssues.find(issue=>issue.id.startsWith('ISS-MAP-')&&issue.severity==='blocker');
  assert.ok(issue,'The captured plan must contain a Map-issued blocker.');
  const run=values=>{
    try{
      const result=evaluate({store,config,inputs:{...inputs,...values},reviewers,runId:prepared.row.run_id,now:new Date().toISOString()});
      return {status:result.status,reason:result.reason,issues:result.issues};
    }catch(error){return {error:{code:error.code,message:error.message}};}
  };
  const recorded=run({});
  // Counterfactual approvals isolate resolution from any remaining model-requested changes.
  const approved=slot=>({...original[slot.id],verdict:'APPROVED',issues:[],resolvedIssueIds:[]});
  const withoutResolution=Object.fromEntries(config.policy.slots.map(slot=>[slot.id,json(approved(slot))]));
  const unclaimed=run(withoutResolution);
  const claims=config.policy.slots.map(slot=>({slot:slot.id,...run({...withoutResolution,[slot.id]:json({...approved(slot),resolvedIssueIds:[issue.id]})})}));
  const report={createdAt:new Date().toISOString(),root,prefix,runId:prepared.row.run_id,subjectId:plan.subjectId,issue,
    recordedDecisions:{verdicts:Object.fromEntries(Object.entries(original).map(([slot,decision])=>[slot,decision.verdict])),evaluation:recorded},
    allApprovedWithoutResolution:{status:unclaimed.status,blockerStillOpen:unclaimed.issues.some(item=>item.id===issue.id)},
    eachSlotClaimsResolution:claims.map(claim=>({slot:claim.slot,status:claim.status??null,error:claim.error?.message??null})),
    sourceStoreReadOnly:true,syntheticDecisionsOnlyInMemory:true};
  const ok=!recorded.error&&unclaimed.issues.some(item=>item.id===issue.id)&&claims.some(claim=>claim.status==='OPEN');
  writeFileSync(reportPath,JSON.stringify(report,null,2)+String.fromCharCode(10));
  console.log(JSON.stringify({reportPath,recorded:recorded.status??recorded.error?.code,claims:report.eachSlotClaimsResolution.map(item=>`${item.slot}:${item.status??'refused'}`)}));
  process.exitCode=ok?0:1;
}finally{db.close();}
