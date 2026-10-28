import { describe, expect, it } from 'vitest';
import { normalizeEmail, normalizePhone, parseIdentifier } from '../../src/common/utils/identifier';

describe('normalizePhone', () => {
  it.each([
    ['08012345678', '+2348012345678'],
    ['0906 456 0957', '+2349064560957'],
    ['+234 801 234 5678', '+2348012345678'],
    ['2348012345678', '+2348012345678'],
    ['002348012345678', '+2348012345678'],
    ['8012345678', '+2348012345678'],
    ['(0801) 234-5678', '+2348012345678'],
    ['+447911123456', '+447911123456'],
  ])('turns %s into %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(['', '+', '12345', 'abc', '0801234567', '+2341234567890', '+0123456789', '08012345678a'])(
    'rejects %j',
    (input) => {
      expect(normalizePhone(input)).toBeNull();
    },
  );
});

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com');
  });

  it('rejects things that are not emails', () => {
    expect(normalizeEmail('nope')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(`${'a'.repeat(250)}@x.co`)).toBeNull();
  });
});

describe('parseIdentifier', () => {
  it('recognises an email', () => {
    expect(parseIdentifier('  Ada@Example.com ')).toEqual({ kind: 'email', value: 'ada@example.com' });
  });

  it('recognises a phone number and normalises it', () => {
    expect(parseIdentifier('0906 456 0957')).toEqual({ kind: 'phone', value: '+2349064560957' });
    expect(parseIdentifier('+2349064560957')).toEqual({ kind: 'phone', value: '+2349064560957' });
  });

  it('recognises staff and registration numbers and uppercases them', () => {
    expect(parseIdentifier('stf-0007')).toEqual({ kind: 'id', value: 'STF-0007' });
    expect(parseIdentifier('2026/0007')).toEqual({ kind: 'id', value: '2026/0007' });
  });

  it('treats digits and dashes only as a phone attempt, so such IDs are not allowed', () => {
    expect(parseIdentifier('2026-0007')).toBeNull();
  });

  it('rejects unusable input without throwing', () => {
    for (const input of ['', '   ', 'ab', 'STF 0007', '$ne', 'STF-0007; DROP', 'x@', 'a'.repeat(300)]) {
      expect(parseIdentifier(input), input).toBeNull();
    }
    for (const input of [123, null, undefined, { email: 'x' }, ['a@b.co'], true]) {
      expect(parseIdentifier(input)).toBeNull();
    }
  });
});