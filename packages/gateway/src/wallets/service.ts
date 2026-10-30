/**
 * Per-user watch-only wallet service: xpub registration, wallet reads and
 * receive-invoice creation. Balances, unspents and transfers come from the
 * USER's own wallet on rgb-node-api, never from a shared one.
 */
import type { GatewayConfig } from '../config.js';
import type { GatewayDb } from '../db.js';
import { HttpError } from '../errors.js';
import { recordOwnership } from '../scoping.js';
import {
  attributeVanillaAddress,
  ATTRIBUTION_WINDOW,
  type AddressDerivation,
} from './derivation.js';
import {
  WalletBackendError,
  walletHttpError,
  type ReceiveData,
  type UserXpubs,
  type WalletAsset,
  type WalletBtcBalance,
  type WalletHandle,
  type WalletIdentity,
  type WalletTransaction,
  type WalletTransfer,
  type WalletUnspent,
} from './backend.js';
import type { WalletPool } from './pool.js';

export interface WalletBalances {
  btc: WalletBtcBalance;
  assets: WalletAsset[];
}

export interface WalletAddress {
  address: string;
  /**
   * Where the address came from, so a client can re-derive it from its own seed
   * before trusting it as a deposit target. Null when attribution failed (see
   * wallets/derivation.ts) — the address is still rgb-lib's, it just carries no
   * proof, and a client that requires proof should refuse it.
   */
  derivation: AddressDerivation | null;
}

export interface ReceiveParams {
  mode: 'blind' | 'witness';
  assetId?: string | undefined;
  amount?: number | undefined;
  durationSeconds?: number | undefined;
  minConfirmations?: number | undefined;
}

export interface ReceiveResult extends ReceiveData {
  mode: 'blind' | 'witness';
}

const DEFAULT_RECEIVE_DURATION_SECONDS = 86_400;
const DEFAULT_MIN_CONFIRMATIONS = 1;

export class WalletService {
  constructor(
    private readonly db: GatewayDb,
    private readonly pool: WalletPool,
    private readonly config: GatewayConfig,
  ) {}

  /** Registered xpubs for a user, or undefined when none are registered. */
  xpubsOf(userId: string): UserXpubs | undefined {
    const row = this.db
      .prepare('SELECT vanilla, colored, fingerprint FROM user_xpubs WHERE user_id = ?')
      .get(userId) as UserXpubs | undefined;
    return row;
  }

  /** Identity for wallet operations; 404 when no xpubs are registered. */
  identityOf(userId: string): WalletIdentity {
    const xpubs = this.xpubsOf(userId);
    if (xpubs === undefined) {
      throw new HttpError(404, 'WALLET_NOT_REGISTERED', 'no xpubs registered for this user');
    }
    return { userId, xpubs };
  }

  private async run<T>(
    identity: WalletIdentity,
    fn: (wallet: WalletHandle) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.pool.withWallet(identity, fn);
    } catch (error) {
      throw walletHttpError(error);
    }
  }

  /**
   * Register a user's account xpubs. Registration is permanent: re-registering
   * identical values is an idempotent success, anything else is a conflict
   * (a different fingerprint means a different master key — never allowed).
   *
   * A master fingerprint also belongs to at most one user. rgb-node-api keys
   * the wallets it has loaded by fingerprint alone, so a second user with the
   * same fingerprint would be served from the first user's wallet (I3).
   */
  async registerXpubs(
    userId: string,
    xpubs: UserXpubs,
    now: number = Date.now(),
  ): Promise<{ created: boolean; address: string }> {
    const existing = this.xpubsOf(userId);
    if (existing !== undefined) {
      if (
        existing.fingerprint === xpubs.fingerprint &&
        existing.vanilla === xpubs.vanilla &&
        existing.colored === xpubs.colored
      ) {
        const address = await this.run({ userId, xpubs: existing }, (wallet) =>
          wallet.getAddress(),
        );
        return { created: false, address };
      }
      throw new HttpError(
        409,
        'XPUBS_MISMATCH',
        'different xpubs are already registered for this user',
      );
    }
    // Claim the fingerprint BEFORE the smoke call: that call loads the wallet
    // on rgb-node-api, which would answer it from another user's wallet if the
    // fingerprint were already taken. The UNIQUE index makes the claim atomic
    // across concurrent registrations; it is released if the smoke call fails.
    try {
      this.db
        .prepare(
          `INSERT INTO user_xpubs (user_id, vanilla, colored, fingerprint, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(userId, xpubs.vanilla, xpubs.colored, xpubs.fingerprint, now);
    } catch (error) {
      if (error instanceof Error && error.message.includes('user_xpubs.fingerprint')) {
        throw new HttpError(
          409,
          'FINGERPRINT_IN_USE',
          'a wallet with this master fingerprint is already registered',
        );
      }
      throw error;
    }
    // Smoke call so malformed xpubs are rejected up front.
    let address: string;
    try {
      address = await this.pool.withWallet({ userId, xpubs }, (wallet) => wallet.getAddress());
    } catch (error) {
      this.db.prepare('DELETE FROM user_xpubs WHERE user_id = ?').run(userId);
      // The pool cached a handle for xpubs that are no longer registered; a
      // retry with different xpubs must not be served from it, and closing it
      // also unloads the wallet from rgb-node-api.
      this.pool.evict(userId);
      // Only a rejection rgb-lib pinned on the REQUEST may be answered 400.
      // Everything else here — an unreachable rgb-node-api or indexer — is the
      // deployment's fault, not the caller's, and blaming the xpubs sends an
      // operator hunting for a client bug. Either way the cause must travel
      // with the error: the central handler logs a 400 ONLY when it carries
      // one, so dropping it left the single most common bring-up failure with
      // no server-side trace at all.
      if (error instanceof WalletBackendError && error.clientError) {
        throw new HttpError(400, 'INVALID_XPUBS', 'wallet construction from these xpubs failed', {
          cause: error,
        });
      }
      throw walletHttpError(error);
    }
    return { created: true, address };
  }

  /**
   * Next address from the user's vanilla wallet, with the derivation it came
   * from where that can be established.
   *
   * The scan ceiling follows the user's own revealed indices: rgb-lib reveals
   * sequentially, so the address just handed out is at most one past the
   * highest one previously attributed. The high-water mark is persisted so the
   * window travels with the wallet rather than expiring at a fixed index.
   */
  async getAddress(userId: string): Promise<WalletAddress> {
    const identity = this.identityOf(userId);
    const address = await this.run(identity, (wallet) => wallet.getAddress());
    const row = this.db
      .prepare('SELECT address_index_high_water AS highWater FROM user_xpubs WHERE user_id = ?')
      .get(userId) as { highWater: number } | undefined;
    const highWater = row?.highWater ?? 0;
    const derivation = attributeVanillaAddress(
      identity.xpubs.vanilla,
      this.config.bitcoinNetwork,
      address,
      highWater + ATTRIBUTION_WINDOW,
    );
    if (derivation !== null && derivation.index > highWater) {
      this.db
        .prepare('UPDATE user_xpubs SET address_index_high_water = ? WHERE user_id = ?')
        .run(derivation.index, userId);
    }
    return { address, derivation };
  }

  async getBalances(userId: string): Promise<WalletBalances> {
    return this.run(this.identityOf(userId), async (wallet) => ({
      btc: await wallet.getBtcBalance(),
      assets: await wallet.listAssets(),
    }));
  }

  async listUnspents(userId: string): Promise<WalletUnspent[]> {
    return this.run(this.identityOf(userId), (wallet) => wallet.listUnspents());
  }

  /**
   * All transfers across the assets the user's wallet knows; with assetId
   * given, only that asset's transfers.
   *
   * A receive created without an asset id has no asset until the sender's
   * transfer arrives, and rgb-node-api can only list transfers by asset, so
   * such a pending receive is not listed until then. The client already holds
   * its recipient id and batch index from the receive response.
   */
  async listTransfers(userId: string, assetId?: string): Promise<WalletTransfer[]> {
    return this.run(this.identityOf(userId), async (wallet) => {
      if (assetId !== undefined) {
        return wallet.listTransfers(assetId);
      }
      const transfers: WalletTransfer[] = [];
      for (const asset of await wallet.listAssets()) {
        transfers.push(...(await wallet.listTransfers(asset.assetId)));
      }
      return transfers;
    });
  }

  /**
   * On-chain transactions of the user's wallet, synced against the indexer
   * first. With txid given, only that transaction — an empty list when the
   * wallet has none by that id. rgb-node-api has no lookup by txid, so the
   * filter runs here.
   */
  async listTransactions(userId: string, txid?: string): Promise<WalletTransaction[]> {
    const transactions = await this.run(this.identityOf(userId), (wallet) =>
      wallet.listTransactions(),
    );
    return txid === undefined ? transactions : transactions.filter((tx) => tx.txid === txid);
  }

  async receive(
    userId: string,
    params: ReceiveParams,
    now: number = Date.now(),
  ): Promise<ReceiveResult> {
    const identity = this.identityOf(userId);
    const data = await this.run(identity, (wallet) =>
      wallet.receive({
        mode: params.mode,
        assetId: params.assetId ?? null,
        amount: params.amount ?? null,
        durationSeconds: params.durationSeconds ?? DEFAULT_RECEIVE_DURATION_SECONDS,
        minConfirmations: params.minConfirmations ?? DEFAULT_MIN_CONFIRMATIONS,
      }),
    );
    // Scoping (I3): the recipient id attributes the future transfer to this
    // user.
    recordOwnership(
      this.db,
      { kind: 'asset_transfer', resourceId: data.recipientId, userId, state: 'pending' },
      now,
    );
    return { ...data, mode: params.mode };
  }

  /** BTC-side sync plus RGB refresh, on the user's wallet. */
  async sync(userId: string): Promise<void> {
    await this.run(this.identityOf(userId), (wallet) => wallet.refresh());
  }
}
