/**
 * Ownership proofs for the existing UTXOs an asset send assigns RGB change to.
 *
 * rgb-lib puts a send's RGB change on an output of the new transaction when
 * that transaction has bitcoin change, and otherwise on a colorable UTXO the
 * wallet already holds. A device verifying the send proves the first kind
 * from the PSBT itself. For the second it needs the transaction that created
 * the UTXO, whose txid commits to the output's script, and the index that
 * script derives from on the user's colored account. The device re-derives
 * and checks both, so nothing gathered here is trusted.
 */
import { electrumCall, parseElectrumUrl, type ElectrumEndpoint } from '../electrum.js';
import type { AssetSendChangeUtxo, RgbExistingOutputProof } from './backend.js';

/** The mobile SDKs refuse evidence with more proofs or a longer transaction. */
export const MAX_EXISTING_OUTPUT_PROOFS = 8;
export const MAX_PROOF_TRANSACTION_HEX_CHARS = 200_000;

const LOWERCASE_HEX = /^([0-9a-f]{2})+$/;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Raw transactions by txid, as lowercase hex. */
export interface RawTransactionSource {
  rawTransaction(txid: string): Promise<string>;
}

export class ElectrumTransactionSource implements RawTransactionSource {
  constructor(
    private readonly endpoint: ElectrumEndpoint,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async rawTransaction(txid: string): Promise<string> {
    const result = await electrumCall(
      this.endpoint,
      'blockchain.transaction.get',
      [txid, false],
      this.timeoutMs,
    );
    if (typeof result !== 'string' || !LOWERCASE_HEX.test(result)) {
      throw new Error('the Electrum server returned no raw transaction');
    }
    return result;
  }
}

/** The indexer the gateway already reads fees from, or null without one. */
export function transactionSourceFor(electrumUrl: string | null): RawTransactionSource | null {
  if (electrumUrl === null) return null;
  const endpoint = parseElectrumUrl(electrumUrl);
  return endpoint === undefined ? null : new ElectrumTransactionSource(endpoint);
}

export interface ExistingOutputProofs {
  proofs: RgbExistingOutputProof[];
  /** Why a change UTXO that needs a proof got none; empty when all did. */
  gaps: string[];
}

/**
 * One proof per change UTXO that is not an output of the prepared transaction.
 *
 * A proof that cannot be built is left out, not turned into a failed prepare:
 * a client that does not verify RGB can still complete the send, and one that
 * does refuses it for exactly this UTXO.
 */
export async function existingOutputProofs(
  changeUtxos: AssetSendChangeUtxo[],
  preparedTxid: string | null,
  source: RawTransactionSource | null,
): Promise<ExistingOutputProofs> {
  const proofs: RgbExistingOutputProof[] = [];
  const gaps: string[] = [];
  for (const utxo of changeUtxos) {
    if (utxo.txid === preparedTxid) continue;
    const where = `${utxo.txid}:${utxo.vout}`;
    if (utxo.derivationIndex === null) {
      gaps.push(`${where}: the wallet service reported no derivation index`);
    } else if (source === null) {
      gaps.push(`${where}: no indexer is configured to read its transaction from`);
    } else if (proofs.length === MAX_EXISTING_OUTPUT_PROOFS) {
      gaps.push(`${where}: more than ${MAX_EXISTING_OUTPUT_PROOFS} change UTXOs need a proof`);
    } else {
      try {
        const transaction = await source.rawTransaction(utxo.txid);
        if (transaction.length > MAX_PROOF_TRANSACTION_HEX_CHARS) {
          gaps.push(`${where}: its transaction exceeds the proof size limit`);
        } else {
          proofs.push({ transaction, vout: utxo.vout, derivationIndex: utxo.derivationIndex });
        }
      } catch (error) {
        gaps.push(
          `${where}: ${error instanceof Error ? error.message : 'transaction lookup failed'}`,
        );
      }
    }
  }
  return { proofs, gaps };
}
