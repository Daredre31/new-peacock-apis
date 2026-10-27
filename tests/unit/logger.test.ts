import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/common/utils/logger';

function capture() {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { destination, output: () => chunks.join('') };
}

describe('logger redaction', () => {
  it('redacts passwords and tokens at several levels', () => {
    const { destination, output } = capture();
    const log = createLogger({ level: 'info', destination });

    log.info({
      password: 'p-top-level',
      body: { password: 'p-nested', currentPassword: 'p-current' },
      user: { credentials: { refreshToken: 'rt-deep' } },
    });

    const out = output();
    expect(out).not.toContain('p-top-level');
    expect(out).not.toContain('p-nested');
    expect(out).not.toContain('p-current');
    expect(out).not.toContain('rt-deep');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts auth headers and cookies', () => {
    const { destination, output } = capture();
    const log = createLogger({ level: 'info', destination });

    log.info({
      req: { headers: { authorization: 'Bearer abc123', cookie: 'sid=xyz789' } },
      res: { headers: { 'set-cookie': ['sid=cookie-secret'] } },
    });

    const out = output();
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('xyz789');
    expect(out).not.toContain('cookie-secret');
  });

  it('serialises errors with message and stack', () => {
    const { destination, output } = capture();
    const log = createLogger({ level: 'info', destination });

    log.error({ err: new Error('boom') }, 'failed');

    const out = output();
    expect(out).toContain('boom');
    expect(out).toContain('stack');
  });
});