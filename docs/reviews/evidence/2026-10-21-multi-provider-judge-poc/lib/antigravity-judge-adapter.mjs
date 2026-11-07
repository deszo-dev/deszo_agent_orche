// Google Antigravity Judge Adapter for ADR-0007.
// Translates Antigravity CLI (agy) capabilities into the Deszo Judge Contract.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { JudgeAdapter, BILLING_MODES, REQUESTED_BILLING_POLICY, STATUS, EVIDENCE_CLASSIFICATIONS } from './judge-adapter-contract.mjs';

export const AGY_BIN = 'C:/Users/jusse/AppData/Local/agy/bin/agy.exe';

function capture(command, args, { env = process.env, timeout = 60000 } = {}) {
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

export class AntigravityJudgeAdapter extends JudgeAdapter {
  constructor({ cliPath = AGY_BIN } = {}) {
    super({ provider: 'antigravity', cliPath, clientVersion: '1.4.4' });
  }

  async inspectCapabilities() {
    const binExists = existsSync(this.cliPath);
    return {
      provider: 'antigravity',
      exactClientVersion: this.clientVersion,
      cliPath: this.cliPath,
      binaryAvailable: binExists,
      authenticationModes: ['consumer_google_account_oauth', 'gcp_service_account', 'gemini_api_key'],
      permittedBillingModes: [BILLING_MODES.SUBSCRIPTION, BILLING_MODES.API, BILLING_MODES.CREDITS],
      subscriptionEligibility: {
        supportedForConsumerOAuth: true,
        supportedForHeadlessCli: true,
        evidence: EVIDENCE_CLASSIFICATIONS.VERIFIED,
        officialSource: 'https://antigravity.google/docs/plans',
      },
      sessionPersistence: {
        supported: true,
        format: 'central SQLite and JSON transcripts (~/.gemini/antigravity-cli/conversations/)',
        evidence: EVIDENCE_CLASSIFICATIONS.VERIFIED,
      },
      sessionResumeSupport: {
        byConversationId: true,
        byContinueFlag: true,
        evidence: EVIDENCE_CLASSIFICATIONS.VERIFIED,
      },
      dedicatedSessionFeasibility: {
        supportedViaConversationId: true,
        evidence: EVIDENCE_CLASSIFICATIONS.VERIFIED,
      },
      exclusiveTurnAdmissionSupport: {
        nativeCliFileLock: false, // CLI processes share conversation database without writer fencing
        hostLevelFencingRequired: true,
        evidence: EVIDENCE_CLASSIFICATIONS.VERIFIED,
      },
      structuredCompletionEvidence: {
        structuredJsonOutput: true,
        streamingNdjson: true,
        usageTelemetryIncluded: true,
        deniedActionsReported: true,
        evidence: EVIDENCE_CLASSIFICATIONS.VERIFIED,
      },
      toolSupport: {
        scopedMcpRegistration: true,
        headlessPermissionModel: 'auto-denies unapproved command tools without pre-configured allow-rule or --dangerously-skip-permissions',
        evidence: EVIDENCE_CLASSIFICATIONS.VERIFIED,
      },
      concurrencyHandling: {
        serializedTurnsRequired: true,
        evidence: EVIDENCE_CLASSIFICATIONS.VERIFIED,
      },
      usageTelemetryAvailability: {
        inputTokens: true,
        outputTokens: true,
        thinkingTokens: true,
        cacheReadTokens: true,
        totalTokens: true,
        evidence: EVIDENCE_CLASSIFICATIONS.VERIFIED,
      },
      knownUnsupportedCapabilities: [
        'Native CLI multi-writer process locking (requires Deszo host serialization)',
        'Interactive permission prompts in headless print mode (auto-denied)',
        'Implicit fallback to paid AI credits without explicit settings toggle',
      ],
    };
  }

  async validateAuthentication() {
    const logPath = join(homedir(), '.gemini', 'antigravity-cli', 'cli.log');
    let hasConsumerOAuth = false;
    let quotaProject = null;
    if (existsSync(logPath)) {
      try {
        const text = await readFile(logPath, 'utf8');
        const lines = text.split('\n');
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 200); i--) {
          const line = lines[i];
          if (line.includes('applyAuthResult') && line.includes('authMethod=consumer')) {
            hasConsumerOAuth = true;
            const match = line.match(/quotaProject=([^\s,]*)/);
            quotaProject = match ? match[1] : '';
            break;
          }
        }
      } catch {}
    }

    return {
      isLoggedIn: hasConsumerOAuth,
      authMethod: hasConsumerOAuth ? 'consumer_google_account_oauth' : 'unknown',
      quotaProject: quotaProject || null,
      status: hasConsumerOAuth ? STATUS.PASS : STATUS.BLOCKED,
      reason: hasConsumerOAuth ? null : 'Run "agy" interactively to complete Google account authentication.',
    };
  }

  async verifyBillingMode(requestedPolicy = REQUESTED_BILLING_POLICY.SUBSCRIPTION_ONLY) {
    const auth = await this.validateAuthentication();
    if (!auth.isLoggedIn) {
      return {
        billingMode: BILLING_MODES.UNKNOWN,
        eligible: false,
        status: STATUS.BLOCKED,
        reason: 'Authentication could not be confirmed.',
      };
    }

    if (auth.quotaProject && auth.quotaProject.trim().length > 0) {
      return {
        billingMode: BILLING_MODES.API,
        eligible: false,
        status: STATUS.FAIL,
        reason: `Configured with Google Cloud quotaProject (${auth.quotaProject}); separately billed API access is active.`,
      };
    }

    // Check settings.json for useG1Credits
    const settingsPath = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');
    let useCredits = false;
    let modelProvider = null;
    if (existsSync(settingsPath)) {
      try {
        const parsed = JSON.parse(await readFile(settingsPath, 'utf8'));
        useCredits = parsed.useG1Credits === true;
        modelProvider = parsed.modelProvider || null;
      } catch {}
    }

    if (modelProvider) {
      return {
        billingMode: BILLING_MODES.API,
        eligible: false,
        status: STATUS.FAIL,
        reason: `Custom modelProvider (${modelProvider}) is configured; subscription requires default provider.`,
      };
    }

    if (useCredits) {
      return {
        billingMode: BILLING_MODES.CREDITS,
        eligible: false,
        status: STATUS.FAIL,
        reason: 'Paid AI credits (useG1Credits) are enabled in settings.json.',
      };
    }

    return {
      billingMode: BILLING_MODES.SUBSCRIPTION,
      eligible: true,
      paidCreditsDisabled: true,
      quotaProjectDisabled: true,
      status: STATUS.PASS,
      officialSource: 'https://antigravity.google/docs/plans',
    };
  }

  async executeHeadlessTurn({ prompt, conversationId = null, outputFormat = 'json', timeoutMs = 60000 }) {
    const args = ['-p', prompt, '--output-format', outputFormat];
    if (conversationId) args.push('--conversation', conversationId);

    const started = Date.now();
    const res = await capture(this.cliPath, args, { timeout: timeoutMs });
    const elapsedMs = Date.now() - started;

    let parsed = null;
    let jsonError = null;
    try {
      parsed = JSON.parse(res.stdout);
    } catch (e) {
      jsonError = e.message;
    }

    return {
      exitCode: res.code,
      elapsedMs,
      rawStdout: res.stdout,
      rawStderr: res.stderr,
      parsedJson: parsed,
      jsonError,
      hasPermissionDenial: Boolean(parsed && Array.isArray(parsed.denied_actions) && parsed.denied_actions.length > 0),
      deniedActions: parsed?.denied_actions || [],
      tokenUsage: parsed?.usage || null,
      status: (res.code === 0 && parsed?.status === 'SUCCESS' && (!parsed.denied_actions || parsed.denied_actions.length === 0))
        ? STATUS.PASS
        : (parsed?.denied_actions?.length > 0 ? STATUS.FAIL : (res.code === 0 ? STATUS.PASS : STATUS.FAIL)),
    };
  }
}
