import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startTestRunner,singleAgent} from './helpers.mjs';
import clientTimeouts from '../../docs/authoring/client-timeouts.json' with {type:'json'};
for (const legacyTerminal of [false,true]) test('restart ends control of '+(legacyTerminal?'a legacy interrupted run':'an interrupted active run'),async()=>{
  const first=await startTestRunner(); let next,runId,closed=false;
  try{
    const engine=first.runner.engine;
    engine.supervisor={shimPath:null,pipeName:'isolated-test',armRun:async()=>({armed:true}),disarmRun:async()=>({armed:false}),releaseRun:async()=>({released:true})};
    await first.workspace();
    const saved=await first.save(singleAgent({id:'restart-control',context:null}));
    const session=engine.createControllerSession({requestId:randomUUID(),clientLabel:'restart fixture',clientProvider:'codex'}).body;
    const grant=engine.requestControlGrant({requestId:randomUUID(),controllerSessionId:session.controllerSessionId,workflowId:'restart-control',workflowSnapshotSha256:saved.snapshotSha256,workspaceId:'main',clientProvider:'codex',clientVersion:clientTimeouts.entries.find(x=>x.provider==='codex').testedVersion,requestedActions:['observe','stop'],observationDeadlineMs:90000,escalationDeadlineMs:180000},{controllerToken:session.controllerToken}).body;
    engine.decideControlGrant(grant.grantId,{requestId:randomUUID(),decision:'approve'});
    const created=await first.call('POST','/api/v2/runs',{requestId:randomUUID(),workflowId:'restart-control',workflowSnapshotSha256:saved.snapshotSha256,workspaceId:'main',controlGrantId:grant.grantId},{headers:{'X-Deszo-Controller-Token':session.controllerToken}});
    assert.equal(created.status,202,JSON.stringify(created.body));runId=created.body.run.runId;
    await first.waitFor(runId,run=>run.state==='waiting_for_user');
    assert.equal(engine.runProcesses(runId).length,0);
    if(legacyTerminal){const row=engine.requireRun(runId);engine.store.appendEvents(runId,[engine.runEvent(row,'interrupted','Legacy restart fixture: terminal run with an active control grant.')]);}
    engine.stopWatchdog(runId);await first.close();closed=true;
    next=await startTestRunner({root:first.root});
    const run=next.runner.engine.requireRun(runId);assert.equal(run.state,'interrupted');
    const control=next.runner.engine.getRunControl(runId);
    assert.equal(control.controlMode,'supervised','ending a grant or reopening headless does not rewrite how the run executed');
    assert.equal(control.controller.state,'ended','the terminal view retains historical control without an active grant');
    assert.equal(control.controller.controllerSessionId,session.controllerSessionId);
    assert.equal(next.runner.engine.store.get('SELECT state FROM control_grants WHERE id = ?',grant.grantId).state,'ended');
    assert.equal(next.runner.engine.activeGrant(runId),null);
    assert.equal(control.terminationOutcome,null,'restart must not invent a confirmed Stop');
    assert.equal(next.runner.engine.runProcesses(runId).length,0);
  }finally{if(next)await next.close();if(!closed){if(runId)first.runner.engine.stopWatchdog(runId);await first.close();}}
});
