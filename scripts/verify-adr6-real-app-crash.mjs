// Native fault injection against an already verified, idle diagnostic Deszo. Never a production/fixture gate bypass.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {connectHost} from '../runtime/host/ipc.mjs';
import {INSTALLED_HOST_PIPE} from '../runtime/host/nativeClient.mjs';
const input=JSON.parse(readFileSync(process.argv[2],'utf8')),output=process.argv[3];
if(!output||existsSync(output))throw new Error('A new evidence destination is required.');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const ps=code=>JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',windowsHide:true,timeout:25000}));
const service=()=>ps("Get-CimInstance Win32_Service -Filter \"Name='DeszoControlHost'\" | Select-Object State,ProcessId,StartName | ConvertTo-Json -Compress");
const snapshot=async()=>{const c=connectHost(INSTALLED_HOST_PIPE,{timeoutMs:5000});try{return {installation:await c.call('installation.status'),runtime:await c.call('installation.runtime.inspect'),worker:await c.call('worker.status')};}finally{c.close();}};
const report={at:new Date().toISOString(),kind:'ActualDeszoServiceCrashVerification',passed:false,qualification:'Actual contained preview and its Node/Tauri chain; does not establish a stable controlling Deszo or owned attempts under it.'};
try{
  const before=await snapshot(),runtime=before.runtime.find(r=>r.runtimeGeneration===input.runtimeGeneration),policy=before.installation.activePolicies.find(p=>p.policyId===runtime?.policyId);
  if(!runtime?.verificationOnly||!runtime.ready||!policy?.valid||policy.activeWork.length||policy.used.providerInvocations||policy.used.attempts)throw new Error('Only an idle verified zero-provider diagnostic application may be used.');
  const native=service();if(native.State!=='Running'||native.StartName!=='NT AUTHORITY\\LocalService')throw new Error('The expected installed service is unavailable.');
  const app=input.launch,node=runtime.process;
  for(const p of [app,node])if(!Number.isInteger(p.pid)||!/^\d+$/.test(p.creationTime))throw new Error('An exact native process birth is required.');
  if(node.parentPid!==app.pid||input.health?.buildId!==runtime.ready.buildId)throw new Error('The application/runtime chain differs from the verified lifecycle evidence.');
  report.before={native,policy,runtime,app};
  // Hold only process handles (never Job handles), compare native creation times, kill the independently selected
  // SCM process, then wait on the actual kernel process objects rather than inferring death from an absent window.
  report.fault=ps(`$ErrorActionPreference='Stop'; $appProcess=[Diagnostics.Process]::GetProcessById(${app.pid}); $nodeProcess=[Diagnostics.Process]::GetProcessById(${node.pid}); try { if($appProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne '${app.creationTime}' -or $nodeProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne '${node.creationTime}'){throw 'Process birth changed'}; $null=$appProcess.Handle; $null=$nodeProcess.Handle; Stop-Process -Id ${native.ProcessId} -Force; $appExited=$appProcess.WaitForExit(10000); $nodeExited=$nodeProcess.WaitForExit(10000); @{appExited=$appExited;nodeExited=$nodeExited;outsideMonitorPid=$PID;crashedServicePid=${native.ProcessId}} | ConvertTo-Json -Compress } finally {$appProcess.Dispose();$nodeProcess.Dispose()}`);
  if(!report.fault.appExited||!report.fault.nodeExited)throw new Error('The actual Deszo/Node chain survived service failure.');
  const deadline=Date.now()+60000;let after,lastError;
  do{await pause(1000);try{const current=service();if(current.State==='Running'&&current.ProcessId!==native.ProcessId){after=await snapshot();break;}}catch(error){lastError=error.message;}}while(Date.now()<deadline);
  if(!after)throw new Error(`Service recovery was not independently established: ${lastError??'timeout'}`);
  const recovered=after.installation.activePolicies.find(p=>p.policyId===policy.policyId);report.after={...after,policy:recovered};
  if(!recovered?.valid||recovered.expiresAt!==policy.expiresAt||JSON.stringify(recovered.used)!==JSON.stringify(policy.used)||after.runtime.some(r=>r.policyId===policy.policyId))throw new Error('Policy time/counters or generation invalidation differs after recovery.');
  report.passed=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{writeFileSync(output,`${JSON.stringify(report,null,2)}\n`,{flag:'wx'});console.log(JSON.stringify({output,passed:report.passed,error:report.error??null}));}
