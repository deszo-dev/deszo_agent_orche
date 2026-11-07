// Anthropic Claude Code Judge Adapter for ADR-0007.
// Translates Claude Code CLI capabilities and enforces the Anthropic Policy Gate.

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { JudgeAdapter, BILLING_MODES, REQUESTED_BILLING_POLICY, STATUS, EVIDENCE_CLASSIFICATIONS } from './judge-adapter-contract.mjs';

export const CLAUDE_BIN = 'C:/Users/jusse/AppData/Local/Microsoft/WinGet/Links/claude.exe';

function capture(command, args, { env = process.env, timeout = 15000 } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err.message });
      return;
    }
    let stdout = '', stderr = '', settled = false;
    const finish = val => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(val);
      }
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ code: -1, stdout, stderr: `${stderr}\nTimeout` });
    }, timeout);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => finish({ code: -1, stdout, stderr: err.message }));
    child.on('close', code => finish({ code, stdout, stderr }));
  });
}

export class ClaudeJudgeAdapter extends JudgeAdapter {
  constructor({ cliPath = CLAUDE_BIN } = {}) {
    super({ provider: 'claude', cliPath, clientVersion: '2.1.302 (Claude Code)' });
  }

  async inspectCapabilities() {
    const binExists = existsSync(this.cliPath);
    return {
      provider: 'claude',
      exactClientVersion: this.clientVersion,
      cliPath: this.cliPath,
      binaryAvailable: binExists,
      authenticationModes: ['claude.ai_subscription', 'anthropic_api_key'],
      permittedBillingModes: [BILLING_MODES.SUBSCRIPTION, BILLING_MODES.API],
      subscriptionEligibility: {
        supportedForInteractiveCli: true,
        supportedForThirdPartyOrchestrator: false, // Prohibited by Anthropic subscription policy
        evidence: EVIDENCE_CLASSIFICATIONS.DOCUMENTED,
        officialSource: 'https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account',
      },
      sessionPersistence: {
        supported: true,
        format: 'project transcripts and tasks (~/.claude/projects/)',
        evidence: EVIDENCE_CLASSIFICATIONS.DOCUMENTED,
      },
      sessionResumeSupport: {
        bySessionId: true,
        byContinueFlag: true,
        evidence: EVIDENCE_CLASSIFICATIONS.DOCUMENTED,
      },
      dedicatedSessionFeasibility: {
        supportedViaProjectId: true,
        evidence: EVIDENCE_CLASSIFICATIONS.DOCUMENTED,
      },
      exclusiveTurnAdmissionSupport: {
        nativeCliFileLock: false,
        hostLevelFencingRequired: true,
        evidence: EVIDENCE_CLASSIFICATIONS.DOCUMENTED,
      },
      structuredCompletionEvidence: {
        structuredJsonOutput: true,
        streamingNdjson: true,
        evidence: EVIDENCE_CLASSIFICATIONS.DOCUMENTED,
      },
      toolSupport: {
        scopedMcpRegistration: true,
        evidence: EVIDENCE_CLASSIFICATIONS.DOCUMENTED,
      },
      concurrencyHandling: {
        serializedTurnsRequired: true,
        evidence: EVIDENCE_CLASSIFICATIONS.DOCUMENTED,
      },
      policyGateStatus: {
        isPermittedForAutomatedJudge: false,
        classification: 'POLICY_BLOCKED',
        reason: 'Anthropic terms restrict Claude Pro subscription allowances to interactive use; non-interactive mode strictly requires ANTHROPIC_API_KEY (API billing).',
        evidence: EVIDENCE_CLASSIFICATIONS.DOCUMENTED,
      },
      knownUnsupportedCapabilities: [
        'Automated third-party orchestrator inference under Claude Pro subscription',
        'Headless subscription authorization without interactive terminal session',
        'API key precedence without separate billing disclosure',
      ],
    };
  }

  async validateAuthentication() {
    const res = await capture(this.cliPath, ['auth', 'status', '--json']);
    let parsed = null;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {}

    const isValidSubscription = Boolean(
      parsed &&
      parsed.loggedIn === true &&
      parsed.authMethod === 'claude.ai' &&
      parsed.apiProvider === 'firstParty'
    );

    return {
      isLoggedIn: isValidSubscription,
      authMethod: parsed?.authMethod || 'none',
      subscriptionType: parsed?.subscriptionType || 'none',
      apiProvider: parsed?.apiProvider || 'none',
      status: isValidSubscription ? STATUS.PASS : STATUS.BLOCKED,
      reason: isValidSubscription ? null : 'Run "claude auth login" with a valid Claude subscription.',
    };
  }

  async verifyBillingMode(requestedPolicy = REQUESTED_BILLING_POLICY.SUBSCRIPTION_ONLY) {
    const auth = await this.validateAuthentication();
    if (!auth.isLoggedIn) {
      return {
        billingMode: BILLING_MODES.UNKNOWN,
        eligible: false,
        status: STATUS.BLOCKED,
        reason: 'Claude authentication is not logged in or cannot be confirmed.',
      };
    }

    // MANDATORY POLICY GATE:
    // Anthropic documentation explicitly restricts Claude Pro/Team subscription usage to personal interactive development.
    // In headless/automation mode, Anthropic requires API keys (ANTHROPIC_API_KEY), which use API-metered billing.
    // Deszo requested policy is subscription_only: fail-closed.
    return {
      billingMode: BILLING_MODES.SUBSCRIPTION,
      subscriptionType: auth.subscriptionType,
      eligible: false,
      status: STATUS.POLICY_BLOCKED,
      policyBlockReason: 'Anthropic terms restrict Claude Pro/Team subscription allowances to interactive human use. Third-party automated orchestrators cannot use subscription credentials as an inference backend. Separately billed API key mode is available but forbidden by Deszo subscription_only policy.',
      officialSource: 'https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account',
      failClosedAction: 'Inference calls blocked to prevent policy violation and silent API charges.',
    };
  }

  /**
   * Fail-closed execution gate: refuses to run automated subscription inference.
   */
  async executeTurn() {
    return {
      status: STATUS.POLICY_BLOCKED,
      executed: false,
      reason: 'Automated Judge turn refused under Anthropic policy gate.',
    };
  }
}
