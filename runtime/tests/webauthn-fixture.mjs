// Software WebAuthn authenticator for consent fixture tests. It produces the real byte layout (RP hash, flags, counter,
// attested credential data, ES256 signature over authenticatorData || SHA-256(clientDataJSON)). It is never accepted as
// Windows Hello evidence: the installed host has no path that trusts a fixture key.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { RP_ID } from '../host/webauthn.mjs';

const sha = value => createHash('sha256').update(value).digest();

export function authenticator() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = pair.publicKey.export({ format: 'jwk' }), id = randomBytes(32);
  const data = (flags, count = 0) => { const bytes = Buffer.alloc(37); sha(RP_ID).copy(bytes); bytes[32] = flags; bytes.writeUInt32BE(count, 33); return bytes; };
  return {
    id: id.toString('base64'), jwk,
    attestation(challenge) {
      const length = Buffer.alloc(2); length.writeUInt16BE(id.length);
      const key = Buffer.concat([Buffer.from([0xa5, 1, 2, 3, 0x26, 0x20, 1, 0x21, 0x58, 32]), Buffer.from(jwk.x, 'base64url'), Buffer.from([0x22, 0x58, 32]), Buffer.from(jwk.y, 'base64url')]);
      return { credentialId: id.toString('base64'), authenticatorData: Buffer.concat([data(0x45), Buffer.alloc(16), length, id, key]).toString('base64'), clientDataJSON: Buffer.from(challenge.clientDataJSON).toString('base64') };
    },
    assertion(clientDataJSON, { flags = 5, count = 0 } = {}) {
      const client = Buffer.from(clientDataJSON), auth = data(flags, count);
      return { credentialId: id.toString('base64'), clientDataJSON: client.toString('base64'), authenticatorData: auth.toString('base64'), signature: sign('sha256', Buffer.concat([auth, sha(client)]), pair.privateKey).toString('base64') };
    },
  };
}
