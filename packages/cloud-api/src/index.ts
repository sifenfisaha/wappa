/**
 * @wappa/cloud-api — official WhatsApp Cloud API transport for wappa.
 *
 * Meta Business webhook (inbound) + Graph API (outbound), built on node:http,
 * node:crypto and the global fetch — no Meta SDK.
 */
export { CloudApiTransport, type CloudApiTransportOptions } from './transport.js';
export {
  buildSendBody,
  isHttpUrl,
  mapCloudApiMessage,
  mapWebhookPayload,
  type CloudApiContact,
  type CloudApiMediaObject,
  type CloudApiMessage,
  type InboundMappingDeps,
} from './mapping.js';
export { computeSignature, readRawBody, verifySignature } from './webhook.js';
