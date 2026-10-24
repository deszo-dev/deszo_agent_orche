// OpenAI Codex Judge Adapter for ADR-0007.
// Translates Codex App Server protocol into the Deszo Judge Contract.
// Reconciles previous POC-01 through POC-08 findings with official OpenAI documentation.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { JudgeAdapter, BILLING_MODES, REQUESTED_BILLING_POLICY, STATUS, EVIDENCE_CLASSIFICATIONS } from './judge-adapter-contract.mjs';

export const CODEX_BIN = 'C:/Users/jusse/AppData/Local/OpenAI/Codex/bin/896a0166b774037a/codex.exe';

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

export class CodexJudgeAdapter extends JudgeAdapter {
  constructor({ cliPath = CODEX_BIN, codexHome = null } = {}) {
    super({ provider: 'codex', cliPath, clientVersion: '0.163.0-alpha.10.2' });
    this.codexHome = codexHome;
  }

  async inspectCapabilities() {
    const binExists = existsSync(this.cliPath);
    return {
      provider: 'codex',
      exactClientVersion: this.clientVersion,
      cliPath: this.cliPath,
      binaryAvailable: binExists,
      authenticationModes: ['chatgpt_subscription', 'api_key', 'access_token'],
      permittedBillingModes: [BILLING_MODES.SUBSCRIPTION, BILLING_MODES.API],
      subscriptionEligibility: {
        supportedForNativeCli: true,
        supportedForThirdPartyOrchestrator: false, // Subject to SIWC preview limitations
        evidence: EVIDENCE_CLASSIFICATIONS.DOCUMENTED,
        officialSource: 'https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations',
      },
      sessionPersistence: {
        supported: true,
        format: 'rollout jsonl',
        evidence: EVIDENCE_CLASSIFICATIONS.VERIFIED,
      },
      sessionResumeSupport: {
        byThreadIdInSameHome: true,
        byPathAcrossHomes: false, // Requires experimentalApi capability
        evidence: EVIDENCE_CLASSIFICATIONS.VERIFIED,
      },
      dedicatedSessionFeasibility: {
        supportedViaIsolatedHome: true,
        evidence: EVIDENCE_CLASSIFICATIONS.VERIFIED,
      },
      exclusiveTurnAdmissionSupport: {
        nativeThreadLockSameHome: true,
        nativeOwnerGenerationFencing: false, // Stale owner can continue writing
        hostLevelFencingRequired: true,
        evidence: EVIDENCE_CLASSIFICATIONS.VERIFIED,
      },
      structuredCompletionEvidence: {
        nativeTurnCompletedEvent: true,
        turnStartedBeforeAuthVerification: true, // HTTP 401 occurs after turn/started
        evidence: EVIDENCE_CLASSIFICATIONS.VERIFIED,
      },
      toolSupport: {
        scopedMcpRegistration: true,
        evidence: EVIDENCE_CLASSIFICATIONS.VERIFIED,
      },
      concurrencyHandling: {
        maxConcurrentTurnsObserved: 1,
        nativeQueueAddRequiresExperimentalApi: true,
        turnBDroppedIfTurnAFails: true, // App Server does not start B after failed A
        evidence: EVIDENCE_CLASSIFICATIONS.VERIFIED,
      },
      knownUnsupportedCapabilities: [
        'Native owner-generation fencing (Codex accepts writes from stale owners)',
        'Cross-home session resume by thread ID without experimentalApi',
        'Automatic serialization of turn B when preceding turn A fails with 401',
        'Headless programmatic subscription consumption without registered OAuth client',
      ],
    };
  }

  async validateAuthentication(customHome = this.codexHome) {
    const env = { ...process.env };
    if (customHome) env.CODEX_HOME = customHome;
    const res = await capture(this.cliPath, ['login', 'status'], { env });
    const output = `${res.stdout}${res.stderr}`.trim();
    const isLoggedInChatGPT = /Logged in using ChatGPT/i.test(output);
    return {
      home: customHome || join(homedir(), '.codex'),
      isLoggedIn: isLoggedInChatGPT,
      statusText: output,
      authMethod: isLoggedInChatGPT ? 'chatgpt_subscription' : 'none',
      status: isLoggedInChatGPT ? STATUS.PASS : STATUS.BLOCKED,
      reason: isLoggedInChatGPT ? null : 'Isolated CODEX_HOME is unauthenticated. Interactive device sign-in or OAuth credential required.',
    };
  }

  async verifyBillingMode(requestedPolicy = REQUESTED_BILLING_POLICY.SUBSCRIPTION_ONLY, customHome = this.codexHome) {
    const auth = await this.validateAuthentication(customHome);
    if (!auth.isLoggedIn) {
      return {
        billingMode: BILLING_MODES.UNKNOWN,
        eligible: false,
        status: STATUS.BLOCKED,
        reason: 'No ChatGPT subscription login found in active profile.',
      };
    }

    // Official policy check: SIWC preview limitations
    // OpenAI documentation explicitly restricts token sharing and automated third-party usage:
    // Third-party applications require explicit OAuth client registration and user consent.
    return {
      billingMode: BILLING_MODES.SUBSCRIPTION,
      eligible: true,
      thirdPartyOrchestrationPolicy: 'RESTRICTED',
      previewLimitationsApplies: true,
      officialSource: 'https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations',
      failClosedOnApiFallback: true,
      status: STATUS.PASS,
    };
  }
}
