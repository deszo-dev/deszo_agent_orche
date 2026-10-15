// CONTRACT-RESUME: authenticate, look up, verify ownership, then validate the recovery state.
const fail = (statusCode, code) => Object.assign(new Error(code), { statusCode, code });

function owned(roundId, userId, roundStore) {
  const round = roundStore.get(roundId);
  if (!round) throw fail(404, 'round_not_found');
  if (round.owner !== userId) throw fail(403, 'forbidden');
  return round;
}

export function getRound(roundId, userId, roundStore) {
  const round = owned(roundId, userId, roundStore);
  return { roundId, status: round.status };
}

export function resumeRound(roundId, userId, roundStore, createToken) {
  const round = owned(roundId, userId, roundStore);
  if (round.status === 'active') return { roundId, status: 'active', resumeToken: round.resumeToken };
  if (round.status !== 'paused') throw fail(409, 'round_not_resumable');
  round.status = 'active';
  round.resumeToken = createToken();
  return { roundId, status: 'active', resumeToken: round.resumeToken };
}
