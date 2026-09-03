/**
 * Operator-facing helpers for the escalation flow. Pure functions kept out of
 * index.ts (which starts the bot on import) so the security-relevant behavior
 * is unit-testable — see operator.test.ts.
 */

/** Matches CR/LF and every other C0/C1 control character (plus DEL). */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'gu');

/**
 * Whether `senderId` is the configured operator. Fails CLOSED: when no
 * operator chat id is configured there is no operator, so nobody is allowed
 * to run operator commands — not everybody.
 */
export function isOperator(senderId: string, operatorChatId: string | undefined): boolean {
  return !!operatorChatId && senderId === operatorChatId;
}

/**
 * Sanitize an attacker-controlled display name (the WhatsApp push name) for
 * embedding in the operator notification: CR/LF and all other control
 * characters are stripped — so a crafted name cannot inject fake message
 * lines, e.g. a bogus '/resume <chatId>' instruction — and the result is
 * capped at 64 characters.
 */
export function sanitizeDisplayName(name: string): string {
  return name.replace(CONTROL_CHARS, '').slice(0, 64);
}

/**
 * Build the operator escalation notification. The machine-actionable chat id
 * lives on its own line and is derived ONLY from `chatId` (the
 * transport-provided ctx.message.chatId), never from customer-controlled
 * text; the customer's push name is sanitized via {@link sanitizeDisplayName}.
 */
export function buildEscalationNotice(
  senderName: string | undefined,
  chatId: string,
  reason: string
): string {
  const name = sanitizeDisplayName(senderName ?? '').trim() || 'customer';
  return [
    `Escalation from ${name}`,
    `Chat: ${chatId}`,
    `Reason: ${reason}`,
    '',
    `Send "/resume ${chatId}" here when resolved.`,
  ].join('\n');
}
