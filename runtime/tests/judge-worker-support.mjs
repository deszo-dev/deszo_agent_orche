// Deterministic worker/provider fixtures around the actual ControllerQueue, Engine and Bridge.
import { randomUUID } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { ControllerQueue } from '../host/controllerQueue.mjs';
import { installedActions } from '../host/serviceActions.mjs';
import { AntigravityJudgeAdapter } from '../core/antigravityJudgeAdapter.mjs';
import { openBridge } from '../../mcp/stdio-client.mjs';
import { data } from './judge-stage1-support.mjs';
import schema from '../../docs/schemas/judge-control.schema.json' with {type:'json'};
const script=resolve(import.meta.dirname,'../../mcp/bridge.mjs');

export async function stage1WorkerFixture(c,{fault=null,onEvidence=null}={}) {
  const queue=new ControllerQueue({host:c.host}),registration={...c.registration,ownerGeneration:1},settingsPath=join(c.api.root,'fixture-judge-settings.json');
  const authoringDirectory=join(c.api.root,'fixture-judge-authoring'),handshakeConfig=join(authoringDirectory,'bridge-handshake-only.json');
  await mkdir(authoringDirectory,{recursive:true});
  // Used by the real Bridge's Antigravity path-isolation handshake; not a loaded CLI permission profile.
  await writeFile(handshakeConfig,JSON.stringify({mcpServers:{}}));
  await writeFile(settingsPath,JSON.stringify({useG1Credits:false}));let current=null,launches=0;
  const bridgeFor=async(i,worker=false)=>openBridge({script,args:['--connection-file',c.api.runner.connection.connectionFile,'--client-provider',worker?'other':'antigravity',...(!worker?['--working-directory',authoringDirectory,'--mcp-config-path',handshakeConfig]:[]),'--judge-invocation',i.invocationId],env:{...process.env,DESZO_JUDGE_INVOCATION_TOKEN:i.invocationToken,...(worker?{DESZO_JUDGE_WORKER_TOKEN:c.controller.controllerToken}:{})}});
  const api=async(method,path,body)=>{
    const r=await c.api.callExternal(method,path,body,{headers:c.headers});
    if(r.status>=400)throw Object.assign(new Error(r.body.message),{code:r.body.code,status:r.status});return r.body;
  };
  const runtime={registration,cwd:c.api.root,schemaPath:JSON.stringify(schema.$defs.decision),runtimeGeneration:c.engine.hostRuntimeGeneration,api,
    modelEnvironment:i=>{current=i;return {};},bridgeForInvocation:i=>bridgeFor(i,true)};
  const launcher={launch:async(_input,{onStarted})=>{
    launches++;await onStarted({nativeSessionId:registration.nativeSessionId,turnId:`fixture-native-${current.invocationId}`});
    if(fault==='after-start'){queue.recover('Deterministic worker crash after actual-start acknowledgement boundary');throw Object.assign(new Error('Injected lost response'),{code:'fixture_worker_crash'});}
    const bridge=await bridgeFor(current);try{
      const e=data(await bridge.call('read_judge_evidence',{})),attention=c.engine.judgeAttentionView(e.package.attentionId),decision=c.decision(attention,current,e);
      await onEvidence?.({bridge,e,attention,decision,invocation:current});
      return {exitCode:0,terminationConfirmed:true,stdout:JSON.stringify({status:'SUCCESS',conversation_id:registration.nativeSessionId,structured_output:decision,denied_actions:[],usage:{fixtureOnly:true,input_tokens:0,output_tokens:0}})};
    }finally{await bridge.close();}
  }};
  runtime.adapter=new AntigravityJudgeAdapter({cliPath:'fixture-provider-not-executed',settingsPath,authenticationInspector:async()=>({verified:true,authMethod:'consumer',subscriptionEligible:true,quotaProject:''}),launcher});
  const enqueue=a=>{
    const itemId=randomUUID(),binding=c.engine.hostRunBinding(c.runId),step={type:'judge.review',args:{judgeSessionId:c.sessionId,attentionId:a.attentionId,runId:c.runId,workflowId:binding.workflowId,workflowSnapshotSha256:binding.workflowSnapshotSha256,workspaceId:binding.workspaceId}};
    queue.enqueue({itemId,policyId:c.policyId,plan:{schemaVersion:1,kind:'ControllerPlan',mode:'deterministic',steps:[step]}},c.connectionId);return itemId;
  };
  const actions=installedActions({host:c.host,queue,installation:{},installRoot:c.api.root,native:async()=>{throw new Error('Native lifecycle is deliberately unavailable in the component fixture.');},judgeRuntime:runtime});
  const execute=claim=>actions.execute({connection:{controller:{connectionId:c.connectionId}},policyId:c.policyId,requestId:claim.requestId,step:claim.step,itemId:claim.itemId,workerId:'fixture-native-worker',lease:claim.lease});
  return {queue,runtime,enqueue,execute,launches:()=>launches};
}
