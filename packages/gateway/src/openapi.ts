/**
 * OpenAPI 3.1 description of the gateway's HTTP API, generated from the route
 * schemas Fastify registers (`app.routeSchemas`).
 *
 * Request and response shapes come from those schemas alone, so the document
 * cannot drift from what the gateway validates and serializes. This module
 * adds only what Fastify does not know: summaries, auth, the Idempotency-Key
 * header, and which error codes each route can answer. The error responses
 * are taken from here rather than from the route schemas, because those
 * declare only the statuses whose bodies need a serializer.
 *
 * `openapi.json` at the package root is the committed output. Regenerate it
 * with `pnpm --filter @utexo/lightsdk-gateway openapi`; the test suite fails
 * while it is stale.
 */
import { isDeepStrictEqual } from 'node:util';
import type { RouteSchemaEntry } from './server.js';
import { errorBodySchema } from './schemas/index.js';
import { assignmentSchema, balanceSchema } from './schemas/wallet.js';
import { completeBodySchema, intentSchema, preparedResponseSchema } from './schemas/onchain.js';

type JsonObject = Record<string, unknown>;

/**
 * Every code the gateway puts in an error body, with its status. The test
 * suite checks this against the codes the source raises, both ways.
 */
export const ERROR_CODES = {
  BAD_REQUEST: {
    status: 400,
    meaning:
      'The body, query string or path parameters failed validation; `message` names the field.',
  },
  IDEMPOTENCY_KEY_REQUIRED: {
    status: 400,
    meaning: 'No `Idempotency-Key` header, or one longer than 128 characters.',
  },
  INVALID_XPUBS: {
    status: 400,
    meaning: 'rgb-lib could not build a wallet from these xpubs. Nothing was registered.',
  },
  INVALID_ADDRESS: { status: 400, meaning: "Not a valid address on the gateway's network." },
  TRANSPORT_ENDPOINT_NOT_ALLOWED: {
    status: 400,
    meaning: "A transport endpoint is not on the operator's allowlist (SSRF guard).",
  },
  WALLET_REQUEST_REJECTED: {
    status: 400,
    meaning:
      'rgb-lib rejected the request itself: bad recipient id, asset id, address, fee rate or transport endpoint. The detail stays server-side.',
  },
  INSUFFICIENT_FUNDS: {
    status: 400,
    meaning: 'Not enough confirmed bitcoins, assets or allocation slots.',
  },
  PSBT_MISMATCH: {
    status: 400,
    meaning: 'The signed PSBT is a different transaction from the one this operation prepared.',
  },
  PSBT_REJECTED: {
    status: 400,
    meaning: 'rgb-lib rejected the signed PSBT (bad signature or tampering). It was not broadcast.',
  },
  UNAUTHORIZED: { status: 401, meaning: 'Missing, malformed or unknown bearer token.' },
  OPERATOR_UNAUTHORIZED: { status: 401, meaning: 'Missing or wrong `x-operator-token`.' },
  WALLET_NOT_REGISTERED: {
    status: 404,
    meaning: 'This user has no registered xpubs yet (`POST /v1/wallet/xpubs`).',
  },
  OP_NOT_FOUND: {
    status: 404,
    meaning: "No such operation for this user. Another user's operation reads the same.",
  },
  IDEMPOTENCY_KEY_REUSED: {
    status: 409,
    meaning: 'This key was already used for a different request.',
  },
  IDEMPOTENCY_IN_FLIGHT: { status: 409, meaning: 'A request with this key is still running.' },
  XPUBS_MISMATCH: {
    status: 409,
    meaning: 'Different xpubs are already registered for this user; registration is permanent.',
  },
  FINGERPRINT_IN_USE: {
    status: 409,
    meaning:
      'Another user already registered this master fingerprint. rgb-node-api keys wallets by fingerprint alone, so it cannot be shared.',
  },
  OP_KIND_MISMATCH: {
    status: 409,
    meaning: 'The operation was prepared by a different flow.',
  },
  OP_ALREADY_COMPLETED: { status: 409, meaning: 'The operation was already completed.' },
  OP_EXPIRED: { status: 410, meaning: 'The operation passed `expiresAt`; prepare again.' },
  QUEUE_FULL: {
    status: 429,
    meaning:
      "Too many of this user's requests are queued or running. Retry after `retry-after` seconds.",
  },
  INTERNAL: {
    status: 500,
    meaning:
      'Unexpected failure, such as rgb-node-api being unreachable or timing out on a route with no more specific code. The detail is logged under `x-request-id`.',
  },
  WALLET_OPERATION_UNSUPPORTED: {
    status: 501,
    meaning:
      'The configured rgb-node-api has no route for this operation (witness receives and BTC sends need rgb-node-api `0280e0e` or later). Nothing was attempted.',
  },
  AMOUNT_NOT_REPRESENTABLE: {
    status: 502,
    meaning:
      "The wallet holds an amount above 2^53−1, which a JSON number cannot carry exactly. Permanent, and not the caller's fault.",
  },
  COMPLETE_AMBIGUOUS: {
    status: 502,
    meaning:
      'The wallet failed after the transaction may have been broadcast. The operation stays pending with its txid recorded; read it with `GET /v1/onchain/operations/{opId}` instead of assuming the send failed.',
  },
  FEE_ESTIMATE_UNAVAILABLE: {
    status: 502,
    meaning: 'The indexer gave no usable fee estimate.',
  },
  UPSTREAM_TIMEOUT: {
    status: 504,
    meaning: 'The indexer did not answer the fee-estimate request within 10 seconds.',
  },
} as const satisfies Record<string, { status: number; meaning: string }>;

export type ErrorCode = keyof typeof ERROR_CODES;

interface RouteDoc {
  operationId: string;
  summary: string;
  description: string;
  tag: 'System' | 'Users' | 'Wallet' | 'On-chain';
  auth: 'none' | 'operator' | 'bearer';
  /** Requires an Idempotency-Key header; its error codes are added automatically. */
  idempotent?: true;
  /** What the success response means. */
  success: string;
  /**
   * Route-specific error codes. Added automatically: BAD_REQUEST for a route
   * with a body, query or path schema, the auth failure, the idempotency
   * codes, and INTERNAL.
   */
  errors: readonly ErrorCode[];
}

const COMPLETE_ERRORS: readonly ErrorCode[] = [
  'WALLET_NOT_REGISTERED',
  'OP_NOT_FOUND',
  'OP_KIND_MISMATCH',
  'OP_ALREADY_COMPLETED',
  'OP_EXPIRED',
  'PSBT_MISMATCH',
  'PSBT_REJECTED',
  'INSUFFICIENT_FUNDS',
  'COMPLETE_AMBIGUOUS',
  'QUEUE_FULL',
];

const COMPLETE_DESCRIPTION =
  "Submit the client-signed PSBT of a prepared operation. rgb-lib finalizes and broadcasts it. Retrying with the same `Idempotency-Key` returns the stored outcome. A 502 `COMPLETE_AMBIGUOUS` means the transaction may already be on the network: don't treat it as a failure. Read the operation instead; the gateway finishes the bookkeeping itself.";

/** Keyed by `METHOD url` exactly as Fastify registers the route; listed in reading order. */
const ROUTE_DOCS: Record<string, RouteDoc> = {
  'GET /v1/health': {
    operationId: 'getHealth',
    summary: 'Liveness check',
    description: 'Answers while the process is up. It checks neither rgb-node-api nor the indexer.',
    tag: 'System',
    auth: 'none',
    success: 'The gateway is up.',
    errors: [],
  },
  'POST /v1/users': {
    operationId: 'createUser',
    summary: 'Create a user',
    description:
      "Operator-only bootstrap. The response is the only time the user's bearer token is shown: the gateway stores just its hash, so a lost token cannot be recovered. Takes no body.",
    tag: 'Users',
    auth: 'operator',
    success: 'The user was created.',
    errors: [],
  },
  'GET /v1/me': {
    operationId: 'getMe',
    summary: 'Current user',
    description: 'The user the bearer token belongs to.',
    tag: 'Users',
    auth: 'bearer',
    success: 'The authenticated user.',
    errors: [],
  },
  'POST /v1/wallet/xpubs': {
    operationId: 'registerXpubs',
    summary: 'Register account xpubs',
    description:
      "Creates the user's watch-only wallet on rgb-node-api from their two account xpubs. Registration is permanent: the same three values again answer 201 again, different ones 409 `XPUBS_MISMATCH`. A master fingerprint can belong to one user only.",
    tag: 'Wallet',
    auth: 'bearer',
    success: 'Registered, or already registered with exactly these values.',
    errors: ['INVALID_XPUBS', 'XPUBS_MISMATCH', 'FINGERPRINT_IN_USE', 'QUEUE_FULL'],
  },
  'GET /v1/wallet/address': {
    operationId: 'getAddress',
    summary: 'Next deposit address',
    description:
      'Reveals the next address of the vanilla (BTC) wallet, with the derivation it came from so the client can re-derive it from its own seed before showing it.',
    tag: 'Wallet',
    auth: 'bearer',
    success: 'A deposit address.',
    errors: ['WALLET_NOT_REGISTERED', 'QUEUE_FULL'],
  },
  'GET /v1/wallet/balances': {
    operationId: 'getBalances',
    summary: 'BTC and asset balances',
    description: 'BTC on both keychains, and every RGB asset the wallet knows with its balance.',
    tag: 'Wallet',
    auth: 'bearer',
    success: 'The balances.',
    errors: ['WALLET_NOT_REGISTERED', 'AMOUNT_NOT_REPRESENTABLE', 'QUEUE_FULL'],
  },
  'GET /v1/wallet/unspents': {
    operationId: 'getUnspents',
    summary: 'UTXOs and their RGB allocations',
    description:
      "The wallet's UTXOs. Each carries its RGB allocations and the blind receives promised against it.",
    tag: 'Wallet',
    auth: 'bearer',
    success: 'The UTXOs.',
    errors: ['WALLET_NOT_REGISTERED', 'AMOUNT_NOT_REPRESENTABLE', 'QUEUE_FULL'],
  },
  'GET /v1/wallet/transfers': {
    operationId: 'getTransfers',
    summary: 'RGB transfers',
    description:
      "Transfers of one asset, or of every asset the wallet knows. A receive created without an `assetId` is not listed until the sender's transfer arrives, because rgb-node-api lists transfers by asset only; the client already has its `recipientId` and `batchTransferIdx` from the receive response.",
    tag: 'Wallet',
    auth: 'bearer',
    success: 'The transfers.',
    errors: [
      'WALLET_NOT_REGISTERED',
      'WALLET_REQUEST_REJECTED',
      'AMOUNT_NOT_REPRESENTABLE',
      'QUEUE_FULL',
    ],
  },
  'GET /v1/wallet/transactions': {
    operationId: 'getTransactions',
    summary: 'On-chain transactions',
    description:
      'Syncs the wallet against the indexer, then lists its on-chain transactions. With `txid`, only that one; an unknown txid answers an empty list, not an error.',
    tag: 'Wallet',
    auth: 'bearer',
    success: 'The transactions.',
    errors: ['WALLET_NOT_REGISTERED', 'AMOUNT_NOT_REPRESENTABLE', 'QUEUE_FULL'],
  },
  'POST /v1/wallet/receive': {
    operationId: 'receive',
    summary: 'Create an RGB invoice',
    description:
      "Creates a blind or witness receive on the user's wallet and returns its invoice. The invoice's transport endpoint is rgb-node-api's configured RGB proxy.",
    tag: 'Wallet',
    auth: 'bearer',
    success: 'The receive was created.',
    errors: [
      'WALLET_NOT_REGISTERED',
      'WALLET_REQUEST_REJECTED',
      'INSUFFICIENT_FUNDS',
      'WALLET_OPERATION_UNSUPPORTED',
      'QUEUE_FULL',
    ],
  },
  'POST /v1/wallet/sync': {
    operationId: 'sync',
    summary: 'Sync and refresh the wallet',
    description:
      'Syncs the wallet against the indexer and refreshes its pending RGB transfers. Takes no body.',
    tag: 'Wallet',
    auth: 'bearer',
    success: 'Synced.',
    errors: ['WALLET_NOT_REGISTERED', 'QUEUE_FULL'],
  },
  'POST /v1/onchain/send-btc/prepare': {
    operationId: 'prepareSendBtc',
    summary: 'Prepare a BTC send',
    description:
      'Builds an unsigned PSBT that pays `amountSat` to `address` from the vanilla wallet. Check it against `intent`, sign it, and complete it before `expiresAt`.',
    tag: 'On-chain',
    auth: 'bearer',
    idempotent: true,
    success: 'Prepared.',
    errors: [
      'INVALID_ADDRESS',
      'WALLET_NOT_REGISTERED',
      'WALLET_REQUEST_REJECTED',
      'INSUFFICIENT_FUNDS',
      'WALLET_OPERATION_UNSUPPORTED',
      'QUEUE_FULL',
    ],
  },
  'POST /v1/onchain/send-btc/complete': {
    operationId: 'completeSendBtc',
    summary: 'Broadcast a signed BTC send',
    description: COMPLETE_DESCRIPTION,
    tag: 'On-chain',
    auth: 'bearer',
    idempotent: true,
    success: 'Broadcast and recorded.',
    errors: [...COMPLETE_ERRORS, 'WALLET_OPERATION_UNSUPPORTED'],
  },
  'POST /v1/onchain/send-asset/prepare': {
    operationId: 'prepareSendAsset',
    summary: 'Prepare an RGB asset send',
    description:
      "Builds an unsigned PSBT that sends `amount` of `assetId` to the invoice's `recipientId`, with the RGB commitment already embedded. `intent` lets the client check the bitcoin side; the RGB transition itself is opaque to it.",
    tag: 'On-chain',
    auth: 'bearer',
    idempotent: true,
    success: 'Prepared.',
    errors: [
      'TRANSPORT_ENDPOINT_NOT_ALLOWED',
      'WALLET_NOT_REGISTERED',
      'WALLET_REQUEST_REJECTED',
      'INSUFFICIENT_FUNDS',
      'QUEUE_FULL',
    ],
  },
  'POST /v1/onchain/send-asset/complete': {
    operationId: 'completeSendAsset',
    summary: 'Broadcast a signed asset send',
    description: `${COMPLETE_DESCRIPTION} rgb-lib also posts the consignment to the transport endpoints.`,
    tag: 'On-chain',
    auth: 'bearer',
    idempotent: true,
    success: 'Broadcast and recorded.',
    errors: COMPLETE_ERRORS,
  },
  'POST /v1/onchain/create-utxos/prepare': {
    operationId: 'prepareCreateUtxos',
    summary: 'Prepare colorable UTXOs',
    description:
      'Builds an unsigned PSBT that creates `num` UTXOs of `size` sats on the colored keychain, paid from the vanilla wallet. RGB allocations need them. Every field is optional, but the body is not: send `{}` for the defaults.',
    tag: 'On-chain',
    auth: 'bearer',
    idempotent: true,
    success: 'Prepared.',
    errors: [
      'WALLET_NOT_REGISTERED',
      'WALLET_REQUEST_REJECTED',
      'INSUFFICIENT_FUNDS',
      'QUEUE_FULL',
    ],
  },
  'POST /v1/onchain/create-utxos/complete': {
    operationId: 'completeCreateUtxos',
    summary: 'Broadcast a signed create-utxos',
    description: COMPLETE_DESCRIPTION,
    tag: 'On-chain',
    auth: 'bearer',
    idempotent: true,
    success: 'Broadcast and recorded.',
    errors: COMPLETE_ERRORS,
  },
  'GET /v1/onchain/operations/:opId': {
    operationId: 'getOnchainOperation',
    summary: 'Read a prepared operation',
    description: [
      "The durable record of a prepared operation, for a client that lost the outcome of `complete`. Takes no `Idempotency-Key` and doesn't wait behind the user's queued wallet work, so it answers while a `complete` is still running. It never returns the PSBT.",
      '',
      '| `state` | `mayHaveBroadcast` | Meaning |',
      '| --- | --- | --- |',
      '| `completed` | `false` | Done; `txid` is final. |',
      '| `pending` | `false` | Prepared, never broadcast: sign and complete it, or let it expire. |',
      '| `pending` | `true` | The transaction may be on the network. The gateway finishes the bookkeeping itself; poll until `completed`. |',
      '| `expired` | `false` | Expired without being broadcast; prepare again. |',
      '| `expired` | `true` | Past `expiresAt` while ambiguous. The gateway still finishes it. |',
    ].join('\n'),
    tag: 'On-chain',
    auth: 'bearer',
    success: 'The operation.',
    errors: ['OP_NOT_FOUND'],
  },
  'GET /v1/onchain/fee-estimate': {
    operationId: 'getFeeEstimate',
    summary: 'Fee-rate estimate',
    description:
      "A fee rate from the gateway's indexer, which clients cannot reach themselves. It is rounded up to a whole sat/vB in the range the prepare routes accept. Cached for 30 seconds. It needs no registered wallet and doesn't wait behind the user's queued wallet work.",
    tag: 'On-chain',
    auth: 'bearer',
    success: 'The estimate.',
    errors: ['FEE_ESTIMATE_UNAVAILABLE', 'UPSTREAM_TIMEOUT'],
  },
};

/**
 * Schemas the routes share, emitted once under `components.schemas`. A route
 * schema node that matches one (ignoring its own `description`) becomes a
 * `$ref`, keeping that description.
 */
const COMPONENT_SCHEMAS: Record<string, JsonObject> = {
  ErrorBody: errorBodySchema,
  Balance: balanceSchema,
  Assignment: assignmentSchema,
  OnchainIntent: intentSchema,
  PreparedOperation: preparedResponseSchema,
  CompleteRequest: completeBodySchema,
};

/** Header names the security schemes already describe. */
const SECURITY_HEADERS = new Set(['authorization', 'x-operator-token']);

const INFO_DESCRIPTION = `REST gateway in front of a private rgb-node-api service that hosts one watch-only rgb-lib wallet per user. Neither the gateway nor rgb-node-api holds keys: an on-chain operation is prepared here, signed by the client, and completed here.

## Authentication

Users send \`Authorization: Bearer <token>\`. \`POST /v1/users\` issues tokens and takes the operator token in \`x-operator-token\`.

## Idempotency

The prepare and complete routes require an \`Idempotency-Key\` header of 1 to 128 characters, scoped to the user. A retry with the same key and the same request (method, route and body) returns the stored response, error responses included, marked \`x-idempotent-replay: true\`. The same key on a different request answers 409 \`IDEMPOTENCY_KEY_REUSED\`. Responses with status 429 or 5xx are not stored, so that request can be retried under the same key. A key whose request never finished can be reclaimed by the same request after 15 minutes. Stored responses are kept for 7 days.

## Errors

Error bodies are \`{"error": {"code", "message"}}\`; branch on \`code\`. Every response carries an \`x-request-id\` header. Error details stay in the gateway's log under that id, so quote it to an operator. A path the gateway does not serve answers Fastify's default 404 body instead.

## Requests

JSON bodies of at most 64 KiB. Unknown fields in a body or query string are removed before processing, not rejected. Amounts are JSON numbers: sats for BTC, asset units for RGB.`;

/** Fastify `:param` segments to OpenAPI `{param}`. */
function openApiPath(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function withoutDescription(schema: JsonObject): JsonObject {
  const { description: _description, ...rest } = schema;
  return rest;
}

function componentRef(node: JsonObject): JsonObject | undefined {
  for (const [name, component] of Object.entries(COMPONENT_SCHEMAS)) {
    if (!isDeepStrictEqual(withoutDescription(node), withoutDescription(component))) continue;
    const ref: JsonObject = { $ref: `#/components/schemas/${name}` };
    if (node['description'] !== undefined && node['description'] !== component['description']) {
      ref['description'] = node['description'];
    }
    return ref;
  }
  return undefined;
}

/** Replaces shared sub-schemas with `$ref`s, outermost match first. */
function refify(value: unknown, isRoot = false): unknown {
  if (Array.isArray(value)) return value.map((item) => refify(item));
  if (value === null || typeof value !== 'object') return value;
  const node = value as JsonObject;
  if (!isRoot) {
    const ref = componentRef(node);
    if (ref !== undefined) return ref;
  }
  return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, refify(item)]));
}

function parameters(schema: unknown, location: 'path' | 'query' | 'header'): JsonObject[] {
  if (schema === undefined) return [];
  const object = schema as { properties?: Record<string, JsonObject>; required?: string[] };
  return Object.entries(object.properties ?? {})
    .filter(([name]) => location !== 'header' || !SECURITY_HEADERS.has(name.toLowerCase()))
    .map(([name, property]) => {
      const parameter: JsonObject = {
        name,
        in: location,
        required: location === 'path' || (object.required ?? []).includes(name),
      };
      if (property['description'] !== undefined) parameter['description'] = property['description'];
      parameter['schema'] = refify(withoutDescription(property), true);
      return parameter;
    });
}

function errorResponses(doc: RouteDoc, validated: boolean): Map<number, ErrorCode[]> {
  const codes: ErrorCode[] = [];
  if (validated) codes.push('BAD_REQUEST');
  if (doc.auth === 'bearer') codes.push('UNAUTHORIZED');
  if (doc.auth === 'operator') codes.push('OPERATOR_UNAUTHORIZED');
  if (doc.idempotent === true) {
    codes.push('IDEMPOTENCY_KEY_REQUIRED', 'IDEMPOTENCY_KEY_REUSED', 'IDEMPOTENCY_IN_FLIGHT');
  }
  codes.push(...doc.errors, 'INTERNAL');
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of new Set(codes)) {
    const { status } = ERROR_CODES[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return new Map([...byStatus.entries()].sort(([a], [b]) => a - b));
}

function responseHeaders(doc: RouteDoc, status: number): JsonObject {
  const headers: JsonObject = { 'x-request-id': { $ref: '#/components/headers/RequestId' } };
  if (status === 429) headers['retry-after'] = { $ref: '#/components/headers/RetryAfter' };
  // Only a response stored by the idempotency middleware can be replayed:
  // never a 401 (auth runs before it), a 429 or a 5xx.
  if (doc.idempotent === true && status < 500 && status !== 401 && status !== 429) {
    headers['x-idempotent-replay'] = { $ref: '#/components/headers/IdempotentReplay' };
  }
  return headers;
}

function operation(doc: RouteDoc, schema: JsonObject): JsonObject {
  const result: JsonObject = {
    operationId: doc.operationId,
    summary: doc.summary,
    description: doc.description,
    tags: [doc.tag],
    security:
      doc.auth === 'bearer'
        ? [{ bearerAuth: [] }]
        : doc.auth === 'operator'
          ? [{ operatorToken: [] }]
          : [],
  };
  const params = [
    ...parameters(schema['params'], 'path'),
    ...parameters(schema['querystring'], 'query'),
    ...parameters(schema['headers'], 'header'),
    ...(doc.idempotent === true ? [{ $ref: '#/components/parameters/IdempotencyKey' }] : []),
  ];
  if (params.length > 0) result['parameters'] = params;
  if (schema['body'] !== undefined) {
    result['requestBody'] = {
      required: true,
      content: { 'application/json': { schema: refify(schema['body']) } },
    };
  }

  const responses: JsonObject = {};
  for (const [status, body] of Object.entries((schema['response'] ?? {}) as JsonObject)) {
    if (!status.startsWith('2')) continue;
    responses[status] = {
      description: doc.success,
      headers: responseHeaders(doc, Number(status)),
      content: { 'application/json': { schema: refify(body) } },
    };
  }
  if (Object.keys(responses).length !== 1) {
    throw new Error(`${doc.operationId}: expected exactly one success response schema`);
  }
  const validated = ['body', 'querystring', 'params'].some((key) => schema[key] !== undefined);
  for (const [status, codes] of errorResponses(doc, validated)) {
    responses[String(status)] = {
      description: codes.map((code) => `- \`${code}\`: ${ERROR_CODES[code].meaning}`).join('\n'),
      headers: responseHeaders(doc, status),
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } },
    };
  }
  result['responses'] = responses;
  return result;
}

/**
 * Builds the OpenAPI document from the routes a built server registered.
 * Throws when a registered route has no entry in ROUTE_DOCS, or the reverse:
 * the document must describe exactly the routes the gateway serves.
 */
export function buildOpenApiDocument(
  routes: readonly RouteSchemaEntry[],
  version: string,
): JsonObject {
  const registered = new Map<string, JsonObject>();
  for (const route of routes) {
    for (const method of [route.method].flat()) {
      // Fastify registers a HEAD twin for every GET; it is not part of the API.
      if (method === 'HEAD') continue;
      registered.set(`${method} ${route.url}`, (route.schema ?? {}) as JsonObject);
    }
  }
  const undocumented = [...registered.keys()].filter((key) => !(key in ROUTE_DOCS));
  const unregistered = Object.keys(ROUTE_DOCS).filter((key) => !registered.has(key));
  if (undocumented.length > 0 || unregistered.length > 0) {
    throw new Error(
      `OpenAPI route docs are out of sync: undocumented [${undocumented.join(', ')}], unregistered [${unregistered.join(', ')}]`,
    );
  }

  const paths: Record<string, JsonObject> = {};
  for (const [key, doc] of Object.entries(ROUTE_DOCS)) {
    const [method, url] = key.split(' ') as [string, string];
    const path = openApiPath(url);
    paths[path] = { ...paths[path], [method.toLowerCase()]: operation(doc, registered.get(key)!) };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'lightsdk-gateway API',
      version,
      description: INFO_DESCRIPTION,
    },
    servers: [
      {
        url: 'http://127.0.0.1:8480',
        description: 'Default listen address (`GATEWAY_HOST`, `GATEWAY_PORT`).',
      },
    ],
    tags: [
      { name: 'System', description: 'Liveness.' },
      { name: 'Users', description: 'User bootstrap and identity.' },
      {
        name: 'Wallet',
        description:
          "Reads and receives on the user's watch-only wallet. Every route but the registration needs registered xpubs.",
      },
      {
        name: 'On-chain',
        description: 'Prepare, sign on the client, complete; plus recovery and fee estimates.',
      },
    ],
    paths,
    components: {
      schemas: Object.fromEntries(
        Object.entries(COMPONENT_SCHEMAS).map(([name, schema]) => [name, refify(schema, true)]),
      ),
      parameters: {
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          description:
            'Client-chosen key for one logical operation, scoped to the user. Reuse it only to retry the same request.',
          schema: { type: 'string', minLength: 1, maxLength: 128 },
        },
      },
      headers: {
        RequestId: {
          description: 'Random id of this request; the gateway logs error details under it.',
          schema: { type: 'string', format: 'uuid' },
        },
        RetryAfter: {
          description: 'Seconds to wait before retrying.',
          schema: { type: 'integer' },
        },
        IdempotentReplay: {
          description: 'Present, as `true`, when this is a stored response being replayed.',
          schema: { type: 'string', enum: ['true'] },
        },
      },
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: "The user's token from `POST /v1/users`.",
        },
        operatorToken: {
          type: 'apiKey',
          in: 'header',
          name: 'x-operator-token',
          description: 'The `GATEWAY_OPERATOR_TOKEN`. Guards user creation only.',
        },
      },
    },
  };
}
