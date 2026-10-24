// Multi-Provider External Judge PoC Runner for ADR-0007.
// Executes safely available checks, reconciles previous PoC findings, tests Antigravity headless execution and conversation resume,
// and enforces the Claude policy gate without bypassing any boundaries or billing restrictions.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CodexJudgeAdapter } from './lib/codex-judge-adapter.mjs';
import { AntigravityJudgeAdapter } from './lib/antigravity-judge-adapter.mjs';
import { ClaudeJudgeAdapter } from './lib/claude-judge-adapter.mjs';
import { STATUS, REQUESTED_BILLING_POLICY } from './lib/judge-adapter-contract.mjs';

const RESULTS_DIR = join(import.meta.dirname, 'results');
mkdirSync(RESULTS_DIR, { recursive: true });

async function runCodex() {
  console.log('\n--- Running OpenAI Codex Evaluation ---');
  const adapter = new CodexJudgeAdapter();
  const caps = await adapter.inspectCapabilities();
  const authDefault = await adapter.validateAuthentication();
  const authIsolated = await adapter.validateAuthentication('C:/DeszoPoC/isolated-home');
  const billingDefault = await adapter.verifyBillingMode(REQUESTED_BILLING_POLICY.SUBSCRIPTION_ONLY);
  const billingIsolated = await adapter.verifyBillingMode(REQUESTED_BILLING_POLICY.SUBSCRIPTION_ONLY, 'C:/DeszoPoC/isolated-home');

  const reconciliation = {
    provider: 'codex',
    version: caps.exactClientVersion,
    capabilities: caps,
    authDefaultProfile: authDefault,
    authIsolatedHome: authIsolated,
    billingDefaultProfile: billingDefault,
    billingIsolatedHome: billingIsolated,
    reconciledFindings: {
      http401RootCause: 'The Codex App Server in an isolated CODEX_HOME has no user auth token (account/read returns no account). The App Server emits turn/started upon local task admission before dispatching to OpenAI; the backend request then fails with HTTP 401 Unauthorized.',
      tokenSharingPolicy: 'OpenAI Sign in with ChatGPT (SIWC) and Token Sharing for Open Source imposes preview limitations: third-party orchestrators cannot extract or reuse user tokens without registered OAuth client credentials and user consent.',
      sessionLocking: 'Codex enforces thread-writer file locks in the same CODEX_HOME, but has no owner-generation fencing (POC-05 S2: stale owner writes are accepted). Deszo trusted host must enforce single-writer admission and fencing.',
      nativeQueueStatus: 'thread/queue/add is locked behind experimentalApi capability. In default mode, turn B accepted during active turn A is dropped/not started if turn A fails (POC-04 FAIL). Deszo must maintain serialized queueing on the host.',
    },
    overallStatus: STATUS.BLOCKED,
    statusReason: 'Codex App Server requires authorized user credentials in the working profile. In isolated profiles, model execution fails with 401. Third-party subscription use is subject to SIWC preview limitations.',
  };

  writeFileSync(join(RESULTS_DIR, 'POC-CODEX.json'), JSON.stringify(reconciliation, null, 2) + '\n');
  console.log(`Codex evaluated: ${reconciliation.overallStatus} (${reconciliation.statusReason})`);
  return { id: 'CODEX', status: reconciliation.overallStatus, detail: reconciliation };
}

async function runAntigravity() {
  console.log('\n--- Running Google Antigravity PoC ---');
  const adapter = new AntigravityJudgeAdapter();
  const caps = await adapter.inspectCapabilities();
  const auth = await adapter.validateAuthentication();
  const billing = await adapter.verifyBillingMode(REQUESTED_BILLING_POLICY.SUBSCRIPTION_ONLY);

  console.log('Antigravity Auth:', auth);
  console.log('Antigravity Billing:', billing);

  let headlessResult = null;
  let resumeResult = null;
  let permissionDenialCheck = null;

  if (auth.isLoggedIn && billing.eligible) {
    console.log('Executing minimal headless turn 1 (structured JSON)...');
    headlessResult = await adapter.executeHeadlessTurn({
      prompt: 'Do not use any tools. Return only the JSON object: {"judge":"active","provider":"antigravity","decision":"PROCEED"}',
      outputFormat: 'json',
    });
    console.log('Turn 1 completed:', headlessResult.status, 'Duration:', headlessResult.elapsedMs, 'ms');

    if (headlessResult.parsedJson?.conversation_id) {
      const convId = headlessResult.parsedJson.conversation_id;
      console.log(`Resuming conversation ${convId} for turn 2...`);
      resumeResult = await adapter.executeHeadlessTurn({
        prompt: 'Do not use any tools. Return only the JSON object: {"judge":"turn_2","resumed":true}',
        conversationId: convId,
        outputFormat: 'json',
      });
      console.log('Turn 2 (resume) completed:', resumeResult.status, 'Duration:', resumeResult.elapsedMs, 'ms');
    }

    console.log('Testing permission-denial diagnostics (requesting tool action in headless mode without dangerous bypass)...');
    permissionDenialCheck = await adapter.executeHeadlessTurn({
      prompt: 'What was the previous JSON response? Check the environment and respond with JSON: {"recalled":"ok"}',
      conversationId: headlessResult.parsedJson?.conversation_id || null,
      outputFormat: 'json',
    });
    console.log('Permission denial check completed. Has denial:', permissionDenialCheck.hasPermissionDenial, 'Denied actions:', permissionDenialCheck.deniedActions);
  }

  const result = {
    provider: 'antigravity',
    version: caps.exactClientVersion,
    capabilities: caps,
    auth,
    billing,
    headlessTurn1: headlessResult,
    headlessTurn2Resume: resumeResult,
    headlessPermissionDenialTest: permissionDenialCheck,
    overallStatus: (auth.isLoggedIn && billing.eligible && headlessResult?.status === STATUS.PASS) ? STATUS.PASS : STATUS.FAIL,
  };

  writeFileSync(join(RESULTS_DIR, 'POC-ANTIGRAVITY.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`Antigravity evaluated: ${result.overallStatus}`);
  return { id: 'ANTIGRAVITY', status: result.overallStatus, detail: result };
}

async function runClaude() {
  console.log('\n--- Running Anthropic Claude Code Evaluation ---');
  const adapter = new ClaudeJudgeAdapter();
  const caps = await adapter.inspectCapabilities();
  const auth = await adapter.validateAuthentication();
  const billing = await adapter.verifyBillingMode(REQUESTED_BILLING_POLICY.SUBSCRIPTION_ONLY);

  console.log('Claude Auth:', auth);
  console.log('Claude Billing & Policy Gate:', billing);

  // In accordance with critical constraints: do not test around policy blocker.
  // Fail-closed enforcement: 0 inference requests executed.
  const turnGate = await adapter.executeTurn();

  const result = {
    provider: 'claude',
    version: caps.exactClientVersion,
    capabilities: caps,
    auth,
    billing,
    executionGate: turnGate,
    overallStatus: STATUS.POLICY_BLOCKED,
    policyFindings: {
      userSubscriptionVerified: auth.isLoggedIn && auth.subscriptionType === 'pro',
      policyRestriction: 'Anthropic terms explicitly restrict Claude Pro subscription to personal interactive usage. Third-party automated orchestration is not permitted under subscription allowances.',
      apiAlternativeAvailable: 'Anthropic Console API keys (ANTHROPIC_API_KEY) are officially supported for automated programmatic use, but constitute separately billed API usage, forbidden under Deszo subscription_only policy.',
      failClosedAction: 'Automated inference blocked to comply with Anthropic policy and prevent unapproved billing.',
    },
  };

  writeFileSync(join(RESULTS_DIR, 'POC-CLAUDE.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`Claude Code evaluated: ${result.overallStatus} (${result.policyFindings.policyRestriction})`);
  return { id: 'CLAUDE', status: result.overallStatus, detail: result };
}

async function main() {
  console.log('====================================================');
  console.log('  Deszo Multi-Provider External Judge PoC Suite');
  console.log('====================================================');

  const codex = await runCodex();
  const antigravity = await runAntigravity();
  const claude = await runClaude();

  const summary = {
    suite: 'ADR-0007 Multi-Provider External Judge Verification',
    timestamp: new Date().toISOString(),
    results: [
      { provider: codex.id, status: codex.status, version: codex.detail.version },
      { provider: antigravity.id, status: antigravity.status, version: antigravity.detail.version },
      { provider: claude.id, status: claude.status, version: claude.detail.version },
    ],
  };

  writeFileSync(join(RESULTS_DIR, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('\n====================================================');
  console.log('  Summary:');
  for (const r of summary.results) {
    console.log(`  - ${r.provider.padEnd(12)}: ${r.status} (${r.version})`);
  }
  console.log('====================================================\n');
}

main().catch(err => {
  console.error('Fatal PoC Runner Error:', err);
  process.exit(1);
});
