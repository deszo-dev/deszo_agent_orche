// Elevated installation preparation only. No enrollment, authenticator action, enablement or provider execution.
import {cpSync,copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {canonicalHash,sha256} from '../runtime/core/canonical.mjs';
import {connectHost} from '../runtime/host/ipc.mjs';
import {INSTALLED_HOST_PIPE} from '../runtime/host/nativeClient.mjs';

const root=resolve(import.meta.dirname,'..'),release=join(root,'src-tauri','target','release');
const config=JSON.parse(readFileSync('C:/Program Files/Deszo Control Host/installation.json','utf8'));
const digest=path=>sha256(readFileSync(path));
for(const name of ['runner.mjs','bridge.mjs','deszo-launch-shim.exe']){
  if(digest(join(release,'runtime',name))!==digest(join(root,'dist-runtime',name)))throw new Error(`The desktop release has stale resources: ${name}. Rebuild it before staging.`);
}
const attempt=process.argv.find(value=>value.startsWith('--attempt='))?.slice(10)??'1';
if(!/^[a-zA-Z0-9-]{1,32}$/.test(attempt))throw new Error('An explicit simple staging-attempt identity is required.');
const buildId=`adr6-native-${canonicalHash({exe:digest(join(release,'deszo.exe')),runner:digest(join(release,'runtime','runner.mjs'))}).slice(0,16)}-${attempt}`;
const directory=join(root,'.deszo','pilots','adr6-completion',buildId),sourceDir=join(directory,'artifacts');
mkdirSync(directory,{recursive:true});
if(!existsSync(sourceDir)){mkdirSync(sourceDir);copyFileSync(join(release,'deszo.exe'),join(sourceDir,'deszo.exe'));cpSync(join(release,'runtime'),join(sourceDir,'runtime'),{recursive:true,errorOnExist:true,force:false});}
const client=connectHost(INSTALLED_HOST_PIPE,{timeoutMs:120000});
try{
  const status=await client.call('installation.status');
  if(status.assurance!=='bootstrap'||status.activePolicies.some(p=>p.valid))throw new Error('This preparation requires an idle bootstrap host, without active execution authority.');
  const source=await client.call('installation.source.inspect',{sourceRoot:root});
  const build=await client.call('installation.build.stage',{buildId,sourceDir,sourceRoot:root,sourceCommit:source.sourceCommit,protocolVersion:1,storeSchemaVersion:11,launchEntry:'deszo.exe',diagnosticOnly:true});
  const profileId='adr6-native-app-verification',profile=await client.call('installation.profile.register',{profileId,path:join(config.profileRoot,profileId)});
  const worker=await client.call('worker.identity'),options=await client.call('host.scope-options');
  const proposal={controller:{controllerId:worker.controllerId,publicKey:worker.publicKey},durationMs:43200000,
    scope:{verificationOnly:true,dataProfile:profileId,workspaces:[],workflows:[],operations:['app.verify','runtime.reregister','run.stop_and_report'],commands:[],desktop:options.desktop,buildRoot:options.buildRoot,applicationMode:'separate_preview',deliveryBoundary:'candidate'},
    limits:{attempts:0,providerInvocations:0,workerModelCalls:0,operations:20,restarts:6,repairs:0,builds:0},
    initialPlan:{schemaVersion:1,kind:'ControllerPlan',mode:'deterministic',steps:[{type:'lifecycle.verify',args:{buildId,requireUi:true}}]}};
  const preparation={preparedAt:new Date().toISOString(),buildId,profile,source,hostSourceDigest:status.sourceDigest,manifestDigest:build.manifest_digest,diagnosticOnly:build.verification.diagnosticOnly,sourceBuildAttestation:build.verification.sourceBuildAttestation,proposal};
  if(process.argv.includes('--propose')){
    if(status.pending.length)throw new Error('An earlier consent proposal is pending; reconcile it before creating another.');
    preparation.consent=await client.call('policy.propose',proposal);
  }
  const path=join(directory,preparation.consent?'consent-proposal.json':'prepared.json');
  writeFileSync(path,`${JSON.stringify(preparation,null,2)}\n`,{flag:'wx'});
  console.log(JSON.stringify({path,buildId,diagnosticOnly:true,policyId:preparation.consent?.decision.policyId??null,challengeId:preparation.consent?.challengeId??null,expiresAt:preparation.consent?.expiresAt??null}));
}finally{client.close();}
