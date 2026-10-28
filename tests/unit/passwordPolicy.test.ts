import { describe, expect, it } from 'vitest';
import {
  assertPasswordPolicy,
  checkPasswordPolicy,
  PASSWORD_MAX_LENGTH,
} from '../../src/common/utils/passwordPolicy';

describe('checkPasswordPolicy', () => {
  it('accepts a long, unusual password', () => {
    expect(checkPasswordPolicy('correct horse 7 battery')).toEqual([]);
    expect(checkPasswordPolicy('Tr0ub4dor&3xyz')).toEqual([]);
  });

  it('rejects short passwords', () => {
    expect(checkPasswordPolicy('short1!')).toEqual(['Must be at least 10 characters']);
  });

  it('rejects very long passwords', () => {
    const tooLong = 'a1'.repeat(PASSWORD_MAX_LENGTH);
    expect(checkPasswordPolicy(tooLong)).toEqual(['Must be at most 128 characters']);
  });

  it('rejects repetitive passwords', () => {
    expect(checkPasswordPolicy('aaaaaaaaaaaa')).toContain('Too repetitive');
    expect(checkPasswordPolicy('abababababab')).toContain('Too repetitive');
  });

  it('rejects common passwords, whatever the case or decoration', () => {
    for (const password of ['Password123', 'MyQWERTY-keys', 'PEACOCK-academy-1', 'LetMeIn-please']) {
      expect(checkPasswordPolicy(password), password).toContain('Too common or easy to guess');
    }
  });

  it('rejects passwords built from the persons own details', () => {
    const context = {
      email: 'Chinedu.Okafor@example.com',
      phone: '+2349064560957',
      identifiers: ['STF-0007'],
    };

    expect(checkPasswordPolicy('chinedu.okafor!!', context)).toContain(
      'Must not contain your email, phone number or ID',
    );
    expect(checkPasswordPolicy('zebra-9064560957-q', context)).toContain(
      'Must not contain your email, phone number or ID',
    );
    expect(checkPasswordPolicy('lion-stf-0007-hill', context)).toContain(
      'Must not contain your email, phone number or ID',
    );
    expect(checkPasswordPolicy('correct horse 7 battery', context)).toEqual([]);
  });

  it('never echoes the password in its messages', () => {
    const password = 'Sup3rSecret-Phrase-99';
    const issues = checkPasswordPolicy(password, { identifiers: ['sup3rsecret'] });

    expect(issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(issues)).not.toContain(password);
  });
});

describe('assertPasswordPolicy', () => {
  it('does nothing for a good password', () => {
    expect(() => assertPasswordPolicy('correct horse 7 battery')).not.toThrow();
  });

  it('throws a VALIDATION_ERROR with details on the named field', () => {
    try {
      assertPasswordPolicy('short', {}, 'newPassword');
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ field: 'newPassword', issue: 'Must be at least 10 characters' }],
      });
    }
  });
});