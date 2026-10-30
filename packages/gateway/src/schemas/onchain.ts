/**
 * JSON schemas for the on-chain prepare/complete routes. Strict responses
 * (additionalProperties: false) so nothing undeclared can leak (I1 backstop).
 */
import { errorBodySchema } from './index.js';

/** Base64 PSBT; the body limit (64KB) bounds overall size. */
const psbtSchema = { type: 'string', pattern: '^[A-Za-z0-9+/=]+$', minLength: 20 } as const;
const opIdSchema = {
  type: 'string',
  pattern: '^[0-9a-f-]{36}$',
  description: 'Operation id (a UUID) returned by prepare.',
} as const;
const feeRateSchema = { type: 'integer', minimum: 1, maximum: 1000 } as const;
/** Request-side fee rate: optional on every prepare route. */
const feeRateRequestSchema = {
  ...feeRateSchema,
  description: 'Fee rate in sat/vB. Default 2.',
} as const;

export const intentSchema = {
  type: 'object',
  description:
    "What the client checks the PSBT against before signing. Built from the request and the gateway's config, never read back from the PSBT.",
  properties: {
    kind: { type: 'string', enum: ['send_btc', 'send_asset', 'create_utxos'] },
    feeRateSatPerVb: { type: 'integer', description: 'Fee rate the PSBT was built with.' },
    recipients: {
      type: 'array',
      description: 'BTC payments: one for send-btc, none otherwise.',
      items: {
        type: 'object',
        properties: {
          address: { type: 'string' },
          scriptHex: { type: 'string', description: 'Output script the address decodes to, hex.' },
          amountSat: { type: 'integer' },
        },
        required: ['address', 'scriptHex', 'amountSat'],
        additionalProperties: false,
      },
    },
    asset: {
      type: ['object', 'null'],
      description: 'The RGB payment of a send-asset; null otherwise.',
      properties: {
        assetId: { type: 'string' },
        amount: { type: 'integer', description: 'Asset units.' },
        recipientId: { type: 'string' },
        witnessAmountSat: {
          type: ['integer', 'null'],
          description: 'Sats on the witness output; null for a blinded recipient.',
        },
        transportEndpoints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Consignment endpoints the transfer is posted to.',
        },
      },
      required: ['assetId', 'amount', 'recipientId', 'witnessAmountSat', 'transportEndpoints'],
      additionalProperties: false,
    },
    utxos: {
      type: ['object', 'null'],
      description: 'The UTXOs a create-utxos makes; null otherwise.',
      properties: {
        upTo: { type: 'boolean' },
        num: { type: 'integer' },
        size: { type: 'integer', description: 'Sats per UTXO.' },
      },
      required: ['upTo', 'num', 'size'],
      additionalProperties: false,
    },
  },
  required: ['kind', 'feeRateSatPerVb', 'recipients', 'asset', 'utxos'],
  additionalProperties: false,
} as const;

export const preparedResponseSchema = {
  type: 'object',
  properties: {
    opId: opIdSchema,
    psbt: { type: 'string', description: 'Unsigned PSBT, base64. Check it against `intent`.' },
    intent: intentSchema,
    expiresAt: {
      type: 'integer',
      description: 'Unix milliseconds. Completing after this fails with 410 `OP_EXPIRED`.',
    },
  },
  required: ['opId', 'psbt', 'intent', 'expiresAt'],
  additionalProperties: false,
} as const;

export const completeBodySchema = {
  type: 'object',
  properties: {
    opId: opIdSchema,
    signedPsbt: {
      ...psbtSchema,
      description: "The prepared PSBT with the client's signatures, base64. Same txid as prepared.",
    },
  },
  required: ['opId', 'signedPsbt'],
  additionalProperties: false,
} as const;

const prepareErrorResponses = {
  400: errorBodySchema,
  401: errorBodySchema,
  404: errorBodySchema,
  409: errorBodySchema,
} as const;

const completeErrorResponses = {
  400: errorBodySchema,
  401: errorBodySchema,
  404: errorBodySchema,
  409: errorBodySchema,
  410: errorBodySchema,
} as const;

/**
 * Read-only operation status. Strict like every other response here: the PSBT
 * is deliberately NOT echoed — the client already holds it from `prepare`, and
 * a 64KB blob has no place in a recovery poll.
 */
export const operationGetRouteSchema = {
  params: {
    type: 'object',
    properties: { opId: opIdSchema },
    required: ['opId'],
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      properties: {
        opId: opIdSchema,
        kind: { type: 'string', enum: ['send_btc', 'send_asset', 'create_utxos'] },
        state: {
          type: 'string',
          enum: ['pending', 'completed', 'expired'],
          description: '`expired` is reported for a pending op past `expiresAt`.',
        },
        txid: {
          type: ['string', 'null'],
          description:
            'Final txid once completed; the txid that may have broadcast while ambiguous; otherwise null.',
        },
        mayHaveBroadcast: {
          type: 'boolean',
          description:
            'True when the op is not completed but a txid is recorded: its transaction may already be on the network.',
        },
        intent: intentSchema,
        createdAt: { type: 'integer', description: 'Unix milliseconds.' },
        expiresAt: { type: 'integer', description: 'Unix milliseconds.' },
      },
      required: [
        'opId',
        'kind',
        'state',
        'txid',
        'mayHaveBroadcast',
        'intent',
        'createdAt',
        'expiresAt',
      ],
      additionalProperties: false,
    },
    401: errorBodySchema,
    404: errorBodySchema,
  },
} as const;

/**
 * Fee estimate from the shared indexer. Clients cannot reach esplora directly,
 * so without this they have no fee source; the answer is a whole sat/vB in the
 * same 1..1000 range every fee-taking route accepts, so it can be passed
 * straight back as `feeRateSatPerVb`.
 */
export const feeEstimateRouteSchema = {
  querystring: {
    type: 'object',
    properties: {
      // 1008 is the widest target esplora publishes.
      blocks: {
        type: 'integer',
        minimum: 1,
        maximum: 1008,
        description: 'Confirmation target in blocks. Default 6.',
      },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      properties: {
        blocks: { type: 'integer', description: 'The requested target.' },
        feeRateSatPerVb: {
          ...feeRateSchema,
          description: 'Whole sat/vB, rounded up. Can be passed straight to a prepare route.',
        },
        sourceBlocks: {
          type: 'integer',
          description:
            'Target the estimate was read from: the nearest one the indexer publishes at or below `blocks`.',
        },
      },
      required: ['blocks', 'feeRateSatPerVb', 'sourceBlocks'],
      additionalProperties: false,
    },
    400: errorBodySchema,
    401: errorBodySchema,
    502: errorBodySchema,
    504: errorBodySchema,
  },
} as const;

export const sendBtcPrepareRouteSchema = {
  body: {
    type: 'object',
    properties: {
      address: {
        type: 'string',
        pattern: '^[a-zA-Z0-9]{14,90}$',
        description: "Recipient address on the gateway's network.",
      },
      amountSat: { type: 'integer', minimum: 294 },
      feeRateSatPerVb: feeRateRequestSchema,
    },
    required: ['address', 'amountSat'],
    additionalProperties: false,
  },
  response: { 201: preparedResponseSchema, ...prepareErrorResponses },
} as const;

export const sendBtcCompleteRouteSchema = {
  body: completeBodySchema,
  response: {
    200: {
      type: 'object',
      properties: { txid: { type: 'string', description: 'The broadcast transaction.' } },
      required: ['txid'],
      additionalProperties: false,
    },
    ...completeErrorResponses,
  },
} as const;

export const sendAssetPrepareRouteSchema = {
  body: {
    type: 'object',
    properties: {
      assetId: { type: 'string', minLength: 1 },
      // Integer, not number: an RGB fungible amount is a u64 on the rgb-lib
      // side, and a fractional one fails serde deserialization there — a 500
      // for what is really a malformed request.
      amount: { type: 'integer', minimum: 1, description: 'Asset units.' },
      recipientId: {
        type: 'string',
        minLength: 1,
        description: "Recipient id from the recipient's invoice (blinded UTXO or witness).",
      },
      witnessAmountSat: {
        type: 'integer',
        minimum: 294,
        description: 'Sats for the witness output. Give it for a witness recipient only.',
      },
      transportEndpoints: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        maxItems: 4,
        description:
          "Consignment endpoints, each on the operator's allowlist. Default: the gateway's `RGB_PROXY_URL`.",
      },
      donation: {
        type: 'boolean',
        description:
          "rgb-lib donation: don't wait for the recipient's acknowledgement. Default false.",
      },
      minConfirmations: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: 'Confirmations required on the spent inputs. Default 1.',
      },
      feeRateSatPerVb: feeRateRequestSchema,
    },
    required: ['assetId', 'amount', 'recipientId'],
    additionalProperties: false,
  },
  response: { 201: preparedResponseSchema, ...prepareErrorResponses },
} as const;

export const sendAssetCompleteRouteSchema = {
  body: completeBodySchema,
  response: {
    200: {
      type: 'object',
      properties: {
        txid: { type: 'string', description: 'The broadcast transaction.' },
        /**
         * rgb-lib's batch transfer index for the transfer this created. refresh,
         * fail and delete address a transfer by this, not by its txid, so a
         * client cannot manage what it just sent without it.
         */
        batchTransferIdx: {
          type: ['integer', 'null'],
          description:
            'Batch index of the transfer this created, which rgb-lib refreshes, fails and deletes it by.',
        },
      },
      required: ['txid', 'batchTransferIdx'],
      additionalProperties: false,
    },
    ...completeErrorResponses,
  },
} as const;

export const createUtxosPrepareRouteSchema = {
  body: {
    type: 'object',
    properties: {
      num: { type: 'integer', minimum: 1, maximum: 50, description: 'UTXOs to create. Default 5.' },
      size: { type: 'integer', minimum: 294, description: 'Sats per UTXO. Default 1000.' },
      upTo: {
        type: 'boolean',
        description:
          'Create only as many as needed to reach `num` free colorable UTXOs. Default false.',
      },
      feeRateSatPerVb: feeRateRequestSchema,
    },
    additionalProperties: false,
  },
  response: { 201: preparedResponseSchema, ...prepareErrorResponses },
} as const;

export const createUtxosCompleteRouteSchema = {
  body: completeBodySchema,
  response: {
    200: {
      type: 'object',
      properties: {
        txid: { type: ['string', 'null'], description: 'The broadcast transaction.' },
        utxosCreated: { type: 'integer' },
      },
      required: ['txid', 'utxosCreated'],
      additionalProperties: false,
    },
    ...completeErrorResponses,
  },
} as const;
