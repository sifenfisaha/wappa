/**
 * @wappa/twilio — Twilio WhatsApp (BSP) transport for wappa.
 *
 * Form-encoded Twilio webhook (inbound) + Messages REST API with basic auth
 * (outbound), built on node:http, node:crypto and the global fetch — no
 * Twilio SDK.
 */
export { TwilioTransport, type TwilioTransportOptions } from './transport.js';
export {
  buildSendParams,
  ensureWhatsappPrefix,
  isHttpUrl,
  isStatusCallback,
  mapTwilioParams,
  mediaKindFromContentType,
  renderButtonFallback,
  type InboundMappingDeps,
  type TwilioParams,
} from './mapping.js';
export {
  computeTwilioSignature,
  parseFormBody,
  readRawBody,
  verifyTwilioSignature,
} from './webhook.js';
