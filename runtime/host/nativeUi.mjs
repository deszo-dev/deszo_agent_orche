import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../core/canonical.mjs';
import { sameProcess } from './authority.mjs';

// One application-bound foreground request, never synthetic input or a consent/authenticator operation.
// Windows may refuse activation; that is missing UI evidence, not a successful check or permission to force focus.
export async function captureNativeUi({ native, policyId, runtimeGeneration, process, stateRoot, deadlineMs = 15000, pollMs = 250 }) {
  const bound = observation => observation?.runtimeGeneration === runtimeGeneration && sameProcess(process, observation) && observation.sessionId === process.sessionId;
  let ui, activation = null;
  const end = Date.now() + deadlineMs;
  do {
    ui = await native('uiEvidence', { runtimeGeneration, process });
    if (ui.available) {
      if (!bound(ui)) return { available: false, reason: 'native_ui_identity_mismatch', activation };
      const { pngBase64, ...metadata } = ui;
      if (typeof pngBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(pngBase64) || pngBase64.length > 800000) return { available: false, reason: 'invalid_native_image', activation };
      const bytes = Buffer.from(pngBase64, 'base64');
      if (bytes.length > 600000 || bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') return { available: false, reason: 'invalid_native_image', activation };
      const path = join(stateRoot, 'evidence', `${randomUUID()}.png`);
      mkdirSync(join(stateRoot, 'evidence'), { recursive: true }); writeFileSync(path, bytes, { flag: 'wx' });
      return { ...metadata, activation, path, sha256: sha256(bytes) };
    }
    if (!['application_not_foreground', 'no_visible_window_for_process'].includes(ui.reason)) return { ...ui, activation };
    if (ui.reason === 'application_not_foreground' && activation === null) {
      activation = await native('uiFocus', { domain: policyId, runtimeGeneration, process });
      if (!activation.focused) return { ...ui, activation };
      if (!bound(activation)) return { available: false, reason: 'native_activation_identity_mismatch', activation };
    }
    await new Promise(done => setTimeout(done, pollMs));
  } while (Date.now() < end);
  return { ...ui, available: false, activation };
}
