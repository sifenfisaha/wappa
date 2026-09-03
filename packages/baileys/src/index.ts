/**
 * @wappa/baileys — Baileys transport adapter for wappa.
 *
 * Run a WhatsApp agent on a personal number via QR login. Baileys is an
 * unofficial client: using it may violate WhatsApp's ToS and can get numbers
 * banned — use a number you can afford to lose; prefer the Cloud API transport
 * for production.
 */
export { BaileysTransport } from './transport.js';
export type { BaileysTransportOptions } from './transport.js';
