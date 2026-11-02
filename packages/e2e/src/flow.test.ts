/**
 * Scripted user journey over the full stack (regtest + rgb-node-api + gateway).
 * The journey uses ONLY the client SDK against the gateway's real HTTP port —
 * never rgb-node-api directly; the counterparty wallet and the faucet are
 * driven by the harness as "the outside world".
 *
 * Trust invariants are asserted while the journey runs:
 *  - I1: every gateway response is scanned for key-material field names and
 *    for the client mnemonics (scanning fetch installed in every client).
 *  - I3: a second user cannot see the first user's operations, transfers,
 *    unspents or balances.
 *  - I4: the operator token appears in no response and no captured gateway
 *    log line.
 *  - A replayed send-btc completion with the same idempotency key does not
 *    send twice.
 *
 * The send-asset leg is load-bearing beyond the journey itself: it is the only
 * place verifyAndSignPsbt runs against a PSBT rgb-lib actually emitted for a
 * COLORED spend (opret output, colored-account key origins, RGB change).
 *
 * Run with `pnpm e2e` (see packages/e2e/README.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ClientKeys,
  GatewayClient,
  GatewayError,
  generateIdempotencyKey,
  verifyAndSignPsbt,
  type PreparedOp,
} from '@utexo/lightweight-client-sdk';
import {
  forbidInLogs,
  forbidMnemonic,
  GATEWAY_URL,
  makeScanningFetch,
  mine,
  OPERATOR_TOKEN,
  regtest,
  retryUntil,
  setupHarness,
  sleep,
  type Harness,
} from './setup.js';

const VAULT_FUND_SAT = 100_000_000; // 1 BTC from the faucet
const UTXO_NUM = 5;
const UTXO_SIZE_SAT = 5_000;
const RGB_RECEIVE_UNITS = 100;
const RGB_SEND_BACK_UNITS = 40;
const SEND_BTC_SAT = 1_000_000;
const MAX_FEE_SAT = 2_000;
const FEE_RATE = 2;

interface JourneyUser {
  client: GatewayClient;
  keys: ClientKeys;
  userId: string;
  token: string;
}

let harness: Harness;
let userA: JourneyUser;
let userB: JourneyUser;
let vaultAddress: string;
/** One of user A's prepared operations, for the I3 check. */
let userAOpId: string;

/** Sign a prepared op with the journey user's keys — verify-before-sign. */
function sign(user: JourneyUser, prepared: PreparedOp): string {
  const { signedPsbt, verdict } = verifyAndSignPsbt(user.keys, prepared.psbt, {
    intent: prepared.intent,
    xpubs: user.keys.xpubs,
    maxFeeSat: MAX_FEE_SAT,
  });
  expect(verdict.ok).toBe(true);
  return signedPsbt;
}

async function createJourneyUser(name: string): Promise<JourneyUser> {
  const fetchFn = makeScanningFetch(harness.recorder);
  const bootstrap = new GatewayClient({ baseUrl: GATEWAY_URL, fetchFn });
  const created = await bootstrap.createUser(OPERATOR_TOKEN);
  forbidInLogs(harness.recorder, `${name}-token`, created.token);
  const { mnemonic, keys } = ClientKeys.generate('Regtest');
  forbidMnemonic(harness.recorder, `${name}-mnemonic`, mnemonic);
  return {
    client: new GatewayClient({ baseUrl: GATEWAY_URL, token: created.token, fetchFn }),
    keys,
    userId: created.userId,
    token: created.token,
  };
}

describe('lightweight-sdk e2e journey on regtest', () => {
  beforeAll(async () => {
    harness = await setupHarness();
  }, 900_000);

  afterAll(async () => {
    await harness?.teardown();
  }, 60_000);

  it('creates a user, registers client-side xpubs, funds the vault', async () => {
    userA = await createJourneyUser('user-a');
    const xpubs = userA.keys.xpubs;
    const registered = await userA.client.registerXpubs({
      vanilla: xpubs.vanilla,
      colored: xpubs.colored,
      fingerprint: xpubs.fingerprint,
    });
    expect(registered.fingerprint).toBe(xpubs.fingerprint);
    vaultAddress = registered.address;
    // The gateway derived the address from the registered xpubs; the client
    // must re-derive the identical script (watch-only parity).
    expect(vaultAddress).toMatch(/^bcrt1p/);

    regtest(`sendtoaddress ${vaultAddress} 1`);
    mine(1);
    await retryUntil(
      'vault funded',
      async () => {
        await userA.client.sync();
        const balances = await userA.client.getBalances();
        return balances.btc.vanilla.settled >= VAULT_FUND_SAT ? true : undefined;
      },
      90_000,
    );
  }, 180_000);

  it('creates colorable UTXOs via prepare -> verify -> sign -> complete', async () => {
    const prepared = await userA.client.prepareCreateUtxos({
      num: UTXO_NUM,
      size: UTXO_SIZE_SAT,
      feeRateSatPerVb: FEE_RATE,
    });
    expect(prepared.intent.kind).toBe('create_utxos');
    userAOpId = prepared.opId;
    const completed = await userA.client.completeCreateUtxos({
      opId: prepared.opId,
      signedPsbt: sign(userA, prepared),
    });
    expect(completed.utxosCreated).toBe(UTXO_NUM);
    mine(1);
    await retryUntil(
      'colorable utxos settled',
      async () => {
        await userA.client.sync();
        const { unspents } = await userA.client.getUnspents();
        return unspents.filter((u) => u.colorable).length >= UTXO_NUM ? true : undefined;
      },
      90_000,
    );
  }, 180_000);

  it('receives an RGB asset into the vault from the counterparty', async () => {
    const receive = await userA.client.receive({ mode: 'blind' });
    expect(receive.invoice.length).toBeGreaterThan(20);
    // RGB proxy protocol 1.0: the gateway hands out the key the sender
    // encrypts the consignment to, and the invoice carries the same one.
    expect(receive.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(receive.invoice).toContain(`pk=${receive.publicKey}`);
    expect(receive.expirationTimestamp).not.toBeNull();

    await harness.cp.sendAsset(
      harness.assetId,
      {
        recipientId: receive.recipientId,
        publicKey: receive.publicKey!,
        expirationTimestamp: receive.expirationTimestamp!,
      },
      RGB_RECEIVE_UNITS,
    );

    // Settlement dance (donation=false): receiver ACKs via refresh, the
    // sender's refresh broadcasts, one confirmation settles both sides.
    await retryUntil(
      'RGB asset settled in the vault',
      async () => {
        await userA.client.sync();
        await harness.cp.refresh();
        const balances = await userA.client.getBalances();
        const asset = balances.assets.find((entry) => entry.assetId === harness.assetId);
        if (asset !== undefined && asset.balance.settled >= RGB_RECEIVE_UNITS) return true;
        mine(1);
        return undefined;
      },
      180_000,
      2000,
    );

    const { transfers } = await userA.client.getTransfers(harness.assetId);
    expect(transfers.some((t) => t.status === 'Settled' && t.amount === RGB_RECEIVE_UNITS)).toBe(
      true,
    );
  }, 240_000);

  it('sends the RGB asset back on chain via prepare -> verify -> sign -> complete', async () => {
    // The only path that runs verify-before-sign against a real rgb-lib
    // COLORED spend: the opret commitment output, the colored-account key
    // origins and the RGB change output all have to satisfy verifyPsbt, which
    // hand-built fixtures cannot prove.
    const recipient = await harness.cp.blindReceive(harness.assetId);

    const prepared = await userA.client.prepareSendAsset(
      {
        assetId: harness.assetId,
        amount: RGB_SEND_BACK_UNITS,
        recipientId: recipient.recipientId,
        recipientPublicKey: recipient.publicKey,
        recipientExpirationTimestamp: recipient.expirationTimestamp,
        feeRateSatPerVb: FEE_RATE,
      },
      generateIdempotencyKey(),
    );
    expect(prepared.intent.kind).toBe('send_asset');
    expect(prepared.intent.asset?.amount).toBe(RGB_SEND_BACK_UNITS);

    const completed = await userA.client.completeSendAsset(
      { opId: prepared.opId, signedPsbt: sign(userA, prepared) },
      generateIdempotencyKey(),
    );
    expect(completed.txid).toMatch(/^[0-9a-f]{64}$/);

    await retryUntil(
      'RGB send settled on both sides',
      async () => {
        await userA.client.sync();
        await harness.cp.refresh();
        const balances = await userA.client.getBalances();
        const asset = balances.assets.find((entry) => entry.assetId === harness.assetId);
        if (
          asset !== undefined &&
          asset.balance.settled === RGB_RECEIVE_UNITS - RGB_SEND_BACK_UNITS &&
          (await harness.cp.assetSettled(harness.assetId)) ===
            1000 - RGB_RECEIVE_UNITS + RGB_SEND_BACK_UNITS
        ) {
          return true;
        }
        mine(1);
        return undefined;
      },
      180_000,
      2000,
    );
  }, 240_000);

  it('sends BTC on chain to the counterparty; a replayed complete does not send twice', async () => {
    const cpAddress = await harness.cp.address();
    const cpBefore = (await harness.cp.call<{ vanilla: { settled: number } }>('btcbalance')).vanilla
      .settled;

    const prepared = await userA.client.prepareSendBtc(
      { address: cpAddress, amountSat: SEND_BTC_SAT, feeRateSatPerVb: FEE_RATE },
      generateIdempotencyKey(),
    );
    expect(prepared.intent.kind).toBe('send_btc');

    const completeKey = generateIdempotencyKey();
    const params = { opId: prepared.opId, signedPsbt: sign(userA, prepared) };
    const completed = await userA.client.completeSendBtc(params, completeKey);
    expect(completed.txid).toMatch(/^[0-9a-f]{64}$/);
    // Same key, same body: the cached response comes back and nothing is
    // broadcast again.
    const replayed = await userA.client.completeSendBtc(params, completeKey);
    expect(replayed.txid).toBe(completed.txid);
    expect((await userA.client.getOnchainOperation(prepared.opId)).state).toBe('completed');

    mine(1);
    await retryUntil(
      'BTC arrived at the counterparty',
      async () => {
        const balance = await harness.cp.call<{ vanilla: { settled: number } }>('btcbalance');
        return balance.vanilla.settled >= cpBefore + SEND_BTC_SAT ? true : undefined;
      },
      90_000,
    );
    const cpAfter = (await harness.cp.call<{ vanilla: { settled: number } }>('btcbalance')).vanilla
      .settled;
    expect(cpAfter).toBe(cpBefore + SEND_BTC_SAT);

    // The vault reports the send exactly once, under its txid.
    const { transactions } = await userA.client.getTransactions(completed.txid);
    expect(transactions).toEqual([
      expect.objectContaining({ transactionType: 'SendBtc', txid: completed.txid }),
    ]);
  }, 180_000);

  it('scopes user A resources away from user B (I3)', async () => {
    userB = await createJourneyUser('user-b');

    // A's prepared operation is indistinguishable from a missing one.
    const foreignOp = await userB.client.getOnchainOperation(userAOpId).catch((e: unknown) => e);
    expect(foreignOp).toBeInstanceOf(GatewayError);
    expect((foreignOp as GatewayError).status).toBe(404);

    // B's own vault is empty: A's unspents and assets are simply not there.
    const xpubs = userB.keys.xpubs;
    await userB.client.registerXpubs({
      vanilla: xpubs.vanilla,
      colored: xpubs.colored,
      fingerprint: xpubs.fingerprint,
    });
    expect((await userB.client.getUnspents()).unspents).toEqual([]);
    const balances = await userB.client.getBalances();
    expect(balances.btc.vanilla.settled).toBe(0);
    expect(balances.assets).toEqual([]);

    // Nobody else can claim A's master fingerprint either: rgb-node-api keys
    // wallets by fingerprint and would serve A's wallet for it.
    const userC = await createJourneyUser('user-c');
    const stolen = await userC.client
      .registerXpubs({ ...userA.keys.xpubs })
      .catch((e: unknown) => e);
    expect(stolen).toBeInstanceOf(GatewayError);
    expect((stolen as GatewayError).status).toBe(409);
    expect((stolen as GatewayError).code).toBe('FINGERPRINT_IN_USE');

    expect((await userB.client.getTransfers()).transfers).toEqual([]);
  }, 120_000);

  it('never leaked key material or credentials (I1/I4)', async () => {
    // Let in-flight worker log lines land before scanning.
    await sleep(1500);
    expect(harness.recorder.scanned).toBeGreaterThan(20);
    expect(harness.recorder.violations).toEqual([]);
    for (const [name, secret] of harness.recorder.logForbidden) {
      const hit = harness.recorder.logs.find((line) => line.includes(secret));
      expect(hit, `secret "${name}" leaked into gateway logs`).toBeUndefined();
    }
  }, 30_000);
});
