/**
 * Fee-rate estimates from the shared Electrum indexer.
 *
 * Clients cannot reach the indexer (it sits behind the gateway with rgb-node-api
 * and the RGB proxy), so without this route a client has no fee source at all
 * and either hardcodes a rate or sends none and accepts the gateway's 2 sat/vB
 * default.
 *
 * The indexer answers `blockchain.estimatefee` for the exact target asked for,
 * in BTC/kvB, or -1 when its node has no estimate. Every gateway fee input is
 * an integer 1..1000, so the answer is rounded UP, never down: a client that
 * signs at exactly this rate must not end up below the estimate it asked for.
 */
import {
  electrumCall,
  ElectrumTimeoutError,
  parseElectrumUrl,
  type ElectrumEndpoint,
} from './electrum.js';
import { HttpError } from './errors.js';

/** Widest target bitcoind estimates; also the ceiling this route accepts. */
export const MAX_TARGET_BLOCKS = 1008;
/** Matches the `feeRateSatPerVb` bounds on every fee-taking route. */
export const MIN_FEE_RATE_SAT_PER_VB = 1;
export const MAX_FEE_RATE_SAT_PER_VB = 1000;
/** Estimates move slowly; a short cache keeps a burst of clients off the indexer. */
export const CACHE_TTL_MS = 30_000;
const INDEXER_TIMEOUT_MS = 10_000;
const SAT_PER_BTC = 100_000_000;

export interface FeeEstimate {
  /** Confirmation target the answer is for (as requested). */
  blocks: number;
  /** Whole sat/vB, rounded up and clamped into the accepted range. */
  feeRateSatPerVb: number;
  /** Target the indexer was asked for: always `blocks`. */
  sourceBlocks: number;
}

export interface FeeEstimatorOptions {
  /** `tcp://host:port` or `ssl://host:port`; null when no indexer is configured. */
  electrumUrl: string | null;
  timeoutMs?: number;
  now?: () => number;
}

export class FeeEstimator {
  /** Null: no indexer configured, so every estimate is unavailable. */
  private readonly endpoint: ElectrumEndpoint | null;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  /** Sat/kvB per target. Targets are bounded by MAX_TARGET_BLOCKS, so is this. */
  private readonly cache = new Map<number, { at: number; satPerKvb: number }>();

  constructor(options: FeeEstimatorOptions) {
    if (options.electrumUrl === null) {
      this.endpoint = null;
    } else {
      const endpoint = parseElectrumUrl(options.electrumUrl);
      if (endpoint === undefined) {
        throw new Error('not an Electrum URL (tcp://host:port or ssl://host:port)');
      }
      this.endpoint = endpoint;
    }
    this.timeoutMs = options.timeoutMs ?? INDEXER_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** Whether an indexer is configured; without one every estimate is unavailable. */
  get configured(): boolean {
    return this.endpoint !== null;
  }

  async estimate(blocks: number): Promise<FeeEstimate> {
    if (this.endpoint === null) {
      // The code clients already fall back on (the gateway's default fee
      // rate); the reason stays in the startup warning, not the response.
      throw new HttpError(502, 'FEE_ESTIMATE_UNAVAILABLE', 'no fee estimate is available');
    }
    const satPerKvb = await this.load(this.endpoint, blocks);
    const clamped = Math.min(
      MAX_FEE_RATE_SAT_PER_VB,
      Math.max(MIN_FEE_RATE_SAT_PER_VB, Math.ceil(satPerKvb / 1000)),
    );
    return { blocks, feeRateSatPerVb: clamped, sourceBlocks: blocks };
  }

  private async load(endpoint: ElectrumEndpoint, blocks: number): Promise<number> {
    const cached = this.cache.get(blocks);
    if (cached !== undefined && this.now() - cached.at < CACHE_TTL_MS) return cached.satPerKvb;
    const btcPerKvb = await this.fetchEstimate(endpoint, blocks);
    // bitcoind reports whole satoshis per kvB as a BTC amount. Going through
    // that integer keeps float error out of the rounding: 0.00006 BTC/kvB is
    // 6 sat/vB, where 0.00006 * 1e5 would round up to 7.
    const satPerKvb = Math.round(btcPerKvb * SAT_PER_BTC);
    this.cache.set(blocks, { at: this.now(), satPerKvb });
    return satPerKvb;
  }

  /**
   * Bounded `blockchain.estimatefee`: without a deadline a stalled indexer
   * holds the caller's request open with it.
   */
  private async fetchEstimate(endpoint: ElectrumEndpoint, blocks: number): Promise<number> {
    let result: unknown;
    try {
      result = await electrumCall(endpoint, 'blockchain.estimatefee', [blocks], this.timeoutMs);
    } catch (error) {
      if (error instanceof ElectrumTimeoutError) {
        throw new HttpError(
          504,
          'UPSTREAM_TIMEOUT',
          'the indexer did not answer the fee-estimate request in time',
          { cause: error },
        );
      }
      throw new HttpError(502, 'FEE_ESTIMATE_UNAVAILABLE', 'the fee-estimate request failed', {
        cause: error,
      });
    }
    if (typeof result !== 'number' || !Number.isFinite(result)) {
      throw new HttpError(
        502,
        'FEE_ESTIMATE_UNAVAILABLE',
        'the indexer returned an unreadable fee estimate',
      );
    }
    // -1: the indexer's node has not yet seen enough blocks and transactions.
    if (result <= 0) {
      throw new HttpError(
        502,
        'FEE_ESTIMATE_UNAVAILABLE',
        'the indexer has no fee estimate for this target',
      );
    }
    return result;
  }
}
