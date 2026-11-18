/**
 * Ownership proofs for existing change UTXOs: which UTXOs get one, and that one
 * the gateway cannot build is reported instead of failing the send.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_EXISTING_OUTPUT_PROOFS,
  MAX_PROOF_TRANSACTION_HEX_CHARS,
  existingOutputProofs,
  transactionSourceFor,
  type RawTransactionSource,
} from '../src/wallets/evidence.js';

const PREPARED = 'cd'.repeat(32);
const txid = (n: number): string => n.toString(16).padStart(64, '0');

function source(transactions: Record<string, string>): RawTransactionSource {
  return {
    rawTransaction: (id) =>
      transactions[id] === undefined
        ? Promise.reject(new Error('unknown transaction'))
        : Promise.resolve(transactions[id]),
  };
}

describe('existing-output proofs for RGB send evidence', () => {
  it('proves existing change UTXOs and skips outputs of the prepared transaction', async () => {
    const result = await existingOutputProofs(
      [
        { txid: PREPARED, vout: 2, derivationIndex: null },
        { txid: txid(1), vout: 3, derivationIndex: 9 },
      ],
      PREPARED,
      source({ [txid(1)]: '0200' }),
    );
    expect(result).toEqual({
      proofs: [{ transaction: '0200', vout: 3, derivationIndex: 9 }],
      gaps: [],
    });
  });

  it('needs no source when every change UTXO is an output of the prepared transaction', async () => {
    const utxos = [{ txid: PREPARED, vout: 2, derivationIndex: null }];
    expect(await existingOutputProofs(utxos, PREPARED, null)).toEqual({ proofs: [], gaps: [] });
  });

  it('reports each proof it cannot build and keeps the others', async () => {
    const result = await existingOutputProofs(
      [
        { txid: txid(1), vout: 0, derivationIndex: null },
        { txid: txid(2), vout: 0, derivationIndex: 1 },
        { txid: txid(3), vout: 0, derivationIndex: 2 },
        { txid: txid(4), vout: 1, derivationIndex: 3 },
      ],
      PREPARED,
      source({
        [txid(3)]: 'ab'.repeat(MAX_PROOF_TRANSACTION_HEX_CHARS / 2 + 1),
        [txid(4)]: '0300',
      }),
    );
    expect(result.proofs).toEqual([{ transaction: '0300', vout: 1, derivationIndex: 3 }]);
    expect(result.gaps).toEqual([
      `${txid(1)}:0: the wallet service reported no derivation index`,
      `${txid(2)}:0: unknown transaction`,
      `${txid(3)}:0: its transaction exceeds the proof size limit`,
    ]);
  });

  it('reports every needed proof as a gap without an indexer', async () => {
    const result = await existingOutputProofs(
      [{ txid: txid(1), vout: 0, derivationIndex: 1 }],
      // An unparsable PSBT has no txid; nothing is then mistaken for its output.
      null,
      transactionSourceFor(null),
    );
    expect(result.proofs).toEqual([]);
    expect(result.gaps).toEqual([
      `${txid(1)}:0: no indexer is configured to read its transaction from`,
    ]);
  });

  it('stops at the number of proofs the mobile SDKs accept', async () => {
    const utxos = Array.from({ length: MAX_EXISTING_OUTPUT_PROOFS + 1 }, (_, n) => ({
      txid: txid(n + 1),
      vout: 0,
      derivationIndex: n,
    }));
    const transactions = Object.fromEntries(utxos.map((utxo) => [utxo.txid, '0200']));
    const result = await existingOutputProofs(utxos, PREPARED, source(transactions));
    expect(result.proofs).toHaveLength(MAX_EXISTING_OUTPUT_PROOFS);
    expect(result.gaps).toHaveLength(1);
  });
});
