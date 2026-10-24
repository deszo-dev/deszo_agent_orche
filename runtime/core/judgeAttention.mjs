// Production Engine authority, not a provider validator. Disabled unless explicitly enabled by its owner.
import { randomBytes, randomUUID } from 'node:crypto';
import { canonicalHash, sha256 } from './canonical.mjs';
import { check } from './schemas.mjs';
const TERMINAL = new Set(['succeeded','failed','canceled','interrupted']);
const ACTIVE = "('admitted','started','unknown')";
const now = () => new Date().toISOString();
export function installJudgeAttention(Engine, { ApiError }) {
  const P = Engine.prototype;
  const fail = (code, message, status = 409) => { throw new ApiError(status, code, message); };
  const uuid = value => typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const contract = (name, body) => {
    const errors = check('judge-control.schema.json', name, body);
    if (errors.length) throw new ApiError(400, 'invalid_judge_contract', 'Judge input violates its versioned contract.', errors);
  };
  const event = (engine, runId, type, facts) => {
    const record=engine.store.putJson({schemaVersion:1,kind:'JudgeLifecycleEvent',eventType:type,facts});
    return engine.store.appendEvents(runId,[{type,nodeInstanceId:null,attemptId:null,payload:{record}}]);
  };

  P.requireJudgeEnabled = function () {
    if (!this.judgeAttentionEnabled) fail('judge_unavailable', 'Judge attention is not enabled for this runtime.');
  };
  P.initializeJudgeAttention = function () {
    if(!this.judgeAttentionEnabled)return;
    this.store.transaction(()=>{
      for(const row of this.store.all("SELECT i.id,a.run_id FROM judge_invocations i JOIN judge_attention a ON a.id=i.attention_id WHERE i.state IN ('admitted','started')")){
        this.store.run("UPDATE judge_invocations SET state='unknown' WHERE id=?",row.id);
        event(this,row.run_id,'judge.invocation_unknown',{invocationId:row.id,reason:'runtime_restart',retryAllowed:false});
      }
    });
  };
  P.judgeSession = function (sessionId, controllerToken, { active = true } = {}) {
    this.requireJudgeEnabled();
    const row = this.store.get('SELECT * FROM judge_sessions WHERE id=?', sessionId);
    if (!row) fail('not_found', 'Judge session not found.', 404);
    this.requireControllerCredential(controllerToken, row.controller_session_id);
    if(active&&this.store.readJson(row.registration_artifact_id).runtimeInstanceId!==this.runtimeInstanceId)fail('judge_runtime_reregistration_required','A new runtime needs explicit fenced Judge re-registration; persisted IDs alone grant no renewed authority.',403);
    if (active && (row.state !== 'active' || Date.parse(row.expires_at) <= Date.now())) fail('judge_authority_expired', 'Judge authority is expired or fenced.', 403);
    return row;
  };
  // Run-scoped identity. A Run is judged against the Published Version it is bound to; a Run that predates the binding
  // is accepted only when its captured definition exactly equals a Published Version of its own workflow. The mutable
  // Draft pointer and later publications are never consulted, so editing or publishing cannot make an admitted Run stale.
  P.runPublicationIdentity = function (run, capturedSha256) {
    const select = 'SELECT p.id, p.version, p.workflow_id, a.sha256 AS snapshot_sha256 FROM workflow_publications p JOIN artifacts a ON a.id = p.snapshot_artifact_id';
    if (run.published_version_id) return this.store.get(`${select} WHERE p.id = ? AND p.workflow_id = ?`, run.published_version_id, run.workflow_id) ?? null;
    return this.store.get(`${select} WHERE p.workflow_id = ? AND a.sha256 = ? ORDER BY p.version DESC LIMIT 1`, run.workflow_id, capturedSha256) ?? null;
  };
  P.judgeSubject = function (runId) {
    const snapshot = this.runSnapshot(runId), run = this.requireRun(runId);
    const workflowSnapshotSha256 = this.store.artifactRow(run.workflow_snapshot_artifact_id).sha256;
    const identity = this.runPublicationIdentity(run, workflowSnapshotSha256);
    return { runId, state:run.state, workflowId:run.workflow_id, workspaceId:run.workspace_id,
      workflowRevision:identity?.version ?? null, workflowSnapshotSha256,
      currentSnapshotSha256:identity?.snapshot_sha256 ?? null,
      outputs:snapshot.instances.map(x=>({nodeInstanceId:x.nodeInstanceId,state:x.state,outputs:x.outputs})), candidateDigest:'' };
  };
  // A host-bound candidate never establishes Judge authority itself: registration is a trusted procedure (JUDGE_STAGE1.md).
  // Owner Token authority covers the public route, but this internal check still refuses the mutation in host-bound mode.
  P.registerJudgeSession = function (body) {
    this.requireJudgeEnabled(); this.refuseHostMutation('Judge registration'); contract('registration', body);
    if (Date.parse(body.expiresAt) <= Date.now() || Date.parse(body.expiresAt) > Date.now()+3_600_000) fail('invalid_judge_expiry','Stage 1 authority must end within one hour.',400);
    if (!this.store.get('SELECT id FROM controller_sessions WHERE id=?',body.controllerSessionId)) fail('not_found','Controller session not found.',404);
    return this.idempotent('POST /judge-sessions',body.requestId,body,()=>{
      const bindings=body.runIds.map(id=>this.judgeSubject(id));
      if(body.runIds.some(id=>this.requireRun(id).journal_version!==2))fail('judge_journal_version_unsupported','Stage 1 Judge events require a v2 journal; historical v1 events are never rewritten.');
      if (bindings.some(x=>x.currentSnapshotSha256!==x.workflowSnapshotSha256)) fail('stale_judge_subject','A run is not on the current saved workflow revision.');
      const duplicate=this.store.all('SELECT registration_artifact_id FROM judge_sessions').some(r=>this.store.readJson(r.registration_artifact_id).nativeSessionId===body.nativeSessionId);
      if (duplicate) fail('judge_session_already_registered','A native conversation is already registered. Use explicit fenced transfer.');
      const id=randomUUID(),record={...body,bindings,ownerGeneration:1,runtimeInstanceId:this.runtimeInstanceId,assurance:'registration-only; native custody/launch not established'};
      const artifact=this.store.putJson(record);
      this.store.run('INSERT INTO judge_sessions(id,controller_session_id,owner_generation,registration_artifact_id,expires_at,max_invocations,created_at) VALUES(?,?,?,?,?,?,?)',id,body.controllerSessionId,1,artifact.artifactId,body.expiresAt,body.maxInvocations,now());
      for(const binding of bindings) event(this,binding.runId,'judge.session_registered',{judgeSessionId:id,ownerGeneration:1,registration:artifact});
      return {status:201,body:{judgeSessionId:id,ownerGeneration:1,registration:artifact,productionDeliveryEnabled:false}};
    });
  };
  P.createJudgeAttention = function ({requestId,judgeSessionId,runId}, {controllerToken}={}) {
    if(!uuid(requestId)||!uuid(judgeSessionId)||!uuid(runId))fail('invalid_judge_request','Stable UUID identities are required.',400);
    const session=this.judgeSession(judgeSessionId,controllerToken),registration=this.store.readJson(session.registration_artifact_id);
    const binding=registration.bindings.find(x=>x.runId===runId);
    if(!binding) fail('judge_subject_not_authorized','Run is outside this explicit registration.',403);
    return this.idempotent('POST /judge-attention',requestId,{judgeSessionId,runId},()=>{
      const subject=this.judgeSubject(runId);
      if(!['waiting_for_user','succeeded'].includes(subject.state)) fail('judge_subject_not_reviewable','Only an Engine pause or completed handoff can request this bounded review.');
      if(subject.workflowSnapshotSha256!==binding.workflowSnapshotSha256||subject.currentSnapshotSha256!==subject.workflowSnapshotSha256) fail('stale_judge_subject','Workflow content changed.');
      const row=this.requireRun(runId),snapshot=this.runSnapshot(runId),createdAt=now(),id=randomUUID();
      // Follow only Engine-owned output-record slots, never artifact-like strings inside model values.
      const outputReferences=subject.outputs.filter(x=>x.outputs).map(x=>x.outputs),detailReferences=[];
      for(const ref of outputReferences){
        if(this.store.artifactRow(ref.artifactId).byte_size>65536)fail('judge_output_record_bound','A captured output record exceeds the verified projection bound.');
        const record=this.store.readJson(ref.artifactId);
        for(const [port,value]of Object.entries(record.values??{})){
          if(value?.artifact?.artifactId)detailReferences.push({outputRecord:ref,port,type:value.type,artifact:value.artifact});
        }
      }
      const evidence={schemaVersion:1,kind:'JudgeEvidencePackage',attentionId:id,subject,subjectDigest:canonicalHash(subject),boundary:'run_handoff_review',candidateAcceptance:false,
        engineFacts:{run:snapshot.run,loops:snapshot.loops,frontier:row.last_sequence},
        modelClaims:{status:'untrusted',references:outputReferences,detailReferences},
        question:'Review the captured pause or handoff. APPROVE records handoff review only; REVISE requests a linked revision. No verdict accepts a candidate or starts work.',
        completeness:'complete_for_captured_handoff_only',limitations:['No candidate tree acceptance or release evidence is established.'],
        bounds:{expiresAt:session.expires_at,maxInvocations:session.max_invocations,usedInvocations:session.invocations}};
      const bytes=Buffer.byteLength(JSON.stringify(evidence));
      if(bytes>16384) fail('judge_package_bound','Pinned handoff package exceeds 16 KiB; a qualified incremental projection is required.');
      const pack=this.store.putJson(evidence),request=this.store.putJson({schemaVersion:1,kind:'JudgeAttentionRequest',attentionId:id,judgeSessionId,runId,subjectDigest:evidence.subjectDigest,evidence:pack,createdAt});
      const busy=Boolean(this.store.get(`SELECT id FROM judge_invocations WHERE session_id=? AND state IN ${ACTIVE}`,judgeSessionId));
      this.store.run('INSERT INTO judge_attention(id,session_id,run_id,request_artifact_id,package_artifact_id,subject_digest,created_at,response_due_at,queue_due_at,queue_reason,queued_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,judgeSessionId,runId,request.artifactId,pack.artifactId,evidence.subjectDigest,createdAt,new Date(Date.parse(createdAt)+900000).toISOString(),new Date(Date.parse(createdAt)+(busy?registration.queueWaitMs:30000)).toISOString(),busy?'queued_behind_active_turn':null,busy?createdAt:null);
      event(this,runId,'judge.request_persisted',{attentionId:id,judgeSessionId,request,evidence:pack,dispatchBarrier:true,queueReason:busy?'queued_behind_active_turn':null});
      return {status:201,body:this.judgeAttentionView(id)};
    });
  };
  P.judgeAttentionView = function (id) {
    const row=this.store.get('SELECT * FROM judge_attention WHERE id=?',id);
    if(!row) fail('not_found','Attention request not found.',404);
    return {...this.store.readJson(row.request_artifact_id),state:row.state,queueReason:row.queue_reason,queuedAt:row.queued_at,responseDueAt:row.response_due_at,queueDueAt:row.queue_due_at,reason:row.reason};
  };
  P.listJudgeAttention = function (sessionId,{controllerToken}={}) {
    this.judgeSession(sessionId,controllerToken); this.expireJudgeAttention();
    return {items:this.store.all('SELECT id FROM judge_attention WHERE session_id=? ORDER BY created_at,id LIMIT 50',sessionId).map(r=>this.judgeAttentionView(r.id))};
  };
  P.hasJudgeBarrier = function (runId) {
    return Boolean(this.store.get("SELECT id FROM judge_attention WHERE run_id=? AND state!='resolved' LIMIT 1",runId));
  };
  P.expireJudgeAttention = function () {
    if(!this.judgeAttentionEnabled) return;
    this.store.transaction(()=>{
      for(const row of this.store.all("SELECT a.*,s.expires_at FROM judge_attention a JOIN judge_sessions s ON s.id=a.session_id WHERE a.state IN ('pending','in_flight')")) {
        const invocation=this.store.get('SELECT * FROM judge_invocations WHERE attention_id=?',row.id);
        const subject=this.judgeSubject(row.run_id);
        const invalidRun=!['waiting_for_user','succeeded'].includes(subject.state)||canonicalHash(subject)!==row.subject_digest;
        let reason=null,cause=null;
        if(invalidRun)reason='subject_stopped_or_changed';
        else if(Date.parse(row.expires_at)<=Date.now())reason='judge_authority_expired';
        else if(Date.parse(row.response_due_at)<=Date.now())reason='attention_response_timeout';
        else if(!invocation&&Date.parse(row.queue_due_at)<=Date.now()){
          reason='attention_delivery_timeout';cause=row.queue_reason==='queued_behind_active_turn'?'queue_wait_expired':'delivery_unconfirmed';
        }else if(invocation?.state==='admitted'&&Date.parse(invocation.wake_due_at)<=Date.now()){
          reason='attention_delivery_timeout';cause='turn_start_unconfirmed';
        }
        if(!reason)continue;
        this.store.run("UPDATE judge_attention SET state='stale',reason=? WHERE id=?",reason,row.id);
        event(this,row.run_id,'judge.attention_expired',{attentionId:row.id,reason,cause,terminalStatePreserved:TERMINAL.has(this.requireRun(row.run_id).state)});
      }
    });
  };
  P.admitJudgeInvocation = async function ({requestId,judgeSessionId,attentionId,ownerGeneration,hostPermitId},{controllerToken}={}) {
    if(!uuid(requestId)||!uuid(judgeSessionId)||!uuid(attentionId)||!uuid(hostPermitId))fail('invalid_judge_request','Stable UUID identities are required.',400);
    this.expireJudgeAttention();
    const session=this.judgeSession(judgeSessionId,controllerToken),attention=this.store.get('SELECT * FROM judge_attention WHERE id=? AND session_id=?',attentionId,judgeSessionId);
    if(!attention||attention.state!=='pending')fail('judge_request_unavailable','Attention is unavailable, expired or already admitted.');
    if(ownerGeneration!==session.owner_generation)fail('stale_judge_owner','Owner generation changed.',403);
    if(this.store.get(`SELECT id FROM judge_invocations WHERE session_id=? AND state IN ${ACTIVE}`,judgeSessionId)){
      if(!attention.queued_at)this.store.transaction(()=>{
        const at=now(),registration=this.store.readJson(session.registration_artifact_id),due=new Date(Math.min(Date.now()+registration.queueWaitMs,Date.parse(attention.response_due_at))).toISOString();
        this.store.run("UPDATE judge_attention SET queue_reason='queued_behind_active_turn',queued_at=?,queue_due_at=? WHERE id=?",at,due,attentionId);
        event(this,attention.run_id,'judge.queued_behind_active_turn',{attentionId,queuedAt:at,queueDueAt:due,responseDueAt:attention.response_due_at});
      });
      return {status:202,body:{queued:true,reason:'queued_behind_active_turn',attentionId}};
    }
    if(session.invocations>=session.max_invocations)fail('judge_budget_exhausted','Finite controller invocation budget exhausted.',403);
    // There is no manual/free model-call path. The actual host independently reserves provider and worker calls.
    const host=this.requireHostAuthority(),permit=await host.permitRequest(hostPermitId);
    if(permit.request.cost?.workerModelCalls<1||!Number.isFinite(permit.request.cost?.workerModelCalls))fail('judge_host_charge_required','A Judge permit must charge workerModelCalls as well as providerInvocations.',403);
    const admission=await this.admitHostPermit(hostPermitId,{operation:'provider.invoke',...this.hostRunBinding(attention.run_id)});
    try {
      return this.store.transaction(()=>{
        const current=this.judgeSession(judgeSessionId,controllerToken);
        this.expireJudgeAttention();
        if(current.owner_generation!==ownerGeneration||current.invocations>=current.max_invocations||this.store.get('SELECT state FROM judge_attention WHERE id=?',attentionId).state!=='pending'||this.store.get(`SELECT id FROM judge_invocations WHERE session_id=? AND state IN ${ACTIVE}`,judgeSessionId))fail('judge_admission_raced','Authority, request or active owner changed.');
        const id=randomUUID(),token=randomBytes(32).toString('base64url'),at=now(),wakeDueAt=new Date(Math.min(Date.now()+30000,Date.parse(attention.queue_due_at),Date.parse(attention.response_due_at))).toISOString();
        this.store.run('INSERT INTO judge_invocations(id,session_id,attention_id,owner_generation,token_sha256,state,host_permit_id,admitted_at,wake_due_at) VALUES(?,?,?,?,?,?,?,?,?)',id,judgeSessionId,attentionId,ownerGeneration,sha256(token),'admitted',admission.permitId,at,wakeDueAt);
        this.store.run('UPDATE judge_sessions SET invocations=invocations+1 WHERE id=?',judgeSessionId);
        this.store.run("UPDATE judge_attention SET state='in_flight',dispatchable_at=?,queue_reason=NULL WHERE id=?",at,attentionId);
        event(this,attention.run_id,'judge.turn_admitted',{attentionId,invocationId:id,judgeSessionId,ownerGeneration,hostPermitId,requestId,wakeDueAt});
        return {status:201,body:{invocationId:id,attentionId,judgeSessionId,invocationToken:token,ownerGeneration,wakeDueAt}};
      });
    }catch(error){await this.settleHostPermit(admission.permitId,'not_executed','Judge engine refused admission before launch.');throw error;}
  };
  P.judgeInvocation = function (invocationId,token,{allowCompleted=false}={}) {
    this.requireJudgeEnabled();this.expireJudgeAttention();
    const row=this.store.get('SELECT i.*,s.controller_session_id,s.owner_generation AS current_generation,s.expires_at,s.state AS session_state FROM judge_invocations i JOIN judge_sessions s ON s.id=i.session_id WHERE i.id=?',invocationId);
    if(!row||typeof token!=='string'||sha256(token)!==row.token_sha256)fail('judge_invocation_credential_required','This command needs its scoped invocation credential.',403);
    if(row.current_generation!==row.owner_generation||row.session_state!=='active'||Date.parse(row.expires_at)<=Date.now())fail('stale_judge_owner','Owner or authority is no longer current.',403);
    if(!allowCompleted&&!['admitted','started'].includes(row.state))fail('judge_invocation_unavailable','Invocation requires reconciliation or is complete.');
    return row;
  };
  P.recordJudgeStarted = function (invocationId,{nativeSessionId,turnId},{controllerToken}={}) {
    const row=this.store.get('SELECT * FROM judge_invocations WHERE id=?',invocationId);
    if(!row)fail('not_found','Invocation not found.',404);
    const session=this.judgeSession(row.session_id,controllerToken),registration=this.store.readJson(session.registration_artifact_id);
    if(session.owner_generation!==row.owner_generation||nativeSessionId!==registration.nativeSessionId||typeof turnId!=='string'||!turnId||turnId.length>200)fail('judge_session_mismatch','Actual external turn identity does not match registration.');
    this.expireJudgeAttention();
    if(row.state!=='admitted'||this.store.get('SELECT state FROM judge_attention WHERE id=?',row.attention_id).state!=='in_flight')fail('judge_start_unavailable','Start is stale or already recorded.');
    this.store.transaction(()=>{
      this.store.run("UPDATE judge_invocations SET state='started',started_at=? WHERE id=?",now(),invocationId);
      const attention=this.judgeAttentionView(row.attention_id);event(this,attention.runId,'judge.turn_started',{invocationId,attentionId:row.attention_id,nativeSessionId,turnId,qualification:'Authenticated worker observation; independent native/provider proof remains required.'});
    });
    return {invocationId,state:'started'};
  };
  P.requireJudgeEvidenceAuthority = async function (invocationId,invocationToken) {
    const captured=this.judgeInvocation(invocationId,invocationToken),host=this.requireHostAuthority();
    if(typeof host.validatePermit!=='function'||!(await host.validatePermit(captured.host_permit_id)).valid)fail('judge_host_authority_unavailable','Evidence access requires current Host authority.',403);
    const invocation=this.judgeInvocation(invocationId,invocationToken);
    if(this.judgeAttentionView(invocation.attention_id).state!=='in_flight')fail('judge_request_stale','Attention is no longer actionable.');
    return invocation;
  };
  P.readJudgeEvidence = async function (invocationId,{invocationToken}={}) {
    const invocation=await this.requireJudgeEvidenceAuthority(invocationId,invocationToken),attention=this.store.get('SELECT * FROM judge_attention WHERE id=?',invocation.attention_id);
    if(attention.state!=='in_flight')fail('judge_request_stale','Attention is no longer actionable.');
    const artifact=this.store.artifactRow(attention.package_artifact_id),pack=this.store.readJson(artifact.id),id=randomUUID();
    this.store.transaction(()=>{
      this.store.run('INSERT INTO judge_evidence_reads(id,invocation_id,artifact_id,digest,kind,created_at) VALUES(?,?,?,?,?,?)',id,invocationId,artifact.id,artifact.sha256,'package',now());
      event(this,attention.run_id,'judge.evidence_read',{invocationId,attentionId:attention.id,evidenceReadId:id,artifactId:artifact.id,sha256:artifact.sha256});
    });
    return {package:pack,evidenceReadId:id,evidenceDigest:artifact.sha256,artifactId:artifact.id,untrusted:true};
  };
  P.listJudgeReads = function (invocationId,{controllerToken}={}) {
    const invocation=this.store.get('SELECT * FROM judge_invocations WHERE id=?',invocationId);
    if(!invocation)fail('not_found','Invocation not found.',404);
    this.judgeSession(invocation.session_id,controllerToken);
    return {items:this.store.all('SELECT id,artifact_id AS artifactId,digest,kind,created_at AS createdAt FROM judge_evidence_reads WHERE invocation_id=? ORDER BY created_at,id LIMIT 64',invocationId)};
  };
  P.readJudgeArtifact = async function (invocationId,artifactId,{invocationToken,offset=0,length=2048}={}) {
    const invocation=await this.requireJudgeEvidenceAuthority(invocationId,invocationToken),attention=this.store.get('SELECT package_artifact_id FROM judge_attention WHERE id=?',invocation.attention_id),pack=this.store.readJson(attention.package_artifact_id),allowed=new Set();
    const visit=value=>{if(!value||typeof value!=='object')return;if(typeof value.artifactId==='string')allowed.add(value.artifactId);for(const child of Object.values(value))visit(child);};visit(pack);
    if(!allowed.has(artifactId))fail('judge_artifact_out_of_scope','Artifact is not referenced by this pinned package.',403);
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||length>65536)fail('invalid_judge_range','Range is outside its bounded integer contract.',400);
    if(this.store.artifactRow(artifactId)?.byte_size>65536)fail('judge_detail_bound','Stage 1 fully verifies detail objects up to 64 KiB; larger-object verification is not claimed.',413);
    this.store.readBytes(artifactId);
    const detail=this.readArtifactRange(artifactId,{offset,length:Math.min(length,65536)}),id=randomUUID();
    this.store.transaction(()=>{
      this.store.run('INSERT INTO judge_evidence_reads(id,invocation_id,artifact_id,digest,kind,created_at) VALUES(?,?,?,?,?,?)',id,invocationId,artifactId,detail.sha256,'detail',now());
      event(this,this.judgeAttentionView(invocation.attention_id).runId,'judge.evidence_detail_read',{invocationId,evidenceReadId:id,artifactId,sha256:detail.sha256,offset:detail.offset,length:detail.length,rangeSha256:detail.rangeSha256});
    });
    return {...detail,evidenceReadId:id,untrusted:true};
  };
  P.submitJudgeDecision = async function (body,{controllerToken,invocationToken}={}) {
    const invocation=this.judgeInvocation(body?.invocationId,invocationToken,{allowCompleted:true}),session=this.judgeSession(invocation.session_id,controllerToken);
    const runId=this.judgeAttentionView(invocation.attention_id).runId;
    try {
    if(Buffer.byteLength(JSON.stringify(body))>16384)fail('judge_decision_bound','Decision exceeds 16 KiB.',413);
    contract('decision',body);
    event(this,runId,'judge.decision_received',{invocationId:invocation.id,attentionId:invocation.attention_id,proposalDigest:canonicalHash(body),untrusted:true});
    if(body.judgeSessionId!==session.id||body.ownerGeneration!==session.owner_generation||body.attentionId!==invocation.attention_id)fail('judge_decision_identity','Decision does not match the authenticated invocation.',403);
    const host=this.requireHostAuthority();
    if(typeof host.validatePermit!=='function'||!(await host.validatePermit(invocation.host_permit_id)).valid)fail('judge_host_authority_unavailable','Current Host authority cannot be established for this decision.',403);
    return this.idempotent('POST /judge-decisions',body.decisionId,body,()=>{
      const attention=this.store.get('SELECT * FROM judge_attention WHERE id=?',body.attentionId);
      if(attention.state!=='in_flight'||invocation.state!=='started')fail('judge_request_stale','Attention/invocation is no longer actionable.');
      const pack=this.store.readJson(attention.package_artifact_id),current=this.judgeSubject(attention.run_id),artifact=this.store.artifactRow(attention.package_artifact_id);
      if(body.runId!==attention.run_id||body.subjectDigest!==attention.subject_digest||canonicalHash(current)!==attention.subject_digest||body.workflowRevision!==current.workflowRevision||body.workflowSnapshotSha256!==current.workflowSnapshotSha256||current.currentSnapshotSha256!==current.workflowSnapshotSha256||body.candidateDigest!==current.candidateDigest)fail('stale_judge_subject','Run, revision, candidate or subject changed.');
      if(body.evidenceDigest!==artifact.sha256)fail('judge_evidence_mismatch','Evidence digest differs from the pinned package.');
      const reads=body.evidenceReadIds.map(id=>this.store.get('SELECT * FROM judge_evidence_reads WHERE id=? AND invocation_id=?',id,invocation.id));
      if(reads.some(x=>!x)||!reads.some(x=>x.kind==='package'&&x.artifact_id===artifact.id&&x.digest===artifact.sha256))fail('judge_evidence_required','No complete authenticated package-read receipt exists for this invocation.');
      if(this.store.get('SELECT id FROM judge_decisions WHERE attention_id=?',attention.id))fail('conflicting_judge_decision','A different decision already resolved this attention.');
      const proposal=this.store.putJson(body),receipt={schemaVersion:1,kind:'JudgeDecisionReceipt',decisionId:body.decisionId,attentionId:attention.id,invocationId:invocation.id,runId:attention.run_id,
        disposition:body.verdict==='APPROVE'?'handoff_reviewed':body.verdict==='REVISE'?'revision_requested':'additional_evidence_requested',
        proposal,subjectDigest:attention.subject_digest,evidenceDigest:artifact.sha256,appliedAt:now(),transition:{from:'in_flight',to:'resolved'},
        runStatePreserved:current.state,linkedContinuationRequired:true,candidateAccepted:false,readyForMerge:false};
      const stored=this.store.putJson(receipt);
      this.store.run('INSERT INTO judge_decisions(id,attention_id,invocation_id,proposal_digest,receipt_artifact_id,applied_at) VALUES(?,?,?,?,?,?)',body.decisionId,attention.id,invocation.id,canonicalHash(body),stored.artifactId,receipt.appliedAt);
      this.store.run("UPDATE judge_attention SET state='resolved' WHERE id=?",attention.id);
      event(this,attention.run_id,'judge.decision_applied',{attentionId:attention.id,invocationId:invocation.id,receipt:stored,disposition:receipt.disposition});
      return {status:200,body:receipt};
    });
    }catch(error){event(this,runId,'judge.decision_rejected',{invocationId:invocation.id,attentionId:invocation.attention_id,code:error.code||'error',authorityUnchanged:true});throw error;}
  };
  P.getJudgeDecision = function (decisionId,{controllerToken}={}) {
    const row=this.store.get('SELECT d.receipt_artifact_id,i.session_id FROM judge_decisions d JOIN judge_invocations i ON i.id=d.invocation_id WHERE d.id=?',decisionId);
    if(!row)fail('not_found','Decision not found.',404);
    this.judgeSession(row.session_id,controllerToken,{active:false});return this.store.readJson(row.receipt_artifact_id);
  };
  P.completeJudgeInvocation = async function (invocationId,result,{controllerToken}={}) {
    const row=this.store.get('SELECT * FROM judge_invocations WHERE id=?',invocationId);
    if(!row)fail('not_found','Invocation not found.',404);
    const session=this.judgeSession(row.session_id,controllerToken);
    if(row.owner_generation!==session.owner_generation)fail('stale_judge_owner','Old worker generation cannot settle the turn.',403);
    if(!['completed','failed','unknown'].includes(result?.outcome))fail('invalid_judge_outcome','A typed outcome is required.',400);
    if(result.outcome==='completed'&&!this.store.get('SELECT id FROM judge_decisions WHERE invocation_id=?',invocationId))fail('judge_decision_required','Successful settlement requires the committed Engine decision receipt.');
    // Even a worker-claimed completion cannot make an uncertain/native-unsupported launch safe to replay.
    const artifact=this.store.putJson({outcome:result.outcome,usage:result.usage??null,qualification:result.qualification??'Worker observation, not an installed native attestation.'});
    this.store.transaction(()=>{
      if(!['admitted','started','unknown'].includes(row.state))fail('judge_invocation_settled','Turn is already settled.');
      this.store.run('UPDATE judge_invocations SET state=?,ended_at=?,result_artifact_id=? WHERE id=?',result.outcome,now(),artifact.artifactId,invocationId);
      if(result.outcome!=='completed')this.store.run("UPDATE judge_attention SET state='stale',reason=? WHERE id=? AND state!='resolved'",`provider_${result.outcome}`,row.attention_id);
      event(this,this.judgeAttentionView(row.attention_id).runId,'judge.turn_settled',{invocationId,outcome:result.outcome,result:artifact});
    });
    await this.settleHostPermit(row.host_permit_id,result.outcome==='unknown'?'unknown':'consumed',`Judge invocation ${invocationId}: ${result.outcome}`);
    return {invocationId,outcome:result.outcome};
  };
  // Owner transfer is the same trusted-authority boundary as registration: refused in host-bound mode before any state changes.
  P.fenceJudgeOwner = function (sessionId,{requestId,controllerSessionId}, {controllerToken}={}) {
    this.refuseHostMutation('Judge owner transfer');
    const session=this.judgeSession(sessionId,controllerToken);
    if(this.store.get(`SELECT id FROM judge_invocations WHERE session_id=? AND state IN ${ACTIVE}`,sessionId))fail('judge_turn_unreconciled','A live or unknown turn must be reconciled before transfer.');
    if(!this.store.get('SELECT id FROM controller_sessions WHERE id=?',controllerSessionId))fail('not_found','New controller session not found.',404);
    return this.idempotent('POST /judge-owner-transfer',requestId,{sessionId,controllerSessionId},()=>{
      this.store.run('UPDATE judge_sessions SET owner_generation=owner_generation+1,controller_session_id=? WHERE id=?',controllerSessionId,sessionId);
      return {status:200,body:{judgeSessionId:sessionId,ownerGeneration:session.owner_generation+1}};
    });
  };
}
