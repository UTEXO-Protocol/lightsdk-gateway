/**
 * On-chain prepare→sign→complete flows against the repo's regtest stack
 * (bitcoind, electrs, RGB proxy and rgb-node-api). Run with:
 *
 *   ./regtest/regtest.sh start            # from the repository root
 *   WALLET_REGTEST=1 pnpm --filter @utexo/lightsdk-gateway test onchain-integration
 *
 * The gateway user is a watch-only wallet (fixture mnemonic #1 signs client-
 * side via @scure); the counterparty is a second wallet on the same
 * rgb-node-api whose keys the test holds and signs with directly (test-only —
 * mnemonics are never a gateway input).
 *
 * Needs a freshly reset chain. When combined with wallet-integration (same
 * fixture account), run that suite FIRST: this one creates colorable UTXOs,
 * which would break its INSUFFICIENT_FUNDS assertion.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  masterFromMnemonic,
  regtestXpubsFromMnemonic,
  signPsbtWithMaster,
} from './fixture-signer.js';
import { createTestUser, testServer, type TestUser } from './helpers.js';
import { Counterparty, PROXY_URL, REGTEST_CONFIG, regtest, retryUntil } from './regtest.js';

// TEST fixture only (same as wallet-integration): client-side signer material.
const FIXTURE_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const master = masterFromMnemonic(FIXTURE_MNEMONIC);

interface Balance {
  settled: number;
}

describe.runIf(process.env['WALLET_REGTEST'] === '1')('on-chain flows on regtest', () => {
  let app: FastifyInstance;
  let user: TestUser;
  const cp = new Counterparty();
  let cpAddress: string;
  let assetId: string;

  async function cpVanillaSettled(): Promise<number> {
    const balance = await cp.call<{ vanilla: Balance }>('btcbalance');
    return balance.vanilla.settled;
  }

  beforeAll(async () => {
    app = await testServer({ configOverrides: REGTEST_CONFIG });
    user = await createTestUser(app);
    const registered = await app.inject({
      method: 'POST',
      url: '/v1/wallet/xpubs',
      headers: authed(),
      payload: regtestXpubsFromMnemonic(FIXTURE_MNEMONIC),
    });
    expect(registered.statusCode).toBe(201);
    const address = (registered.json() as { address: string }).address;

    // Faucet-fund the user's vault and the counterparty, and wait for both
    // wallets to see it.
    cpAddress = (await cp.call<{ address: string }>('address')).address;
    regtest(`sendtoaddress ${address} 1`);
    regtest(`sendtoaddress ${cpAddress} 1`);
    regtest('mine 1');
    await retryUntil(async () => {
      await gateway('POST', '/v1/wallet/sync');
      const balances = (await gateway('GET', '/v1/wallet/balances')) as {
        btc: { vanilla: Balance };
      };
      return balances.btc.vanilla.settled >= 100_000_000 ? true : undefined;
    }, 60_000);
    await retryUntil(
      async () => ((await cpVanillaSettled()) >= 100_000_000 ? true : undefined),
      60_000,
    );
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  function authed() {
    return { authorization: `Bearer ${user.token}` };
  }

  let keyCounter = 0;
  async function gateway(method: 'GET' | 'POST', url: string, payload?: object): Promise<unknown> {
    keyCounter += 1;
    const response = await app.inject({
      method,
      url,
      headers: { ...authed(), 'idempotency-key': `it-${Date.now()}-${keyCounter}` },
      ...(payload !== undefined ? { payload } : {}),
    });
    if (response.statusCode >= 400) {
      throw new Error(`${method} ${url} -> ${response.statusCode} ${response.body}`);
    }
    return response.json();
  }

  it('send-btc: prepare, reject unsigned, sign client-side, complete, funds arrive', async () => {
    const before = await cpVanillaSettled();
    const prepared = (await gateway('POST', '/v1/onchain/send-btc/prepare', {
      address: cpAddress,
      amountSat: 1_000_000,
      feeRateSatPerVb: 2,
    })) as { opId: string; psbt: string; intent: { recipients: { scriptHex: string }[] } };
    expect(prepared.psbt.length).toBeGreaterThan(100);
    expect(prepared.intent.recipients[0]!.scriptHex).toMatch(/^5120[0-9a-f]{64}$/);

    // Unsigned completion must fail via rgb-lib's own finalize error, not a 500.
    const unsigned = await app.inject({
      method: 'POST',
      url: '/v1/onchain/send-btc/complete',
      headers: { ...authed(), 'idempotency-key': `it-tamper-${Date.now()}` },
      payload: { opId: prepared.opId, signedPsbt: prepared.psbt },
    });
    expect(unsigned.statusCode).toBe(400);
    expect((unsigned.json() as { error: { code: string } }).error.code).toBe('PSBT_REJECTED');

    const signedPsbt = signPsbtWithMaster(master, prepared.psbt);
    const completed = (await gateway('POST', '/v1/onchain/send-btc/complete', {
      opId: prepared.opId,
      signedPsbt,
    })) as { txid: string };
    expect(completed.txid).toMatch(/^[0-9a-f]{64}$/);

    regtest('mine 1');
    await retryUntil(
      async () => ((await cpVanillaSettled()) >= before + 1_000_000 ? true : undefined),
      60_000,
    );

    // The user's wallet reports the send under its txid, confirmed by now.
    const { transactions } = (await gateway(
      'GET',
      `/v1/wallet/transactions?txid=${completed.txid}`,
    )) as {
      transactions: {
        transactionType: string;
        sentSat: number;
        feeSat: number;
        confirmationTime: { height: number } | null;
      }[];
    };
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({ transactionType: 'SendBtc' });
    expect(transactions[0]!.feeSat).toBeGreaterThan(0);
    expect(transactions[0]!.sentSat).toBeGreaterThan(1_000_000);
    expect(transactions[0]!.confirmationTime).not.toBeNull();
  }, 120_000);

  it('create-utxos: prepare, sign client-side, complete; colorable utxos appear', async () => {
    const prepared = (await gateway('POST', '/v1/onchain/create-utxos/prepare', {
      num: 5,
      size: 5000,
    })) as { opId: string; psbt: string };
    const signedPsbt = signPsbtWithMaster(master, prepared.psbt);
    const completed = (await gateway('POST', '/v1/onchain/create-utxos/complete', {
      opId: prepared.opId,
      signedPsbt,
    })) as { txid: string | null; utxosCreated: number };
    expect(completed.utxosCreated).toBe(5);
    expect(completed.txid).toMatch(/^[0-9a-f]{64}$/);

    regtest('mine 1');
    await retryUntil(async () => {
      await gateway('POST', '/v1/wallet/sync');
      const { unspents } = (await gateway('GET', '/v1/wallet/unspents')) as {
        unspents: { colorable: boolean }[];
      };
      return unspents.filter((u) => u.colorable).length >= 5 ? true : undefined;
    }, 60_000);
  }, 120_000);

  it('receives a real RGB asset from the counterparty into the vault', async () => {
    // Counterparty side: colorable utxos (signed by the test) + NIA issuance.
    await cp.beginSignEnd('createutxos', { up_to: false, num: 5, size: 5000, fee_rate: 2 });
    regtest('mine 1');
    await retryUntil(async () => {
      await cp.call('refresh');
      const unspents =
        await cp.call<{ utxo: { colorable: boolean; exists: boolean } }[]>('listunspents');
      return unspents.filter((u) => u.utxo.colorable && u.utxo.exists).length >= 5
        ? true
        : undefined;
    }, 60_000);
    const issued = await cp.call<{ asset_id: string }>('issueassetnia', {
      amounts: [1000],
      ticker: 'ITEST',
      name: 'Integration Test',
      precision: 0,
    });
    assetId = issued.asset_id;
    expect(assetId.length).toBeGreaterThan(10);

    const receive = (await gateway('POST', '/v1/wallet/receive', { mode: 'blind' })) as {
      recipientId: string;
      publicKey: string;
      expirationTimestamp: number;
    };
    // RGB proxy protocol 1.0: the consignment is encrypted to the receiver's key.
    expect(receive.publicKey).toMatch(/^[0-9a-f]{64}$/);
    const sent = await cp.beginSignEnd<{ txid: string }>('send', {
      recipient_map: {
        [assetId]: [
          {
            recipient_id: receive.recipientId,
            witness_data: null,
            amount: 100,
            transport_endpoints: [PROXY_URL],
            public_key: receive.publicKey,
            expiration_timestamp: receive.expirationTimestamp,
          },
        ],
      },
      donation: false,
      fee_rate: 2,
      min_confirmations: 1,
      expiration_timestamp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(sent.txid).toMatch(/^[0-9a-f]{64}$/);

    // Settlement dance (donation=false): receiver ACKs via refresh, sender's
    // refresh then broadcasts, and a confirmation settles both sides — so
    // sync/refresh/mine run inside the poll loop.
    await retryUntil(async () => {
      await gateway('POST', '/v1/wallet/sync');
      await cp.call('refresh');
      const balances = (await gateway('GET', '/v1/wallet/balances')) as {
        assets: { assetId: string; balance: Balance }[];
      };
      const asset = balances.assets.find((entry) => entry.assetId === assetId);
      if (asset !== undefined && asset.balance.settled >= 100) return true;
      regtest('mine 1');
      return undefined;
    }, 90_000);
  }, 180_000);

  it('send-asset: prepare, sign client-side (colored keychain), complete, settle', async () => {
    const back = await cp.call<{
      recipient_id: string;
      public_key: string;
      expiration_timestamp: number;
    }>('blindreceive', {
      asset_id: assetId,
      duration_seconds: 3600,
    });

    const prepared = (await gateway('POST', '/v1/onchain/send-asset/prepare', {
      assetId,
      amount: 40,
      recipientId: back.recipient_id,
      transportEndpoints: [PROXY_URL],
      recipientPublicKey: back.public_key,
      recipientExpirationTimestamp: back.expiration_timestamp,
    })) as {
      opId: string;
      psbt: string;
      intent: { asset: { amount: number; recipientPublicKey: string | null } };
    };
    expect(prepared.intent.asset.amount).toBe(40);
    expect(prepared.intent.asset.recipientPublicKey).toBe(back.public_key);

    const signedPsbt = signPsbtWithMaster(master, prepared.psbt);
    const completed = (await gateway('POST', '/v1/onchain/send-asset/complete', {
      opId: prepared.opId,
      signedPsbt,
    })) as { txid: string };
    expect(completed.txid).toMatch(/^[0-9a-f]{64}$/);

    // Ownership recorded for I3 scoping.
    const owned = app.db
      .prepare('SELECT user_id, state FROM resource_map WHERE kind = ? AND resource_id = ?')
      .get('asset_transfer', completed.txid) as { user_id: string; state: string };
    expect(owned).toEqual({ user_id: user.userId, state: 'sent' });

    // Same ACK dance in reverse: cp ACKs, the user's refresh broadcasts.
    await retryUntil(async () => {
      await cp.call('refresh');
      await gateway('POST', '/v1/wallet/sync');
      // 1000 issued, 100 sent to the vault, 40 back.
      const balance = await cp.call<Balance>('assetbalance', { asset_id: assetId });
      if (balance.settled >= 940) return true;
      regtest('mine 1');
      return undefined;
    }, 90_000);
  }, 180_000);
});
