import {createHash, timingSafeEqual} from 'node:crypto';

export function secretsMatch(left, right) {
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes);
}

export function tokenHashMatches(candidate, expectedHash) {
  if (!candidate || !expectedHash) return false;
  const left = Buffer.from(createHash('sha256').update(String(candidate)).digest('hex'));
  const right = Buffer.from(String(expectedHash));
  return left.length === right.length
    && left.length > 0
    && timingSafeEqual(left, right);
}

export function researchCredentialMatches(candidate, rawToken, tokenHash) {
  return secretsMatch(candidate, rawToken)
    || tokenHashMatches(candidate, tokenHash);
}
