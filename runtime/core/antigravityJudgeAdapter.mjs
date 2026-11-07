// Provider mechanics only. Model launches require the existing host's independently contained launcher.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { capture } from './adapters.mjs';
import { parseStrictJson } from './canonical.mjs';
import { check } from './schemas.mjs';
const API_KEYS = ['OPENAI_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_CLOUD_PROJECT','GOOGLE_CLOUD_QUOTA_PROJECT'];
const error = (code,message) => Object.assign(new Error(message),{code});
export class AntigravityJudgeAdapter {
  constructor({cliPath,settingsPath=join(homedir(),'.gemini','antigravity-cli','settings.json'),authenticationInspector=null,launcher=null}={}) {
    this.cliPath=cliPath;this.settingsPath=settingsPath;this.authenticationInspector=authenticationInspector;this.launcher=launcher;
  }
  async inspectCapabilities() {
    if(!this.cliPath)throw error('judge_cli_unavailable','An explicit Antigravity executable is required.');
    const version=await capture(this.cliPath,['--version'],{timeout:10000});
    const help=await capture(this.cliPath,['--help'],{timeout:10000});
    // The installed 1.4.4 prints successful --help to stderr (exit 0).
    const helpText=help.code===0?`${help.stdout}\n${help.stderr}`:'';
    return {provider:'antigravity',cliVersion:version.stdout.trim(),available:version.code===0,
      structuredOutput:helpText.includes('--json-schema'),resume:helpText.includes('--conversation'),
      explicitModel:helpText.includes('--model'),explicitEffort:helpText.includes('--effort'),
      nativeOwnershipVerified:false,subscriptionVerified:false,productionLaunchAvailable:Boolean(this.launcher),
      limits:'Capability inspection does not establish entitlement, protected custody, actual turn start or billing attribution.'};
  }
  async validateAuthentication() {
    // Historical log lines and copied OAuth files are not authoritative current account/plan verification.
    if(!this.authenticationInspector)return {status:'INCONCLUSIVE',verified:false,reason:'No installed authoritative account/entitlement inspector is registered.'};
    const observed=await this.authenticationInspector();
    return observed?.verified===true?observed:{status:'BLOCKED',verified:false,reason:'Current consumer subscription entitlement is not established.'};
  }
  async verifyBillingMode({env=process.env,billing='subscription_only'}={}) {
    if(billing!=='subscription_only')throw error('judge_billing_forbidden','Only subscription_only is authorized.');
    const forbidden=API_KEYS.filter(k=>typeof env[k]==='string'&&env[k].length);
    if(forbidden.length)throw error('judge_api_override','API/project credential overrides are present; values are never logged.');
    let bytes;
    try{bytes=await readFile(this.settingsPath);}catch{throw error('judge_settings_unavailable','Cannot inspect the selected effective Antigravity settings.');}
    if(bytes.length>65536||bytes.subarray(0,3).equals(Buffer.from([239,187,191])))throw error('judge_settings_invalid','Settings must be bounded UTF-8 JSON without BOM.');
    let settings;try{settings=parseStrictJson(bytes.toString('utf8'));}catch{throw error('judge_settings_invalid','Settings JSON is invalid or ambiguous.');}
    if(!settings||typeof settings!=='object'||Array.isArray(settings))throw error('judge_settings_invalid','Settings must be a JSON object.');
    if(settings.useG1Credits!==false||settings.modelProvider||settings.quotaProject)throw error('judge_billing_forbidden','Credit fallback must be explicitly disabled; custom API/quota providers are forbidden.');
    const auth=await this.validateAuthentication();
    if(auth.verified!==true||auth.authMethod!=='consumer'||auth.subscriptionEligible!==true||auth.quotaProject)throw error('judge_subscription_unverified','Current consumer subscription eligibility cannot be authoritatively confirmed.');
    return {billing:'subscription_only',configurationVerified:true,authMethod:'consumer',paidCreditsEnabled:false,apiOverride:false,
      exactBillingAttribution:'unavailable unless the provider supplies independent billing evidence; no $0.00 claim'};
  }
  buildInvocation({registration,prompt,schemaPath,cwd,timeoutMs=300000,env=process.env}) {
    if(env.DESZO_MANAGED_INVOCATION)throw error('managed_invocation_denied','A managed workflow invocation cannot become a controller by removing its marker.');
    if(registration.provider!=='antigravity'||registration.model!=='gemini-3.8-flash-high'||registration.effort!=='high'||registration.billing!=='subscription_only'||registration.ownership!=='dedicated')throw error('judge_profile_unsupported','The exact registered Stage 1 Antigravity profile is required.');
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000)throw error('judge_timeout_invalid','Judge timeout must be bounded by its captured profile.');
    if(!registration.nativeSessionId)throw error('judge_session_missing','A registered native conversation is required; no fresh-session fallback.');
    return {command:this.cliPath,args:['-p','--model',registration.model,'--effort',registration.effort,'--conversation',registration.nativeSessionId,
      '--json-schema',schemaPath,'--output-format','json','--disable-slash-commands','--print-timeout',`${Math.max(1,Math.floor(timeoutMs/1000)-5)}s`],
      stdin:prompt,cwd,env,timeoutMs,maxOutputBytes:1024*1024};
  }
  async startTurn(input,{signal}={}) {
    if(!this.launcher?.launch)throw error('judge_native_launch_unavailable','The installed trusted worker has no verified contained Antigravity launcher; no model was invoked.');
    if(signal?.aborted)throw error('judge_stopped','Stop precedes model launch.');
    await this.verifyBillingMode(input);
    const invocation=this.buildInvocation(input);
    // Launcher must retain process ownership/Stop and bounded output. A provider cannot supply its own proof.
    const result=await this.launcher.launch(invocation,{signal,onStarted:input.onStarted});
    if(!result?.terminationConfirmed)throw error('judge_invocation_unknown','Owned-process completion is not confirmed; retain charge and do not replay.');
    return result;
  }
  parseResult(result,{registration,attention,invocationId,requiredReadIds=[]}) {
    if(Buffer.byteLength(result.stdout??'')>1024*1024)throw error('judge_output_bound','Provider result exceeds its bound.');
    let envelope;try{envelope=parseStrictJson(result.stdout);}catch{throw error('judge_output_invalid','Provider did not return one strict JSON result.');}
    if(result.exitCode!==0||envelope.status!=='SUCCESS'||!result.terminationConfirmed)throw error('judge_provider_incomplete','Exit/status alone does not establish complete model execution.');
    if(!Array.isArray(envelope.denied_actions??[]))throw error('judge_output_invalid','Invalid permission diagnostics.');
    if(envelope.denied_actions?.length)throw error('judge_tool_denied','A required or attempted tool was denied; do not apply the proposed decision.');
    if(envelope.conversation_id!==registration.nativeSessionId)throw error('judge_session_mismatch','Provider resumed a different or fresh session.');
    let decision=envelope.structured_output;
    if(typeof decision==='string'){try{decision=parseStrictJson(decision);}catch{throw error('judge_output_invalid','Invalid structured decision.');}}
    if(check('judge-control.schema.json','decision',decision).length)throw error('judge_output_invalid','Native structured output does not satisfy the current Deszo schema.');
    if(decision.attentionId!==attention.attentionId||decision.judgeSessionId!==attention.judgeSessionId||decision.runId!==attention.runId||decision.invocationId!==invocationId)throw error('judge_decision_identity','Structured output is bound to another request.');
    if(!requiredReadIds.length||!decision.evidenceReadIds.some(id=>requiredReadIds.includes(id)))throw error('judge_tool_evidence_missing','No executed Engine-owned evidence read supports the response.');
    const usage=envelope.usage&&typeof envelope.usage==='object'?envelope.usage:null;
    return {decision,usage,usageScope:'cumulative_session',usageQualification:'Native cumulative session counters; do not sum resumed snapshots or equate them with Deszo invocation count or billing attribution.',
      providerConversationId:envelope.conversation_id,providerDurationSeconds:envelope.duration_seconds??null,providerNumTurns:envelope.num_turns??null};
  }
  async interruptTurn(handle) {
    if(!this.launcher?.interrupt)throw error('judge_interrupt_unavailable','Native interruption is not installed; effect remains unknown.');
    return this.launcher.interrupt(handle);
  }
  async reconcileUncertainTurn(identity) {
    if(!this.launcher?.reconcile)return {outcome:'unknown',retryAllowed:false,reason:'No authoritative external/native turn reconciliation is available.'};
    return this.launcher.reconcile(identity);
  }
}
