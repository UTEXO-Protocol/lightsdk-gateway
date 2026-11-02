import type { FastifyInstance } from 'fastify';
import { loadConfig, type GatewayConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import type { WalletBackend } from '../src/wallets/backend.js';

export const OPERATOR_TOKEN = 'test-operator-token-0123456789';

export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    RGB_NODE_API_URL: 'http://127.0.0.1:34000',
    ELECTRUM_URL: 'tcp://127.0.0.1:50001',
    RGB_PROXY_URL: 'rpc://127.0.0.1:3000/json-rpc',
    GATEWAY_SQLITE_PATH: ':memory:',
    GATEWAY_OPERATOR_TOKEN: OPERATOR_TOKEN,
    ...overrides,
  };
}

export function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { ...loadConfig(testEnv()), ...overrides };
}

export interface TestServerOptions {
  configOverrides?: Partial<GatewayConfig>;
  loggerStream?: { write(msg: string): void };
  walletBackend?: WalletBackend;
}

export async function testServer(options: TestServerOptions = {}): Promise<FastifyInstance> {
  const config = testConfig(options.configOverrides ?? {});
  return buildServer({
    config,
    ...(options.loggerStream !== undefined ? { loggerStream: options.loggerStream } : {}),
    ...(options.walletBackend !== undefined ? { walletBackend: options.walletBackend } : {}),
  });
}

export interface TestUser {
  userId: string;
  token: string;
  createdAt: number;
}

export async function createTestUser(app: FastifyInstance): Promise<TestUser> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/users',
    headers: { 'x-operator-token': OPERATOR_TOKEN },
  });
  if (response.statusCode !== 201) {
    throw new Error(`user bootstrap failed: ${response.statusCode} ${response.body}`);
  }
  return response.json() as TestUser;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
