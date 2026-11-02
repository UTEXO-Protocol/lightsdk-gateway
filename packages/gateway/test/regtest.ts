/**
 * Helpers for the WALLET_REGTEST suites: the repo's own regtest stack
 * (regtest/regtest.sh) and a keys-holding counterparty wallet driven directly
 * on rgb-node-api — the outside world, never the gateway user. Mnemonics here
 * are test-only; they are never a gateway input (I1/I2).
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { HDKey } from '@scure/bip32';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type { GatewayConfig } from '../src/config.js';
import type { UserXpubs } from '../src/wallets/backend.js';
import {
  masterFromMnemonic,
  regtestXpubsFromMnemonic,
  signPsbtWithMaster,
} from './fixture-signer.js';
import { sleep } from './helpers.js';

const REGTEST_SCRIPT = fileURLToPath(new URL('../../../regtest/regtest.sh', import.meta.url));

export const RGB_NODE_API_URL = `http://127.0.0.1:${process.env['REGTEST_RGB_NODE_API_PORT'] ?? '34000'}`;
export const ELECTRUM_URL = `tcp://127.0.0.1:${process.env['REGTEST_ELECTRUM_PORT'] ?? '50001'}`;
/** The RGB proxy as rgb-node-api reaches it on the compose network; invoices carry this. */
export const PROXY_URL = 'rpc://proxy:3000/json-rpc';

/** Gateway config overrides pointing at the regtest stack. */
export const REGTEST_CONFIG: Partial<GatewayConfig> = {
  walletServiceUrl: RGB_NODE_API_URL,
  electrumUrl: ELECTRUM_URL,
  rgbProxyUrl: PROXY_URL,
  rgbTransportAllowlist: [PROXY_URL],
};

export function regtest(command: string): string {
  return execSync(`${REGTEST_SCRIPT} ${command}`, { encoding: 'utf8' }).trim();
}

export async function retryUntil<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition not reached before timeout');
    await sleep(intervalMs);
  }
}

/** A wallet on rgb-node-api whose keys the test holds and signs with. */
export class Counterparty {
  readonly xpubs: UserXpubs;
  private readonly master: HDKey;

  constructor(mnemonic: string = generateMnemonic(wordlist)) {
    this.xpubs = regtestXpubsFromMnemonic(mnemonic);
    this.master = masterFromMnemonic(mnemonic);
  }

  async call<T = Record<string, unknown>>(route: string, body: object = {}): Promise<T> {
    const response = await fetch(`${RGB_NODE_API_URL}/wallet/${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'xpub-van': this.xpubs.vanilla,
        'xpub-col': this.xpubs.colored,
        'master-fingerprint': this.xpubs.fingerprint,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`rgb-node-api /wallet/${route} -> ${response.status}: ${text}`);
    }
    return JSON.parse(text) as T;
  }

  /** `<op>begin` → sign client-side → `<op>end`, returning the end response. */
  async beginSignEnd<T = Record<string, unknown>>(op: string, body: object): Promise<T> {
    const { psbt } = await this.call<{ psbt: string }>(`${op}begin`, body);
    return this.call<T>(`${op}end`, { signed_psbt: signPsbtWithMaster(this.master, psbt) });
  }
}
