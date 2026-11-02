/**
 * Typed gateway configuration loaded from environment variables.
 *
 * The operator token is a credential: it must never be logged or echoed in any
 * response (invariant I4).
 */
import { parseElectrumUrl } from './electrum.js';

export interface GatewayConfig {
  /** Interface the gateway listens on. Defaults to loopback. */
  host: string;
  port: number;
  /**
   * Base URL of the rgb-node-api service hosting the watch-only wallets. It has
   * no authentication of its own, so it must be reachable only from the gateway.
   */
  walletServiceUrl: string;
  /** Per-call timeout for rgb-node-api requests (ms). */
  walletServiceTimeoutMs: number;
  /**
   * Electrum server the fee estimate is read from (`tcp://host:port` or
   * `ssl://host:port`): the same indexer as rgb-node-api's `indexer_address`.
   * Null when unset: the gateway still starts, warns, and the fee-estimate
   * route answers FEE_ESTIMATE_UNAVAILABLE. Nothing else reads it.
   */
  electrumUrl: string | null;
  /**
   * Default RGB consignment proxy for sends. Receive invoices carry
   * rgb-node-api's own `proxy_address` instead, so keep the two identical.
   */
  rgbProxyUrl: string;
  /** Path to the gateway SQLite database (':memory:' for tests). */
  sqlitePath: string;
  /**
   * rgb-lib BitcoinNetwork of the user wallets: must match rgb-node-api's
   * `network`. The gateway uses it to decode recipient addresses and to
   * attribute deposit addresses to their derivation path.
   */
  bitcoinNetwork: 'Mainnet' | 'Testnet' | 'Testnet4' | 'Signet' | 'SignetCustom' | 'Regtest';
  /**
   * LRU capacity of the open-wallet pool. An evicted wallet is also dropped
   * from rgb-node-api's memory, so this bounds what that service keeps loaded.
   */
  walletMaxOpen: number;
  /** Seconds an unsigned prepare-step PSBT stays completable before expiring. */
  onchainOpTtlSeconds: number;
  /** Guards the bootstrap-only POST /v1/users route. */
  operatorToken: string;
  /**
   * RGB consignment-proxy endpoints users may name in send-asset requests
   * (SSRF guard — the wallet service dials these). Always includes rgbProxyUrl.
   */
  rgbTransportAllowlist: string[];
  /** Poll interval of the ambiguous-completion worker (ms). */
  completionsIntervalMs: number;
  /**
   * Attempts the completions worker makes at finishing one ambiguous operation
   * before leaving it to an operator.
   */
  completionsMaxAttempts: number;
  /** Max downstream operations running at once across all users. */
  queueGlobalConcurrency: number;
  /** Max queued+running operations per user before 429. */
  queuePerUserDepth: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function requireString(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(`missing required environment variable ${name}`);
  }
  return value.trim();
}

function requireUrl(env: Record<string, string | undefined>, name: string): string {
  const value = requireString(env, name);
  try {
    new URL(value);
  } catch {
    throw new ConfigError(`environment variable ${name} is not a valid URL: ${value}`);
  }
  return value;
}

/**
 * Unset (or blank) disables fee estimates rather than failing startup: they
 * are the only thing the URL serves. A value that is set but malformed still
 * fails, so a typo cannot silently turn them off.
 */
function optionalElectrumUrl(env: Record<string, string | undefined>, name: string): string | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const value = raw.trim();
  if (parseElectrumUrl(value) === undefined) {
    throw new ConfigError(
      `environment variable ${name} must be tcp://host:port or ssl://host:port, got: ${value}`,
    );
  }
  return value;
}

function intWithDefault(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`environment variable ${name} must be a positive integer, got: ${raw}`);
  }
  return value;
}

/**
 * Every rgb-lib `BitcoinNetwork` variant (src/utils.rs). `Signet` means Bitcoin's
 * DEFAULT signet; a signet with its own challenge is `SignetCustom` and is a
 * different chain to RGB, even though every signet shares the same genesis block
 * hash. Telling the gateway `Signet` for a custom signet fails at first wallet
 * use with an `InvalidIndexer`/"resolver is for another chain-network pair" that
 * names neither the network nor the fix, so the option has to exist here.
 */
const BITCOIN_NETWORKS = [
  'Mainnet',
  'Testnet',
  'Testnet4',
  'Signet',
  'SignetCustom',
  'Regtest',
] as const;

function bitcoinNetwork(
  env: Record<string, string | undefined>,
): (typeof BITCOIN_NETWORKS)[number] {
  const raw = env['GATEWAY_BITCOIN_NETWORK']?.trim();
  if (raw === undefined || raw === '') return 'Regtest';
  const match = BITCOIN_NETWORKS.find((name) => name.toLowerCase() === raw.toLowerCase());
  if (match === undefined) {
    throw new ConfigError(
      `GATEWAY_BITCOIN_NETWORK must be one of ${BITCOIN_NETWORKS.join(', ')}, got: ${raw}`,
    );
  }
  return match;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
  const operatorToken = requireString(env, 'GATEWAY_OPERATOR_TOKEN');
  if (operatorToken.length < 16) {
    throw new ConfigError('GATEWAY_OPERATOR_TOKEN must be at least 16 characters');
  }
  const rgbProxyUrl = requireUrl(env, 'RGB_PROXY_URL');
  const extraTransports = (env['GATEWAY_RGB_TRANSPORT_ALLOWLIST'] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return {
    host: env['GATEWAY_HOST']?.trim() || '127.0.0.1',
    port: intWithDefault(env, 'GATEWAY_PORT', 8480),
    walletServiceUrl: requireUrl(env, 'RGB_NODE_API_URL'),
    walletServiceTimeoutMs: intWithDefault(env, 'GATEWAY_WALLET_SERVICE_TIMEOUT_MS', 60_000),
    electrumUrl: optionalElectrumUrl(env, 'ELECTRUM_URL'),
    rgbProxyUrl,
    sqlitePath: requireString(env, 'GATEWAY_SQLITE_PATH'),
    bitcoinNetwork: bitcoinNetwork(env),
    walletMaxOpen: intWithDefault(env, 'GATEWAY_WALLET_MAX_OPEN', 32),
    onchainOpTtlSeconds: intWithDefault(env, 'GATEWAY_ONCHAIN_OP_TTL_SECONDS', 600),
    operatorToken,
    rgbTransportAllowlist: [rgbProxyUrl, ...extraTransports.filter((e) => e !== rgbProxyUrl)],
    completionsIntervalMs: intWithDefault(env, 'GATEWAY_COMPLETIONS_INTERVAL_MS', 30_000),
    completionsMaxAttempts: intWithDefault(env, 'GATEWAY_COMPLETIONS_MAX_ATTEMPTS', 5),
    queueGlobalConcurrency: intWithDefault(env, 'GATEWAY_QUEUE_GLOBAL_CONCURRENCY', 4),
    queuePerUserDepth: intWithDefault(env, 'GATEWAY_QUEUE_PER_USER_DEPTH', 16),
  };
}
