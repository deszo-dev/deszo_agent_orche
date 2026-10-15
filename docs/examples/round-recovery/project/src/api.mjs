// Base HTTP-shaped adapter of the round-recovery toy service (prepared base for M5).
// CONTRACT-AUTH runs before CONTRACT-RESUME; documented errors become HTTP responses.
import { authenticate } from './auth.mjs';
import { getRound, resumeRound } from './resume.mjs';

export function createService({ tokens, rounds, now, createToken }) {
  const tokenStore = new Map(tokens.map(token => [token.token, token]));
  const roundStore = new Map(rounds.map(round => [round.roundId, { ...round }]));
  return function handle({ method, path, headers = {} }) {
    try {
      const match = /^Bearer (\S+)$/.exec(headers.authorization || '');
      const { userId } = authenticate(match ? match[1] : null, now(), tokenStore);
      const route = /^\/rounds\/([A-Za-z0-9-]+)(\/resume)?$/.exec(path);
      if (!route) return { status: 404, body: { error: 'not_found' } };
      if (method === 'GET' && !route[2]) return { status: 200, body: getRound(route[1], userId, roundStore) };
      if (method === 'POST' && route[2]) return { status: 200, body: resumeRound(route[1], userId, roundStore, createToken) };
      return { status: 405, body: { error: 'method_not_allowed' } };
    } catch (error) {
      if (error.statusCode) return { status: error.statusCode, body: { error: error.code } };
      throw error;
    }
  };
}
