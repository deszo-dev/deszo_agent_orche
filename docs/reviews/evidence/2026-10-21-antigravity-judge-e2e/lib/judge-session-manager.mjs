// Deszo ADR-0007 Antigravity Judge Session Manager
// Manages durable attention requests, session lifecycle, serialized queueing,
// and safe CLI execution without permission bypass flags.

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function sha256(data) {
  return createHash('sha256').update(typeof data === 'string' ? data : JSON.stringify(data)).digest('hex');
}

export class AntigravityJudgeSessionManager {
  constructor(options = {}) {
    this.rootDir = options.rootDir || resolve('.');
    this.storageDir = options.storageDir || join(this.rootDir, 'docs', 'reviews', 'evidence', '2026-10-21-antigravity-judge-e2e', 'traces');
    this.schemaPath = options.schemaPath || join(this.rootDir, 'docs', 'reviews', 'evidence', '2026-10-21-antigravity-judge-e2e', 'fixtures', 'judge-decision.schema.json');
    this.agyPath = options.agyPath || (process.platform === 'win32' 
      ? join(process.env.LOCALAPPDATA || 'C:\\Users\\jusse\\AppData\\Local', 'agy', 'bin', 'agy.exe') 
      : 'agy');
    this.activeTurnPromise = null;
    this.turnQueue = [];
    mkdirSync(this.storageDir, { recursive: true });
  }

  createAttentionRequest({ runId, revision, packageId, evidenceDigest, claimedObjective }) {
    const requestId = `att-req-${randomUUID()}`;
    const request = {
      requestId,
      runId,
      revision,
      packageId,
      evidenceDigest,
      claimedObjective,
      createdAt: new Date().toISOString(),
      status: 'PENDING'
    };
    this.persistAttentionRequest(request);
    return request;
  }

  persistAttentionRequest(request) {
    const filePath = join(this.storageDir, `request-${request.requestId}.json`);
    writeFileSync(filePath, JSON.stringify(request, null, 2), 'utf8');
  }

  loadAttentionRequest(requestId) {
    const filePath = join(this.storageDir, `request-${requestId}.json`);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  }

  /**
   * Enqueues or immediately executes an attention request against the Antigravity Judge session.
   * If a turn is currently in flight, the request is queued ('queued_behind_active_turn').
   */
  async submitAttentionRequest({ attentionRequest, registeredSession, promptOverride = null }) {
    if (this.activeTurnPromise) {
      // Serialized queueing: record queued status
      attentionRequest.status = 'QUEUED';
      attentionRequest.queueReason = 'queued_behind_active_turn';
      this.persistAttentionRequest(attentionRequest);

      // Wait for existing active turn to complete before starting this turn
      return new Promise((resolvePrompt, rejectPrompt) => {
        this.turnQueue.push(async () => {
          try {
            const res = await this._executeJudgeTurn({ attentionRequest, registeredSession, promptOverride });
            resolvePrompt(res);
          } catch (err) {
            rejectPrompt(err);
          }
        });
      });
    }

    return this._executeJudgeTurn({ attentionRequest, registeredSession, promptOverride });
  }

  async _executeJudgeTurn({ attentionRequest, registeredSession, promptOverride }) {
    attentionRequest.status = 'IN_FLIGHT';
    attentionRequest.turnStartedAt = new Date().toISOString();
    this.persistAttentionRequest(attentionRequest);

    let resolveActive;
    this.activeTurnPromise = new Promise(r => { resolveActive = r; });

    try {
      const result = await this._spawnAntigravityTurn({ attentionRequest, registeredSession, promptOverride });
      
      attentionRequest.status = result.exitCode === 0 ? 'COMPLETED' : 'FAILED';
      attentionRequest.turnCompletedAt = new Date().toISOString();
      attentionRequest.durationMs = result.durationMs;
      attentionRequest.tokens = result.tokens;
      this.persistAttentionRequest(attentionRequest);

      return result;
    } catch (err) {
      attentionRequest.status = 'FAILED';
      attentionRequest.error = err.message;
      this.persistAttentionRequest(attentionRequest);
      throw err;
    } finally {
      this.activeTurnPromise = null;
      resolveActive();
      
      // Drain next queued turn if any
      if (this.turnQueue.length > 0) {
        const nextTurn = this.turnQueue.shift();
        nextTurn();
      }
    }
  }

  async _spawnAntigravityTurn({ attentionRequest, registeredSession, promptOverride }) {
    const prompt = promptOverride || this._buildJudgePrompt({ attentionRequest, registeredSession });

    const args = [
      '-p', prompt,
      '--json-schema', this.schemaPath,
      '--output-format', 'json'
    ];

    if (registeredSession.nativeSessionId) {
      args.push('--conversation', registeredSession.nativeSessionId);
    }

    const startTime = Date.now();
    const env = { ...process.env };
    // Strip external API keys
    delete env.OPENAI_API_KEY;
    delete env.ANTHROPIC_API_KEY;

    return new Promise((resolveTurn, rejectTurn) => {
      const child = spawn(this.agyPath, args, {
        cwd: this.rootDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });

      child.on('error', err => {
        rejectTurn(new Error(`Failed to spawn agy: ${err.message}`));
      });

      child.on('close', code => {
        const durationMs = Date.now() - startTime;
        let parsed = null;
        try {
          parsed = JSON.parse(stdout.trim());
        } catch {
          const jsonMatch = stdout.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try { parsed = JSON.parse(jsonMatch[0]); } catch {}
          }
        }

        const turnResult = {
          exitCode: code,
          durationMs,
          rawStdout: stdout,
          rawStderr: stderr,
          parsedOutput: parsed,
          conversationId: parsed?.conversation_id || registeredSession.nativeSessionId || null,
          tokens: parsed?.usage || null,
          structuredOutput: parsed?.structured_output || null,
          deniedActions: parsed?.denied_actions || []
        };

        // If native conversation ID is returned, bind to nativeSessionId
        if (turnResult.conversationId) {
          registeredSession.nativeSessionId = turnResult.conversationId;
        }

        resolveTurn(turnResult);
      });
    });
  }

  _buildJudgePrompt({ attentionRequest, registeredSession }) {
    return [
      `You are the external Judge controller for Deszo.`,
      `Controller ID: "${registeredSession.controllerId}".`,
      `Session ID: "${registeredSession.sessionId}".`,
      `Attention Request ID: "${attentionRequest.requestId}".`,
      `Workflow Run ID: "${attentionRequest.runId}".`,
      `Workflow Revision: ${attentionRequest.revision}.`,
      `Claimed Task Objective: "${attentionRequest.claimedObjective}".`,
      `Evidence Package ID: "${attentionRequest.packageId}".`,
      `Expected Evidence Digest: "${attentionRequest.evidenceDigest}".`,
      ``,
      `TASK INSTRUCTIONS:`,
      `1. Do NOT execute any shell commands, run commands, or bash tools.`,
      `2. Call the MCP tool read_evidence_package from server deszo-evidence with arguments {"package_id": "${attentionRequest.packageId}"}.`,
      `3. Verify whether all unit and regression tests passed, whether budget limits were observed, and whether the git diff matches the claimed objective.`,
      `4. Verify that the evidence_digest returned by the tool matches the expected digest.`,
      `5. Return your evaluation strictly complying with the JSON schema:`,
      `   - schema_version must be "deszo.judge.decision.v1"`,
      `   - request_id must be "${attentionRequest.requestId}"`,
      `   - controller_id must be "${registeredSession.controllerId}"`,
      `   - session_id must be "${registeredSession.sessionId}"`,
      `   - workflow_revision must be ${attentionRequest.revision}`,
      `   - evidence_digest must be "${attentionRequest.evidenceDigest}"`,
      `   - verdict must be "APPROVE" if all tests pass, or "REVISE" if tests fail`,
      `   - confidence must be 1.0 (or between 0.0 and 1.0)`,
      `   - findings must cite observations and sources`,
      `   - policy_evaluation must contain tests_passed, budget_ok, diff_within_bounds`,
      `   - resource_adjustments must be null (no budget modifications allowed)`
    ].join('\n');
  }
}
