import type { FastifyInstance } from 'fastify';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { p2tr } from '@scure/btc-signer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WalletBackendError } from '../src/wallets/backend.js';
import { createTestUser, testServer, type TestUser } from './helpers.js';
import { EMPTY_BALANCE, MockWalletBackend, type MockWalletHandle } from './wallet-mocks.js';

// Real regtest account xpubs (deterministic fixture).
const XPUBS = {
  vanilla:
    'tpubDDfvzhdVV4unsoKt5aE6dcsNsfeWbTgmLZPi8LQDYU2xixrYemMfWJ3BaVneH3u7DBQePdTwhpybaKRU95pi6PMUtLPBJLVQRpzEnjfjZzX',
  colored:
    'tpubDCtpoJs6YJcjLnr9gq6jYriYNMuWEu8mSDvEQU5st3ZkJbFqqzwpHUiPvxqD2366ciFAfpehk1k2d7Tyk7AJEr8uZva7KfnX4RpsiVSoEcZ',
  fingerprint: '73c5da0a',
};

/**
 * Re-derive the fixture wallet's vanilla addresses the way a client would, so
 * the attribution the route reports is checked against an independent
 * derivation rather than against the gateway's own helper.
 */
function deriveVanilla(index: number): { address: string; scriptHex: string } {
  const account = HDKey.fromExtendedKey(XPUBS.vanilla, {
    private: 0x04358394,
    public: 0x043587cf,
  });
  const key = account.deriveChild(0).deriveChild(index);
  const payment = p2tr(key.publicKey!.slice(1), undefined, {
    bech32: 'bcrt',
    pubKeyHash: 0x6f,
    scriptHash: 0xc4,
    wif: 0xef,
  });
  return { address: payment.address as string, scriptHex: hex.encode(payment.script) };
}

describe('wallet routes', () => {
  let app: FastifyInstance;
  let backend: MockWalletBackend;
  let user: TestUser;

  beforeEach(async () => {
    backend = new MockWalletBackend();
    app = await testServer({ walletBackend: backend });
    user = await createTestUser(app);
  });

  afterEach(async () => {
    await app.close();
  });

  function authed(token: string = user.token) {
    return { authorization: `Bearer ${token}` };
  }

  async function register(token: string = user.token) {
    return app.inject({
      method: 'POST',
      url: '/v1/wallet/xpubs',
      headers: authed(token),
      payload: XPUBS,
    });
  }

  describe('xpub registration', () => {
    it('registers xpubs and returns the first address', async () => {
      const response = await register();
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        fingerprint: XPUBS.fingerprint,
        address: `addr-${user.userId}`,
      });
      expect(backend.openCalls[0]?.xpubs).toEqual(XPUBS);
    });

    it('is idempotent for identical re-registration', async () => {
      await register();
      const again = await register();
      expect(again.statusCode).toBe(201);
      expect(again.json().fingerprint).toBe(XPUBS.fingerprint);
    });

    it('rejects re-registration with a different fingerprint', async () => {
      await register();
      const response = await app.inject({
        method: 'POST',
        url: '/v1/wallet/xpubs',
        headers: authed(),
        payload: { ...XPUBS, fingerprint: 'deadbeef' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('XPUBS_MISMATCH');
    });

    it('rejects re-registration with different xpubs even under the same fingerprint', async () => {
      await register();
      const response = await app.inject({
        method: 'POST',
        url: '/v1/wallet/xpubs',
        headers: authed(),
        payload: { ...XPUBS, vanilla: XPUBS.colored },
      });
      expect(response.statusCode).toBe(409);
    });

    it('rejects malformed fingerprints and xpubs at the schema layer', async () => {
      const bad = await app.inject({
        method: 'POST',
        url: '/v1/wallet/xpubs',
        headers: authed(),
        payload: { ...XPUBS, fingerprint: 'nothex!!' },
      });
      expect(bad.statusCode).toBe(400);
      const short = await app.inject({
        method: 'POST',
        url: '/v1/wallet/xpubs',
        headers: authed(),
        payload: { ...XPUBS, vanilla: 'tooshort' },
      });
      expect(short.statusCode).toBe(400);
    });

    it('maps a REJECTED xpub to 400 INVALID_XPUBS and persists nothing', async () => {
      backend.openError = new WalletBackendError(
        'wallet construction failed',
        'RgbLib(InvalidBitcoinKeys)',
        false,
        true,
      );
      const response = await register();
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_XPUBS');

      backend.openError = undefined;
      const retry = await register();
      expect(retry.statusCode).toBe(201);
    });

    it('does NOT blame the xpubs for a deployment failure, and logs the cause', async () => {
      // An unreachable rgb-node-api or indexer also fails the smoke call. Answering 400 INVALID_XPUBS sent an operator hunting for a
      // client bug — and, because the central handler logs a 400 only when it
      // carries a cause, left the most common bring-up failure with no trace at
      // all. Both halves are asserted here.
      const lines: string[] = [];
      const logged = await testServer({
        walletBackend: backend,
        loggerStream: { write: (msg) => lines.push(msg) },
      });
      const loggedUser = await createTestUser(logged);
      backend.openError = new WalletBackendError(
        'wallet construction failed',
        'rgb-node-api /wallet/address unreachable: connect ECONNREFUSED 127.0.0.1:34000',
      );
      const response = await logged.inject({
        method: 'POST',
        url: '/v1/wallet/xpubs',
        headers: { authorization: `Bearer ${loggedUser.token}` },
        payload: XPUBS,
      });
      expect(response.statusCode).toBe(500);
      expect(response.json().error.code).toBe('INTERNAL');
      // Opaque to the client (I4) but present in the log for the operator.
      expect(response.body).not.toContain('rgb-node-api');
      expect(lines.join('\n')).toContain('ECONNREFUSED');
      backend.openError = undefined;
      await logged.close();
    });

    it('records the cause of a rejected xpub so a 400 is still diagnosable', async () => {
      const lines: string[] = [];
      const logged = await testServer({
        walletBackend: backend,
        loggerStream: { write: (msg) => lines.push(msg) },
      });
      const loggedUser = await createTestUser(logged);
      backend.openError = new WalletBackendError(
        'wallet construction failed',
        'RgbLib(InvalidFingerprint)',
        false,
        true,
      );
      const response = await logged.inject({
        method: 'POST',
        url: '/v1/wallet/xpubs',
        headers: { authorization: `Bearer ${loggedUser.token}` },
        payload: XPUBS,
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('RgbLib');
      expect(lines.join('\n')).toContain('InvalidFingerprint');
      backend.openError = undefined;
      await logged.close();
    });

    it('releases the claim and evicts the wallet when the smoke call fails', async () => {
      // The pool keys handles by userId alone, so a handle cached for xpubs
      // that are not registered would serve addresses derived from the WRONG
      // key on a retry with different xpubs — funds sent to an address the
      // registered wallet never watches. Closing it also unloads the wallet
      // from rgb-node-api, which keys loaded wallets by fingerprint.
      const otherXpubs = {
        vanilla:
          'tpubDCtpoJs6YJcjLnr9gq6jYriYNMuWEu8mSDvEQU5st3ZkJbFqqzwpHUiPvxqD2366ciFAfpehk1k2d7Tyk7AJEr8uZva7KfnX4RpsiVSoEcZ',
        colored:
          'tpubDDfvzhdVV4unsoKt5aE6dcsNsfeWbTgmLZPi8LQDYU2xixrYemMfWJ3BaVneH3u7DBQePdTwhpybaKRU95pi6PMUtLPBJLVQRpzEnjfjZzX',
        fingerprint: '73c5da0a',
      };
      // The handle opens (rgb-node-api loads lazily) but its first call fails.
      const open = backend.open.bind(backend);
      backend.open = async (identity) => {
        const handle = (await open(identity)) as MockWalletHandle;
        handle.failWith = new WalletBackendError(
          'wallet getAddress failed',
          'rgb-node-api /wallet/address timed out after 60000ms',
        );
        return handle;
      };
      const failed = await register();
      expect(failed.statusCode).toBe(500);
      expect(app.walletPool.openCount()).toBe(0);
      expect(app.db.prepare('SELECT 1 FROM user_xpubs').all()).toHaveLength(0);
      await new Promise((resolve) => setImmediate(resolve));
      expect(backend.handleFor(user.userId)?.closed).toBe(true);

      // Register DIFFERENT xpubs: the address must come from a wallet reopened
      // with those xpubs, not from the cached handle.
      backend.open = open;
      const retry = await app.inject({
        method: 'POST',
        url: '/v1/wallet/xpubs',
        headers: authed(),
        payload: otherXpubs,
      });
      expect(retry.statusCode).toBe(201);
      expect(backend.openCalls).toHaveLength(2);
      expect(backend.openCalls[1]?.xpubs).toEqual(otherXpubs);
    });

    it("refuses another user's master fingerprint before touching the wallet service", async () => {
      // rgb-node-api serves every request naming a loaded fingerprint from that
      // one wallet, so the smoke call itself would answer from the first
      // user's wallet (I3). Same xpubs or different, the second claim fails.
      expect((await register()).statusCode).toBe(201);
      const other = await createTestUser(app);
      for (const payload of [XPUBS, { ...XPUBS, vanilla: XPUBS.colored, colored: XPUBS.vanilla }]) {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/wallet/xpubs',
          headers: authed(other.token),
          payload,
        });
        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe('FINGERPRINT_IN_USE');
      }
      expect(backend.openCalls.every((call) => call.userId === user.userId)).toBe(true);
      const owners = app.db.prepare('SELECT user_id FROM user_xpubs').all();
      expect(owners).toEqual([{ user_id: user.userId }]);
    });
  });

  describe('wallet reads', () => {
    it('answers 404 WALLET_NOT_REGISTERED before registration', async () => {
      for (const url of [
        '/v1/wallet/address',
        '/v1/wallet/balances',
        '/v1/wallet/unspents',
        '/v1/wallet/transfers',
        '/v1/wallet/transactions',
      ]) {
        const response = await app.inject({ method: 'GET', url, headers: authed() });
        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe('WALLET_NOT_REGISTERED');
      }
    });

    it('requires auth on every wallet route', async () => {
      for (const [method, url] of [
        ['POST', '/v1/wallet/xpubs'],
        ['GET', '/v1/wallet/address'],
        ['GET', '/v1/wallet/balances'],
        ['GET', '/v1/wallet/unspents'],
        ['GET', '/v1/wallet/transfers'],
        ['GET', '/v1/wallet/transactions'],
        ['POST', '/v1/wallet/receive'],
        ['POST', '/v1/wallet/sync'],
      ] as const) {
        const response = await app.inject({ method, url });
        expect(response.statusCode).toBe(401);
      }
    });

    it('returns the address of the registered wallet', async () => {
      await register();
      const response = await app.inject({
        method: 'GET',
        url: '/v1/wallet/address',
        headers: authed(),
      });
      expect(response.statusCode).toBe(200);
      // The mock hands out a synthetic address, so it cannot be attributed to a
      // derivation under the registered xpub: null evidence, not a guess.
      expect(response.json()).toEqual({ address: `addr-${user.userId}`, derivation: null });
    });

    it('attributes a real rgb-lib address to its vanilla derivation', async () => {
      // Derived from the fixture xpub at m/86'/1'/0'/0/0 — the first address
      // rgb-lib reveals on the vanilla keychain for these xpubs.
      const derived = deriveVanilla(0);
      backend.dataFor = () => ({ address: derived.address });
      await register();
      const response = await app.inject({
        method: 'GET',
        url: '/v1/wallet/address',
        headers: authed(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        address: derived.address,
        derivation: {
          account: 'vanilla',
          keychain: 0,
          index: 0,
          derivationPath: "m/86'/1'/0'/0/0",
          scriptHex: derived.scriptHex,
        },
      });
    });

    it('attributes an address past the first index and advances the scan window', async () => {
      const derived = deriveVanilla(7);
      backend.dataFor = () => ({ address: derived.address });
      await register();
      const response = await app.inject({
        method: 'GET',
        url: '/v1/wallet/address',
        headers: authed(),
      });
      expect(response.json().derivation).toMatchObject({
        index: 7,
        derivationPath: "m/86'/1'/0'/0/7",
      });
      // High-water mark persisted, so attribution keeps working as the wallet's
      // revealed index grows instead of falling off a fixed window.
      const row = app.db
        .prepare('SELECT address_index_high_water AS h FROM user_xpubs WHERE user_id = ?')
        .get(user.userId) as { h: number };
      expect(row.h).toBe(7);
    });

    it('reports balances from the user wallet (BTC + per-asset)', async () => {
      backend.dataFor = () => ({
        btcBalance: {
          vanilla: { settled: 5000, future: 5000, spendable: 5000 },
          colored: { settled: 700, future: 700, spendable: 700 },
        },
        assets: [
          {
            assetId: 'rgb:asset-1',
            schema: 'nia',
            ticker: 'TST',
            name: 'Test',
            details: null,
            precision: 0,
            issuedSupply: 1000,
            timestamp: 1_700_000_000,
            addedAt: 1_700_000_100,
            balance: { settled: 100, future: 100, spendable: 100 },
          },
        ],
      });
      await register();
      const response = await app.inject({
        method: 'GET',
        url: '/v1/wallet/balances',
        headers: authed(),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.btc.vanilla.settled).toBe(5000);
      expect(body.assets).toEqual([
        {
          assetId: 'rgb:asset-1',
          schema: 'nia',
          ticker: 'TST',
          name: 'Test',
          details: null,
          precision: 0,
          issuedSupply: 1000,
          timestamp: 1_700_000_000,
          addedAt: 1_700_000_100,
          balance: { settled: 100, future: 100, spendable: 100 },
        },
      ]);
    });

    it('lists unspents', async () => {
      backend.dataFor = () => ({
        unspents: [
          {
            txid: 'ab'.repeat(32),
            vout: 1,
            amountSat: 9999,
            colorable: true,
            exists: true,
            pendingBlinded: 2,
            allocations: [
              {
                assetId: 'rgb:asset-1',
                amount: 42,
                assignment: { kind: 'Fungible', amount: 42 },
                settled: true,
              },
            ],
          },
        ],
      });
      await register();
      const response = await app.inject({
        method: 'GET',
        url: '/v1/wallet/unspents',
        headers: authed(),
      });
      expect(response.statusCode).toBe(200);
      // pendingBlinded and the full assignment survive serialization: a client
      // counting free allocation slots needs both.
      expect(response.json().unspents[0]).toEqual({
        txid: 'ab'.repeat(32),
        vout: 1,
        amountSat: 9999,
        colorable: true,
        exists: true,
        pendingBlinded: 2,
        allocations: [
          {
            assetId: 'rgb:asset-1',
            amount: 42,
            assignment: { kind: 'Fungible', amount: 42 },
            settled: true,
          },
        ],
      });
    });

    it('lists on-chain transactions, and filters by txid when asked', async () => {
      const incoming = {
        transactionType: 'Incoming',
        txid: 'aa'.repeat(32),
        receivedSat: 50_000_000,
        sentSat: 0,
        feeSat: 0,
        confirmationTime: { height: 104, timestamp: 1_700_000_000 },
      };
      const pending = {
        transactionType: 'SendBtc',
        txid: 'bb'.repeat(32),
        receivedSat: 48_999_000,
        sentSat: 50_000_000,
        feeSat: 1_000,
        confirmationTime: null,
      };
      backend.dataFor = () => ({ transactions: [incoming, pending] });
      await register();

      const all = await app.inject({
        method: 'GET',
        url: '/v1/wallet/transactions',
        headers: authed(),
      });
      expect(all.statusCode).toBe(200);
      expect(all.json()).toEqual({ transactions: [incoming, pending] });

      const one = await app.inject({
        method: 'GET',
        url: `/v1/wallet/transactions?txid=${pending.txid}`,
        headers: authed(),
      });
      expect(one.json()).toEqual({ transactions: [pending] });

      // An unknown txid is an empty list, not an error.
      const none = await app.inject({
        method: 'GET',
        url: `/v1/wallet/transactions?txid=${'cc'.repeat(32)}`,
        headers: authed(),
      });
      expect(none.statusCode).toBe(200);
      expect(none.json()).toEqual({ transactions: [] });
    });

    it('rejects a malformed txid filter at the schema layer', async () => {
      await register();
      for (const txid of ['abc', 'AA'.repeat(32), 'zz'.repeat(32)]) {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/wallet/transactions?txid=${txid}`,
          headers: authed(),
        });
        expect(response.statusCode).toBe(400);
      }
      expect(backend.handleFor(user.userId)?.operations).not.toContain('listTransactions');
    });

    it('aggregates transfers across assets, and filters by assetId when asked', async () => {
      const transfer = (idx: number, assetId: string | null) => ({
        idx,
        batchTransferIdx: idx + 100,
        assetId,
        amount: 10,
        assignments: [{ kind: 'Fungible', amount: 10 }],
        kind: 'ReceiveBlind',
        status: 'Settled',
        txid: null,
        recipientId: `rcpt-${idx}`,
        expiration: null,
        createdAt: 1,
        updatedAt: 2,
      });
      backend.dataFor = () => ({
        assets: [
          {
            assetId: 'rgb:a1',
            schema: 'nia',
            ticker: null,
            name: 'A1',
            details: null,
            precision: 0,
            issuedSupply: null,
            timestamp: 0,
            addedAt: 0,
            balance: EMPTY_BALANCE,
          },
        ],
        transfersByAsset: {
          'rgb:a1': [transfer(2, 'rgb:a1')],
        },
      });
      await register();

      const all = await app.inject({
        method: 'GET',
        url: '/v1/wallet/transfers',
        headers: authed(),
      });
      expect(all.statusCode).toBe(200);
      expect(all.json().transfers.map((t: { idx: number }) => t.idx)).toEqual([2]);
      // rgb-node-api lists by asset only: no asset-less listing is requested.
      const handle = backend.handleFor(user.userId);
      expect(handle?.operations.filter((op) => op.startsWith('listTransfers:'))).toEqual([
        'listTransfers:rgb:a1',
      ]);

      const filtered = await app.inject({
        method: 'GET',
        url: '/v1/wallet/transfers?assetId=rgb:a1',
        headers: authed(),
      });
      expect(filtered.json().transfers.map((t: { idx: number }) => t.idx)).toEqual([2]);
    });
  });

  describe('receive', () => {
    it('creates a blind receive and records ownership of the recipient id', async () => {
      await register();
      const response = await app.inject({
        method: 'POST',
        url: '/v1/wallet/receive',
        headers: authed(),
        payload: { mode: 'blind', assetId: 'rgb:a1', amount: 5 },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.mode).toBe('blind');
      expect(body.invoice).toContain('mock-invoice');

      const row = app.db
        .prepare('SELECT user_id, state FROM resource_map WHERE kind = ? AND resource_id = ?')
        .get('asset_transfer', body.recipientId) as { user_id: string; state: string };
      expect(row.user_id).toBe(user.userId);
      expect(row.state).toBe('pending');
    });

    it('passes the requested duration and confirmation defaults to the wallet', async () => {
      await register();
      await app.inject({
        method: 'POST',
        url: '/v1/wallet/receive',
        headers: authed(),
        payload: { mode: 'witness', durationSeconds: 600 },
      });
      const handle = backend.handleFor(user.userId);
      expect(handle?.operations).toContain('receive:witness');
      const request = handle?.lastReceiveRequest;
      if (request === undefined) throw new Error('receive request not recorded');
      // rgb-node-api takes a duration and names its own proxy as the
      // transport endpoint, so neither an expiry timestamp nor endpoints travel.
      expect(request).toEqual({
        mode: 'witness',
        assetId: null,
        amount: null,
        durationSeconds: 600,
        minConfirmations: 1,
      });
    });

    it('rejects a fractional receive amount at the schema layer', async () => {
      await register();
      const response = await app.inject({
        method: 'POST',
        url: '/v1/wallet/receive',
        headers: authed(),
        payload: { mode: 'blind', assetId: 'rgb:asset', amount: 1.5 },
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects an unknown mode at the schema layer', async () => {
      await register();
      const response = await app.inject({
        method: 'POST',
        url: '/v1/wallet/receive',
        headers: authed(),
        payload: { mode: 'psychic' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('maps insufficient-funds failures to a clean 400, not a 500', async () => {
      await register();
      const handle = backend.handleFor(user.userId);
      if (handle === undefined) throw new Error('no handle');
      handle.failWith = new WalletBackendError(
        'wallet blindReceive failed',
        'RgbLib(InsufficientBitcoins { needed: 2000, available: 0 })',
        true,
      );
      const response = await app.inject({
        method: 'POST',
        url: '/v1/wallet/receive',
        headers: authed(),
        payload: { mode: 'blind' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INSUFFICIENT_FUNDS');
      // The rgb-lib detail must not leak to the client.
      expect(response.body).not.toContain('RgbLib');
    });
  });

  describe('sync and isolation', () => {
    it('syncs and refreshes the user wallet in one refresh call', async () => {
      await register();
      const response = await app.inject({
        method: 'POST',
        url: '/v1/wallet/sync',
        headers: authed(),
      });
      expect(response.statusCode).toBe(200);
      const handle = backend.handleFor(user.userId);
      expect(handle?.refreshCount).toBe(1);
    });

    it("keeps users isolated: a second user never touches the first user's wallet", async () => {
      await register();
      const other = await createTestUser(app);
      const response = await app.inject({
        method: 'GET',
        url: '/v1/wallet/address',
        headers: authed(other.token),
      });
      expect(response.statusCode).toBe(404);
      expect(backend.openCalls.every((call) => call.userId === user.userId)).toBe(true);
    });
  });
});
