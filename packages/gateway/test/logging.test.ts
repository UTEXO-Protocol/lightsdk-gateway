import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WalletBackendError } from '../src/wallets/backend.js';
import { OPERATOR_TOKEN, createTestUser, testServer } from './helpers.js';
import { MockWalletBackend } from './wallet-mocks.js';

const XPUBS = {
  vanilla:
    'tpubDDfvzhdVV4unsoKt5aE6dcsNsfeWbTgmLZPi8LQDYU2xixrYemMfWJ3BaVneH3u7DBQePdTwhpybaKRU95pi6PMUtLPBJLVQRpzEnjfjZzX',
  colored:
    'tpubDCtpoJs6YJcjLnr9gq6jYriYNMuWEu8mSDvEQU5st3ZkJbFqqzwpHUiPvxqD2366ciFAfpehk1k2d7Tyk7AJEr8uZva7KfnX4RpsiVSoEcZ',
  fingerprint: '73c5da0a',
};

let app: FastifyInstance;

afterEach(async () => {
  await app.close();
});

describe('invariant I4: credentials never reach the logs', () => {
  it('user tokens and the operator token are absent from log output', async () => {
    const chunks: string[] = [];
    app = await testServer({
      loggerStream: { write: (msg: string) => void chunks.push(msg) },
    });
    const user = await createTestUser(app);
    await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${user.token}` },
    });
    // Error paths log more; make sure they do not leak headers either.
    await app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: { 'x-operator-token': 'wrong-operator-token-123' },
    });
    const logs = chunks.join('');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(user.token);
    expect(logs).not.toContain(OPERATOR_TOKEN);
    expect(logs).not.toContain('wrong-operator-token-123');
    // The user id is fine to log; the token hash is not stored in logs either.
    const row = app.db.prepare('SELECT token_hash FROM users WHERE id = ?').get(user.userId) as {
      token_hash: string;
    };
    expect(logs).not.toContain(row.token_hash);
  });
});

describe('failed money-moving calls leave an operator-readable record', () => {
  it('logs the wallet-service cause behind an opaque client error', async () => {
    const chunks: string[] = [];
    const backend = new MockWalletBackend();
    app = await testServer({
      walletBackend: backend,
      loggerStream: { write: (msg: string) => void chunks.push(msg) },
    });
    const user = await createTestUser(app);
    const headers = { authorization: `Bearer ${user.token}` };
    await app.inject({ method: 'POST', url: '/v1/wallet/xpubs', headers, payload: XPUBS });
    const handle = backend.handleFor(user.userId);
    if (handle === undefined) throw new Error('no handle');
    // An rgb-node-api without the route answers a bare 404.
    handle.failWith = new WalletBackendError(
      'wallet sendBtcBegin failed',
      'rgb-node-api /wallet/sendbtcbegin -> 404 (no such route)',
      false,
      false,
      false,
      true,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/onchain/send-btc/prepare',
      headers: { ...headers, 'idempotency-key': 'p-1' },
      payload: {
        address: 'bcrt1p8wpt9v4frpf3tkn0srd97pksgsxc5hs52lafxwru9kgeephvs7rqjeprhg',
        amountSat: 1000,
      },
    });
    // The client learns nothing about the wallet service...
    expect(response.statusCode).toBe(501);
    expect(response.json().error.code).toBe('WALLET_OPERATION_UNSUPPORTED');
    expect(response.body).not.toContain('/wallet/sendbtcbegin');
    // ...but the operator can see which route the deployment is missing.
    const logs = chunks.join('');
    expect(logs).toContain('rgb-node-api /wallet/sendbtcbegin -> 404 (no such route)');
    expect(logs).toContain('WALLET_OPERATION_UNSUPPORTED');
    expect(logs).not.toContain(user.token);
  });
});
