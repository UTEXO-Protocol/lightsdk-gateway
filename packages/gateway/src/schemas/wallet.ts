/**
 * JSON schemas for the wallet routes. Strict responses
 * (additionalProperties: false) strip anything undeclared — nothing from the
 * rgb-lib layer reaches a client unless declared here (I1 backstop).
 */
import { errorBodySchema } from './index.js';

export const balanceSchema = {
  type: 'object',
  description: 'rgb-lib balance triple: sats for BTC, asset units for an RGB asset.',
  properties: {
    settled: { type: 'number', description: 'Confirmed balance.' },
    future: { type: 'number', description: 'Balance once pending transfers settle.' },
    spendable: { type: 'number', description: 'Balance that can be spent now.' },
  },
  required: ['settled', 'future', 'spendable'],
  additionalProperties: false,
} as const;

/** Base58 account xpub (tpub/xpub/vpub...); length bounds, not full checksum. */
const xpubPattern = '^[a-zA-Z0-9]{100,120}$';

/**
 * An rgb-lib Assignment as a variant name plus its fungible value. `kind`
 * carries the variant verbatim, so a new rgb-lib assignment variant reaches a
 * client as itself rather than as a silently dropped field.
 */
export const assignmentSchema = {
  type: 'object',
  description: 'An rgb-lib assignment: its variant name plus its fungible amount.',
  properties: {
    kind: {
      type: 'string',
      description:
        'rgb-lib Assignment variant, verbatim: `Fungible`, `Any`, `InflationRight`, `NonFungible`, ...',
    },
    amount: {
      type: ['integer', 'null'],
      description: 'Fungible amount; null for a variant that carries none.',
    },
  },
  required: ['kind', 'amount'],
  additionalProperties: false,
} as const;

export const registerXpubsRouteSchema = {
  body: {
    type: 'object',
    properties: {
      vanilla: {
        type: 'string',
        pattern: xpubPattern,
        description: 'Base58 account xpub of the vanilla (BTC) keychain.',
      },
      colored: {
        type: 'string',
        pattern: xpubPattern,
        description: 'Base58 account xpub of the colored (RGB) keychain.',
      },
      fingerprint: {
        type: 'string',
        pattern: '^[0-9a-f]{8}$',
        description: 'Master key fingerprint, 8 lowercase hex characters.',
      },
    },
    required: ['vanilla', 'colored', 'fingerprint'],
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      properties: {
        fingerprint: { type: 'string', description: 'The registered master fingerprint.' },
        address: { type: 'string', description: 'A deposit address from the vanilla wallet.' },
      },
      required: ['fingerprint', 'address'],
      additionalProperties: false,
    },
    400: errorBodySchema,
    401: errorBodySchema,
    409: errorBodySchema,
  },
} as const;

export const walletAddressRouteSchema = {
  response: {
    200: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Next deposit address of the vanilla wallet.' },
        /**
         * Derivation the address came from, so a client can re-derive it from
         * its own seed before trusting it as a deposit target — the gateway
         * holds the xpubs and could otherwise return any address. Null when it
         * could not be attributed (see wallets/derivation.ts): the address is
         * still rgb-lib's, it just carries no proof.
         */
        derivation: {
          type: ['object', 'null'],
          description:
            'Where the address came from, so the client can re-derive it from its own seed before showing it. Null when the gateway could not attribute it: treat the address as unproven.',
          properties: {
            account: { type: 'string', enum: ['vanilla'] },
            keychain: { type: 'integer', description: 'Keychain index in the path (0).' },
            index: { type: 'integer', description: 'Child index of the address.' },
            derivationPath: {
              type: 'string',
              description: "Full path from the master key, `m/86'/<coin>'/0'/<keychain>/<index>`.",
            },
            scriptHex: { type: 'string', description: "The address's output script, hex." },
          },
          required: ['account', 'keychain', 'index', 'derivationPath', 'scriptHex'],
          additionalProperties: false,
        },
      },
      required: ['address', 'derivation'],
      additionalProperties: false,
    },
    401: errorBodySchema,
    404: errorBodySchema,
    502: errorBodySchema,
  },
} as const;

export const walletBalancesRouteSchema = {
  response: {
    200: {
      type: 'object',
      properties: {
        btc: {
          type: 'object',
          properties: {
            vanilla: { ...balanceSchema, description: 'BTC on the vanilla keychain, in sats.' },
            colored: {
              ...balanceSchema,
              description: 'BTC on the colored keychain, which holds the RGB allocations, in sats.',
            },
          },
          required: ['vanilla', 'colored'],
          additionalProperties: false,
        },
        assets: {
          type: 'array',
          description: 'Every RGB asset the wallet knows.',
          items: {
            type: 'object',
            properties: {
              assetId: { type: 'string', description: 'RGB contract id.' },
              schema: {
                type: 'string',
                description: 'rgb-lib AssetSchema, verbatim (`Nia`, `Ifa`, ...).',
              },
              ticker: { type: ['string', 'null'], description: 'Null for schemas without one.' },
              name: { type: 'string' },
              details: { type: ['string', 'null'] },
              precision: { type: 'integer', description: 'Decimal places of one asset unit.' },
              issuedSupply: {
                type: ['integer', 'null'],
                description: 'Total issued amount; null for schemas without one (UDA).',
              },
              timestamp: { type: 'integer', description: 'Unix seconds of the asset genesis.' },
              addedAt: {
                type: 'integer',
                description: 'Unix seconds when this wallet imported the asset.',
              },
              balance: { ...balanceSchema, description: 'In asset units.' },
            },
            required: [
              'assetId',
              'schema',
              'ticker',
              'name',
              'details',
              'precision',
              'issuedSupply',
              'timestamp',
              'addedAt',
              'balance',
            ],
            additionalProperties: false,
          },
        },
      },
      required: ['btc', 'assets'],
      additionalProperties: false,
    },
    401: errorBodySchema,
    404: errorBodySchema,
    502: errorBodySchema,
  },
} as const;

export const walletUnspentsRouteSchema = {
  response: {
    200: {
      type: 'object',
      properties: {
        unspents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              txid: { type: 'string' },
              vout: { type: 'integer' },
              amountSat: { type: 'number' },
              colorable: {
                type: 'boolean',
                description: 'Whether the UTXO can hold RGB allocations.',
              },
              exists: {
                type: 'boolean',
                description: 'True once the transaction creating this UTXO has been broadcast.',
              },
              /**
               * Blind receives already promised against this UTXO. A client
               * counting free allocation slots cannot derive this from
               * `allocations`: a pending blind receive reserves a slot before it
               * holds an allocation.
               */
              pendingBlinded: {
                type: 'integer',
                description:
                  'Blind receives already promised against this UTXO. Each reserves an allocation slot before it holds an allocation, so free slots cannot be counted from `allocations` alone.',
              },
              allocations: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    assetId: { type: ['string', 'null'] },
                    amount: {
                      type: ['number', 'null'],
                      description: 'Fungible amount of `assignment`; null when it has none.',
                    },
                    assignment: assignmentSchema,
                    settled: { type: 'boolean' },
                  },
                  required: ['assetId', 'amount', 'assignment', 'settled'],
                  additionalProperties: false,
                },
              },
            },
            required: [
              'txid',
              'vout',
              'amountSat',
              'colorable',
              'exists',
              'pendingBlinded',
              'allocations',
            ],
            additionalProperties: false,
          },
        },
      },
      required: ['unspents'],
      additionalProperties: false,
    },
    401: errorBodySchema,
    404: errorBodySchema,
    502: errorBodySchema,
  },
} as const;

export const walletTransfersRouteSchema = {
  querystring: {
    type: 'object',
    properties: {
      assetId: {
        type: 'string',
        minLength: 1,
        description: "List only this asset's transfers. Omitted: every known asset's.",
      },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      properties: {
        transfers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              idx: { type: 'integer', description: 'rgb-lib transfer index.' },
              /**
               * Batch this transfer belongs to. rgb-lib keys refresh, fail and
               * delete by the BATCH index, not by `idx`, so a client that only
               * sees `idx` cannot act on the transfer it just read.
               */
              batchTransferIdx: {
                type: ['integer', 'null'],
                description:
                  'Batch this transfer belongs to. rgb-lib refreshes, fails and deletes transfers by this index, not by `idx`.',
              },
              assetId: { type: ['string', 'null'] },
              amount: {
                type: ['number', 'null'],
                description:
                  'Requested amount, or else the total of the fungible assignments; null when there is neither.',
              },
              assignments: {
                type: 'array',
                items: assignmentSchema,
                description: 'Full assignment list; `amount` is only its fungible summary.',
              },
              kind: {
                type: 'string',
                description: 'rgb-lib TransferKind, verbatim (`ReceiveBlind`, `Send`, ...).',
              },
              status: {
                type: 'string',
                description:
                  'rgb-lib TransferStatus, verbatim (`WaitingCounterparty`, `WaitingConfirmations`, `Settled`, `Failed`).',
              },
              txid: { type: ['string', 'null'] },
              recipientId: {
                type: ['string', 'null'],
                description: 'Blinded UTXO or witness recipient id, when the transfer has one.',
              },
              expiration: {
                type: ['number', 'null'],
                description: 'Unix seconds after which a pending transfer expires.',
              },
              createdAt: { type: 'number', description: 'Unix seconds.' },
              updatedAt: { type: 'number', description: 'Unix seconds.' },
            },
            required: [
              'idx',
              'batchTransferIdx',
              'assetId',
              'amount',
              'assignments',
              'kind',
              'status',
              'txid',
              'recipientId',
              'expiration',
              'createdAt',
              'updatedAt',
            ],
            additionalProperties: false,
          },
        },
      },
      required: ['transfers'],
      additionalProperties: false,
    },
    401: errorBodySchema,
    404: errorBodySchema,
    502: errorBodySchema,
  },
} as const;

/** A txid as rgb-lib reports it: 64 lowercase hex characters. */
const txidPattern = '^[0-9a-f]{64}$';

export const walletTransactionsRouteSchema = {
  querystring: {
    type: 'object',
    properties: {
      txid: {
        type: 'string',
        pattern: txidPattern,
        description: 'Return only this transaction (an empty list when the wallet has none).',
      },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      properties: {
        transactions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              /**
               * rgb-lib TransactionType verbatim (RgbSend, Drain, CreateUtxos,
               * SendBtc, Incoming), so a variant added upstream arrives named.
               */
              transactionType: {
                type: 'string',
                description:
                  'rgb-lib TransactionType, verbatim (`Incoming`, `SendBtc`, `CreateUtxos`, `RgbSend`, `Drain`, ...).',
              },
              txid: { type: 'string' },
              receivedSat: {
                type: 'integer',
                description: 'Value of the outputs paying the wallet, change included.',
              },
              sentSat: {
                type: 'integer',
                description:
                  "Value of the wallet's own inputs. What left the wallet is `sentSat - receivedSat`, fee included.",
              },
              feeSat: { type: 'integer' },
              confirmationTime: {
                type: ['object', 'null'],
                description: 'Null while unconfirmed.',
                properties: {
                  height: { type: 'integer' },
                  timestamp: { type: 'integer', description: 'Unix seconds of the block.' },
                },
                required: ['height', 'timestamp'],
                additionalProperties: false,
              },
            },
            required: [
              'transactionType',
              'txid',
              'receivedSat',
              'sentSat',
              'feeSat',
              'confirmationTime',
            ],
            additionalProperties: false,
          },
        },
      },
      required: ['transactions'],
      additionalProperties: false,
    },
    400: errorBodySchema,
    401: errorBodySchema,
    404: errorBodySchema,
    502: errorBodySchema,
  },
} as const;

export const walletReceiveRouteSchema = {
  body: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['blind', 'witness'],
        description:
          '`blind`: the sender pays to a blinded UTXO of this wallet. `witness`: the sender creates a new output for this wallet.',
      },
      assetId: {
        type: 'string',
        minLength: 1,
        description: 'Restrict the invoice to this asset. Omitted: any asset.',
      },
      // Integer for the same reason as sendAssetPrepareRouteSchema: rgb-lib
      // deserializes a fungible assignment into a u64.
      amount: {
        type: 'integer',
        minimum: 1,
        description: 'Requested amount in asset units. Omitted: an amount-less invoice.',
      },
      durationSeconds: {
        type: 'integer',
        minimum: 60,
        maximum: 2_592_000,
        description: 'Invoice lifetime. Default 86400 (one day).',
      },
      minConfirmations: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: 'Confirmations before the incoming transfer settles. Default 1.',
      },
    },
    required: ['mode'],
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      properties: {
        invoice: { type: 'string', description: 'RGB invoice to give the sender.' },
        recipientId: {
          type: 'string',
          description: 'Blinded UTXO or witness recipient id the invoice names.',
        },
        expirationTimestamp: {
          type: ['number', 'null'],
          description: 'Unix seconds when the invoice expires.',
        },
        /**
         * Batch index of the created receive; rgb-lib keys refresh, fail and
         * delete by it, so without this a client cannot manage the receive it
         * just asked for. Null only on rgb-lib shape drift.
         */
        batchTransferIdx: {
          type: ['integer', 'null'],
          description:
            'Batch index of the created receive, which rgb-lib refreshes, fails and deletes it by.',
        },
        mode: { type: 'string', enum: ['blind', 'witness'] },
      },
      required: ['invoice', 'recipientId', 'expirationTimestamp', 'batchTransferIdx', 'mode'],
      additionalProperties: false,
    },
    400: errorBodySchema,
    401: errorBodySchema,
    404: errorBodySchema,
    502: errorBodySchema,
  },
} as const;

export const walletSyncRouteSchema = {
  response: {
    200: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['ok'] } },
      required: ['status'],
      additionalProperties: false,
    },
    401: errorBodySchema,
    404: errorBodySchema,
  },
} as const;
