/**
 * Backend abstraction over per-user watch-only rgb-lib wallets.
 *
 * The gateway never holds user key material (invariant I2): a wallet is
 * constructed from the account xpubs registered by the client and can prepare
 * but never sign. The production implementation (./rgbnodeapi.ts) calls a
 * private rgb-node-api service that hosts the wallets; unit tests substitute a
 * mock.
 */
import { HttpError } from '../errors.js';

export interface UserXpubs {
  vanilla: string;
  colored: string;
  fingerprint: string;
}

export interface WalletIdentity {
  userId: string;
  xpubs: UserXpubs;
}

/** rgb-lib Balance triple, used for both BTC (sats) and assets (units). */
export interface Balance {
  settled: number;
  future: number;
  spendable: number;
}

export interface WalletBtcBalance {
  vanilla: Balance;
  colored: Balance;
}

/** An rgb-lib Assignment flattened to a variant name plus its fungible value. */
export interface Assignment {
  kind: string;
  amount: number | null;
}

export interface WalletAsset {
  assetId: string;
  schema: string;
  ticker: string | null;
  name: string;
  details: string | null;
  precision: number;
  /** Total issued amount; null for schemas without one (UDA). */
  issuedSupply: number | null;
  /** Unix seconds of asset genesis. */
  timestamp: number;
  /** Unix seconds this wallet imported the asset. */
  addedAt: number;
  balance: Balance;
}

export interface UnspentAllocation {
  assetId: string | null;
  /** Fungible amount, when the assignment carries one. */
  amount: number | null;
  /** The full assignment, so non-fungible variants are not silently dropped. */
  assignment: Assignment;
  settled: boolean;
}

export interface WalletUnspent {
  txid: string;
  vout: number;
  amountSat: number;
  colorable: boolean;
  /**
   * Whether the transaction creating this UTXO has been broadcast. A client
   * selecting inputs or counting spendable value cannot infer this from the
   * other fields, and must not guess it.
   */
  exists: boolean;
  /** Blind receives already promised against this UTXO (reserved slots). */
  pendingBlinded: number;
  allocations: UnspentAllocation[];
}

export interface WalletTransfer {
  idx: number;
  /** Batch this transfer belongs to; rgb-lib keys refresh/fail/delete by it. */
  batchTransferIdx: number | null;
  assetId: string | null;
  amount: number | null;
  assignments: Assignment[];
  kind: string;
  status: string;
  txid: string | null;
  recipientId: string | null;
  expiration: number | null;
  createdAt: number;
  updatedAt: number;
}

/** When a transaction confirmed (rgb-lib BlockTime). */
export interface WalletBlockTime {
  height: number;
  /** Unix seconds of the confirming block. */
  timestamp: number;
}

/** An on-chain transaction of the wallet (rgb-lib Transaction). */
export interface WalletTransaction {
  /** rgb-lib TransactionType verbatim: RgbSend, Drain, CreateUtxos, SendBtc, Incoming. */
  transactionType: string;
  txid: string;
  receivedSat: number;
  sentSat: number;
  feeSat: number;
  /** Null while unconfirmed. */
  confirmationTime: WalletBlockTime | null;
}

export interface ReceiveRequest {
  mode: 'blind' | 'witness';
  /** null = asset-agnostic invoice. */
  assetId: string | null;
  /** null = amount-less invoice (rgb-lib Assignment "Any"). */
  amount: number | null;
  /**
   * Seconds until the invoice expires. rgb-node-api takes a duration and names
   * the transport endpoint itself (its configured RGB proxy).
   */
  durationSeconds: number;
  minConfirmations: number;
}

export interface ReceiveData {
  invoice: string;
  recipientId: string;
  expirationTimestamp: number | null;
  /** Batch index of the created receive; null only on rgb-lib shape drift. */
  batchTransferIdx: number | null;
}

export interface SendAssetBeginRequest {
  assetId: string;
  /** Blinded UTXO or witness recipient id from the recipient's invoice. */
  recipientId: string;
  amount: number;
  /** Sats carried by the witness output; null for blind recipients. */
  witnessAmountSat: number | null;
  transportEndpoints: string[];
  donation: boolean;
  feeRateSatPerVb: number;
  minConfirmations: number;
  /** Unix seconds after which the wallet-side pending transfer expires. */
  expirationTimestamp: number;
}

export interface AssetSendResult {
  txid: string;
  /** rgb-lib's batch transfer index for the created transfer. */
  batchTransferIdx: number;
}

export interface CreateUtxosParams {
  upTo: boolean;
  num: number;
  size: number;
  feeRateSatPerVb: number;
}

/**
 * One open watch-only wallet. All calls MUST be serialized through the
 * per-wallet operation queue; the handle itself is not concurrency-safe.
 */
export interface WalletHandle {
  getAddress(): Promise<string>;
  getBtcBalance(): Promise<WalletBtcBalance>;
  listAssets(): Promise<WalletAsset[]>;
  listUnspents(): Promise<WalletUnspent[]>;
  listTransfers(assetId: string): Promise<WalletTransfer[]>;
  /** On-chain transactions, after a sync against the shared indexer. */
  listTransactions(): Promise<WalletTransaction[]>;
  receive(request: ReceiveRequest): Promise<ReceiveData>;
  /** Prepare an unsigned BTC-send PSBT (client signs externally). */
  sendBtcBegin(address: string, amountSat: number, feeRateSatPerVb: number): Promise<string>;
  /** Broadcast a signed BTC-send PSBT; returns the txid. */
  sendBtcEnd(signedPsbt: string): Promise<string>;
  /** Prepare an unsigned asset-send PSBT (opret commitment already embedded). */
  sendAssetBegin(request: SendAssetBeginRequest): Promise<string>;
  /**
   * Post consignment + broadcast a signed asset-send PSBT.
   *
   * The batch transfer index comes back with the txid because rgb-lib keys
   * refresh, fail and delete by it — a client that only receives a txid cannot
   * address the transfer it just created.
   */
  sendAssetEnd(signedPsbt: string): Promise<AssetSendResult>;
  /** Prepare an unsigned PSBT creating colorable UTXOs. */
  createUtxosBegin(params: CreateUtxosParams): Promise<string>;
  /** Broadcast a signed create-utxos PSBT; returns how many UTXOs were created. */
  createUtxosEnd(signedPsbt: string): Promise<number>;
  /** BTC-side sync against the shared indexer, then RGB refresh of pending transfers. */
  refresh(): Promise<void>;
  close(): Promise<void>;
}

export interface WalletBackend {
  open(identity: WalletIdentity): Promise<WalletHandle>;
}

/**
 * Wallet-layer failure. `detail` stays gateway-internal (logged, never sent
 * to clients); `insufficientFunds` and `clientError` mark the failures caused
 * by the caller's own request rather than by the gateway or the node.
 */
export class WalletBackendError extends Error {
  constructor(
    message: string,
    readonly detail: string,
    readonly insufficientFunds: boolean = false,
    /** rgb-lib rejected the REQUEST (bad recipient/asset/address/fee/endpoint). */
    readonly clientError: boolean = false,
    /**
     * rgb-lib returned a value this API cannot carry losslessly — in practice a
     * u64 asset amount above 2^53-1, which `JSON.parse` has already rounded.
     * Nobody's request is at fault and no retry helps; it is reported rather
     * than rounded (see `safeInteger` in ./rgbnodeapi.ts).
     */
    readonly unrepresentable: boolean = false,
    /**
     * The wallet service does not implement this operation at all (the
     * rgb-node-api route does not exist). Nothing was attempted, so nothing
     * can have been broadcast.
     */
    readonly unsupported: boolean = false,
  ) {
    super(message);
    this.name = 'WalletBackendError';
  }
}

/**
 * Single mapper from wallet-layer failures to client responses, shared by the
 * wallet service and the on-chain prepare flows. A request the caller got
 * wrong must answer 4xx: letting an rgb-lib rejection fall through to the
 * central handler would report bad input as 500 INTERNAL and log it as an
 * unhandled error. Anything not classified here is genuinely unexpected and
 * is deliberately left to become a 500.
 *
 * The `complete` path keeps its own mapping: a failure that proves the
 * transaction never broadcast is the caller's fault and carries a more useful
 * code (PSBT_REJECTED), while anything unclassified there may have happened
 * with the transaction already on the network and must not be blamed on the
 * signature (see PSBT_REJECTION_VARIANTS in ./prepare.ts).
 */
export function walletHttpError(error: unknown): unknown {
  if (!(error instanceof WalletBackendError)) return error;
  if (error.unsupported) {
    // A deployment gap, not the caller's fault: the configured rgb-node-api
    // has no route for this operation.
    return new HttpError(
      501,
      'WALLET_OPERATION_UNSUPPORTED',
      'this wallet operation is not available on the configured wallet service',
      { cause: error },
    );
  }
  if (error.unrepresentable) {
    // 502 like DEPOSIT_ADDRESS_CONFLICT: an upstream-shaped, permanent problem
    // that no client request can fix. It is deliberately NOT a 4xx — the caller
    // did nothing wrong — and deliberately not a rounded success.
    return new HttpError(
      502,
      'AMOUNT_NOT_REPRESENTABLE',
      'the wallet holds an amount this API cannot represent exactly',
      { cause: error },
    );
  }
  if (error.insufficientFunds) {
    return new HttpError(
      400,
      'INSUFFICIENT_FUNDS',
      'not enough confirmed bitcoins, assets or allocation slots for this operation',
      { cause: error },
    );
  }
  if (error.clientError) {
    return new HttpError(
      400,
      'WALLET_REQUEST_REJECTED',
      'the wallet rejected this request (bad recipient, asset, address, fee rate or transport endpoint)',
      { cause: error },
    );
  }
  return error;
}
