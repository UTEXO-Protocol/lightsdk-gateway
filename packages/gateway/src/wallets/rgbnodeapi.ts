/**
 * rgb-node-api backend: per-user watch-only rgb-lib wallets hosted by a private
 * rgb-node-api service (https://github.com/UTEXO-Protocol/rgb-node-api).
 *
 * rgb-node-api identifies a wallet only by the three headers below; it holds
 * no keys, never signs, and has no authentication of its own. Anyone who can
 * reach it and knows a user's xpubs can drive that user's wallet, so it must be
 * reachable from the gateway alone (invariant I4).
 *
 * It also keys loaded wallets (in memory and on disk) by master fingerprint
 * only. The gateway therefore never lets two users register the same
 * fingerprint (see WalletService.registerXpubs) — otherwise one user's requests
 * would be served from the other's wallet (invariant I3).
 *
 * Wire format: JSON bodies, rgb-lib models serialized snake_case (rgb-node-api
 * does not build rgb-lib with `camel_case`). Errors come back as
 * `{"error": {code, status, message, details: {kind}}}` where `kind` is the
 * rgb-lib error variant name; classification below is by that variant.
 */
import {
  WalletBackendError,
  type AssetSendResult,
  type Balance,
  type CreateUtxosParams,
  type ReceiveData,
  type ReceiveRequest,
  type RecipientEncryption,
  type SendAssetBeginRequest,
  type UnspentAllocation,
  type UserXpubs,
  type WalletAsset,
  type WalletBackend,
  type WalletBtcBalance,
  type WalletHandle,
  type WalletIdentity,
  type WalletTransaction,
  type WalletTransfer,
  type WalletUnspent,
} from './backend.js';

export const DEFAULT_WALLET_SERVICE_TIMEOUT_MS = 60_000;

/** rgb-lib `Encryption` as serde spells it (src/database/enums.rs, no rename). */
const RGB_LIB_ENCRYPTION: Record<RecipientEncryption, string> = {
  required: 'Required',
  optional: 'Optional',
  unsupported: 'Unsupported',
};

/**
 * rgb-lib error variants that mean "the REQUEST was wrong", as opposed to a
 * gateway bug or a node/indexer failure. Matched on the variant name that
 * rgb-node-api reports as `details.kind`. Keep in sync with rgb-lib's
 * `src/error.rs` on version bumps; an unlisted variant degrades to 500, never
 * to a wrong 400. rgb-node-api's own HTTP status is deliberately not trusted
 * for this: on the `complete` path a 4xx is read as "never broadcast".
 */
const CLIENT_ERROR_VARIANTS =
  /^(AssetNotFound|BitcoinNetworkMismatch|Invalid(Address|AmountZero|Assignment|BitcoinKeys|BitcoinNetwork|Expiration|FeeRate|Fingerprint|Invoice|ProxyProtocol|Pubkey|RecipientData|RecipientID|RecipientMap|RecipientNetwork|TransportEndpoints?|Txid|VanillaKeychain|WitnessVersion)|MaxFeeExceeded|MinFeeNotMet|NoValidTransportEndpoint|OutputBelowDustLimit|RecipientIDAlreadyUsed|RecipientIDDuplicated|UnknownRgbSchema|UnsupportedSchema|UnsupportedTransportType)$/;

const INSUFFICIENT_VARIANTS =
  /^Insufficient(Bitcoins|AllocationSlots|Assignments|SpendableAssets|TotalAssets)$/;

interface ServiceErrorBody {
  status: string;
  message: string;
  kind: string | null;
}

function parseErrorBody(text: string): ServiceErrorBody | undefined {
  try {
    const error = asRecord(asRecord(JSON.parse(text) as unknown)['error']);
    if (typeof error['status'] !== 'string') return undefined;
    const kind = asRecord(error['details'])['kind'];
    return {
      status: error['status'],
      message: typeof error['message'] === 'string' ? error['message'] : '',
      kind: typeof kind === 'string' && kind !== '' ? kind : null,
    };
  } catch {
    return undefined;
  }
}

/** Map a non-2xx rgb-node-api response to a wallet-layer failure. Exported for unit tests. */
export function serviceError(
  operation: string,
  path: string,
  status: number,
  text: string,
): WalletBackendError {
  const body = parseErrorBody(text);
  // rgb-node-api answers an unknown route with a 404 `not_found` envelope that
  // names no rgb-lib variant (or, behind a proxy, a bare 404), while every
  // handler error names one. A 404 without a variant therefore means this
  // rgb-node-api has no such route — nothing was attempted.
  if (status === 404 && (body === undefined || body.kind === null)) {
    return new WalletBackendError(
      `wallet ${operation} failed`,
      `rgb-node-api ${path} -> 404 (no such route)`,
      false,
      false,
      false,
      true,
    );
  }
  if (body === undefined) {
    return new WalletBackendError(
      `wallet ${operation} failed`,
      `rgb-node-api ${path} -> ${status}${text !== '' ? `: ${text.slice(0, 200)}` : ''}`,
    );
  }
  const detail = `rgb-node-api ${path} -> ${status} ${body.kind ?? body.status}: ${body.message}`;
  // No rgb-lib variant means rgb-node-api rejected the request itself
  // (missing headers, malformed JSON): a gateway bug, never the caller's.
  const kind = body.kind ?? '';
  const insufficient = INSUFFICIENT_VARIANTS.test(kind);
  return new WalletBackendError(
    `wallet ${operation} failed`,
    detail,
    insufficient,
    !insufficient && CLIENT_ERROR_VARIANTS.test(kind),
    false,
    false,
    body.kind,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * A JSON number from rgb-lib that must round-trip losslessly.
 *
 * rgb-lib counts assets in u64 and `JSON.parse` decodes into a double, so any
 * value above 2^53-1 is already rounded by the time this sees it — it cannot be
 * recovered, only detected. Detection is exact: a u64 above the safe range
 * always parses to at least 2^53, which `Number.isSafeInteger` rejects. The
 * alternative was to keep returning the rounded value, which would report a
 * balance the wallet does not hold; a loud failure is the lesser evil, and the
 * caller (`walletHttpError`) maps it to 502 AMOUNT_NOT_REPRESENTABLE.
 *
 * Absence is a separate concern and stays with each caller: some fields are
 * genuinely optional (an amount-less RGB assignment) and some are drift.
 */
function safeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new WalletBackendError(
      'wallet value is not representable',
      `${field} is not a safe integer: ${String(value)}`,
      false,
      false,
      true,
    );
  }
  return value;
}

/** Drift-tolerant read for fields rgb-lib may omit; a present value is still range-checked. */
function safeIntegerOrZero(value: unknown, field: string): number {
  return value === undefined || value === null ? 0 : safeInteger(value, field);
}

function safeIntegerOrNull(value: unknown, field: string): number | null {
  return value === undefined || value === null ? null : safeInteger(value, field);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function requiredString(raw: Record<string, unknown>, field: string, operation: string): string {
  const value = stringOrNull(raw[field]);
  if (value === null) {
    throw new WalletBackendError(
      `wallet ${operation} failed`,
      `unexpected ${operation} response shape: ${Object.keys(raw).join(',')}`,
    );
  }
  return value;
}

function mapBalance(value: unknown, field: string): Balance {
  const record = asRecord(value);
  return {
    settled: safeIntegerOrZero(record['settled'], `${field}.settled`),
    future: safeIntegerOrZero(record['future'], `${field}.future`),
    spendable: safeIntegerOrZero(record['spendable'], `${field}.spendable`),
  };
}

/** Fungible amount of an externally tagged rgb-lib Assignment, if any. */
function assignmentAmount(value: unknown, field: string): number | null {
  const record = asRecord(value);
  return safeIntegerOrNull(record['Fungible'], `${field}.Fungible`);
}

/**
 * An rgb-lib Assignment as a flat pair. The wire form is externally tagged —
 * `{"Fungible": 100}`, `{"InflationRight": 100}` or the bare string `"Any"` /
 * `"NonFungible"` for unit variants — which is awkward to declare in a strict
 * response schema and awkward to consume. `kind` carries the variant name
 * verbatim so a new rgb-lib variant surfaces as itself rather than as a
 * dropped field; `amount` is set only for the fungible-valued ones.
 */
export function mapAssignment(
  value: unknown,
  field: string,
): { kind: string; amount: number | null } {
  if (typeof value === 'string') return { kind: value, amount: null };
  const entries = Object.entries(asRecord(value));
  const first = entries[0];
  if (entries.length !== 1 || first === undefined) {
    throw new WalletBackendError(
      'wallet returned an unreadable assignment',
      `${field} is not an externally tagged assignment: ${JSON.stringify(value)}`,
    );
  }
  const [kind, payload] = first;
  return { kind, amount: typeof payload === 'number' ? safeInteger(payload, field) : null };
}

/** Exported for unit tests (response-shape drift must fail loudly, not corrupt data). */
export function mapAssets(raw: unknown): WalletAsset[] {
  const bySchema = asRecord(raw);
  const assets: WalletAsset[] = [];
  for (const [schemaKey, list] of Object.entries(bySchema)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const record = asRecord(entry);
      const assetId = stringOrNull(record['asset_id']);
      if (assetId === null) continue;
      // Every rgb-lib asset schema declares a non-optional, non-empty name.
      // Substituting '' here would hide the drift and then hand a client a
      // nameless asset it cannot display or validate; fail loudly instead.
      const name = stringOrNull(record['name']);
      if (name === null) {
        throw new WalletBackendError(
          'wallet returned an unnamed asset',
          `asset ${assetId} (${schemaKey}) has no name`,
        );
      }
      assets.push({
        assetId,
        schema: schemaKey,
        ticker: stringOrNull(record['ticker']),
        name,
        details: stringOrNull(record['details']),
        precision: safeIntegerOrZero(record['precision'], `asset ${assetId} precision`),
        // NIA/CFA report `issued_supply`; IFA and BFA name the same genesis
        // amount `initial_supply`. UDA has neither.
        issuedSupply: safeIntegerOrNull(
          record['issued_supply'] ?? record['initial_supply'],
          `asset ${assetId} issued_supply`,
        ),
        timestamp: safeIntegerOrZero(record['timestamp'], `asset ${assetId} timestamp`),
        addedAt: safeIntegerOrZero(record['added_at'], `asset ${assetId} added_at`),
        balance: mapBalance(record['balance'], `asset ${assetId} balance`),
      });
    }
  }
  return assets;
}

export function mapUnspents(raw: unknown): WalletUnspent[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const record = asRecord(entry);
    const utxo = asRecord(record['utxo']);
    const outpoint = asRecord(utxo['outpoint']);
    const allocationsRaw = record['rgb_allocations'];
    const allocations: UnspentAllocation[] = Array.isArray(allocationsRaw)
      ? allocationsRaw.map((allocation, index) => {
          const allocationRecord = asRecord(allocation);
          const field = `unspent allocation[${index}]`;
          return {
            assetId: stringOrNull(allocationRecord['asset_id']),
            amount: assignmentAmount(allocationRecord['assignment'], field),
            assignment: mapAssignment(allocationRecord['assignment'], `${field}.assignment`),
            settled: allocationRecord['settled'] === true,
          };
        })
      : [];
    return {
      txid: typeof outpoint['txid'] === 'string' ? outpoint['txid'] : '',
      vout: safeIntegerOrZero(outpoint['vout'], 'unspent vout'),
      amountSat: safeIntegerOrZero(utxo['btc_amount'], 'unspent btc_amount'),
      colorable: utxo['colorable'] === true,
      exists: utxo['exists'] === true,
      // Blind receives already promised against this UTXO. A client choosing
      // inputs or counting free allocation slots cannot do it from
      // `allocations` alone: a pending blind receive reserves a slot without
      // yet holding an allocation.
      pendingBlinded: safeIntegerOrZero(record['pending_blinded'], 'unspent pending_blinded'),
      allocations,
    };
  });
}

export function mapTransfers(raw: unknown, assetId: string | null): WalletTransfer[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const record = asRecord(entry);
    let amount = assignmentAmount(record['requested_assignment'], 'transfer requested_assignment');
    const rawAssignments = record['assignments'];
    const assignments = Array.isArray(rawAssignments)
      ? rawAssignments.map((assignment, index) =>
          mapAssignment(assignment, `transfer assignments[${index}]`),
        )
      : [];
    if (amount === null && Array.isArray(rawAssignments)) {
      const total = rawAssignments
        .map((assignment, index) => assignmentAmount(assignment, `transfer assignments[${index}]`))
        .filter((value): value is number => value !== null)
        .reduce((sum, value) => sum + value, 0);
      amount = total > 0 ? safeInteger(total, 'transfer assignments total') : null;
    }
    return {
      idx: safeIntegerOrZero(record['idx'], 'transfer idx'),
      // The batch transfer this one belongs to. rgb-lib's own operations
      // (refresh, fail, delete) are keyed by the BATCH index, not `idx`, so a
      // client that only sees `idx` cannot address the transfer it just read.
      batchTransferIdx: safeIntegerOrNull(
        record['batch_transfer_idx'],
        'transfer batch_transfer_idx',
      ),
      assetId,
      amount,
      assignments,
      kind: typeof record['kind'] === 'string' ? record['kind'] : 'Unknown',
      status: typeof record['status'] === 'string' ? record['status'] : 'Unknown',
      txid: stringOrNull(record['txid']),
      recipientId: stringOrNull(record['recipient_id']),
      expiration: safeIntegerOrNull(
        record['expiration_timestamp'],
        'transfer expiration_timestamp',
      ),
      createdAt: safeIntegerOrZero(record['created_at'], 'transfer created_at'),
      updatedAt: safeIntegerOrZero(record['updated_at'], 'transfer updated_at'),
    };
  });
}

export function mapTransactions(raw: unknown): WalletTransaction[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const record = asRecord(entry);
    // Clients look transactions up by txid; one without it is drift, not data.
    const txid = stringOrNull(record['txid']);
    if (txid === null) {
      throw new WalletBackendError(
        'wallet returned a transaction without a txid',
        `transaction without txid: ${JSON.stringify(entry)}`,
      );
    }
    const confirmation = record['confirmation_time'];
    const block = asRecord(confirmation);
    return {
      transactionType:
        typeof record['transaction_type'] === 'string' ? record['transaction_type'] : 'Unknown',
      txid,
      receivedSat: safeIntegerOrZero(record['received'], `transaction ${txid} received`),
      sentSat: safeIntegerOrZero(record['sent'], `transaction ${txid} sent`),
      feeSat: safeIntegerOrZero(record['fee'], `transaction ${txid} fee`),
      confirmationTime:
        confirmation === undefined || confirmation === null
          ? null
          : {
              height: safeInteger(block['height'], `transaction ${txid} confirmation height`),
              timestamp: safeInteger(
                block['timestamp'],
                `transaction ${txid} confirmation timestamp`,
              ),
            },
    };
  });
}

export interface RgbNodeApiBackendOptions {
  /** Base URL of the private rgb-node-api service (reachable only from the gateway). */
  baseUrl: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class RgbNodeApiWalletBackend implements WalletBackend {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RgbNodeApiBackendOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_WALLET_SERVICE_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Nothing to do remotely: rgb-node-api loads the wallet (construction +
   * goOnline) on the first call that names it, so malformed xpubs surface on
   * the registration smoke call rather than here.
   */
  async open(identity: WalletIdentity): Promise<WalletHandle> {
    return new RgbNodeApiWalletHandle(this.baseUrl, this.timeoutMs, this.fetchImpl, identity.xpubs);
  }
}

class RgbNodeApiWalletHandle implements WalletHandle {
  private closed = false;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch,
    private readonly xpubs: UserXpubs,
  ) {}

  /** POST `/wallet/<route>`; returns the parsed JSON object of a 2xx response. */
  private async call(
    operation: string,
    route: string,
    body: unknown = {},
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new WalletBackendError(`wallet ${operation} failed`, 'wallet handle is closed');
    }
    const path = `/wallet/${route}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // The timer stays armed until the BODY is read too: a response whose body
    // stalls must not pin the wallet's queue slot forever.
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'xpub-van': this.xpubs.vanilla,
          'xpub-col': this.xpubs.colored,
          'master-fingerprint': this.xpubs.fingerprint,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      // No response: the call may or may not have run on the service. Left
      // unclassified so a `complete` treats it as possibly broadcast.
      const reason = controller.signal.aborted
        ? `timed out after ${this.timeoutMs}ms`
        : `unreachable: ${error instanceof Error ? error.message : String(error)}`;
      throw new WalletBackendError(`wallet ${operation} failed`, `rgb-node-api ${path} ${reason}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw serviceError(operation, path, response.status, text);
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      throw new WalletBackendError(
        `wallet ${operation} failed`,
        `rgb-node-api ${path} returned non-JSON: ${text.slice(0, 200)}`,
      );
    }
  }

  async getAddress(): Promise<string> {
    const raw = await this.call('getAddress', 'address');
    return requiredString(raw, 'address', 'getAddress');
  }

  async getBtcBalance(): Promise<WalletBtcBalance> {
    const raw = await this.call('getBtcBalance', 'btcbalance');
    return {
      vanilla: mapBalance(raw['vanilla'], 'btc balance vanilla'),
      colored: mapBalance(raw['colored'], 'btc balance colored'),
    };
  }

  async listAssets(): Promise<WalletAsset[]> {
    return mapAssets(await this.call('listAssets', 'listassets'));
  }

  async listUnspents(): Promise<WalletUnspent[]> {
    // A JSON array: `call` wraps non-object bodies as { value }.
    const raw = await this.call('listUnspents', 'listunspents');
    return mapUnspents(raw['value']);
  }

  async listTransfers(assetId: string): Promise<WalletTransfer[]> {
    const raw = await this.call('listTransfers', 'listtransfers', { asset_id: assetId });
    return mapTransfers(raw['value'], assetId);
  }

  async listTransactions(): Promise<WalletTransaction[]> {
    // A JSON array: `call` wraps non-object bodies as { value }.
    const raw = await this.call('listTransactions', 'listtransactions');
    return mapTransactions(raw['value']);
  }

  async receive(request: ReceiveRequest): Promise<ReceiveData> {
    const operation = `${request.mode}Receive`;
    const raw = await this.call(
      operation,
      request.mode === 'blind' ? 'blindreceive' : 'witnessreceive',
      {
        asset_id: request.assetId,
        amount: request.amount,
        duration_seconds: request.durationSeconds,
        min_confirmations: request.minConfirmations,
      },
    );
    return {
      invoice: requiredString(raw, 'invoice', operation),
      recipientId: requiredString(raw, 'recipient_id', operation),
      expirationTimestamp: safeIntegerOrNull(
        raw['expiration_timestamp'],
        'receive expiration_timestamp',
      ),
      // rgb-lib keys refresh/fail/delete by batch index, so a client that wants
      // to manage the receive it just created needs this. It is non-optional in
      // rgb-lib's ReceiveData; null here only means shape drift.
      batchTransferIdx: safeIntegerOrNull(raw['batch_transfer_idx'], 'receive batch_transfer_idx'),
      // RGB proxy protocol 1.0 (rgb-lib-bfa): the key a sender encrypts the
      // consignment to, also embedded in the invoice as `pk`. Absent before.
      publicKey: stringOrNull(raw['public_key']),
    };
  }

  async sendBtcBegin(address: string, amountSat: number, feeRateSatPerVb: number): Promise<string> {
    const raw = await this.call('sendBtcBegin', 'sendbtcbegin', {
      address,
      amount: amountSat,
      fee_rate: feeRateSatPerVb,
    });
    return requiredString(raw, 'psbt', 'sendBtcBegin');
  }

  async sendBtcEnd(signedPsbt: string): Promise<string> {
    const raw = await this.call('sendBtcEnd', 'sendbtcend', { signed_psbt: signedPsbt });
    return requiredString(raw, 'txid', 'sendBtcEnd');
  }

  async sendAssetBegin(request: SendAssetBeginRequest): Promise<string> {
    const raw = await this.call('sendAssetBegin', 'sendbegin', {
      recipient_map: {
        [request.assetId]: [
          {
            recipient_id: request.recipientId,
            witness_data:
              request.witnessAmountSat === null
                ? null
                : { amount_sat: request.witnessAmountSat, blinding: null },
            amount: request.amount,
            transport_endpoints: request.transportEndpoints,
            // Sent only when given: an rgb-node-api older than RGB proxy
            // protocol 1.0 has no such fields, and `encryption` is not
            // nullable on the newer one (absent means Required).
            ...(request.recipientPublicKey !== null
              ? { public_key: request.recipientPublicKey }
              : {}),
            ...(request.recipientExpirationTimestamp !== null
              ? { expiration_timestamp: request.recipientExpirationTimestamp }
              : {}),
            ...(request.recipientEncryption !== null
              ? { encryption: RGB_LIB_ENCRYPTION[request.recipientEncryption] }
              : {}),
          },
        ],
      },
      donation: request.donation,
      fee_rate: request.feeRateSatPerVb,
      min_confirmations: request.minConfirmations,
      expiration_timestamp: request.expirationTimestamp,
    });
    return requiredString(raw, 'psbt', 'sendAssetBegin');
  }

  async sendAssetEnd(signedPsbt: string): Promise<AssetSendResult> {
    const raw = await this.call('sendAssetEnd', 'sendend', { signed_psbt: signedPsbt });
    const txid = stringOrNull(raw['txid']);
    // rgb-lib's OperationResult always carries both; a response missing either
    // is shape drift, and a transfer a client cannot address is not a success.
    if (txid === null || typeof raw['batch_transfer_idx'] !== 'number') {
      throw new WalletBackendError(
        'wallet sendAssetEnd failed',
        `unexpected send result shape: ${Object.keys(raw).join(',')}`,
      );
    }
    return {
      txid,
      batchTransferIdx: safeInteger(raw['batch_transfer_idx'], 'send batch_transfer_idx'),
    };
  }

  async createUtxosBegin(params: CreateUtxosParams): Promise<string> {
    const raw = await this.call('createUtxosBegin', 'createutxosbegin', {
      up_to: params.upTo,
      num: params.num,
      size: params.size,
      fee_rate: params.feeRateSatPerVb,
    });
    return requiredString(raw, 'psbt', 'createUtxosBegin');
  }

  async createUtxosEnd(signedPsbt: string): Promise<number> {
    const raw = await this.call('createUtxosEnd', 'createutxosend', { signed_psbt: signedPsbt });
    if (typeof raw['created'] !== 'number') {
      throw new WalletBackendError(
        'wallet createUtxosEnd failed',
        `unexpected create-utxos result shape: ${Object.keys(raw).join(',')}`,
      );
    }
    return safeInteger(raw['created'], 'create-utxos created');
  }

  async refresh(): Promise<void> {
    // rgb-lib refresh without skip_sync: syncs against the indexer first.
    await this.call('refresh', 'refresh');
  }

  /**
   * Unload the wallet from rgb-node-api's memory (pool eviction, shutdown, or
   * a failed registration). The next call that names it loads it again.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.call('close', 'drop');
    this.closed = true;
  }
}
