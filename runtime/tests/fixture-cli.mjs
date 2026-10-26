// Deterministic stand-in for a provider CLI. It speaks the Codex JSON event protocol.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let [scenario = 'echo', session = '', stateDir = '', provider = 'codex', schemaPath = ''] = process.argv.slice(2);
const event = data => process.stdout.write(JSON.stringify(data) + '\n');
const prompt = await new Promise(resolve => { let text = ''; process.stdin.on('data', chunk => { text += chunk; }); process.stdin.on('end', () => resolve(text)); });
const sessionId = session || `fixture-${randomUUID()}`;
let turns = 0;
if (stateDir) {
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, `${sessionId}.log`);
  if (existsSync(file)) turns = readFileSync(file, 'utf8').split('\n␞\n').length - 1;
  appendFileSync(file, `${prompt}\n␞\n`);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const answer = text => event({ type: 'item.completed', item: { type: 'agent_message', text } });
const done = () => event({ type: 'turn.completed', usage: { input_tokens: prompt.length, output_tokens: 3 } });

event({ type: 'thread.started', thread_id: sessionId });
// Like the real CLIs, reject a native output schema outside the provider-supported subset.
if (schemaPath) {
  const { nativeSchemaProblems } = await import('../core/transport.mjs');
  const problems = nativeSchemaProblems(JSON.parse(readFileSync(schemaPath, 'utf8')));
  if (problems.length) { event({ type: 'error', message: `Invalid schema for response_format 'codex_output_schema': ${problems.join('; ')}` }); process.exit(1); }
}
if (scenario === 'fail') { event({ type: 'error', message: 'Simulated process failure.' }); process.exit(1); }
const delayedFailure = /^fail-after-(\d+)$/.exec(scenario);
if (delayedFailure) { await sleep(Number(delayedFailure[1]) * 1000); event({ type: 'error', message: 'Simulated delayed process failure.' }); process.exit(1); }
if (scenario === 'quota') { event({ type: 'error', message: 'Usage limit reached. Quota exhausted.' }); process.exit(1); }
if (scenario === 'rate-limited') { event({ type: 'error', message: 'Rate limit exceeded. HTTP 429.' }); process.exit(1); }
if (scenario === 'auth-required') { event({ type: 'error', message: 'Authentication required. HTTP 401.' }); process.exit(1); }
if (scenario === 'service-unavailable') { event({ type: 'error', message: 'Service temporarily unavailable. HTTP 503.' }); process.exit(1); }
if (scenario === 'malformed-jsonl') { process.stdout.write('{"type":\n'); process.exit(0); }
if (scenario === 'no-final-newline') {
  event({ type: 'item.completed', item: { type: 'agent_message', text: 'Final line without a newline.' } });
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: prompt.length, output_tokens: 5 } }));
  process.exit(0);
}
if (scenario === 'unknown-event') event({ type: 'future.provider_event', payload: { retained: true } });
if (scenario === 'no-terminal') { answer('{"message":"partial"}'); process.exit(0); }
if (scenario === 'bad-json') { answer('{"wrong": 42}'); done(); process.exit(0); }
if (scenario === 'not-json') { answer('plain words'); done(); process.exit(0); }
if (scenario === 'managed-task') {
  const input = JSON.parse(/MANAGED_TASK_INPUT_BEGIN\n(.*)\nMANAGED_TASK_INPUT_END/.exec(prompt)[1]);
  const envelope = { status: 'COMPLETED', reason: '', requestedPaths: [], assessment: null, review: null, triage: null };
  if (input.request.includes('SLOW_DEFINE') && input.phase === 'define') await sleep(60000);
  if (input.request.includes('SLOW_SMOKE') && input.phase === 'implement') await sleep(50);
  if (['define', 'discovery'].includes(input.phase)) envelope.assessment = {
    schemaVersion: 1, kind: 'TaskAssessment', assessmentId: 'ASSESS-FIXTURE', assessmentRunId: input.runId, businessRequestId: input.businessRequestId,
    authorRole: 'analyst', sourceSnapshotHash: input.sourceSnapshotHash, intendedOutcome: 'Return the requested feature value.', constraints: [],
    requirements: [{ id: 'REQ-1', title: 'Requested value', acceptanceCriteria: [{ id: 'AC-1', description: 'The feature returns 42.', requiredEvidence: input.request.includes('MANUAL_ACCEPTANCE') ? 'Final business observation' : 'Passing engine check', evidenceProducer: input.request.includes('MANUAL_ACCEPTANCE') ? 'analyst' : 'testRunner' }] }],
    scope: { affectedComponents: ['src/feature.mjs'] }, sourceDerivedFacts: { criticalPaths: [], publicContracts: [], dependencyFanOut: 1 },
    assessmentAxes: { scopeCoupling: 'local', technicalDifficulty: 'low', failureImpact: 'limited', uncertainty: input.request.includes('UNCERTAIN') && input.phase === 'define' ? 'high' : 'low', verifiability: 'clear' },
    grounds: { references: ['src/feature.mjs'], assumptions: [], confidence: 'Fixture', unresolvedQuestions: [] }, planningAdvice: { recommendedStages: [] }, createdAt: new Date().toISOString(),
  };
  else if (input.phase === 'write-tests') {
    mkdirSync('tests', { recursive: true });
    writeFileSync('tests/feature.test.mjs', "import assert from 'node:assert/strict'; import {feature} from '../src/feature.mjs'; assert.equal(feature(),42);\n");
  } else if (input.phase === 'implement') {
    const value = input.request.includes('REPAIR_CHECK') && !input.feedback.some(item => item.phase === 'triage') ? 41 : 42;
    mkdirSync('src', { recursive: true }); writeFileSync('src/feature.mjs', `export const feature=()=>${value};\n`);
    if (input.request.includes('CRITICAL_ACTUAL')) { mkdirSync('docs/storage', { recursive: true }); writeFileSync('docs/storage/m12.sql', '-- fixture critical change\n'); }
    if (input.request.includes('SCOPE_VIOLATION')) writeFileSync('unapproved.txt', 'outside allowed scope');
  } else if (input.phase === 'triage') {
    envelope.triage = { cause: input.request.includes('ENVIRONMENT_FAILURE') ? 'environment' : 'implementation', reason: 'The captured check output identifies the cause.' };
  } else if (input.phase === 'review-code' && input.request.includes('REVIEW_INCOMPLETE')) {
    envelope.status = 'REVIEW_INCOMPLETE'; envelope.reason = 'The business requirement cannot be verified with the captured inputs.';
  } else if (input.phase === 'review-code' && input.request.includes('MISSING_CONTEXT')) {
    envelope.status = 'CONTEXT_NEEDED'; envelope.requestedPaths = ['missing-contract.md']; envelope.reason = 'Need a contract absent from the snapshot.';
  } else if (input.phase === 'review-code' && input.request.includes('CONTEXT_EXPANSION') && !input.expandedPaths.includes('README.md')) {
    envelope.status = 'CONTEXT_NEEDED'; envelope.requestedPaths = ['README.md']; envelope.reason = 'Need the captured project contract.';
  } else if (input.phase === 'review-code' && input.request.includes('EVIDENCE_EXPANSION') && !input.expandedPaths.some(path => path.startsWith('evidence:'))) {
    envelope.status = 'CONTEXT_NEEDED'; envelope.requestedPaths = [input.evidenceCatalog.find(item => item.kind === 'ExecutionEvidence').streams.stdout.chunks[0].requestPath]; envelope.reason = 'Need the exact captured check output chunk.';
  } else {
    if (input.phase === 'review-code' && input.request.includes('REVIEW_MUTATION')) writeFileSync('src/feature.mjs', 'export const feature=()=>99;\n');
    const repair = input.request.includes('REPAIR_REVIEW') && input.phase === 'review-code' && !input.feedback.some(item => item.phase === 'review-code');
    const readiness = ['confirm-plan', 'readiness-code', 'readiness-tests', 'review-test-source'].includes(input.phase);
    envelope.review = { verdict: repair ? 'CHANGES_REQUESTED' : 'APPROVED', reason: repair ? 'A source defect requires one repair.' : 'Captured source and checks satisfy the criteria.', criteria: input.criteria.map(c => ({ criterionId: c.id, status: repair ? 'unsatisfied' : readiness ? 'unverified' : 'satisfied', reason: readiness ? 'Ready for implementation; the business outcome is not asserted yet.' : 'Verified from the supplied source and evidence.' })) };
  }
  answer(JSON.stringify(envelope)); done(); process.exit(0);
}
const approve = /^checker-approve-(\d+)$/.exec(scenario);
if (approve) {
  // Approves once the reviewed draft reports writer turn >= N.
  const turn = Number((/turn (\d+)/.exec(prompt) || [0, 0])[1]);
  const ok = turn >= Number(approve[1]);
  answer(JSON.stringify({ continue: !ok, reason: ok ? `Turn ${turn} is good enough.` : `Turn ${turn} needs work.`, feedback: ok ? '' : `Improve on turn ${turn}.` }));
  done(); process.exit(0);
}
if (scenario === 'checker-invalid') { answer('{"continue":"false","reason":"Looks fine.","feedback":""}'); done(); process.exit(0); }
if (scenario === 'fail-once') {
  const marker = join(stateDir, `fail-once-${provider}.marker`);
  if (!existsSync(marker)) { mkdirSync(stateDir, { recursive: true }); appendFileSync(marker, 'failed'); event({ type: 'error', message: 'Simulated transient failure.' }); process.exit(1); }
}
if (scenario === 'analyst' || scenario === 'analyst-bad' || scenario === 'analyst-slow') {
  // Writes a specification bundle whose revision is the conversation turn.
  if (scenario === 'analyst-slow') await sleep(4000);
  const revision = turns + 1;
  const spec = `# Specification\n\n## BUS-RESUME\nRevision ${revision}. A reconnecting client resumes its paused round.\n\n## REQ-RESUME\nThe public API lists paused rounds of the caller.\n\n## CONTRACT-API\nGET /rounds?state=paused returns the caller's rounds.\n`;
  const index = { schemaVersion: 1, document: 'SPEC.md', sections: [
    { id: 'BUS-RESUME', kind: 'business', normative: true, visibility: 'public', dependsOn: [] },
    { id: 'REQ-RESUME', kind: 'requirement', normative: true, visibility: 'public', dependsOn: ['BUS-RESUME'] },
    { id: scenario === 'analyst-bad' ? 'CONTRACT-MISSING' : 'CONTRACT-API', kind: 'contract', normative: true, visibility: 'internal', dependsOn: ['REQ-RESUME'] },
  ] };
  writeFileSync(join(process.cwd(), 'SPEC.md'), spec);
  writeFileSync(join(process.cwd(), 'spec-index.json'), JSON.stringify(index, null, 2));
  answer(`Wrote revision ${revision}.`); done(); process.exit(0);
}
const reviewer = /^reviewer-(approve|wrong-role|foreign|reject-once)-(\d+)$/.exec(scenario);
if (reviewer) {
  // Reads SUBJECT.json and the spec text from the attachment list; approves at revision >= N.
  const attached = Object.fromEntries([...prompt.matchAll(/^- (\S+) → (.+)$/gm)].map(match => [match[1], match[2].trim()]));
  const subject = JSON.parse(readFileSync(attached['SUBJECT.json'], 'utf8'));
  // Specification views attach SPEC.md; delivery views nest it as specification/SPEC.md or SPEC.public.md.
  const specPath = Object.entries(attached).find(([path]) => /(^|\/)SPEC(\.public)?\.md$/.test(path))?.[1];
  const specText = readFileSync(specPath, 'utf8');
  const revision = Number((/Revision (\d+)/.exec(specText) || [0, 0])[1]);
  const plan = JSON.parse(/Review plan \(JSON\):\n(.*)\n/.exec(prompt)[1]);
  // A reviewer resolves its own issues and any imported issue the plan authorizes for its slot.
  const authorized = plan.slots?.find(slot => slot.id === subject.slot)?.resolvableIssueIds || [];
  const own = [...new Set([...plan.openIssues.filter(issue => issue.id.startsWith(`ISS-${subject.slot.toUpperCase()}-`)).map(issue => issue.id), ...authorized])];
  const ok = reviewer[1] === 'reject-once' ? turns > 0 : revision >= Number(reviewer[2]);
  const decision = { schemaVersion: 1, subjectId: subject.subjectId, role: reviewer[1] === 'wrong-role' ? 'someone-else' : subject.role,
    verdict: ok ? 'APPROVED' : 'CHANGES_REQUESTED', scopeRefs: ['REQ-RESUME'],
    resolvedIssueIds: reviewer[1] === 'foreign' ? plan.openIssues.map(issue => issue.id) : ok ? own : [],
    issues: ok ? [] : [{ localId: `rev-${revision}`, severity: 'blocker', ownerRole: 'analyst', requirementRefs: ['REQ-RESUME'], message: `Revision ${revision} is incomplete for ${subject.role}.`, requestedChange: 'Describe resume ordering.' }] };
  answer(JSON.stringify(decision)); done(); process.exit(0);
}
const finalTriage = /^final-triage(-spec)?$/.exec(scenario);
if (finalTriage) {
  // Delivery triage of a failed final Gate: repair the recovery code, or revise the specification.
  const spec = Boolean(finalTriage[1]);
  answer(JSON.stringify({ schemaVersion: 1, cause: spec ? 'specification' : 'implementation', action: spec ? 'revise-specification' : 'repair-tasks',
    affectedTaskIds: spec ? [] : ['TASK-RESUME-CODE'], requirementRefs: ['REQ-RESUME'], reason: `Final review failure triaged on turn ${turns + 1}.` }));
  done(); process.exit(0);
}
if (scenario === 'analyst-m5') {
  // Writes the round-recovery bundle (spec, index, map); the revision is the conversation turn.
  const doc = name => readFileSync(new URL(`../../docs/examples/round-recovery/${name}`, import.meta.url), 'utf8');
  writeFileSync(join(process.cwd(), 'SPEC.md'), doc('SPEC.md').replace('## BUSINESS-TASK\n', `## BUSINESS-TASK\n\nRevision ${turns + 1}.\n`));
  writeFileSync(join(process.cwd(), 'spec-index.json'), doc('spec-index.json'));
  writeFileSync(join(process.cwd(), 'implementation-map.json'), doc('implementation-map.json'));
  answer(`Wrote revision ${turns + 1}.`); done(); process.exit(0);
}
// ---------- M5 Map roles ----------
const toy = name => readFileSync(new URL(`./toy/${name}`, import.meta.url));
const taskId = (/^Task: (TASK-[A-Z0-9-]+)/m.exec(prompt) || [])[1];
const outputs = (/Outputs to write:\n((?:- .+\n)+)/.exec(prompt) || [, ''])[1].split('\n').filter(Boolean).map(line => line.slice(2));
const write = (path, bytes) => { mkdirSync(join(process.cwd(), ...path.split('/').slice(0, -1)), { recursive: true }); writeFileSync(join(process.cwd(), ...path.split('/')), bytes); };
const TOY = { 'src/auth.mjs': 'auth.mjs', 'src/resume.mjs': 'resume.mjs', 'tests/auth.test.mjs': 'auth.test.mjs', 'tests/resume.test.mjs': 'resume.test.mjs' };
// implementer-spec-once: the recovery task first asks for a specification revision, then implements.
const specOnceMarker = stateDir && taskId ? join(stateDir, `spec-once-${taskId}.marker`) : null;
if (scenario === 'implementer-spec-once' && taskId === 'TASK-RESUME-CODE' && !existsSync(specOnceMarker)) { mkdirSync(stateDir, { recursive: true }); writeFileSync(specOnceMarker, 'asked'); }
else if (scenario === 'implementer-spec-once') scenario = 'implementer';
if (/^(implementer|implementer-buggy|implementer-spec|implementer-spec-once|implementer-slow|test-author)$/.test(scenario)) {
  if (scenario === 'implementer-slow' && taskId === 'TASK-RESUME-CODE') await sleep(3000);
  if (scenario === 'implementer-spec' || scenario === 'implementer-spec-once') {
    answer(JSON.stringify({ schemaVersion: 1, kind: 'specification_revision_required', reason: 'The boundary is undefined.',
      issues: [{ localId: 'boundary', severity: 'blocker', requirementRefs: ['REQ-AUTH'], message: 'Expiration at exactly now is undefined.', requestedChange: 'Define expiresAt <= now as expired.' }] }));
    done(); process.exit(0);
  }
  for (const path of outputs) {
    if (path === 'src/auth.mjs' && scenario === 'implementer-buggy' && turns === 0) write(path, toy('auth-buggy.mjs'));
    else if (TOY[path]) write(path, toy(TOY[path]));
    else write(path, `// ${taskId} output (turn ${turns + 1})\n`);
  }
  answer(JSON.stringify({ schemaVersion: 1, kind: 'candidate', summary: `${taskId}: wrote ${outputs.join(', ')} on turn ${turns + 1}.` }));
  done(); process.exit(0);
}
if (scenario === 'task-reviewer-fail-once') {
  const marker = join(stateDir, 'task-reviewer-auth-failed.marker');
  if (taskId === 'TASK-AUTH-CODE' && !existsSync(marker)) {
    writeFileSync(marker, 'failed'); answer('{"invalidReview":true}'); done(); process.exit(0);
  }
  scenario = 'task-reviewer';
}
if (scenario === 'task-reviewer' || scenario === 'task-reviewer-reject-once') {
  const field = name => (new RegExp(`^${name}: ([A-Z0-9-]+)`, 'm').exec(prompt) || [])[1];
  const reject = scenario === 'task-reviewer-reject-once' && turns === 0;
  answer(JSON.stringify({ schemaVersion: 1, taskId: field('Task'), resultId: field('Result'), criterionId: field('Criterion'), verdict: reject ? 'CHANGES_REQUESTED' : 'APPROVED',
    issues: reject ? [{ localId: 'naming', severity: 'blocker', requirementRefs: [], message: 'Name the boundary explicitly.', requestedChange: 'Add a comment on the expiry rule.' }] : [] }));
  done(); process.exit(0);
}
if (scenario === 'triage-wrong-subject-once') {
  if (turns === 0) {
    answer(JSON.stringify({ schemaVersion: 1, cause: 'unknown', subjectId: 'TASK-VERIFY', affectedTaskIds: [], requirementRefs: [], reason: 'Wrong identity regression.', issues: [] }));
    done(); process.exit(0);
  }
  scenario = 'triage';
}
if (scenario === 'triage-native-subject') {
  const expected = (/^Specification: (SPEC-[A-F0-9]+)/m.exec(prompt) || [])[1];
  const property = schemaPath && JSON.parse(readFileSync(schemaPath, 'utf8')).properties.subjectId;
  const pinned = property && (property.const ?? (property.enum?.length === 1 ? property.enum[0] : undefined));
  if (pinned !== expected) { event({ type: 'error', message: 'The native triage schema does not pin the specification identity.' }); process.exit(1); }
  scenario = 'triage';
}
const triage = /^triage(-spec|-unknown|-tests)?$/.exec(scenario);
if (triage) {
  const subjectId = (/^Specification: (SPEC-[A-F0-9]+)/m.exec(prompt) || [])[1];
  const candidates = ((/^Candidate tasks: (.+)$/m.exec(prompt) || [])[1] || '').split(', ');
  const failed = [...prompt.matchAll(/^Failed check (CHECK-[A-Z0-9-]+)/gm)].map(match => match[1]);
  const conflict = /^Conflict on /m.test(prompt);
  const pick = suffix => candidates.find(id => id.endsWith(suffix)) || candidates[0];
  const target = triage[1] === '-tests' ? pick('AUTH-TESTS') : conflict ? candidates[0] : failed.includes('CHECK-AUTH') ? pick('AUTH-CODE') : pick('RESUME-CODE');
  const cause = triage[1] === '-spec' ? 'specification' : triage[1] === '-unknown' ? 'unknown' : conflict ? 'integration_conflict' : triage[1] === '-tests' ? 'tests' : 'implementation';
  const issue = { localId: 'verify', severity: 'blocker', ownerRole: cause === 'specification' ? 'analyst' : 'implementer', requirementRefs: ['REQ-AUTH'],
    message: `${failed.join(', ') || 'Assembly'} failed on turn ${turns + 1}.`, requestedChange: 'Treat expiresAt <= now as expired.' };
  answer(JSON.stringify({ schemaVersion: 1, cause, subjectId, affectedTaskIds: ['implementation', 'tests', 'integration_conflict'].includes(cause) ? [target] : [],
    requirementRefs: cause === 'specification' ? ['REQ-AUTH'] : [], reason: `Triage turn ${turns + 1}.`, issues: cause === 'unknown' ? [] : [issue] }));
  done(); process.exit(0);
}
if (scenario === 'write-out') { appendFileSync(join(process.cwd(), 'out.txt'), `written by ${provider}
`); }
if (scenario === 'noisy') { for (let i = 0; i < 400; i++) event({ type: 'fixture_noise', index: i, padding: 'x'.repeat(400) }); }
if (scenario === 'lifecycle-proposal') {
  // Deterministic Judge proposal for the self-repair fixture. It repeats the candidate identity that the harness saved in the
  // workspace (candidate.json) and never computes or invents one. Without that file it proposes nothing.
  const candidateFile = join(process.cwd(), 'candidate.json');
  const candidate = existsSync(candidateFile) ? JSON.parse(readFileSync(candidateFile, 'utf8')) : null;
  answer(candidate
    ? `Candidate reviewed; contract tests passed.\nREQUEST_LIFECYCLE_ACTION ${JSON.stringify({ action: 'application.activate_candidate', target_version: candidate.candidateId ?? '0.2.1-repair.1', candidate_digest: candidate.candidateDigest, continuation_checkpoint_id: candidate.continuationCheckpointId })}`
    : 'No candidate identity was found; no lifecycle action is requested.');
  done(); process.exit(0);
}
const slow = /^slow-(\d+)$/.exec(scenario);
if (slow) {
  // A descendant proves that Stop terminates the whole tree; a normal finish cleans it up.
  const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  descendant.unref();
  if (stateDir) {
    writeFileSync(join(stateDir, 'slow-provider.pid'), String(process.pid));
    writeFileSync(join(stateDir, 'slow-descendant.pid'), String(descendant.pid));
  }
  await sleep(Number(slow[1]) * 1000);
  try { process.kill(descendant.pid); } catch { /* Already gone. */ }
}
const last = prompt.trim().split('\n')[0].slice(0, 80);
answer(JSON.stringify({ message: `${provider} turn ${turns + 1}: ${last}` }));
done();
