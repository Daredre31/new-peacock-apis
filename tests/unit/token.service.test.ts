import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { ROLES } from '../../src/config/constants';
import { createTokenService } from '../../src/modules/auth/token.service';
import { createMemoryStore } from '../helpers/memoryStore';

const ACCESS_SECRET = 'access-secret-for-tests-0123456789-abcdef';
const REFRESH_SECRET = 'refresh-secret-for-tests-0123456789-abcde';
const USER_ID = 'a'.repeat(24);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const login = { userId: USER_ID, role: ROLES.PARENT, mustChangePassword: false };

let clock: number;
let memory: ReturnType<typeof createMemoryStore>;
let service: ReturnType<typeof createTokenService>;

beforeEach(() => {
  clock = Date.parse('2026-01-01T00:00:00.000Z');
  memory = createMemoryStore(() => clock);
  service = createTokenService({
    store: memory.store,
    accessSecret: ACCESS_SECRET,
    refreshSecret: REFRESH_SECRET,
    now: () => clock,
  });
});

// Builds access tokens by hand so tests can break one rule at a time.
async function forge(
  claims: Record<string, unknown> = {},
  opts: { aud?: string; iss?: string; secret?: string; exp?: number } = {},
): Promise<string> {
  const iat = Math.floor(clock / 1000);
  return new SignJWT({ role: ROLES.PARENT, sid: 'b'.repeat(32), mcp: false, ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(opts.iss ?? 'peacock-academy-api')
    .setAudience(opts.aud ?? 'peacock-academy-web')
    .setSubject(USER_ID)
    .setIssuedAt(iat)
    .setExpirationTime(opts.exp ?? iat + 900)
    .sign(new TextEncoder().encode(opts.secret ?? ACCESS_SECRET));
}

const b64 = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('issuing a session', () => {
  it('returns an access token, a refresh token and expiry times', async () => {
    const session = await service.issueSession(login);

    expect(session.sessionId).toMatch(/^[a-f0-9]{32}$/);
    expect(session.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.accessExpiresAt.getTime()).toBe(clock + 15 * MINUTE);
    expect(session.refreshExpiresAt.getTime()).toBe(clock + 7 * DAY);
  });

  it('produces an access token that verifies with the right claims', async () => {
    const session = await service.issueSession({ ...login, mustChangePassword: true });
    const result = await service.verifyAccessToken(session.accessToken);

    expect(result).toMatchObject({
      ok: true,
      claims: {
        userId: USER_ID,
        role: ROLES.PARENT,
        sessionId: session.sessionId,
        mustChangePassword: true,
      },
    });
    if (result.ok) expect(result.claims.expiresAt.getTime()).toBe(clock + 15 * MINUTE);
  });

  it('never stores a raw refresh token', async () => {
    const session = await service.issueSession(login);
    const rotated = await service.rotateRefreshToken(session.refreshToken);

    expect(memory.dump()).not.toContain(session.refreshToken);
    if (rotated.outcome === 'rotated') expect(memory.dump()).not.toContain(rotated.refreshToken);
  });

  it('refuses to start with weak secrets', () => {
    expect(() =>
      createTokenService({ store: memory.store, accessSecret: 'short', refreshSecret: REFRESH_SECRET }),
    ).toThrow('at least 32');
  });
});

describe('verifying access tokens', () => {
  it('accepts a correctly built token (sanity check for the forge helper)', async () => {
    expect((await service.verifyAccessToken(await forge())).ok).toBe(true);
  });

  it('reports a valid but old token as expired', async () => {
    const session = await service.issueSession(login);
    clock += 16 * MINUTE;

    expect(await service.verifyAccessToken(session.accessToken)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects tampering, wrong secrets, issuers and audiences as invalid', async () => {
    const session = await service.issueSession(login);
    const tampered = `${session.accessToken.slice(0, -4)}AAAA`;

    for (const token of [
      tampered,
      await forge({}, { secret: 'x'.repeat(40) }),
      await forge({}, { iss: 'someone-else' }),
      await forge({}, { aud: 'another-app' }),
    ]) {
      expect(await service.verifyAccessToken(token)).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('does not call a forged token expired', async () => {
    const forgedExpired = await forge({}, { secret: 'x'.repeat(40), exp: Math.floor(clock / 1000) - 3600 });

    expect(await service.verifyAccessToken(forgedExpired)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects the "none" algorithm', async () => {
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      sub: USER_ID,
      role: ROLES.SUPER_ADMIN,
      sid: 'b'.repeat(32),
      mcp: false,
      iss: 'peacock-academy-api',
      aud: 'peacock-academy-web',
      iat: Math.floor(clock / 1000),
      exp: Math.floor(clock / 1000) + 900,
    })}.`;

    expect(await service.verifyAccessToken(unsigned)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects correctly signed tokens whose claims are wrong', async () => {
    for (const token of [
      await forge({ role: 'ROOT' }),
      await forge({ sid: 'short' }),
      await forge({ mcp: 'yes' }),
    ]) {
      expect((await service.verifyAccessToken(token)).ok).toBe(false);
    }
  });

  it('rejects junk without throwing', async () => {
    for (const input of ['', 'abc', 'a.b.c', 'x'.repeat(5000), 123, null, undefined, {}, ['t']]) {
      expect((await service.verifyAccessToken(input)).ok).toBe(false);
    }
  });
});

describe('session liveness', () => {
  it('is active after issue and ends on logout', async () => {
    const session = await service.issueSession(login);
    const claims = { userId: USER_ID, sessionId: session.sessionId };

    expect(await service.isSessionActive(claims)).toBe(true);
    await service.revokeSession(session.sessionId);
    expect(await service.isSessionActive(claims)).toBe(false);
  });

  it('is not active for another user, or an unknown session', async () => {
    const session = await service.issueSession(login);

    expect(await service.isSessionActive({ userId: 'b'.repeat(24), sessionId: session.sessionId })).toBe(false);
    expect(await service.isSessionActive({ userId: USER_ID, sessionId: 'c'.repeat(32) })).toBe(false);
  });

  it('logout-all ends every earlier login but not a later one', async () => {
    const first = await service.issueSession(login);
    clock += 1_000;
    const second = await service.issueSession(login);
    clock += 1_000;

    await service.revokeAllSessions(USER_ID);
    clock += 1_000;
    const third = await service.issueSession(login);

    expect(await service.isSessionActive({ userId: USER_ID, sessionId: first.sessionId })).toBe(false);
    expect(await service.isSessionActive({ userId: USER_ID, sessionId: second.sessionId })).toBe(false);
    expect(await service.isSessionActive({ userId: USER_ID, sessionId: third.sessionId })).toBe(true);
  });

  it('a login created in the same instant as a revoke-all survives it', async () => {
    await service.revokeAllSessions(USER_ID);
    const session = await service.issueSession(login);

    expect(await service.isSessionActive({ userId: USER_ID, sessionId: session.sessionId })).toBe(true);
  });

  it('logout-all does not touch other users', async () => {
    const other = await service.issueSession({ ...login, userId: 'b'.repeat(24) });
    clock += 1_000;

    await service.revokeAllSessions(USER_ID);

    expect(await service.isSessionActive({ userId: 'b'.repeat(24), sessionId: other.sessionId })).toBe(true);
  });

  it('ignores malformed ids when revoking', async () => {
    await expect(service.revokeSession('nope')).resolves.toBeUndefined();
    await expect(service.revokeAllSessions('nope')).resolves.toBeUndefined();
  });
});

describe('refresh rotation', () => {
  it('swaps a token for a new one, and the new one can be swapped again', async () => {
    const session = await service.issueSession(login);

    const first = await service.rotateRefreshToken(session.refreshToken);
    expect(first).toMatchObject({ outcome: 'rotated', userId: USER_ID, sessionId: session.sessionId });
    if (first.outcome !== 'rotated') return;
    expect(first.refreshToken).not.toBe(session.refreshToken);
    expect(first.refreshExpiresAt.getTime()).toBe(clock + 7 * DAY);

    clock += 5 * MINUTE;
    const second = await service.rotateRefreshToken(first.refreshToken);
    expect(second.outcome).toBe('rotated');
  });

  it('keeps the same login across rotations', async () => {
    const session = await service.issueSession(login);
    const rotated = await service.rotateRefreshToken(session.refreshToken);

    expect(await service.isSessionActive({ userId: USER_ID, sessionId: session.sessionId })).toBe(true);
    if (rotated.outcome === 'rotated') expect(rotated.sessionId).toBe(session.sessionId);
  });

  it('treats unknown and malformed tokens as invalid', async () => {
    expect(await service.rotateRefreshToken('A'.repeat(43))).toEqual({ outcome: 'invalid' });

    for (const input of ['', 'short', 'x'.repeat(100), '../../etc', 123, null, undefined, {}]) {
      expect(await service.rotateRefreshToken(input)).toEqual({ outcome: 'invalid' });
    }
  });

  it('rejects an expired refresh token', async () => {
    const session = await service.issueSession(login);
    clock += 7 * DAY + MINUTE;

    expect(await service.rotateRefreshToken(session.refreshToken)).toEqual({ outcome: 'invalid' });
  });

  it('rejects a token whose login was ended', async () => {
    const session = await service.issueSession(login);
    await service.revokeSession(session.sessionId);

    expect(await service.rotateRefreshToken(session.refreshToken)).toEqual({ outcome: 'invalid' });
  });

  it('rejects a token from before a logout-all', async () => {
    const session = await service.issueSession(login);
    clock += 1_000;
    await service.revokeAllSessions(USER_ID);

    expect(await service.rotateRefreshToken(session.refreshToken)).toEqual({ outcome: 'invalid' });
  });
});

describe('reuse detection', () => {
  it('revokes the whole login when an old token comes back after the grace period', async () => {
    const session = await service.issueSession(login);
    const rotated = await service.rotateRefreshToken(session.refreshToken);
    if (rotated.outcome !== 'rotated') throw new Error('expected rotation');

    clock += 60_000; // well past the 10 second grace window
    const replay = await service.rotateRefreshToken(session.refreshToken);

    expect(replay).toEqual({ outcome: 'reused', userId: USER_ID, sessionId: session.sessionId });
    expect(await service.isSessionActive({ userId: USER_ID, sessionId: session.sessionId })).toBe(false);
    // The newest token, held by the real user, is dead too.
    expect(await service.rotateRefreshToken(rotated.refreshToken)).toEqual({ outcome: 'invalid' });
  });

  it('treats a replay inside the grace window as concurrent, without revoking anything', async () => {
    const session = await service.issueSession(login);
    const rotated = await service.rotateRefreshToken(session.refreshToken);
    if (rotated.outcome !== 'rotated') throw new Error('expected rotation');

    clock += 3_000;
    expect(await service.rotateRefreshToken(session.refreshToken)).toEqual({ outcome: 'concurrent' });

    expect(await service.isSessionActive({ userId: USER_ID, sessionId: session.sessionId })).toBe(true);
    expect((await service.rotateRefreshToken(rotated.refreshToken)).outcome).toBe('rotated');
  });

  it('survives two simultaneous refreshes with the same token', async () => {
    const session = await service.issueSession(login);

    const results = await Promise.all([
      service.rotateRefreshToken(session.refreshToken),
      service.rotateRefreshToken(session.refreshToken),
    ]);

    expect(results.filter((r) => r.outcome === 'rotated')).toHaveLength(1);
    expect(results.some((r) => r.outcome === 'reused')).toBe(false);
    expect(await service.isSessionActive({ userId: USER_ID, sessionId: session.sessionId })).toBe(true);
  });
});

describe('the 30 day cap', () => {
  it('shortens late refresh tokens and ends the login at the cap', async () => {
    const start = clock;
    let token = (await service.issueSession(login)).refreshToken;

    for (let i = 0; i < 4; i += 1) {
      clock += 6 * DAY;
      const rotated = await service.rotateRefreshToken(token);
      if (rotated.outcome !== 'rotated') throw new Error(`rotation ${i} failed`);
      token = rotated.refreshToken;
      expect(rotated.refreshExpiresAt.getTime()).toBeLessThanOrEqual(start + 30 * DAY);
    }

    clock = start + 30 * DAY;
    expect(await service.rotateRefreshToken(token)).toEqual({ outcome: 'invalid' });
  });
});

describe('when the session store is down', () => {
  it('fails closed with SERVICE_UNAVAILABLE everywhere', async () => {
    const session = await service.issueSession(login);
    memory.setDown(true);

    const claims = { userId: USER_ID, sessionId: session.sessionId };
    await expect(service.issueSession(login)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await expect(service.isSessionActive(claims)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await expect(service.rotateRefreshToken(session.refreshToken)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    await expect(service.revokeSession(session.sessionId)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('still verifies access token signatures, which need no store', async () => {
    const session = await service.issueSession(login);
    memory.setDown(true);

    expect((await service.verifyAccessToken(session.accessToken)).ok).toBe(true);
  });
});