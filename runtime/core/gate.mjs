import { canonicalHash, parseStrictJson, sha256 } from './canonical.mjs';
import { assertValid, check } from './schemas.mjs';
import { UtilityError, jsonValue, ref, values as valueHelpers } from './utilities.mjs';

const PUBLIC_KINDS = new Set(['business', 'requirement', 'acceptance']);
const PREFIX = { requirement: 'REQ-', contract: 'CONTRACT-', check: 'CHECK-' };
const fail = message => { throw new UtilityError('output_contract', message); };
const shortHash = (value, length) => canonicalHash(value).slice(0, length).toUpperCase();

export const policyFingerprint = policy => canonicalHash(policy);
export const subjectIdOf = manifestSha => `SPEC-${manifestSha.slice(0, 12).toUpperCase()}`;

// Exact "## ID" headings outside fences; a section ends at the next second-level heading.
export function parseSections(markdown) {
  const sections = new Map();
  let inFence = false, current = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence && /^## (\S.*?)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      if (sections.has(current)) fail(`Section heading "${current}" appears more than once.`);
      sections.set(current, [line]);
    } else if (current) sections.get(current).push(line);
  }
  return new Map([...sections].map(([id, lines]) => [id, lines.join('\n').trimEnd()]));
}

// Validates a specification bundle (index, document, optional map) and returns its parts.
export function readBundle(store, subject) {
  const { readManifest } = valueHelpers(store);
  const manifest = readManifest(subject.artifact);
  const entries = new Map(manifest.entries.map(entry => [entry.path, entry]));
  const text = path => {
    const entry = entries.get(path);
    if (!entry) fail(`The specification bundle has no ${path}.`);
    return store.readBytes(entry.artifact.artifactId).bytes.toString('utf8');
  };
  let index;
  try { index = parseStrictJson(text('spec-index.json')); } catch (error) { if (error instanceof UtilityError) throw error; fail(`spec-index.json is not valid JSON: ${error.message}`); }
  const issues = check('spec-section-index.schema.json', null, index);
  if (issues.length) fail(`spec-index.json does not match its schema: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`);
  const document = text(index.document);
  const headings = parseSections(document);
  const ids = new Set();
  for (const section of index.sections) {
    if (ids.has(section.id)) fail(`Section ${section.id} is indexed twice.`);
    ids.add(section.id);
    if (!headings.has(section.id)) fail(`Indexed section ${section.id} has no "## ${section.id}" heading in ${index.document}.`);
    if (PREFIX[section.kind] && !section.id.startsWith(PREFIX[section.kind])) fail(`${section.kind} section ${section.id} must start with ${PREFIX[section.kind]}.`);
    if (!section.normative && section.kind !== 'informative') fail(`Section ${section.id} is ${section.kind} but not normative.`);
  }
  for (const id of headings.keys()) if (!ids.has(id)) fail(`Heading "## ${id}" is not in spec-index.json.`);
  const byId = new Map(index.sections.map(section => [section.id, section]));
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) fail(`Section dependencies form a cycle: ${[...path, id].join(' → ')}.`);
    state.set(id, 1);
    for (const dependency of byId.get(id).dependsOn) {
      if (!byId.has(dependency)) fail(`Section ${id} depends on unknown section ${dependency}.`);
      if (!byId.get(dependency).normative) fail(`Section ${id} depends on informative section ${dependency}.`);
      visit(dependency, [...path, id]);
    }
    state.set(id, 2);
  };
  for (const id of byId.keys()) visit(id, []);
  if (entries.has('implementation-map.json')) {
    let map;
    try { map = parseStrictJson(text('implementation-map.json')); } catch (error) { fail(`implementation-map.json is not valid JSON: ${error.message}`); }
    const mapIssues = check('implementation-map.schema.json', null, map);
    if (mapIssues.length) fail(`implementation-map.json does not match its schema: ${mapIssues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`);
  }
  return { manifest, entries, index, document, headings };
}

// M6 Merkle section hashes: exact section bytes, index metadata, dependency hashes and,
// for the map section, the canonical map bytes. Informative sections never feed a scope.
export function sectionHashes(bundle) {
  const byId = new Map(bundle.index.sections.map(section => [section.id, section]));
  const mapSha = bundle.entries.get('implementation-map.json')?.artifact.sha256 ?? null;
  const memo = new Map();
  const visit = id => {
    if (memo.has(id)) return memo.get(id);
    const section = byId.get(id);
    const value = canonicalHash({ text: sha256(Buffer.from(bundle.headings.get(id), 'utf8')), meta: section, deps: section.dependsOn.map(visit), map: section.kind === 'map' ? mapSha : null });
    memo.set(id, value);
    return value;
  };
  for (const id of byId.keys()) visit(id);
  return memo;
}

export function sectionClosure(index, roots) {
  const byId = new Map(index.sections.map(section => [section.id, section]));
  const result = new Set();
  const visit = id => {
    if (result.has(id)) return;
    if (!byId.has(id)) fail(`Scope names unknown section ${id}.`);
    result.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
  };
  roots.forEach(visit);
  return result;
}

// Hash of what a slot's view covers: its normative section closure, plus (for a full view
// without explicit scopeRefs) every bundle file that is not the document, index or map.
export function slotScopeHash(bundle, hashes, slot) {
  const sections = bundle.index.sections;
  const roots = slot.scopeRefs || sections.filter(section => section.normative && (slot.view === 'full' || (section.visibility === 'public' && PUBLIC_KINDS.has(section.kind)))).map(section => section.id);
  const closure = [...sectionClosure(bundle.index, roots)].sort();
  const files = slot.view === 'full' && !slot.scopeRefs
    ? bundle.manifest.entries.filter(entry => ![bundle.index.document, 'spec-index.json', 'implementation-map.json'].includes(entry.path)).map(entry => [entry.path, entry.artifact.sha256]).sort()
    : [];
  return canonicalHash({ view: slot.view, scopeRefs: slot.scopeRefs || null, sections: closure.map(id => [id, hashes.get(id)]), files });
}

// Issue ownership (RERUN-04). An issue in a slot's namespace ("ISS-<SLOT>-") belongs to that reviewer
// and only that slot may resolve it. An issue in a namespace no slot of this policy owns was imported
// (from a Map, a triage or another Gate's policy): a live slot may resolve it when its review scope
// covers every requirement the issue cites; an issue citing none needs an unrestricted full view.
export function issueOwner(issueId, slots) {
  return slots.find(slot => issueId.startsWith(`ISS-${slot.id.toUpperCase()}-`)) ?? null;
}
export function mayResolve({ issue, slot, slots, bundle }) {
  const owner = issueOwner(issue.id, slots);
  if (owner) return owner.id === slot.id;
  if (!issue.requirementRefs.length || !bundle) return slot.view === 'full' && !slot.scopeRefs;
  const roots = slot.scopeRefs || bundle.index.sections.filter(section => section.normative && (slot.view === 'full' || (section.visibility === 'public' && PUBLIC_KINDS.has(section.kind)))).map(section => section.id);
  const covered = sectionClosure(bundle.index, roots);
  return issue.requirementRefs.every(ref => covered.has(ref));
}

export function prepare({ store, config, inputs, reviewerFingerprints = {}, readRecord = null }) {
  const { putSet, readValue } = valueHelpers(store);
  const bundle = readBundle(store, inputs.subject);
  const subjectId = subjectIdOf(inputs.subject.artifact.sha256);
  const fingerprint = policyFingerprint(config.policy);
  const hashes = sectionHashes(bundle);
  // Prior approval for selective review (revisions-v1).
  let priorCertificate = null;
  const priorReviews = new Map();
  if (config.carry) {
    const claim = readValue(inputs.prior);
    if (claim !== null) {
      if (check('gate.schema.json', 'recordRef', claim).length) fail('The prior input must be a GateCertificate record reference or null.');
      const stored = readRecord(claim.recordId);
      if (!stored || stored.kind !== 'GateCertificate' || stored.ref.artifact.artifactId !== claim.artifact.artifactId) fail(`${claim.recordId} is not a certificate issued by this engine.`);
      priorCertificate = stored.value;
      for (const review of priorCertificate.reviews) {
        const record = readRecord(review.recordId);
        if (record && ['ReviewRecord', 'ReviewCarry'].includes(record.kind)) priorReviews.set(record.value.slot, { ref: record.ref, value: record.value });
      }
    }
  }
  const openIssues = readValue(inputs.issues);
  if (!Array.isArray(openIssues)) fail('The issues input must be a JSON array of open issues.');
  for (const issue of openIssues) {
    const problems = check('pipeline-state.schema.json', 'issue', issue);
    if (problems.length) fail(`An open issue does not match the issue record: ${problems.map(problem => `${problem.path} ${problem.message}`).join('; ')}`);
  }
  const entry = (path, bytes, mediaType) => ({ path, artifact: ref(store.putBytes(bytes, mediaType)), byteSize: bytes.length, mediaType });
  const outputs = { subject: inputs.subject };
  const slots = [];
  for (const slot of config.policy.slots) {
    const scopeHash = slotScopeHash(bundle, hashes, slot);
    const reviewerFingerprint = reviewerFingerprints[slot.id] ?? null;
    const prior = priorReviews.get(slot.id);
    const ownOpen = openIssues.some(issue => issue.id.startsWith(`ISS-${slot.id.toUpperCase()}-`) && issue.severity === 'blocker');
    let status = 'missing';
    if (prior) {
      const value = prior.value;
      const approved = value.kind === 'ReviewCarry' || value.verdict === 'APPROVED';
      const same = value.scopeHash === scopeHash && value.reviewerFingerprint && value.reviewerFingerprint === reviewerFingerprint && priorCertificate.policyFingerprint === fingerprint;
      status = approved && same && !ownOpen ? (priorCertificate.subject.sha256 === inputs.subject.artifact.sha256 ? 'current' : 'carried') : 'stale';
    }
    const needsReview = !['carried', 'current'].includes(status);
    if (config.carry) {
      const need = { schemaVersion: 1, kind: 'ReviewNeed', slot: slot.id, subjectId, status, needsReview, scopeHash,
        carry: needsReview ? null : { schemaVersion: 1, kind: 'ReviewCarryRequest', slot: slot.id, subjectId, priorReview: prior.ref, scopeHash } };
      assertValid('gate.schema.json', 'reviewNeed', need, 'Review need');
      outputs[`${slot.id}-need`] = jsonValue(store.putJson(need));
    }
    const marker = { schemaVersion: 1, subjectId, slot: slot.id, role: slot.role, view: slot.view, policyFingerprint: fingerprint };
    assertValid('gate.schema.json', 'subjectView', marker, 'Subject view marker');
    const files = [entry('SUBJECT.json', Buffer.from(JSON.stringify(marker, null, 2)), 'application/json')];
    if (slot.view === 'full') files.push(...bundle.manifest.entries);
    else {
      const sections = bundle.index.sections.filter(section => section.normative && section.visibility === 'public' && PUBLIC_KINDS.has(section.kind));
      const keep = new Set(sections.map(section => section.id));
      const publicIndex = { ...bundle.index, document: 'SPEC.public.md', sections: sections.map(section => ({ ...section, dependsOn: section.dependsOn.filter(id => keep.has(id)) })) };
      const body = `# Public specification view\n\nSubject ${subjectId}. Internal contracts, checks and the implementation map are not part of this view.\n\n${sections.map(section => bundle.headings.get(section.id)).join('\n\n')}\n`;
      files.push(entry('SPEC.public.md', Buffer.from(body), 'text/markdown; charset=utf-8'), entry('spec-index.public.json', Buffer.from(JSON.stringify(publicIndex, null, 2)), 'application/json'));
    }
    const view = putSet(files);
    outputs[slot.id] = view;
    slots.push({ id: slot.id, role: slot.role, view: slot.view, viewManifest: ref(view.artifact), scopeHash, status, needsReview, priorReview: prior && !needsReview ? prior.ref : null, reviewerFingerprint,
      resolvableIssueIds: openIssues.filter(issue => mayResolve({ issue, slot, slots: config.policy.slots, bundle })).map(issue => issue.id) });
  }
  const plan = { schemaVersion: 1, kind: 'ReviewPlan', subjectId, subject: ref(inputs.subject.artifact), policyFingerprint: fingerprint, slots, openIssues,
    priorCertificate: priorCertificate ? { recordId: priorCertificate.recordId, subjectId: priorCertificate.subjectId } : null };
  assertValid('gate.schema.json', 'reviewPlan', plan, 'Review plan');
  outputs.plan = jsonValue(store.putJson(plan));
  return { outputs, event: { mode: 'prepare', subjectId, status: null, recordId: null } };
}

// `reviewers` maps slot IDs to { nodeInstanceId, attemptId, requestedModel, observedModel } of the producing Agent attempt.
export function evaluate({ store, config, inputs, reviewers, runId, now, readRecord = null }) {
  const { readValue } = valueHelpers(store);
  const plan = readValue(inputs.plan);
  // Resolution authority is recomputed from the subject itself, never taken from the plan input.
  let subjectBundle = null;
  if (plan?.subjectKind !== 'delivery') { try { subjectBundle = readBundle(store, inputs.subject); } catch { subjectBundle = null; } }
  const problems = check('gate.schema.json', 'reviewPlan', plan);
  if (problems.length) fail(`The plan input is not a ReviewPlan: ${problems.map(problem => problem.message).join('; ')}`);
  if (plan.subject.sha256 !== inputs.subject.artifact.sha256) fail('The plan belongs to a different subject than the subject input.');
  if (plan.policyFingerprint !== policyFingerprint(config.policy)) fail('The plan was prepared under a different review policy.');
  const open = new Map(plan.openIssues.map(issue => [issue.id, issue]));
  const records = [], resolved = new Set(), added = [];
  for (const slot of config.policy.slots) {
    const decision = readValue(inputs[slot.id]);
    const planned = plan.slots.find(item => item.id === slot.id);
    if (decision?.kind === 'ReviewCarryRequest') {
      records.push(carryRecord({ slot, decision, planned, plan, runId, now, readRecord }));
      continue;
    }
    const issues = check('review-decision.schema.json', null, decision);
    if (issues.length) fail(`Slot ${slot.id}: the review does not match review-decision.schema.json (${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}).`);
    if (decision.subjectId !== plan.subjectId) fail(`Slot ${slot.id}: the review names subject ${decision.subjectId}, not ${plan.subjectId}.`);
    if (decision.role !== slot.role) fail(`Slot ${slot.id}: the review role is "${decision.role}", expected "${slot.role}".`);
    const localIds = decision.issues.map(issue => issue.localId);
    if (new Set(localIds).size !== localIds.length) fail(`Slot ${slot.id}: duplicate local issue IDs.`);
    const slotTag = `ISS-${slot.id.toUpperCase()}-`;
    for (const id of decision.resolvedIssueIds) {
      if (open.has(id) && !issueOwner(id, config.policy.slots)) {
        if (!mayResolve({ issue: open.get(id), slot, slots: config.policy.slots, bundle: subjectBundle }))
          fail(`Slot ${slot.id}: ${id} was imported for requirements outside this slot's review scope; a reviewer covering ${open.get(id).requirementRefs.join(', ') || 'the full specification'} must resolve it.`);
        resolved.add(id);
        continue;
      }
      if (!open.has(id)) fail(`Slot ${slot.id}: cannot resolve ${id}; it is not an open issue.`);
      if (!id.startsWith(slotTag)) fail(`Slot ${slot.id}: ${id} was raised by another reviewer and can only be resolved there.`);
      resolved.add(id);
    }
    const newIds = decision.issues.map(issue => {
      const id = `${slotTag}${shortHash({ subjectId: plan.subjectId, slot: slot.id, localId: issue.localId }, 10)}`;
      added.push({ id, severity: issue.severity, ownerRole: issue.ownerRole, requirementRefs: issue.requirementRefs, message: issue.message, requestedChange: issue.requestedChange });
      return id;
    });
    const reviewer = reviewers[slot.id];
    if (!reviewer) fail(`Slot ${slot.id}: the reviewing Agent attempt could not be identified.`);
    const decisionRef = ref(inputs[slot.id].artifact);
    const recordId = `REV-${shortHash({ subjectId: plan.subjectId, slot: slot.id, attemptId: reviewer.attemptId }, 12)}`;
    const record = { schemaVersion: 1, kind: 'ReviewRecord', recordId, subjectId: plan.subjectId, slot: slot.id, role: slot.role, verdict: decision.verdict,
      decision: decisionRef, reviewer: { runId, ...reviewer }, newIssueIds: newIds, resolvedIssueIds: decision.resolvedIssueIds,
      ...(planned?.scopeHash ? { scopeHash: planned.scopeHash, policyFingerprint: plan.policyFingerprint, reviewerFingerprint: planned.reviewerFingerprint ?? null } : {}) };
    assertValid('gate.schema.json', 'reviewRecord', record, 'Review record');
    records.push({ record, verdict: decision.verdict });
  }
  const remaining = [...open.values()].filter(issue => !resolved.has(issue.id));
  const issues = [...remaining, ...added.filter(issue => !remaining.some(existing => existing.id === issue.id))];
  const blockers = issues.filter(issue => issue.severity === 'blocker').length;
  const rejected = records.filter(item => item.verdict === 'CHANGES_REQUESTED').length;
  const carried = records.filter(item => item.record.kind === 'ReviewCarry').length;
  const status = rejected === 0 && blockers === 0 ? 'OPEN' : 'REVISION_REQUIRED';
  const reason = status === 'OPEN' ? `All ${records.length} required reviews approved ${plan.subjectId}${carried ? ` (${carried} carried from verified prior approvals)` : ''}.`
    : `${rejected} review(s) requested changes; ${blockers} open blocker(s) remain.`;
  return { plan, records: records.map(item => item.record), status, reason, issues };
}

// A carried slot is valid only when prepare planned it and the prior approval still matches.
function carryRecord({ slot, decision, planned, plan, runId, now, readRecord }) {
  const problems = check('gate.schema.json', 'reviewCarryRequest', decision);
  if (problems.length) fail(`Slot ${slot.id}: the carry request is malformed (${problems.map(item => item.message).join('; ')}).`);
  if (!planned || planned.needsReview || !planned.priorReview) fail(`Slot ${slot.id}: prepare did not plan a carried review; the live reviewer must run.`);
  if (decision.slot !== slot.id || decision.subjectId !== plan.subjectId || decision.scopeHash !== planned.scopeHash || decision.priorReview.recordId !== planned.priorReview.recordId)
    fail(`Slot ${slot.id}: the carry request does not match the review plan.`);
  const prior = readRecord(decision.priorReview.recordId);
  if (!prior || !['ReviewRecord', 'ReviewCarry'].includes(prior.kind) || prior.ref.artifact.artifactId !== decision.priorReview.artifact.artifactId) fail(`Slot ${slot.id}: ${decision.priorReview.recordId} is not an engine review record.`);
  const value = prior.value;
  if ((value.kind === 'ReviewRecord' && value.verdict !== 'APPROVED') || value.scopeHash !== planned.scopeHash || value.policyFingerprint !== plan.policyFingerprint
    || !value.reviewerFingerprint || value.reviewerFingerprint !== planned.reviewerFingerprint || value.slot !== slot.id)
    fail(`Slot ${slot.id}: the prior approval no longer matches this scope, policy or reviewer.`);
  const record = { schemaVersion: 1, kind: 'ReviewCarry', recordId: `RCAR-${shortHash({ subjectId: plan.subjectId, slot: slot.id, prior: value.recordId }, 12)}`,
    subjectId: plan.subjectId, priorSubjectId: value.subjectId, slot: slot.id, role: slot.role, verdict: 'APPROVED', priorReview: decision.priorReview,
    scopeHash: planned.scopeHash, policyFingerprint: plan.policyFingerprint, reviewerFingerprint: planned.reviewerFingerprint, runId, verifiedAt: now };
  assertValid('gate.schema.json', 'reviewCarry', record, 'Review carry');
  return { record, verdict: 'APPROVED' };
}

export function certificateFor({ plan, reviewRefs, runId, now }) {
  const recordId = `CERT-${shortHash({ subject: plan.subject.sha256, policy: plan.policyFingerprint, reviews: reviewRefs.map(item => item.recordId) }, 12)}`;
  const certificate = { schemaVersion: 1, kind: 'GateCertificate', recordId, subjectId: plan.subjectId, subject: plan.subject, policyFingerprint: plan.policyFingerprint,
    reviews: reviewRefs, issuedAt: now, runId,
    // A delivery certificate pins the exact specification approval (and, for the final Customer, the technical approval).
    ...(plan.subjectKind === 'delivery' ? { subjectKind: 'delivery', prerequisites: plan.prerequisites } : {}) };
  assertValid('gate.schema.json', 'certificate', certificate, 'Gate certificate');
  return certificate;
}

// ---------- Final delivery subject ----------
// Builds the immutable delivery subject from engine evidence only: the verified specification
// approval, the completed MapState, its Candidate and a passing CheckReport for every check
// criterion of the approved map. A final Customer prepare also requires a technical certificate
// for this exact subject. Agent-supplied JSON never establishes any of these facts.
export function prepareDelivery({ store, config, inputs, readRecord }) {
  const { putSet, readValue, readManifest } = valueHelpers(store);
  const lookup = id => { const found = readRecord(id); return found ? { kind: found.kind, artifact_id: found.ref.artifact.artifactId } : null; };
  const stored = (claim, kind) => {
    if (!claim || check('gate.schema.json', 'recordRef', claim).length) fail(`Expected a ${kind} record reference.`);
    const found = readRecord(claim.recordId);
    if (!found || found.kind !== kind || found.ref.artifact.artifactId !== claim.artifact.artifactId) fail(`${claim.recordId} is not a ${kind} record issued by this engine.`);
    store.verifyRef(claim.artifact);
    return found.value;
  };
  const specification = verify({ store, config: { policy: config.specificationPolicy }, inputs: { subject: inputs.documentation, certificate: inputs.approval }, lookupRecord: lookup });
  if (specification.status !== 'OPEN') fail(`The specification approval does not verify: ${specification.reason}`);
  const bundle = readBundle(store, inputs.documentation);
  const mapEntry = bundle.entries.get('implementation-map.json');
  if (!mapEntry) fail('The approved bundle contains no implementation-map.json.');
  const map = parseStrictJson(store.readBytes(mapEntry.artifact.artifactId).bytes.toString('utf8'));
  const summary = readValue(inputs.summary);
  const problems = check('map.schema.json', 'summary', summary);
  if (problems.length) fail(`The summary input is not a MapSummary: ${problems.map(item => `${item.path} ${item.message}`).join('; ')}`);
  if (summary.outcome !== 'implementation_complete') fail(`The Map outcome is ${summary.outcome}; final review needs implementation_complete.`);
  if (summary.specificationId !== specification.subjectId) fail(`The Map implemented ${summary.specificationId}, not the approved ${specification.subjectId}.`);
  const mapState = stored(summary.state, 'MapState');
  if (mapState.state !== 'implementation_complete' || mapState.subjectId !== specification.subjectId) fail('The MapState record is not a completed execution of this specification.');
  // The stored MapState is the selection proof. Every piece of evidence below is derived from its
  // selected TaskResults and their recorded criterion proofs; the summary's own references must match.
  const selected = new Map();
  for (const task of map.tasks) {
    const recorded = mapState.tasks.find(item => item.taskId === task.id);
    if (recorded?.state !== 'accepted' || !recorded.selectedResult) fail(`Task ${task.id} is not accepted in the recorded Map state.`);
    const result = stored(recorded.selectedResult, 'TaskResult');
    if (result.taskId !== task.id) fail(`${result.recordId} is not a result of ${task.id}.`);
    if (!Array.isArray(recorded.criteria)) fail(`MapState ${mapState.recordId} records no criterion evidence for ${task.id}; run the Map again to establish it.`);
    selected.set(task.id, { ref: recorded.selectedResult, result, criteria: new Map(recorded.criteria.map(item => [item.id, item.recordId])) });
  }
  if (summary.selectedResults.length !== selected.size || summary.selectedResults.some(item => selected.get(item.taskId)?.ref.recordId !== item.result.recordId))
    fail('The summary\'s selected results differ from the recorded Map state.');
  const producers = map.tasks.filter(task => task.outputs.some(output => output.type === 'candidate'));
  if (producers.length !== 1) fail('Final review needs exactly one candidate-producing verification task in the approved map.');
  const producer = selected.get(producers[0].id);
  const produced = Object.values(producer.result.outputs).find(output => output.type === 'candidate');
  if (!produced) fail(`${producer.result.recordId} records no candidate.`);
  if (!summary.candidate || summary.candidate.recordId !== produced.record.recordId || summary.candidate.artifact.artifactId !== produced.record.artifact.artifactId)
    fail(`The summary candidate is not ${produced.record.recordId}, the Candidate selected by MapState ${mapState.recordId}.`);
  const candidate = stored(produced.record, 'Candidate');
  const assembledFrom = candidate.results.map(item => item.recordId).sort();
  const expectedSources = producers[0].dependsOn.map(dep => selected.get(dep.taskId).ref.recordId).sort();
  if (assembledFrom.join() !== expectedSources.join()) fail(`Candidate ${candidate.recordId} was not assembled from the selected results ${expectedSources.join(', ')}.`);
  if (candidate.manifest.sha256 !== inputs.candidate.artifact.sha256) fail('The candidate input is not the Candidate recorded by the Map.');
  const indexed = new Map(bundle.index.sections.map(section => [section.id, section]));
  const checkSummaries = [];
  for (const task of map.tasks) for (const criterion of task.acceptanceCriteria.filter(item => item.method === 'check')) {
    const recordId = selected.get(task.id).criteria.get(criterion.id);
    if (!recordId) fail(`MapState ${mapState.recordId} records no evidence for ${task.id} ${criterion.id}.`);
    const found = readRecord(recordId);
    if (!found || found.kind !== 'CheckReport') fail(`${recordId} is not a CheckReport issued by this engine.`);
    store.verifyRef(found.ref.artifact);
    const report = found.value, command = indexed.get(criterion.checkId)?.command;
    if (report.taskId !== task.id || report.criterionId !== criterion.id || report.checkId !== criterion.checkId) fail(`${recordId} does not prove ${task.id} ${criterion.id}.`);
    if (report.outcome !== 'passed' || report.sourceIntegrity !== 'intact') fail(`${recordId} did not pass with intact sources.`);
    if (!command || canonicalHash(report.arguments) !== canonicalHash(command.args) || report.requiredExitCode !== command.requiredExitCode || report.timeoutSeconds !== command.timeoutSeconds || report.source.kind !== command.source)
      fail(`${recordId} did not run the approved ${criterion.checkId} command.`);
    const expectedSource = command.source === 'candidate' ? candidate.recordId : selected.get(task.id).ref.recordId;
    if (report.source.recordId !== expectedSource) fail(`${recordId} checked ${report.source.recordId}, not the selected ${expectedSource}.`);
    checkSummaries.push({ taskId: task.id, criterionId: criterion.id, checkId: criterion.checkId, outcome: 'passed', exitCode: report.exitCode, recordId, source: report.source });
  }
  const entry = (path, bytes, mediaType) => ({ path, artifact: ref(store.putBytes(bytes, mediaType)), byteSize: bytes.length, mediaType });
  const json = value => Buffer.from(JSON.stringify(value, null, 2));
  const deliveryRecord = { schemaVersion: 1, kind: 'DeliverySubject', specificationId: specification.subjectId, specificationCertificate: specification.certificate,
    mapState: summary.state, candidate: summary.candidate, checks: checkSummaries };
  const candidateEntries = readManifest(inputs.candidate.artifact).entries;
  const files = [
    entry('DELIVERY.json', json(deliveryRecord), 'application/json'),
    ...bundle.manifest.entries.map(item => ({ ...item, path: `specification/${item.path}` })),
    ...candidateEntries.map(item => ({ ...item, path: `candidate/${item.path}` })),
    ...checkSummaries.map(item => entry(`checks/${item.criterionId}.json`, json(item), 'application/json')),
  ].sort((a, b) => (a.path < b.path ? -1 : 1));
  const subject = putSet(files);
  const subjectId = `DLV-${subject.artifact.sha256.slice(0, 12).toUpperCase()}`;
  const fingerprint = policyFingerprint(config.policy);
  const prerequisites = [specification.certificate];
  if (config.technicalPolicy) {
    const claim = readValue(inputs.technical);
    const technical = stored(claim, 'GateCertificate');
    if (technical.subject.sha256 !== subject.artifact.sha256) fail(`Technical certificate ${technical.recordId} approved ${technical.subjectId}, not this delivery ${subjectId}.`);
    if (technical.policyFingerprint !== policyFingerprint(config.technicalPolicy)) fail(`Technical certificate ${technical.recordId} was issued under a different policy.`);
    prerequisites.push(claim);
  }
  const openIssues = readValue(inputs.issues);
  if (!Array.isArray(openIssues)) fail('The issues input must be a JSON array of open issues.');
  for (const issue of openIssues) if (check('pipeline-state.schema.json', 'issue', issue).length) fail('An open issue does not match the issue record.');
  const outputs = { subject };
  const slots = [];
  const sections = bundle.index.sections.filter(section => section.normative && section.visibility === 'public' && PUBLIC_KINDS.has(section.kind));
  for (const slot of config.policy.slots) {
    const marker = { schemaVersion: 1, subjectId, slot: slot.id, role: slot.role, view: slot.view, policyFingerprint: fingerprint };
    assertValid('gate.schema.json', 'subjectView', marker, 'Subject view marker');
    const viewFiles = [entry('SUBJECT.json', json(marker), 'application/json')];
    if (slot.view === 'full') viewFiles.push(...files);
    else {
      // Customer view: public business/requirements/scenarios and engine check summaries; no source or internal contracts.
      const body = `# Public delivery view\n\nDelivery ${subjectId} for specification ${specification.subjectId}.\n\n${sections.map(section => bundle.headings.get(section.id)).join('\n\n')}\n`;
      viewFiles.push(entry('SPEC.public.md', Buffer.from(body), 'text/markdown; charset=utf-8'),
        entry('DELIVERY.public.json', json({ subjectId, specificationId: specification.subjectId, candidate: summary.candidate.recordId, checks: checkSummaries.map(({ source, ...item }) => item) }), 'application/json'));
    }
    const view = putSet(viewFiles);
    outputs[slot.id] = view;
    slots.push({ id: slot.id, role: slot.role, view: slot.view, viewManifest: ref(view.artifact) });
  }
  const plan = { schemaVersion: 1, kind: 'ReviewPlan', subjectId, subject: ref(subject.artifact), policyFingerprint: fingerprint, slots, openIssues, subjectKind: 'delivery', prerequisites };
  assertValid('gate.schema.json', 'reviewPlan', plan, 'Review plan');
  outputs.plan = jsonValue(store.putJson(plan));
  return { outputs, event: { mode: 'prepare', subjectId, status: null, recordId: null } };
}

export function report({ status, subjectId, reason, issues, certificate }) {
  const value = { schemaVersion: 1, kind: 'GateReport', status, subjectId, reason, issues, certificate };
  assertValid('gate.schema.json', 'report', value, 'Gate report');
  return value;
}

// Verify an engine-issued certificate against the current subject and policy; never calls a model.
export function verify({ store, config, inputs, lookupRecord }) {
  const { readValue } = valueHelpers(store);
  const subjectId = subjectIdOf(inputs.subject.artifact.sha256);
  const claimed = readValue(inputs.certificate);
  const revise = reason => ({ status: 'REVISION_REQUIRED', subjectId, reason, certificate: null });
  if (claimed === null) return revise('No approval certificate exists for this subject yet.');
  if (check('gate.schema.json', 'recordRef', claimed).length) return revise('The certificate input is not a record reference.');
  const row = lookupRecord(claimed.recordId);
  if (!row || row.kind !== 'GateCertificate' || row.artifact_id !== claimed.artifact.artifactId) return revise(`Certificate ${claimed.recordId} was not issued by this engine.`);
  store.verifyRef(claimed.artifact);
  const certificate = store.readJson(claimed.artifact.artifactId);
  assertValid('gate.schema.json', 'certificate', certificate, 'Stored certificate');
  if (certificate.subject.sha256 !== inputs.subject.artifact.sha256) return revise(`Certificate ${claimed.recordId} approved ${certificate.subjectId}, not the current subject ${subjectId}.`);
  if (certificate.policyFingerprint !== policyFingerprint(config.policy)) return revise(`Certificate ${claimed.recordId} was issued under a different review policy.`);
  return { status: 'OPEN', subjectId, reason: `Certificate ${claimed.recordId} is valid for ${subjectId}.`, certificate: claimed };
}

export const digestOf = text => sha256(Buffer.from(text, 'utf8'));
