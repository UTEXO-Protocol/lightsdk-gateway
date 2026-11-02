/**
 * Fee-estimate route and estimator.
 *
 * Clients cannot reach the indexer — it sits behind the gateway with rgb-node-api
 * and the RGB proxy — so without this route a client either hardcodes a fee rate or
 * sends none and takes the gateway's 2 sat/vB default. The estimator talks to a real
 * Electrum server stub on loopback, so the protocol framing is exercised too. The
 * rounding is deliberate and tested here: up to a whole sat/vB, never below the
 * estimate the caller asked for.
 */
import { createServer, type AddressInfo, type Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CACHE_TTL_MS, FeeEstimator } from '../src/fees.js';
import { createTestUser, testServer, type TestUser } from './helpers.js';

interface ElectrumRequest {
  id: unknown;
  method: string;
  params: unknown[];
}

/** The raw reply to one request (newline included), or undefined to send nothing. */
type Responder = (request: ElectrumRequest, socket: Socket) => string | undefined;

interface ElectrumStub {
  url: string;
  /** Every request received, in order, `server.version` included. */
  requests: ElectrumRequest[];
  close(): Promise<void>;
}

function reply(id: unknown, body: { result?: unknown; error?: unknown }): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`;
}

/** An Electrum server that answers `server.version` and hands the rest to `respond`. */
async function electrumStub(respond: Responder): Promise<ElectrumStub> {
  const requests: ElectrumRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffered = '';
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const request = JSON.parse(buffered.slice(0, newline)) as ElectrumRequest;
        buffered = buffered.slice(newline + 1);
        requests.push(request);
        const answer =
          request.method === 'server.version'
            ? reply(request.id, { result: ['stub', '1.4'] })
            : respond(request, socket);
        if (answer !== undefined && !socket.destroyed) socket.write(answer);
        newline = buffered.indexOf('\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `tcp://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Answers `blockchain.estimatefee` from target → BTC/kvB; -1 (no estimate) otherwise. */
function rates(table: Record<number, number>): Responder {
  return (request) => reply(request.id, { result: table[request.params[0] as number] ?? -1 });
}

function estimateCalls(stub: ElectrumStub): unknown[][] {
  return stub.requests.filter((r) => r.method === 'blockchain.estimatefee').map((r) => r.params);
}

describe('FeeEstimator', () => {
  const stubs: ElectrumStub[] = [];

  async function indexer(respond: Responder): Promise<ElectrumStub> {
    const stub = await electrumStub(respond);
    stubs.push(stub);
    return stub;
  }

  afterEach(async () => {
    await Promise.all(stubs.splice(0).map((stub) => stub.close()));
  });

  it('without an indexer reports every estimate unavailable, never a made-up rate', async () => {
    const estimator = new FeeEstimator({ electrumUrl: null });
    expect(estimator.configured).toBe(false);
    await expect(estimator.estimate(6)).rejects.toMatchObject({
      statusCode: 502,
      code: 'FEE_ESTIMATE_UNAVAILABLE',
    });
  });

  it('rounds a fractional rate UP to a whole sat/vB', async () => {
    const stub = await indexer(rates({ 6: 0.0000542 }));
    const estimator = new FeeEstimator({ electrumUrl: stub.url });
    // 5.42 -> 6, not 5: a client signing at exactly this rate must not land
    // below the estimate it asked for.
    expect(await estimator.estimate(6)).toEqual({
      blocks: 6,
      feeRateSatPerVb: 6,
      sourceBlocks: 6,
    });
  });

  it('does not round a whole rate up past itself', async () => {
    // 0.00006 * 1e5 is 6.000000000000001 in floating point; the answer must
    // still be 6, not 7.
    const stub = await indexer(rates({ 6: 0.00006 }));
    const estimator = new FeeEstimator({ electrumUrl: stub.url });
    expect((await estimator.estimate(6)).feeRateSatPerVb).toBe(6);
  });

  it('negotiates the protocol version, then asks for exactly the requested target', async () => {
    const stub = await indexer(rates({ 5: 0.00012 }));
    const estimator = new FeeEstimator({ electrumUrl: stub.url });
    expect(await estimator.estimate(5)).toEqual({
      blocks: 5,
      feeRateSatPerVb: 12,
      sourceBlocks: 5,
    });
    expect(stub.requests.map((r) => [r.method, r.params])).toEqual([
      ['server.version', ['lightsdk-gateway', '1.4']],
      ['blockchain.estimatefee', [5]],
    ]);
  });

  it('clamps into the range every fee-taking route accepts', async () => {
    const stub = await indexer(rates({ 1: 0.040005, 1008: 0.000002 }));
    const estimator = new FeeEstimator({ electrumUrl: stub.url });
    expect((await estimator.estimate(1)).feeRateSatPerVb).toBe(1000);
    // 0.2 sat/vB rounds up to 1, which is also the floor — a 0 would be
    // rejected by every route this value is meant to be passed to.
    expect((await estimator.estimate(1008)).feeRateSatPerVb).toBe(1);
  });

  it('caches each target for the TTL so a burst of clients is one indexer call', async () => {
    const stub = await indexer(rates({ 1: 0.0002461, 6: 0.0000542 }));
    let now = 1_000_000;
    const estimator = new FeeEstimator({ electrumUrl: stub.url, now: () => now });
    await estimator.estimate(6);
    await estimator.estimate(6);
    await estimator.estimate(1);
    expect(estimateCalls(stub)).toEqual([[6], [1]]);
    now += CACHE_TTL_MS;
    await estimator.estimate(6);
    expect(estimateCalls(stub)).toEqual([[6], [1], [6]]);
  });

  it('reports an indexer failure as 502, not as a made-up rate', async () => {
    const responders: Responder[] = [
      rates({}), // -1: the node has no estimate yet
      (request) => reply(request.id, { result: 0 }),
      (request) => reply(request.id, { result: 'not a number' }),
      (request) => reply(request.id, { error: { code: -32603, message: 'daemon error' } }),
      () => 'not json\n',
      (_request, socket) => {
        socket.end();
        return undefined;
      },
      () => 'x'.repeat(70 * 1024),
    ];
    for (const respond of responders) {
      const stub = await indexer(respond);
      const estimator = new FeeEstimator({ electrumUrl: stub.url });
      await expect(estimator.estimate(6)).rejects.toMatchObject({
        statusCode: 502,
        code: 'FEE_ESTIMATE_UNAVAILABLE',
      });
    }
  });

  it('reports an unreachable indexer as 502', async () => {
    const stub = await indexer(rates({ 6: 0.00006 }));
    await stub.close();
    const estimator = new FeeEstimator({ electrumUrl: stub.url });
    await expect(estimator.estimate(6)).rejects.toMatchObject({
      statusCode: 502,
      code: 'FEE_ESTIMATE_UNAVAILABLE',
    });
  });

  it('does not cache a failure', async () => {
    let attempt = 0;
    const stub = await indexer((request) => {
      attempt += 1;
      return reply(request.id, { result: attempt === 1 ? -1 : 0.00006 });
    });
    const estimator = new FeeEstimator({ electrumUrl: stub.url });
    await expect(estimator.estimate(6)).rejects.toMatchObject({ statusCode: 502 });
    expect((await estimator.estimate(6)).feeRateSatPerVb).toBe(6);
  });

  it('times out rather than holding the caller open on a stalled indexer', async () => {
    const stub = await indexer(() => undefined);
    const estimator = new FeeEstimator({ electrumUrl: stub.url, timeoutMs: 50 });
    await expect(estimator.estimate(6)).rejects.toMatchObject({
      statusCode: 504,
      code: 'UPSTREAM_TIMEOUT',
    });
  });
});

describe('GET /v1/onchain/fee-estimate', () => {
  let stub: ElectrumStub;
  let app: FastifyInstance;
  let user: TestUser;

  beforeEach(async () => {
    stub = await electrumStub(rates({ 1: 0.0002461, 6: 0.0000542 }));
    app = await testServer({ configOverrides: { electrumUrl: stub.url } });
    user = await createTestUser(app);
  });

  afterEach(async () => {
    await app.close();
    await stub.close();
  });

  function authed() {
    return { authorization: `Bearer ${user.token}` };
  }

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/onchain/fee-estimate' });
    expect(response.statusCode).toBe(401);
  });

  it('answers a whole sat/vB a client can pass straight back as feeRateSatPerVb', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/onchain/fee-estimate?blocks=6',
      headers: authed(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ blocks: 6, feeRateSatPerVb: 6, sourceBlocks: 6 });
  });

  it('defaults to a six-block target', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/onchain/fee-estimate',
      headers: authed(),
    });
    expect(response.json()).toEqual({ blocks: 6, feeRateSatPerVb: 6, sourceBlocks: 6 });
  });

  it('rejects a target outside 1..1008', async () => {
    for (const blocks of ['0', '1009', 'six', '1.5']) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/onchain/fee-estimate?blocks=${blocks}`,
        headers: authed(),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('BAD_REQUEST');
    }
  });

  it('needs no wallet registration and no Idempotency-Key', async () => {
    // A client needs a fee rate BEFORE it can prepare anything, so this must not
    // depend on wallet state or on the per-user wallet queue.
    const response = await app.inject({
      method: 'GET',
      url: '/v1/onchain/fee-estimate?blocks=1',
      headers: authed(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().feeRateSatPerVb).toBe(25);
  });

  it('keeps the indexer failure detail server-side', async () => {
    const failingStub = await electrumStub((request) =>
      reply(request.id, { error: { code: -32603, message: 'daemon error: estimatesmartfee' } }),
    );
    const failing = await testServer({ configOverrides: { electrumUrl: failingStub.url } });
    const failingUser = await createTestUser(failing);
    const response = await failing.inject({
      method: 'GET',
      url: '/v1/onchain/fee-estimate',
      headers: { authorization: `Bearer ${failingUser.token}` },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: { code: 'FEE_ESTIMATE_UNAVAILABLE', message: expect.any(String) },
    });
    expect(response.body).not.toContain('daemon error');
    await failing.close();
    await failingStub.close();
  });

  it('without ELECTRUM_URL, starts with a warning and answers FEE_ESTIMATE_UNAVAILABLE', async () => {
    const lines: string[] = [];
    const unconfigured = await testServer({
      configOverrides: { electrumUrl: null },
      loggerStream: { write: (msg) => void lines.push(msg) },
    });
    const warning = lines
      .map((line) => JSON.parse(line) as { level: number; msg: string })
      .find((entry) => entry.msg.startsWith('ELECTRUM_URL is not set'));
    expect(warning?.level).toBe(40);
    const unconfiguredUser = await createTestUser(unconfigured);
    const response = await unconfigured.inject({
      method: 'GET',
      url: '/v1/onchain/fee-estimate',
      headers: { authorization: `Bearer ${unconfiguredUser.token}` },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('FEE_ESTIMATE_UNAVAILABLE');
    // Every other route is unaffected.
    expect((await unconfigured.inject({ method: 'GET', url: '/v1/health' })).statusCode).toBe(200);
    await unconfigured.close();
  });
});

describe('x-request-id', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await testServer();
  });

  afterEach(async () => {
    await app.close();
  });

  it('is present on success and on errors, and is a fresh random id', async () => {
    // Client-facing error bodies carry only code and message (I4); the failure
    // they were mapped from is logged under this id and nowhere else, so without
    // the header a client holding a 502 has nothing an operator can grep for.
    const seen = new Set<string>();
    for (const url of ['/v1/health', '/v1/me']) {
      const response = await app.inject({ method: 'GET', url });
      const id = response.headers['x-request-id'];
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      seen.add(id as string);
    }
    expect(seen.size).toBe(2);
  });

  it('never adopts a caller-supplied id', async () => {
    // Otherwise a client could choose the value that ties together every log
    // line for its own requests.
    const response = await app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { 'request-id': 'attacker-chosen', 'x-request-id': 'attacker-chosen' },
    });
    expect(response.headers['x-request-id']).not.toBe('attacker-chosen');
  });

  it('is set on an idempotency replay too', async () => {
    const user = await createTestUser(app);
    const headers = {
      authorization: `Bearer ${user.token}`,
      'idempotency-key': 'replayed-key',
    };
    const payload = { address: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', amountSat: 1000 };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/onchain/send-btc/prepare',
      headers,
      payload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/onchain/send-btc/prepare',
      headers,
      payload,
    });
    expect(replay.statusCode).toBe(first.statusCode);
    expect(replay.headers['x-idempotent-replay']).toBe('true');
    expect(typeof replay.headers['x-request-id']).toBe('string');
    expect(replay.headers['x-request-id']).not.toBe(first.headers['x-request-id']);
  });
});
