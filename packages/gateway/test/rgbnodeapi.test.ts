import { describe, expect, it } from 'vitest';
import { walletHttpError, WalletBackendError } from '../src/wallets/backend.js';
import type { WalletHandle } from '../src/wallets/backend.js';
import {
  mapAssets,
  mapAssignment,
  mapTransactions,
  mapTransfers,
  mapUnspents,
  RgbNodeApiWalletBackend,
  serviceError,
} from '../src/wallets/rgbnodeapi.js';
import { HttpError } from '../src/errors.js';

const XPUBS = { vanilla: 'tpubVanilla', colored: 'tpubColored', fingerprint: '73c5da0a' };
const BASE_URL = 'http://rgb-node-api.test:34000/';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status: number; body: string } | Error;

/** Fake fetch answering queued replies in order and recording every request. */
function fakeService(...replies: Reply[]): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
    });
    const reply = replies.shift();
    if (reply === undefined) throw new Error('no reply queued');
    if (reply instanceof Error) throw reply;
    return new Response(reply.body, { status: reply.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function ok(body: unknown): Reply {
  return { status: 200, body: JSON.stringify(body) };
}

function rgbError(status: number, kind: string, message = 'rejected'): Reply {
  return {
    status,
    body: JSON.stringify({
      error: { code: 1001, status: 'bad_input', message, details: { kind } },
    }),
  };
}

async function handleFor(...replies: Reply[]): Promise<{
  handle: WalletHandle;
  calls: RecordedCall[];
}> {
  const { fetchImpl, calls } = fakeService(...replies);
  const backend = new RgbNodeApiWalletBackend({ baseUrl: BASE_URL, fetchImpl });
  const handle = await backend.open({ userId: 'u1', xpubs: XPUBS });
  return { handle, calls };
}

async function failure(promise: Promise<unknown>): Promise<WalletBackendError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(WalletBackendError);
  return error as WalletBackendError;
}

describe('RgbNodeApiWalletBackend requests', () => {
  it('opens without a remote call and names the wallet by its three headers', async () => {
    const { handle, calls } = await handleFor(ok({ address: 'bcrt1qaddr' }));
    expect(calls).toHaveLength(0);
    expect(await handle.getAddress()).toBe('bcrt1qaddr');
    expect(calls[0]).toEqual({
      url: 'http://rgb-node-api.test:34000/wallet/address',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'xpub-van': XPUBS.vanilla,
        'xpub-col': XPUBS.colored,
        'master-fingerprint': XPUBS.fingerprint,
      },
      body: {},
    });
  });

  it('sends snake_case bodies to the begin/end routes', async () => {
    const { handle, calls } = await handleFor(
      ok({ psbt: 'psbt-btc' }),
      ok({ txid: 'txid-btc' }),
      ok({ psbt: 'psbt-asset' }),
      ok({ txid: 'txid-asset', batch_transfer_idx: 4 }),
      ok({ psbt: 'psbt-utxos' }),
      ok({ created: 3 }),
    );
    expect(await handle.sendBtcBegin('bcrt1qdest', 1_000, 2)).toBe('psbt-btc');
    expect(await handle.sendBtcEnd('signed-btc')).toBe('txid-btc');
    expect(
      await handle.sendAssetBegin({
        assetId: 'rgb:asset',
        recipientId: 'wvout:recipient',
        amount: 25,
        witnessAmountSat: 1_000,
        transportEndpoints: ['rpc://proxy:3000/json-rpc'],
        recipientPublicKey: null,
        recipientExpirationTimestamp: null,
        recipientEncryption: null,
        donation: false,
        feeRateSatPerVb: 3,
        minConfirmations: 1,
        expirationTimestamp: 1_700_000_600,
      }),
    ).toBe('psbt-asset');
    expect(await handle.sendAssetEnd('signed-asset')).toEqual({
      txid: 'txid-asset',
      batchTransferIdx: 4,
    });
    expect(
      await handle.createUtxosBegin({ upTo: true, num: 3, size: 1_000, feeRateSatPerVb: 2 }),
    ).toBe('psbt-utxos');
    expect(await handle.createUtxosEnd('signed-utxos')).toBe(3);

    expect(calls.map((call) => [call.url.replace(BASE_URL, '/'), call.body])).toEqual([
      ['/wallet/sendbtcbegin', { address: 'bcrt1qdest', amount: 1_000, fee_rate: 2 }],
      ['/wallet/sendbtcend', { signed_psbt: 'signed-btc' }],
      [
        '/wallet/sendbegin',
        {
          recipient_map: {
            'rgb:asset': [
              {
                recipient_id: 'wvout:recipient',
                witness_data: { amount_sat: 1_000, blinding: null },
                assignment: { Fungible: 25 },
                transport_endpoints: ['rpc://proxy:3000/json-rpc'],
              },
            ],
          },
          donation: false,
          fee_rate: 3,
          min_confirmations: 1,
          expiration_timestamp: 1_700_000_600,
        },
      ],
      ['/wallet/sendend', { signed_psbt: 'signed-asset' }],
      ['/wallet/createutxosbegin', { up_to: true, num: 3, size: 1_000, fee_rate: 2 }],
      ['/wallet/createutxosend', { signed_psbt: 'signed-utxos' }],
    ]);
  });

  it('passes the recipient key, expiry and encryption of a proxy protocol 1.0 send', async () => {
    const { handle, calls } = await handleFor(ok({ psbt: 'psbt-asset' }));
    await handle.sendAssetBegin({
      assetId: 'rgb:asset',
      recipientId: 'sb:wvout:recipient',
      amount: 25,
      witnessAmountSat: 1_000,
      transportEndpoints: ['rpcs://proxy.example/json-rpc'],
      recipientPublicKey: 'cd'.repeat(32),
      recipientExpirationTimestamp: 1_793_723_445,
      recipientEncryption: 'optional',
      donation: false,
      feeRateSatPerVb: 2,
      minConfirmations: 1,
      expirationTimestamp: 1_700_000_600,
    });
    const body = calls[0]!.body as { recipient_map: Record<string, unknown[]> };
    expect(body.recipient_map['rgb:asset']).toEqual([
      {
        recipient_id: 'sb:wvout:recipient',
        witness_data: { amount_sat: 1_000, blinding: null },
        assignment: { Fungible: 25 },
        transport_endpoints: ['rpcs://proxy.example/json-rpc'],
        public_key: 'cd'.repeat(32),
        expiration_timestamp: 1_793_723_445,
        // rgb-lib's serde spelling of Encryption::Optional.
        encryption: 'Optional',
      },
    ]);
  });

  it('names a missing recipient key on its own, not as a generic rejection', () => {
    // What rgb-node-api main answers a send without `public_key`.
    const error = serviceError(
      'sendAssetBegin',
      '/wallet/sendbegin',
      400,
      JSON.stringify({
        error: {
          code: 1001,
          status: 'bad_input',
          message: 'Invalid pubkey: missing recipient public key',
          details: { kind: 'InvalidPubkey' },
        },
      }),
    );
    expect(error.clientError).toBe(true);
    const mapped = walletHttpError(error) as HttpError;
    expect(mapped.statusCode).toBe(400);
    expect(mapped.code).toBe('INVALID_RECIPIENT_PUBLIC_KEY');
  });

  it('routes receives by mode and passes the duration through', async () => {
    const receiveData = {
      invoice: 'rgb:~/~/~/bcrt:utxob:abc',
      recipient_id: 'utxob:abc',
      expiration_timestamp: 1_700_003_600,
      batch_transfer_idx: 9,
      public_key: 'ef'.repeat(32),
    };
    const { handle, calls } = await handleFor(ok(receiveData), ok(receiveData));
    const request = {
      assetId: null,
      amount: null,
      durationSeconds: 3_600,
      minConfirmations: 1,
    };
    expect(await handle.receive({ ...request, mode: 'blind' })).toEqual({
      invoice: receiveData.invoice,
      recipientId: 'utxob:abc',
      expirationTimestamp: 1_700_003_600,
      batchTransferIdx: 9,
      publicKey: 'ef'.repeat(32),
    });
    await handle.receive({ ...request, mode: 'witness', assetId: 'rgb:asset', amount: 5 });
    expect(calls.map((call) => [call.url.replace(BASE_URL, '/'), call.body])).toEqual([
      [
        '/wallet/blindreceive',
        // rgb-lib's serde spelling of Assignment::Any: an amount-less invoice.
        { asset_id: null, assignment: 'Any', duration_seconds: 3_600, min_confirmations: 1 },
      ],
      [
        '/wallet/witnessreceive',
        {
          asset_id: 'rgb:asset',
          assignment: { Fungible: 5 },
          duration_seconds: 3_600,
          min_confirmations: 1,
        },
      ],
    ]);
  });

  it('lists transactions from the listtransactions route', async () => {
    const { handle, calls } = await handleFor(
      ok([
        {
          transaction_type: 'Incoming',
          txid: 'aa'.repeat(32),
          received: 50_000_000,
          sent: 0,
          fee: 0,
          confirmation_time: { height: 104, timestamp: 1_700_000_000 },
        },
      ]),
    );
    expect(await handle.listTransactions()).toEqual([
      {
        transactionType: 'Incoming',
        txid: 'aa'.repeat(32),
        receivedSat: 50_000_000,
        sentSat: 0,
        feeSat: 0,
        confirmationTime: { height: 104, timestamp: 1_700_000_000 },
      },
    ]);
    expect(calls.map((call) => [call.url.replace(BASE_URL, '/'), call.body])).toEqual([
      ['/wallet/listtransactions', {}],
    ]);
  });

  it('lists transfers for one asset', async () => {
    const { handle, calls } = await handleFor(ok([]));
    await handle.listTransfers('rgb:asset');
    expect(calls.map((call) => call.body)).toEqual([{ asset_id: 'rgb:asset' }]);
  });

  it('refreshes in one call and drops the wallet from the service on close', async () => {
    const { handle, calls } = await handleFor(ok({}), ok({}));
    await handle.refresh();
    await handle.close();
    await handle.close();
    expect(calls.map((call) => call.url.replace(BASE_URL, '/'))).toEqual([
      '/wallet/refresh',
      '/wallet/drop',
    ]);
    const closed = await failure(handle.getAddress());
    expect(closed.detail).toBe('wallet handle is closed');
  });
});

describe('RgbNodeApiWalletBackend failures', () => {
  it.each([
    'InsufficientBitcoins',
    'InsufficientAllocationSlots',
    'InsufficientAssignments',
    'InsufficientSpendableAssets',
    'InsufficientTotalAssets',
  ])('classifies %s as insufficient funds', async (kind) => {
    const { handle } = await handleFor(rgbError(400, kind, 'not enough'));
    const error = await failure(handle.sendBtcBegin('bcrt1qdest', 1, 1));
    expect(error.insufficientFunds).toBe(true);
    expect(error.clientError).toBe(false);
    expect(error.message).toBe('wallet sendBtcBegin failed');
    expect(error.detail).toBe(`rgb-node-api /wallet/sendbtcbegin -> 400 ${kind}: not enough`);
  });

  it.each([
    'InvalidAddress',
    'InvalidRecipientID',
    'InvalidRecipientNetwork',
    'InvalidRecipientData',
    'AssetNotFound',
    'InvalidTransportEndpoint',
    'RecipientIDDuplicated',
    'InvalidFeeRate',
    'InvalidExpiration',
    // Key material the caller registered: their request, their 400.
    'InvalidBitcoinKeys',
    'InvalidFingerprint',
    'InvalidPubkey',
    'InvalidVanillaKeychain',
  ])('classifies %s as a client error', async (kind) => {
    const { handle } = await handleFor(rgbError(400, kind));
    const error = await failure(handle.sendAssetEnd('signed'));
    expect(error.insufficientFunds).toBe(false);
    expect(error.clientError).toBe(true);
  });

  it.each([
    [500, 'Database'],
    [500, 'Internal'],
    [503, 'FailedBdkSync'],
    // rgb-node-api answers 4xx for these, but on the `complete` path a client
    // error means "never broadcast": only the variant list decides that.
    [409, 'InvalidPsbtOperationStatus'],
  ])('leaves a %i %s unclassified so it surfaces as a server error', async (status, kind) => {
    const { handle } = await handleFor(rgbError(status, kind));
    const error = await failure(handle.sendBtcEnd('signed'));
    expect(error.insufficientFunds).toBe(false);
    expect(error.clientError).toBe(false);
    expect(error.unsupported).toBe(false);
  });

  it('keeps the rgb-lib variant in the detail, where the PSBT-rejection check reads it', async () => {
    const { handle } = await handleFor(rgbError(400, 'FailedBroadcast', 'sendrawtransaction: bad'));
    const error = await failure(handle.sendBtcEnd('signed'));
    expect(error.detail).toMatch(/\bFailedBroadcast\b/);
  });

  it.each([
    // What rgb-node-api's default service answers for an unknown route.
    [
      'an empty not_found envelope',
      '{"error":{"code":1000,"status":"not_found","message":"","details":{}}}',
    ],
    ['a bare 404', ''],
  ])('reports %s as an operation the service does not implement', async (_name, body) => {
    const { handle } = await handleFor({ status: 404, body });
    const error = await failure(
      handle.receive({
        mode: 'witness',
        assetId: null,
        amount: null,
        durationSeconds: 60,
        minConfirmations: 1,
      }),
    );
    expect(error.unsupported).toBe(true);
    expect(error.detail).toBe('rgb-node-api /wallet/witnessreceive -> 404 (no such route)');
    const mapped = walletHttpError(error) as HttpError;
    expect(mapped.statusCode).toBe(501);
    expect(mapped.code).toBe('WALLET_OPERATION_UNSUPPORTED');
  });

  it('treats a 404 naming an rgb-lib variant as not found, not a missing route', () => {
    const error = serviceError(
      'listTransfers',
      '/wallet/listtransfers',
      404,
      JSON.stringify({
        error: {
          code: 1000,
          status: 'not_found',
          message: 'asset',
          details: { kind: 'AssetNotFound' },
        },
      }),
    );
    expect(error.unsupported).toBe(false);
    expect(error.clientError).toBe(true);
  });

  it('blames the gateway, not the caller, when rgb-node-api rejects the request itself', async () => {
    // Malformed JSON or missing headers carry no rgb-lib variant.
    const { handle } = await handleFor({
      status: 422,
      body: JSON.stringify({
        error: { code: 1001, status: 'bad_input', message: 'invalid json format' },
      }),
    });
    const error = await failure(handle.listTransfers('rgb:asset'));
    expect(error.clientError).toBe(false);
    expect(error.detail).toBe(
      'rgb-node-api /wallet/listtransfers -> 422 bad_input: invalid json format',
    );
  });

  it('leaves an unreachable service unclassified (a complete may have broadcast)', async () => {
    const { handle } = await handleFor(new TypeError('fetch failed'));
    const error = await failure(handle.sendAssetEnd('signed'));
    expect(error.clientError).toBe(false);
    expect(error.unsupported).toBe(false);
    expect(error.detail).toBe('rgb-node-api /wallet/sendend unreachable: fetch failed');
  });

  it('aborts a call that outlives the timeout', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const backend = new RgbNodeApiWalletBackend({ baseUrl: BASE_URL, fetchImpl, timeoutMs: 20 });
    const handle = await backend.open({ userId: 'u1', xpubs: XPUBS });
    const error = await failure(handle.refresh());
    expect(error.detail).toBe('rgb-node-api /wallet/refresh timed out after 20ms');
  });

  it('refuses a 2xx body that is not JSON or lacks the expected field', async () => {
    const { handle } = await handleFor({ status: 200, body: '<html>' }, ok({ txid: 'x' }));
    expect((await failure(handle.getAddress())).detail).toContain('non-JSON');
    expect((await failure(handle.sendAssetEnd('signed'))).detail).toContain(
      'unexpected send result shape',
    );
  });
});

describe('mapAssignment', () => {
  it('flattens externally tagged fungible and unit variants', () => {
    expect(mapAssignment({ Fungible: 100 }, 'a')).toEqual({ kind: 'Fungible', amount: 100 });
    expect(mapAssignment('Any', 'a')).toEqual({ kind: 'Any', amount: null });
    expect(mapAssignment('NonFungible', 'a')).toEqual({ kind: 'NonFungible', amount: null });
  });

  it('carries an unknown variant through by name instead of dropping it', () => {
    expect(mapAssignment({ InflationRight: 7 }, 'a')).toEqual({
      kind: 'InflationRight',
      amount: 7,
    });
  });

  it('rejects a payload that is not a single-key tagged object', () => {
    expect(() => mapAssignment({ Fungible: 1, Any: null }, 'a')).toThrow(WalletBackendError);
  });

  it('refuses a fungible amount outside the safe integer range', () => {
    expect(() => mapAssignment({ Fungible: 2 ** 53 }, 'a')).toThrow(
      expect.objectContaining({
        unrepresentable: true,
        detail: expect.stringMatching(/not a safe integer/),
      }),
    );
  });
});

describe('mapAssets', () => {
  it('flattens the per-schema snake_case asset map', () => {
    const assets = mapAssets({
      nia: [
        {
          asset_id: 'rgb:nia',
          ticker: 'NIA',
          name: 'Nia Asset',
          details: null,
          precision: 2,
          issued_supply: 1_000,
          timestamp: 1_700_000_000,
          added_at: 1_700_000_100,
          balance: { settled: 10, future: 12, spendable: 10 },
          media: null,
        },
      ],
      ifa: [
        {
          asset_id: 'rgb:ifa',
          ticker: 'IFA',
          name: 'Ifa Asset',
          details: 'inflatable',
          precision: 0,
          initial_supply: 500,
          max_supply: 900,
          known_circulating_supply: 500,
          timestamp: 1,
          added_at: 2,
          balance: { settled: 5, future: 5, spendable: 5 },
        },
      ],
      uda: null,
      cfa: null,
      bfa: null,
    });
    expect(assets).toEqual([
      {
        assetId: 'rgb:nia',
        schema: 'nia',
        ticker: 'NIA',
        name: 'Nia Asset',
        details: null,
        precision: 2,
        issuedSupply: 1_000,
        timestamp: 1_700_000_000,
        addedAt: 1_700_000_100,
        balance: { settled: 10, future: 12, spendable: 10 },
      },
      {
        assetId: 'rgb:ifa',
        schema: 'ifa',
        ticker: 'IFA',
        name: 'Ifa Asset',
        details: 'inflatable',
        precision: 0,
        // IFA names its genesis amount `initial_supply`.
        issuedSupply: 500,
        timestamp: 1,
        addedAt: 2,
        balance: { settled: 5, future: 5, spendable: 5 },
      },
    ]);
  });

  it('leaves issuance metadata null when the schema has none (UDA)', () => {
    const [asset] = mapAssets({
      uda: [{ asset_id: 'rgb:uda', ticker: 'UDA', name: 'Collectible', precision: 0, balance: {} }],
    });
    expect(asset?.issuedSupply).toBeNull();
    expect(asset?.balance).toEqual({ settled: 0, future: 0, spendable: 0 });
  });

  it('refuses an asset with no name rather than emitting an empty one', () => {
    expect(() => mapAssets({ nia: [{ asset_id: 'rgb:nia', name: '' }] })).toThrow(
      expect.objectContaining({ detail: 'asset rgb:nia (nia) has no name' }),
    );
  });

  it('refuses a balance outside the safe integer range instead of rounding it', () => {
    let thrown: unknown;
    try {
      mapAssets({
        nia: [{ asset_id: 'rgb:nia', name: 'Big', balance: { settled: 2 ** 64, future: 0 } }],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WalletBackendError);
    expect((thrown as WalletBackendError).unrepresentable).toBe(true);
  });
});

describe('mapUnspents', () => {
  it('maps utxos with their rgb allocations', () => {
    expect(
      mapUnspents([
        {
          utxo: {
            outpoint: { txid: 'aa'.repeat(32), vout: 1 },
            btc_amount: 1_000,
            colorable: true,
            exists: true,
            derivation_index: 3,
          },
          rgb_allocations: [{ asset_id: 'rgb:nia', assignment: { Fungible: 40 }, settled: true }],
          pending_blinded: 1,
        },
      ]),
    ).toEqual([
      {
        txid: 'aa'.repeat(32),
        vout: 1,
        amountSat: 1_000,
        colorable: true,
        exists: true,
        pendingBlinded: 1,
        allocations: [
          {
            assetId: 'rgb:nia',
            amount: 40,
            assignment: { kind: 'Fungible', amount: 40 },
            settled: true,
          },
        ],
      },
    ]);
  });

  it('returns an empty list for a non-array payload', () => {
    expect(mapUnspents({})).toEqual([]);
  });
});

describe('mapTransfers', () => {
  it('maps snake_case transfers, preferring the requested assignment amount', () => {
    const [requested, summed] = mapTransfers(
      [
        {
          idx: 1,
          batch_transfer_idx: 2,
          created_at: 10,
          updated_at: 20,
          status: 'WaitingCounterparty',
          requested_assignment: { Fungible: 50 },
          assignments: [],
          kind: 'ReceiveBlind',
          txid: null,
          recipient_id: 'utxob:abc',
          expiration_timestamp: 1_700_003_600,
          transport_endpoints: [],
        },
        {
          idx: 2,
          batch_transfer_idx: 3,
          created_at: 30,
          updated_at: 40,
          status: 'Settled',
          requested_assignment: null,
          assignments: [{ Fungible: 30 }, { Fungible: 12 }, 'Any'],
          kind: 'Send',
          txid: 'bb'.repeat(32),
          recipient_id: null,
          expiration_timestamp: null,
        },
      ],
      'rgb:nia',
    );
    expect(requested).toEqual({
      idx: 1,
      batchTransferIdx: 2,
      assetId: 'rgb:nia',
      amount: 50,
      assignments: [],
      kind: 'ReceiveBlind',
      status: 'WaitingCounterparty',
      txid: null,
      recipientId: 'utxob:abc',
      expiration: 1_700_003_600,
      createdAt: 10,
      updatedAt: 20,
    });
    expect(summed?.amount).toBe(42);
    expect(summed?.assignments).toEqual([
      { kind: 'Fungible', amount: 30 },
      { kind: 'Fungible', amount: 12 },
      { kind: 'Any', amount: null },
    ]);
  });

  it('defaults missing fields instead of throwing on shape drift', () => {
    expect(mapTransfers([{}], null)).toEqual([
      {
        idx: 0,
        batchTransferIdx: null,
        assetId: null,
        amount: null,
        assignments: [],
        kind: 'Unknown',
        status: 'Unknown',
        txid: null,
        recipientId: null,
        expiration: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ]);
  });
});

describe('mapTransactions', () => {
  it('reports an unconfirmed transaction with a null confirmation time', () => {
    expect(
      mapTransactions([
        {
          transaction_type: 'SendBtc',
          txid: 'bb'.repeat(32),
          received: 48_999_000,
          sent: 50_000_000,
          fee: 1_000,
          confirmation_time: null,
        },
      ]),
    ).toEqual([
      {
        transactionType: 'SendBtc',
        txid: 'bb'.repeat(32),
        receivedSat: 48_999_000,
        sentSat: 50_000_000,
        feeSat: 1_000,
        confirmationTime: null,
      },
    ]);
  });

  it('refuses a transaction without a txid', () => {
    expect(() => mapTransactions([{ transaction_type: 'Incoming', received: 1 }])).toThrow(
      expect.objectContaining({ message: 'wallet returned a transaction without a txid' }),
    );
  });

  it('refuses an amount outside the safe integer range instead of rounding it', () => {
    expect(() =>
      mapTransactions([{ transaction_type: 'Incoming', txid: 'aa'.repeat(32), received: 2 ** 64 }]),
    ).toThrow(expect.objectContaining({ unrepresentable: true }));
  });

  it('returns an empty list for a non-array payload', () => {
    expect(mapTransactions({})).toEqual([]);
  });
});
