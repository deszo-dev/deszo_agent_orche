// Acceptance evidence is installed by the elevated verification operator, outside ordinary autonomous operations.
// No candidate, controller, worker or caller boolean can flip production authority. Changed host bytes invalidate it.
import { canonicalHash, canonicalize } from '../core/canonical.mjs';
import { HostError } from './authority.mjs';
import { CAPABILITIES } from './capabilities.mjs';

export const REQUIRED_NATIVE_CHECKS = Object.freeze({
  protectedService: ['scm-localservice-sid','protected-state-and-config-acls'],
  peerIdentity: ['mutual-native-pipe-identity','untrusted-peer-and-endpoint-refused'],
  consentBroker: ['native-webauthn-uv-signature','decision-bound-native-consent','synthetic-consent-refused'],
  launcherTask: ['protected-interactive-task','actual-medium-nonadmin-token','launcher-independent-of-deszo'],
  nativeJobFailStop: ['scm-crash-owned-tree','pending-launch-crash','duplicate-handle-refused','real-deszo-nested-jobs','stable-preview-and-unrelated-survive','native-deadline'],
  immutableBuildIdentity: ['sealed-build-write-refused','manifest-substitution-refused','authority-dependency-closure-refused','pinned-metadata-tool'],
  routeCredentialMatrix: ['published-route-matrix','legacy-route-mutations-refused','candidate-has-no-firstparty-credential'],
  persistentWorker: ['installed-worker-without-chat','durable-queue-no-unknown-replay','processed-observation-ack','stalled-worker-stops','injected-worker-actions-refused','worker-timeout-profile'],
  compatibleRollback: ['native-fork-preserves-new-writes','incompatible-store-refused','host-authority-history-preserved'],
  nativeUiEvidence: ['native-foreground-build-evidence','wrong-identity-refused','locked-desktop-unavailable'],
});
const deny = message => { throw new HostError(503, 'autonomy_disabled', message); };
export class InstalledEnablement {
  constructor({ host, installation }) { Object.assign(this, { host, sourceDigest: canonicalHash({fingerprintVersion:2,installation}) }); }
  missing() { return CAPABILITIES.filter(c => !this.host.get('SELECT capability FROM capability_receipts WHERE capability=? AND source_digest=?', c.id, this.sourceDigest)).map(c => c.id); }
  record({ capability, sourceDigest, evidence }) {
    if (!REQUIRED_NATIVE_CHECKS[capability] || sourceDigest !== this.sourceDigest) deny('Capability evidence belongs to another protected host build.');
    if (!evidence || evidence.assurance !== 'native' || !Array.isArray(evidence.checks) || !evidence.probeSourceSha256?.match(/^[a-f0-9]{64}$/) || !evidence.recordedAt || evidence.sourceDigest !== sourceDigest) deny('An independent source-bound native evidence document is required.');
    for (const id of REQUIRED_NATIVE_CHECKS[capability]) {
      const matches = evidence.checks.filter(c => c.id === id);
      if (matches.length !== 1 || matches[0].passed !== true || !matches[0].evidence || canonicalize(matches[0].evidence) === '{}') deny(`Required independent native check is missing: ${id}.`);
    }
    this.host.transaction(() => {
      this.host.run('INSERT INTO capability_receipts(capability,source_digest,evidence_json,recorded_at) VALUES(?,?,?,?) ON CONFLICT(capability) DO UPDATE SET source_digest=excluded.source_digest,evidence_json=excluded.evidence_json,recorded_at=excluded.recorded_at', capability, sourceDigest, canonicalize(evidence), evidence.recordedAt);
      this.host.audit('installation.capability_recorded', { capability, sourceDigest, evidenceDigest: canonicalHash(evidence) });
    });
    return { recorded: true, capability, sourceDigest, missing: this.missing() };
  }
  enable() {
    const assurance = this.host.get("SELECT value FROM host_meta WHERE key='assurance'")?.value;
    if (assurance !== 'production' || !['bootstrap','production'].includes(this.host.assurance)) deny('Fixture authority cannot be promoted.');
    const missing = this.missing(); if (missing.length) deny(`Native verification is incomplete: ${missing.join(', ')}.`);
    if (!this.host.verifyAudit().intact) deny('Host audit integrity is not established.');
    const row = { enabled: true, sourceDigest: this.sourceDigest, at: new Date(this.host.time.wallNow()).toISOString() };
    this.host.transaction(() => { this.host.run("INSERT INTO host_meta(key,value) VALUES('production_enablement',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", canonicalize(row)); this.host.audit('installation.autonomy_enabled', row); });
    this.host.assurance = 'production'; return row;
  }
  restore() {
    if (this.host.get("SELECT value FROM host_meta WHERE key='assurance'")?.value !== 'production' || !['bootstrap','production'].includes(this.host.assurance)) return false;
    const row = this.host.get("SELECT value FROM host_meta WHERE key='production_enablement'"); if (!row) return false;
    const selected = JSON.parse(row.value);
    if (selected.enabled !== true || selected.sourceDigest !== this.sourceDigest || this.missing().length || !this.host.verifyAudit().intact) return false;
    this.host.assurance = 'production'; return true;
  }
}
