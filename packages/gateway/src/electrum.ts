/**
 * Minimal Electrum protocol client for the gateway's one direct indexer read,
 * the fee estimate. rgb-node-api's `indexer_address` is an Electrum server, and
 * pointing `ELECTRUM_URL` at the same one keeps a deployment to a single indexer.
 *
 * One short-lived connection per call: estimates are cached for 30s, so a
 * persistent connection, with its reconnect and keep-alive handling, would buy
 * nothing. The protocol is newline-delimited JSON-RPC over TCP or TLS, addressed
 * as `tcp://host:port` or `ssl://host:port` — the URL forms rgb-lib takes.
 */
import { connect as connectTcp, isIP, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';

/** Protocol version the gateway negotiates; every current server speaks it. */
const PROTOCOL_VERSION = '1.4';
const CLIENT_NAME = 'lightsdk-gateway';
const VERSION_ID = 0;
const CALL_ID = 1;
/** Longest reply line accepted. A fee estimate is a few bytes. */
const MAX_LINE_CHARS = 64 * 1024;

export interface ElectrumEndpoint {
  host: string;
  port: number;
  tls: boolean;
}

export class ElectrumTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`the Electrum server did not answer within ${timeoutMs}ms`);
    this.name = 'ElectrumTimeoutError';
  }
}

/** Parses `tcp://host:port` or `ssl://host:port`; undefined for anything else. */
export function parseElectrumUrl(value: string): ElectrumEndpoint | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'tcp:' && url.protocol !== 'ssl:') return undefined;
  const port = Number(url.port);
  if (url.hostname === '' || !Number.isInteger(port) || port < 1) return undefined;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return undefined;
  }
  if (url.pathname !== '' && url.pathname !== '/') return undefined;
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port,
    tls: url.protocol === 'ssl:',
  };
}

/**
 * Sends one request and resolves with its `result`. A JSON-RPC error, a refused
 * or closed connection, or an unreadable reply rejects with an Error; no answer
 * within `timeoutMs` rejects with ElectrumTimeoutError.
 */
export function electrumCall(
  endpoint: ElectrumEndpoint,
  method: string,
  params: unknown[],
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket: Socket = endpoint.tls
      ? connectTls({
          host: endpoint.host,
          port: endpoint.port,
          ...(isIP(endpoint.host) === 0 ? { servername: endpoint.host } : {}),
        })
      : connectTcp({ host: endpoint.host, port: endpoint.port });
    let buffered = '';
    let settled = false;
    const finish = (error: Error | undefined, result?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error !== undefined) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new ElectrumTimeoutError(timeoutMs)), timeoutMs);

    socket.setEncoding('utf8');
    socket.on('error', (error) => finish(error));
    socket.on('close', () =>
      finish(new Error('the Electrum server closed the connection before answering')),
    );
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const outcome = readReply(buffered.slice(0, newline), method);
        if (outcome !== undefined) {
          finish(outcome.error, outcome.result);
          return;
        }
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
      if (buffered.length > MAX_LINE_CHARS) {
        finish(new Error('the Electrum server sent a reply over the size limit'));
      }
    });

    // Some servers refuse every other method until the version is negotiated.
    socket.write(
      `${request(VERSION_ID, 'server.version', [CLIENT_NAME, PROTOCOL_VERSION])}\n` +
        `${request(CALL_ID, method, params)}\n`,
    );
  });
}

function request(id: number, method: string, params: unknown[]): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

/**
 * The outcome a reply line settles the call with, or undefined for a line that
 * does not: the version answer, a notification, a blank line.
 */
function readReply(
  line: string,
  method: string,
): { error: Error | undefined; result?: unknown } | undefined {
  if (line.trim() === '') return undefined;
  let reply: unknown;
  try {
    reply = JSON.parse(line);
  } catch {
    return { error: new Error('the Electrum server sent an unreadable reply') };
  }
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) {
    return { error: new Error('the Electrum server sent an unreadable reply') };
  }
  const { id, error, result } = reply as { id?: unknown; error?: unknown; result?: unknown };
  const failed = error !== undefined && error !== null;
  if (id === VERSION_ID) {
    return failed
      ? { error: new Error(`server.version was rejected: ${JSON.stringify(error)}`) }
      : undefined;
  }
  if (id !== CALL_ID) return undefined;
  if (failed) return { error: new Error(`${method} failed: ${JSON.stringify(error)}`) };
  return { error: undefined, result };
}
