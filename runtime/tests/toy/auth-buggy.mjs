// CONTRACT-AUTH: a token is expired when expiresAt <= now.
const unauthorized = () => Object.assign(new Error('unauthorized'), { statusCode: 401, code: 'unauthorized' });

export function authenticate(token, now, tokenStore) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9-]+$/.test(token)) throw unauthorized();
  const record = tokenStore.get(token);
  if (!record || record.expiresAt < now) throw unauthorized();
  return { userId: record.userId };
}
