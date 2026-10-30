/**
 * E2e harness: brings up the repo's regtest stack (bitcoind, electrs, esplora,
 * the RGB proxy and rgb-node-api — see regtest/compose.yaml), prepares a
 * counterparty wallet holding an RGB asset, and starts the gateway in-process
 * on a real HTTP port.
 *
 * The user JOURNEY (flow.test.ts) talks ONLY to the gateway through the client
 * SDK. This harness may drive the counterparty wallet on rgb-node-api and the
 * regtest faucet directly — that models the outside world, not the user.
 *
 * Env knobs (see README): E2E_SKIP_STACK=1 reuses an already-running regtest
 * stack, E2E_STOP_STACK=1 tears the containers down afterwards,
 * E2E_GATEWAY_PORT moves the gateway off 8490, and REGTEST_RGB_NODE_API_PORT /
 * REGTEST_ESPLORA_PORT move the stack's host ports.
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildServer, findKeyMaterialInValue, loadConfig } from '@utexo/lightsdk-gateway';
import { ClientKeys, verifyAndSignPsbt, type OnchainIntent } from '@utexo/lightweight-client-sdk';

const REGTEST_SCRIPT = fileURLToPath(new URL('../../../regtest/regtest.sh', import.meta.url));

export const RGB_NODE_API_URL = `http://127.0.0.1:${process.env['REGTEST_RGB_NODE_API_PORT'] ?? '34000'}`;
export const ESPLORA_URL = `http://127.0.0.1:${process.env['REGTEST_ESPLORA_PORT'] ?? '3002'}`;
/** The RGB proxy as rgb-node-api reaches it on the compose network; invoices carry this. */
export const PROXY_URL = 'rpc://proxy:3000/json-rpc';

export const GATEWAY_PORT = Number(process.env['E2E_GATEWAY_PORT'] ?? '8490');
export const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

export const OPERATOR_TOKEN = 'e2e-operator-token-0123456789abcdef';

const FEE_RATE = 2;
const MAX_FEE_SAT = 5_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function regtest(command: string): string {
  return execSync(`${REGTEST_SCRIPT} ${command}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function mine(blocks: number): void {
  regtest(`mine ${blocks}`);
}

export async function retryUntil<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(intervalMs);
  }
}

/** Every secret that must never appear in a gateway response or log line. */
export interface InvariantRecorder {
  /** Violations found while scanning gateway responses; must stay empty. */
  violations: string[];
  /** Number of gateway responses scanned (sanity: the scan actually ran). */
  scanned: number;
  /** name -> secret scanned against every RESPONSE body. */
  responseForbidden: Map<string, string>;
  /** name -> secret scanned against captured gateway LOGS. */
  logForbidden: Map<string, string>;
  /** Captured gateway log lines. */
  logs: string[];
}

export function makeRecorder(): InvariantRecorder {
  const recorder: InvariantRecorder = {
    violations: [],
    scanned: 0,
    responseForbidden: new Map(),
    logForbidden: new Map(),
    logs: [],
  };
  recorder.responseForbidden.set('operator-token', OPERATOR_TOKEN);
  recorder.logForbidden.set('operator-token', OPERATOR_TOKEN);
  return recorder;
}

/** Register a client-side mnemonic: forbidden in every response and log. */
export function forbidMnemonic(recorder: InvariantRecorder, name: string, mnemonic: string): void {
  recorder.responseForbidden.set(name, mnemonic);
  recorder.logForbidden.set(name, mnemonic);
}

/** User bearer tokens are returned ONCE by createUser but must never be logged. */
export function forbidInLogs(recorder: InvariantRecorder, name: string, secret: string): void {
  recorder.logForbidden.set(name, secret);
}

/**
 * fetch wrapper for ALL journey clients: scans every gateway response for
 * key-material field names (mirrors the I1 schema-scan test at runtime) and
 * for forbidden secret values (I4).
 */
export function makeScanningFetch(recorder: InvariantRecorder): typeof fetch {
  const scanningFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(input as string | URL | Request, init);
    const url = String(input);
    let text = '';
    try {
      text = await response.clone().text();
    } catch {
      return response;
    }
    recorder.scanned += 1;
    for (const [name, secret] of recorder.responseForbidden) {
      if (secret !== '' && text.includes(secret)) {
        recorder.violations.push(`secret "${name}" found in response of ${url}`);
      }
    }
    try {
      const parsed: unknown = JSON.parse(text);
      for (const path of findKeyMaterialInValue(parsed)) {
        recorder.violations.push(`key-material field ${path} in response of ${url}`);
      }
    } catch {
      // non-JSON response: substring scan above is all we can do
    }
    return response;
  }) as typeof fetch;
  return scanningFetch;
}

/**
 * A wallet on rgb-node-api whose keys the HARNESS holds: the outside world the
 * user pays and gets paid by. It signs its own PSBTs with the client SDK's
 * verify-before-sign against the intent it stated itself, so rgb-node-api's
 * counterparty-side PSBTs exercise the same checks the user's do.
 */
export class Counterparty {
  readonly mnemonic: string;
  readonly keys: ClientKeys;

  constructor() {
    const generated = ClientKeys.generate('Regtest');
    this.mnemonic = generated.mnemonic;
    this.keys = generated.keys;
  }

  async call<T = Record<string, unknown>>(route: string, body: object = {}): Promise<T> {
    const xpubs = this.keys.xpubs;
    const response = await fetch(`${RGB_NODE_API_URL}/wallet/${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'xpub-van': xpubs.vanilla,
        'xpub-col': xpubs.colored,
        'master-fingerprint': xpubs.fingerprint,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`rgb-node-api /wallet/${route} -> ${response.status}: ${text}`);
    }
    return JSON.parse(text) as T;
  }

  private async beginSignEnd<T>(op: string, body: object, intent: OnchainIntent): Promise<T> {
    const { psbt } = await this.call<{ psbt: string }>(`${op}begin`, body);
    const { signedPsbt } = verifyAndSignPsbt(this.keys, psbt, {
      intent,
      xpubs: this.keys.xpubs,
      maxFeeSat: MAX_FEE_SAT,
    });
    return this.call<T>(`${op}end`, { signed_psbt: signedPsbt });
  }

  async address(): Promise<string> {
    return (await this.call<{ address: string }>('address')).address;
  }

  async refresh(): Promise<void> {
    await this.call('refresh');
  }

  async assetSettled(assetId: string): Promise<number> {
    return (await this.call<{ settled: number }>('assetbalance', { asset_id: assetId })).settled;
  }

  async createUtxos(num: number, size: number): Promise<void> {
    await this.beginSignEnd(
      'createutxos',
      { up_to: false, num, size, fee_rate: FEE_RATE },
      {
        kind: 'create_utxos',
        feeRateSatPerVb: FEE_RATE,
        recipients: [],
        asset: null,
        utxos: { upTo: false, num, size },
      },
    );
  }

  async sendAsset(assetId: string, recipientId: string, amount: number): Promise<string> {
    const sent = await this.beginSignEnd<{ txid: string }>(
      'send',
      {
        recipient_map: {
          [assetId]: [
            {
              recipient_id: recipientId,
              witness_data: null,
              amount,
              transport_endpoints: [PROXY_URL],
            },
          ],
        },
        donation: false,
        fee_rate: FEE_RATE,
        min_confirmations: 1,
        expiration_timestamp: Math.floor(Date.now() / 1000) + 3600,
      },
      {
        kind: 'send_asset',
        feeRateSatPerVb: FEE_RATE,
        recipients: [],
        asset: {
          assetId,
          amount,
          recipientId,
          witnessAmountSat: null,
          transportEndpoints: [PROXY_URL],
        },
        utxos: null,
      },
    );
    return sent.txid;
  }

  async blindReceive(assetId: string): Promise<string> {
    const receive = await this.call<{ recipient_id: string }>('blindreceive', {
      asset_id: assetId,
      duration_seconds: 3600,
    });
    return receive.recipient_id;
  }
}

/** Fund the counterparty, give it colorable UTXOs and issue the journey's NIA asset. */
async function prepareCounterparty(cp: Counterparty): Promise<string> {
  const address = await cp.address();
  regtest(`sendtoaddress ${address} 0.5`);
  mine(1);
  await retryUntil(
    'counterparty on-chain funds',
    async () => {
      const balance = await cp.call<{ vanilla: { settled: number } }>('btcbalance');
      return balance.vanilla.settled >= 45_000_000 ? true : undefined;
    },
    60_000,
  );
  await cp.createUtxos(4, 32_500);
  mine(1);
  await retryUntil(
    'counterparty colorable utxos',
    async () => {
      await cp.refresh();
      const unspents =
        await cp.call<{ utxo: { colorable: boolean; exists: boolean } }[]>('listunspents');
      return unspents.filter((u) => u.utxo.colorable && u.utxo.exists).length >= 4
        ? true
        : undefined;
    },
    60_000,
  );
  const issued = await cp.call<{ asset_id: string }>('issueassetnia', {
    ticker: 'E2E',
    name: 'E2E Asset',
    precision: 0,
    amounts: [1000],
  });
  return issued.asset_id;
}

export interface Harness {
  cp: Counterparty;
  app: FastifyInstance;
  recorder: InvariantRecorder;
  /** NIA asset issued on the counterparty, ready to be sent to the vault. */
  assetId: string;
  teardown(): Promise<void>;
}

function startStack(): void {
  if (process.env['E2E_SKIP_STACK'] === '1') {
    return;
  }
  regtest('start');
}

async function startGateway(
  recorder: InvariantRecorder,
  tempDirs: string[],
): Promise<FastifyInstance> {
  const dbDir = mkdtempSync(join(tmpdir(), 'utexo-e2e-gw-db-'));
  tempDirs.push(dbDir);
  const config = loadConfig({
    GATEWAY_PORT: String(GATEWAY_PORT),
    RGB_NODE_API_URL,
    ESPLORA_URL,
    RGB_PROXY_URL: PROXY_URL,
    GATEWAY_SQLITE_PATH: join(dbDir, 'gateway.sqlite'),
    GATEWAY_OPERATOR_TOKEN: OPERATOR_TOKEN,
  });
  const app = await buildServer({
    config,
    loggerStream: {
      write(msg: string) {
        recorder.logs.push(msg);
      },
    },
    startWorkers: true,
  });
  await app.listen({ host: '127.0.0.1', port: GATEWAY_PORT });
  return app;
}

export async function setupHarness(): Promise<Harness> {
  startStack();
  const recorder = makeRecorder();

  // Anything already started must be torn down if a later step throws:
  // beforeAll never returns a harness in that case, so the test file's
  // afterAll cannot clean up, and an orphaned gateway holds the fixed port —
  // the next run would then fail on a bind error instead of the real cause.
  const tempDirs: string[] = [];
  let app: FastifyInstance | undefined;
  const cleanup = async (): Promise<void> => {
    await app?.close();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  try {
    const cp = new Counterparty();
    // The counterparty never talks to the gateway; its mnemonic appearing in
    // a gateway response or log would mean something crossed that boundary.
    forbidMnemonic(recorder, 'counterparty-mnemonic', cp.mnemonic);
    const assetId = await prepareCounterparty(cp);

    app = await startGateway(recorder, tempDirs);

    return {
      cp,
      app,
      recorder,
      assetId,
      async teardown() {
        await cleanup();
        if (process.env['E2E_STOP_STACK'] === '1') {
          regtest('stop');
        }
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
