/**
 * Integration test against the repo's regtest stack (bitcoind, electrs,
 * esplora, RGB proxy and rgb-node-api). Run with:
 *
 *   ./regtest/regtest.sh start            # from the repository root
 *   WALLET_REGTEST=1 pnpm --filter @utexo/lightsdk-gateway test wallet-integration
 *
 * Skipped (not failed) when WALLET_REGTEST is unset so the default unit-test
 * command needs no infrastructure.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { regtestXpubsFromMnemonic } from './fixture-signer.js';
import { createTestUser, sleep, testServer, type TestUser } from './helpers.js';
import { REGTEST_CONFIG, regtest } from './regtest.js';

// TEST fixture only: mnemonics are never a gateway input (I1/I2). The client
// SDK must reproduce these xpubs and this first address exactly.
const FIXTURE_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const FIXTURE_FIRST_ADDRESS = 'bcrt1p8wpt9v4frpf3tkn0srd97pksgsxc5hs52lafxwru9kgeephvs7rqjeprhg';

const FUND_BTC = 0.5;
const FUND_SAT = 50_000_000;

describe.runIf(process.env['WALLET_REGTEST'] === '1')('wallet service on regtest', () => {
  let app: FastifyInstance;
  let user: TestUser;
  let fundingTxid: string;

  beforeAll(async () => {
    app = await testServer({ configOverrides: REGTEST_CONFIG });
    user = await createTestUser(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  function authed() {
    return { authorization: `Bearer ${user.token}` };
  }

  it('registers fixture xpubs and derives the expected first address', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/wallet/xpubs',
      headers: authed(),
      payload: regtestXpubsFromMnemonic(FIXTURE_MNEMONIC),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      fingerprint: '73c5da0a',
      address: FIXTURE_FIRST_ADDRESS,
    });
  }, 60_000);

  it('sees funded balance on the watch-only wallet after sync', async () => {
    const before = (
      await app.inject({ method: 'GET', url: '/v1/wallet/balances', headers: authed() })
    ).json() as { btc: { vanilla: { settled: number } } };

    fundingTxid = regtest(`sendtoaddress ${FIXTURE_FIRST_ADDRESS} ${FUND_BTC}`);
    regtest('mine 1');

    let settled = before.btc.vanilla.settled;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(1500);
      const syncResponse = await app.inject({
        method: 'POST',
        url: '/v1/wallet/sync',
        headers: authed(),
      });
      expect(syncResponse.statusCode).toBe(200);
      const balances = (
        await app.inject({ method: 'GET', url: '/v1/wallet/balances', headers: authed() })
      ).json() as { btc: { vanilla: { settled: number } } };
      settled = balances.btc.vanilla.settled;
      if (settled >= before.btc.vanilla.settled + FUND_SAT) break;
    }
    expect(settled).toBeGreaterThanOrEqual(before.btc.vanilla.settled + FUND_SAT);

    const unspents = (
      await app.inject({ method: 'GET', url: '/v1/wallet/unspents', headers: authed() })
    ).json() as { unspents: { txid: string; amountSat: number }[] };
    expect(unspents.unspents.length).toBeGreaterThanOrEqual(1);
    expect(unspents.unspents.some((u) => u.amountSat === FUND_SAT)).toBe(true);
  }, 120_000);

  it('lists the funding as a confirmed incoming transaction, also by txid', async () => {
    const all = await app.inject({
      method: 'GET',
      url: '/v1/wallet/transactions',
      headers: authed(),
    });
    expect(all.statusCode).toBe(200);
    const byTxid = await app.inject({
      method: 'GET',
      url: `/v1/wallet/transactions?txid=${fundingTxid}`,
      headers: authed(),
    });
    expect(byTxid.statusCode).toBe(200);
    const { transactions } = byTxid.json() as {
      transactions: { confirmationTime: { height: number } | null }[];
    };
    expect(transactions).toEqual([
      expect.objectContaining({
        transactionType: 'Incoming',
        txid: fundingTxid,
        receivedSat: FUND_SAT,
        sentSat: 0,
      }),
    ]);
    expect(transactions[0]?.confirmationTime?.height).toBeGreaterThan(0);
    expect((all.json() as { transactions: unknown[] }).transactions).toContainEqual(
      transactions[0],
    );
  }, 60_000);

  it('maps a real rgb-lib insufficient-allocation failure to a clean 400', async () => {
    // No colored utxos were created (that needs client signing), so a receive
    // must fail with the sanitized INSUFFICIENT_FUNDS error, not a 500.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/wallet/receive',
      headers: authed(),
      payload: { mode: 'blind' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INSUFFICIENT_FUNDS');
    expect(response.body).not.toContain('Insufficient');
  }, 60_000);

  it('lists transfers (empty but well-formed) on the fresh wallet', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/wallet/transfers',
      headers: authed(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ transfers: [] });
  }, 60_000);

  it('creates a witness receive without colorable UTXOs', async () => {
    // Unlike a blind receive, the sender's transaction creates the output, so
    // the same fresh wallet that cannot blind-receive can witness-receive.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/wallet/receive',
      headers: authed(),
      payload: { mode: 'witness' },
    });
    expect(response.statusCode).toBe(201);
    const receive = response.json() as { recipientId: string; mode: string };
    expect(receive.mode).toBe('witness');
    expect(receive.recipientId).toMatch(/^bcrt:wvout:/);

    // Created without an asset, so it has none yet: rgb-node-api lists
    // transfers by asset only, and the receive stays out of the list until the
    // sender's transfer gives it one.
    const listed = await app.inject({
      method: 'GET',
      url: '/v1/wallet/transfers',
      headers: authed(),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ transfers: [] });
  }, 60_000);
});
