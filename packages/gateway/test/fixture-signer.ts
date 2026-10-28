/**
 * Test-only client-side signer: derives keys from a fixture mnemonic and
 * signs a prepared PSBT purely from its own key-origin metadata — the same
 * loop the Task-6 client SDK implements. Mnemonics are never a gateway input.
 */
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { base64 } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import type { UserXpubs } from '../src/wallets/backend.js';

export const PSBT_PARSE_OPTIONS = {
  allowUnknownInputs: true,
  allowUnknownOutputs: true,
} as const;

export function masterFromMnemonic(mnemonic: string): HDKey {
  return HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
}

/** tprv/tpub version bytes (regtest serializes extended keys like testnet). */
const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587cf };

/**
 * The account xpubs a client registers for a fixture mnemonic on regtest:
 * BIP-86 account 0 on the vanilla (coin 1) and colored (RGB coin 827167)
 * sides, as rgb-lib derives them.
 */
export function regtestXpubsFromMnemonic(mnemonic: string): UserXpubs {
  const master = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic), TESTNET_VERSIONS);
  const account = (coin: number): string => master.derive(`m/86'/${coin}'/0'`).publicExtendedKey;
  return {
    vanilla: account(1),
    colored: account(827167),
    fingerprint: master.fingerprint.toString(16).padStart(8, '0'),
  };
}

/**
 * BIP-341 key-path sign + finalize every input whose key origin matches the
 * master fingerprint; paths (vanilla or colored keychain) come from the PSBT.
 */
export function signPsbtWithMaster(master: HDKey, psbtBase64: string): string {
  const tx = Transaction.fromPSBT(base64.decode(psbtBase64), PSBT_PARSE_OPTIONS);
  for (let index = 0; index < tx.inputsLength; index += 1) {
    const input = tx.getInput(index);
    for (const [, derivation] of input.tapBip32Derivation ?? []) {
      if (derivation.der.fingerprint !== master.fingerprint) continue;
      let key = master;
      for (const step of derivation.der.path) key = key.deriveChild(step);
      tx.signIdx(key.privateKey!, index);
    }
  }
  tx.finalize();
  return base64.encode(tx.toPSBT());
}
