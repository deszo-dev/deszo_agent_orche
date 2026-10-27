// Injected authority/lifecycle tests. A real installed diagnostic policy still requires physical Windows Hello.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {canonicalBytes} from '../core/canonical.mjs';
import {ControlHost} from '../host/authority.mjs';
import {manualTimeSource} from '../host/timeSource.mjs';
import {ControllerQueue} from '../host/controllerQueue.mjs';
import {ApplicationLifecycle,createBuildManifest} from '../host/lifecycle.mjs';
import {ApplicationStop} from '../host/applicationStop.mjs';
import {Engine} from '../core/engine.mjs';
import { ownedDir } from './test-roots.mjs';

const publicText=key=>key.export({format:'der',type:'spki'}).toString('base64');
function setup({plannedClose=false}={}){
  const root=ownedDir(join(tmpdir(),'deszo-verification-bootstrap-')),time=manualTimeSource(),host=new ControlHost({root:join(root,'host'),time}),key=generateKeyPairSync('ed25519'),controller=generateKeyPairSync('ed25519');
  host.enrollCredential({credentialId:'fixture',publicKey:publicText(key.publicKey),label:'fixture only'},{enrolledBy:'fixture'});
  const scope={verificationOnly:true,dataProfile:'native-probe',workspaces:[{workspaceId:'main',cwdIdentity:'a'.repeat(64)}],workflows:[{workflowId:'preserved-reference',baselineSha256:'b'.repeat(64),permittedRevisions:[]}],operations:['app.verify','runtime.reregister','run.stop_and_report',...(plannedClose?['app.stop']:[])],commands:[],desktop:{user:'fixture-user',sessionId:1},buildRoot:join(root,'builds'),applicationMode:'separate_preview',deliveryBoundary:'candidate'};
  const limits={attempts:0,providerInvocations:0,workerModelCalls:0,operations:10,restarts:3,repairs:0,builds:0};
  const plan={schemaVersion:1,kind:'ControllerPlan',mode:'deterministic',steps:[{type:'lifecycle.verify',args:{buildId:'native-probe',requireUi:true}}]};
  const args={controller:{controllerId:'fixture-controller',publicKey:publicText(controller.publicKey)},scope,limits,durationMs:3600000,initialPlan:plan};
  const proposal=host.proposePolicy(args),clientData={type:'deszo.autonomy.consent',challengeId:proposal.challengeId,nonce:proposal.nonce,decisionDigest:proposal.decisionDigest,audience:proposal.audience},flags={userPresent:true,userVerified:true};
  const {policyId}=host.authorizePolicy({challengeId:proposal.challengeId,assertion:{credentialId:'fixture',clientData,flags,signature:sign(null,canonicalBytes({clientData,flags}),key.privateKey).toString('base64')}});
  const auth=host.controllerChallenge(policyId,'fixture-controller'),signature=sign(null,canonicalBytes({type:'deszo.controller.auth',...auth}),controller.privateKey).toString('base64');
  const {connectionId}=host.authenticateController({nonce:auth.nonce,signature});
  host.assurance='bootstrap'; // Store marker stays fixture; this tests refusal/diagnostics, never promotion or native consent.
  return{host,root,time,scope,limits,args,plan,policyId,connectionId};
}
function machine(c,{ui=true}={}){
  const buildDir=join(c.scope.buildRoot,'native-probe');mkdirSync(buildDir,{recursive:true});writeFileSync(join(buildDir,'deszo.exe'),'fixture application');
  const manifest=createBuildManifest({buildDir,buildId:'native-probe',sourceCommit:'c'.repeat(40),inputsDigest:'d'.repeat(64),protocolVersion:1,storeSchemaVersion:11,launchEntry:'deszo.exe',createdAt:new Date(c.time.wallNow()).toISOString()});
  const process={pid:9123,creationTime:'100',imagePath:join(buildDir,'deszo.exe'),imageSha256:manifest.artifacts[0].sha256,sessionId:1};let alive=false;
  const lifecycle=new ApplicationLifecycle({host:c.host,launcher:{start:async({operationId,registrationNonce})=>{alive=true;setTimeout(()=>c.host.registerRuntime({policyId:c.policyId,operationId,registrationNonce,processEvidence:process,peerEvidence:process}),0);return process;},stop:async()=>{alive=false;return{domainEmpty:true};}},inspector:{describe:async()=>process,isRunning:async()=>alive},healthCheck:async()=>({ok:true,buildId:'native-probe',protocolVersion:1,storeSchemaVersion:11}),uiCheck:async({runtimeGeneration})=>({available:ui,pid:process.pid,runtimeGeneration}),pollMs:1});
  const native=async(method,{process:p}={})=>method==='stopProcess'?lifecycle.launcher.stop(p).then(result=>({...result,terminationConfirmed:true})):method==='isRunning'?{running:alive}:Promise.reject(new Error(`Unexpected native method ${method}`));
  return{lifecycle,native,args:{connectionId:c.connectionId,policyId:c.policyId,requestId:randomUUID(),buildRoot:c.scope.buildRoot,buildDir,manifest,profile:'native-probe',applicationMode:c.scope.applicationMode,desktop:c.scope.desktop,operation:'app.verify',requireUi:true,rationale:'Native diagnostic fixture only.'},alive:()=>alive};
}
test('ADR6 consented diagnostics can verify an app while bootstrap still denies workflows, providers, commands and production authority',async()=>{
  const c=setup(),m=machine(c);
  try{
    const expiry=c.host.status(c.policyId).expiresAt,result=await m.lifecycle.restart(m.args);assert.equal(result.outcome,'verified');assert.equal(c.host.assurance,'bootstrap');
    assert.equal(c.host.runtimeRegistrations.get(result.runtimeGeneration).verificationOnly,true);assert.equal(c.host.status(c.policyId).expiresAt,expiry);assert.equal(c.host.status(c.policyId).used.restarts,1);
    for(const operation of ['run.approve','supervision.approve','provider.invoke','check.run','build.run','app.restart']){
      const r=c.host.decide({requestId:randomUUID(),policyId:c.policyId,operation,runtimeGeneration:result.runtimeGeneration,workspaceId:'main',workflowId:'preserved-reference',workflowSnapshotSha256:'b'.repeat(64),workspaceCwdIdentity:'a'.repeat(64),cost:{}},{connectionId:c.connectionId});
      assert.equal(r.outcome,'denied');assert.equal(r.reason,'verification_only_policy');
    }
    assert.equal(c.host.status(c.policyId).used.providerInvocations,0);assert.equal(c.host.status(c.policyId).used.attempts,0);
  }finally{c.host.close();}
});
test('ADR6 diagnostics retain the signed initial plan and never lease an injected workflow or suppressed-UI step',()=>{
  const c=setup(),queue=new ControllerQueue(c),itemId=randomUUID();
  try{
    assert.deepEqual(JSON.parse(c.host.policyRow(c.policyId).decision_json).initialPlan,c.plan);
    assert.ok(c.host.proposePolicy({...c.args,scope:{...c.scope,workspaces:[],workflows:[]}}).challengeId);
    queue.enqueue({itemId,policyId:c.policyId,plan:c.plan},c.connectionId);assert.equal(queue.claim(c.policyId,'fixed-worker',c.connectionId).step.type,'lifecycle.verify');
    for(const initialPlan of [{...c.plan,steps:[{type:'workflow.run',args:{workflowId:'preserved-reference',workspaceId:'main',workflowSnapshotSha256:'b'.repeat(64)}}]},{...c.plan,steps:[{type:'lifecycle.verify',args:{buildId:'native-probe',requireUi:false}}]}])assert.throws(()=>c.host.proposePolicy({...c.args,initialPlan}),/Native verification plans/);
    assert.throws(()=>c.host.proposePolicy({...c.args,limits:{...c.limits,providerInvocations:1}}),/cannot authorize/);
    assert.throws(()=>c.host.proposePolicy({...c.args,scope:{...c.scope,operations:[...c.scope.operations,'run.approve']}}),/cannot authorize/);
  }finally{c.host.close();}
});
test('ADR6 unavailable native UI stops the diagnostic application and retires its registration',async()=>{
  const c=setup(),m=machine(c,{ui:false});
  try{const result=await m.lifecycle.restart(m.args);assert.equal(result.outcome,'blocked');assert.equal(result.reason,'ui_evidence_unavailable');assert.equal(m.alive(),false);assert.equal(c.host.runtimeRegistrations.size,0);}finally{c.host.close();}
});

test('ADR6 diagnostic planned close needs explicit fresh scope and its exact queued step; legacy app.verify authority does not widen',async()=>{
  for(const plannedClose of [false,true]){
    const c=setup({plannedClose}),m=machine(c),stopper=new ApplicationStop({host:c.host,native:m.native}),queue=new ControllerQueue(c);
    try{
      const launch=await m.lifecycle.restart(m.args),expiry=c.host.status(c.policyId).expiresAt;
      const stopPlan={schemaVersion:1,kind:'ControllerPlan',mode:'deterministic',steps:[{type:'lifecycle.stop',args:{buildId:'native-probe'}}]};
      const direct={policyId:c.policyId,requestId:randomUUID(),runtimeGeneration:launch.runtimeGeneration};
      if(!plannedClose){
        assert.equal((await stopper.stop(direct,c.connectionId)).reason,'operation_not_authorized');assert.equal(m.alive(),true);
        assert.throws(()=>queue.enqueue({itemId:randomUUID(),policyId:c.policyId,plan:stopPlan},c.connectionId),/does not cover app.stop/);
      }else{
        const itemId=randomUUID();queue.enqueue({itemId,policyId:c.policyId,plan:stopPlan},c.connectionId);
        const claim=queue.claim(c.policyId,'fixed-worker',c.connectionId),request={...direct,requestId:claim.requestId};
        await assert.rejects(stopper.stop(request,c.connectionId,{itemId:'some-other-item'}),/does not own this exact Stop/);
        const result=await stopper.stop(request,c.connectionId,{itemId});assert.equal(result.outcome,'verified');assert.equal(m.alive(),false);
        assert.equal(queue.finish({itemId,lease:claim.lease,result:{...result,outcome:'succeeded'}},'fixed-worker').state,'succeeded');
        assert.equal(c.host.status(c.policyId).used.restarts,1);assert.equal(c.host.status(c.policyId).expiresAt,expiry);
        assert.equal(c.host.assurance,'bootstrap');assert.equal(c.host.status(c.policyId).used.providerInvocations,0);
      }
    }finally{c.host.close();}
  }
});
test('ADR6 verification capability inspection does not execute installed provider CLIs',async()=>{
  let probes=0;const root=ownedDir(join(tmpdir(),'deszo-verification-capabilities-')),engine=new Engine({root,hostVerificationOnly:true,adapters:{detect:async()=>{probes++;throw new Error('Must not execute a CLI.');}}});
  try{const c=await engine.capabilities();assert.equal(probes,0);assert.ok(c.providers.length>0);assert.ok(c.providers.every(p=>p.available===false));}finally{engine.store.close();}
});
