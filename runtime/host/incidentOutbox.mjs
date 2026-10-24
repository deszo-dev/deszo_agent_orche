import { canonicalHash, canonicalize } from '../core/canonical.mjs';
import { HostError } from './authority.mjs';
import { check } from '../core/schemas.mjs';

// Delivery retries use the exact persisted engine request ID/body. A lost response is not a new incident or a new run.
export class IncidentOutbox {
  constructor({ host }) { this.host = host; }
  enqueue({ requestId, policyId, itemId = null, profileId, storeId = null, observation }) {
    if (check('run-control-api.schema.json','incidentFileRequest',{requestId,observation}).length) throw new HostError(400,'invalid_incident','A schema-valid immutable incident request is required.');
    // The engine refuses a malformed observation only at delivery; refusing it here keeps invalid evidence out of the outbox.
    if (check('incident.schema.json','incidentObservation',observation).length) throw new HostError(400,'invalid_incident','The incident observation does not match its contract.');
    if (JSON.parse(this.host.policyRow(policyId).decision_json).scope.dataProfile !== profileId) throw new HostError(403,'incident_profile_mismatch','The incident profile is outside its policy.');
    const digest = canonicalHash({ policyId, itemId, profileId, storeId, observation });
    return this.host.transaction(() => {
      const old = this.host.get('SELECT * FROM incident_outbox WHERE request_id=?', requestId);
      if (old) {
        if (old.observation_digest !== digest) throw new HostError(409, 'conflict', 'An incident request ID cannot be reused for other evidence.');
        return this.view(old);
      }
      const at = new Date(this.host.time.wallNow()).toISOString();
      this.host.run("INSERT INTO incident_outbox(request_id,policy_id,item_id,profile_id,store_id,run_id,observation_json,observation_digest,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?)",
        requestId, policyId, itemId, profileId, storeId, observation.runId ?? null, canonicalize(observation), digest, at, at);
      this.host.audit('incident.spooled', { requestId, itemId, runId: observation.runId ?? null, observationDigest: digest }, { policyId });
      return this.get(requestId);
    });
  }
  view(row) { return { requestId: row.request_id, policyId: row.policy_id, itemId: row.item_id, runId: row.run_id, state: row.state, attempts: row.attempts, receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null, lastError: row.last_error, termination: row.termination_json ? JSON.parse(row.termination_json) : null }; }
  get(requestId) { const row = this.host.get('SELECT * FROM incident_outbox WHERE request_id=?', requestId); if (!row) throw new HostError(404,'not_found','Incident outbox entry not found.'); return this.view(row); }
  termination(requestId, evidence) {
    this.host.transaction(() => {
      this.host.run('UPDATE incident_outbox SET termination_json=?,updated_at=? WHERE request_id=?', canonicalize(evidence), new Date(this.host.time.wallNow()).toISOString(), requestId);
      this.host.audit('incident.native_stop_observed', { requestId, evidence }, { policyId: this.get(requestId).policyId });
    });
    return this.get(requestId);
  }
  recover() {
    // The receiving engine's durable request receipt, not this transient sending state, resolves a lost reply.
    this.host.run("UPDATE incident_outbox SET state='pending',last_error='Delivery interrupted; reconcile using the same engine request receipt.' WHERE state='sending'");
  }
  async deliver(requestId, { profileId, storeId, post }) {
    let row = this.host.get('SELECT * FROM incident_outbox WHERE request_id=?', requestId);
    if (!row) throw new HostError(404,'not_found','Incident outbox entry not found.');
    if (row.state === 'registered') return this.view(row);
    if (row.profile_id !== profileId || !storeId || (row.store_id && row.store_id !== storeId) || (!row.store_id && row.run_id)) throw new HostError(403,'incident_store_mismatch','The original application profile and store must be established before incident delivery.');
    // A setup incident created before an application store existed has no run/artifact references. Bind that global
    // observation once to the first independently registered store of the already selected profile.
    if (!row.store_id) {
      this.host.transaction(() => { this.host.run('UPDATE incident_outbox SET store_id=? WHERE request_id=? AND store_id IS NULL',storeId,requestId); this.host.audit('incident.initial_store_bound',{requestId,storeId,profileId},{policyId:row.policy_id}); });
      row=this.host.get('SELECT * FROM incident_outbox WHERE request_id=?',requestId);
    }
    if (row.state === 'sending') throw new HostError(409,'incident_delivery_busy','An incident delivery already owns this request.');
    this.host.run("UPDATE incident_outbox SET state='sending',attempts=attempts+1,updated_at=? WHERE request_id=?", new Date(this.host.time.wallNow()).toISOString(), requestId);
    try {
      const result = await post({ requestId, observation: JSON.parse(row.observation_json) });
      if (!result?.incidentId) throw new HostError(502,'incident_receipt_missing','The engine returned no durable incident receipt.');
      this.host.transaction(() => {
        this.host.run("UPDATE incident_outbox SET state='registered',receipt_json=?,last_error=NULL,updated_at=? WHERE request_id=?", canonicalize(result), new Date(this.host.time.wallNow()).toISOString(), requestId);
        this.host.audit('incident.registered', { requestId, incidentId: result.incidentId, receiptDigest: canonicalHash(result) }, { policyId: row.policy_id });
      });
    } catch (error) {
      this.host.run("UPDATE incident_outbox SET state='pending',last_error=?,updated_at=? WHERE request_id=?", error.message.slice(0,4000), new Date(this.host.time.wallNow()).toISOString(), requestId);
    }
    return this.get(requestId);
  }
}
