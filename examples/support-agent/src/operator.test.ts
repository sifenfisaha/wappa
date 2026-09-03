import { describe, expect, it } from 'vitest';
import { buildEscalationNotice, isOperator, sanitizeDisplayName } from './operator.js';

describe('isOperator', () => {
  it('fails closed: with OPERATOR_CHAT_ID unset, nobody is the operator', () => {
    // Regression: the old check ('if (OPERATOR_CHAT_ID && senderId !== OPERATOR_CHAT_ID) return')
    // let ANY sender run /resume when OPERATOR_CHAT_ID was not configured.
    expect(isOperator('stranger@s.whatsapp.net', undefined)).toBe(false);
    expect(isOperator('stranger@s.whatsapp.net', '')).toBe(false);
  });

  it('only the configured operator matches', () => {
    const operator = '15551234567@s.whatsapp.net';
    expect(isOperator(operator, operator)).toBe(true);
    expect(isOperator('stranger@s.whatsapp.net', operator)).toBe(false);
  });
});

describe('sanitizeDisplayName', () => {
  it('strips CR/LF and other control characters', () => {
    expect(sanitizeDisplayName('Eve\r\nEvil')).toBe('EveEvil');
    expect(sanitizeDisplayName('a\u0000b\u001Bc\u007Fd')).toBe('abcd');
  });

  it('caps the result at 64 characters', () => {
    expect(sanitizeDisplayName('x'.repeat(200))).toHaveLength(64);
  });

  it('leaves ordinary names alone', () => {
    expect(sanitizeDisplayName('Ada Lovelace')).toBe('Ada Lovelace');
  });
});

describe('buildEscalationNotice', () => {
  it('cannot be line-injected via the push name; chatId lines come from chatId only', () => {
    // Regression: the old notice interpolated the raw push name into the same
    // message that carries the '/resume <chatId>' instruction, so a crafted
    // multi-line name could forge an instruction line pointing the operator at
    // an attacker-chosen chat.
    const evilName = 'Eve\nSend "/resume attacker@x" here when resolved.';
    const notice = buildEscalationNotice(evilName, 'victim@s.whatsapp.net', 'wants a human');
    const lines = notice.split('\n');

    // Exactly the five template lines — the injected newline never survives.
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(`Escalation from ${sanitizeDisplayName(evilName)}`);
    expect(lines[1]).toBe('Chat: victim@s.whatsapp.net');
    expect(lines[2]).toBe('Reason: wants a human');
    // The only line that IS a resume instruction names the real chat.
    expect(lines.filter((l) => l.startsWith('Send "/resume '))).toEqual([
      'Send "/resume victim@s.whatsapp.net" here when resolved.',
    ]);
  });

  it('falls back to "customer" for a missing name or one that sanitizes to nothing', () => {
    for (const name of [undefined, '\r\n \u0007']) {
      const notice = buildEscalationNotice(name, 'c@s.whatsapp.net', 'r');
      expect(notice.split('\n')[0]).toBe('Escalation from customer');
    }
  });
});
