# Client-side RGB verification before signing

Research note, 2026-10-29. Question: can the client SDK stop signing colored spends blind by
verifying the RGB side itself, the way
[`rgb-verify`](https://github.com/UTEXO-Protocol/rgb-btcpay-plugin/tree/c2670ea/native/rgb-verify)
does in the BTCPay plugin?

## Answer

Partly. Porting rgb-verify's commitment and transition checks to the client would stop a
compromised rgb-node-api from redirecting RGB allocations, which is the theft described under
"send-time trust" in the [architecture doc](lightsdk-architecture.md). It would not reach
rgb-verify's full guarantee. One of its checks reads the wallet's own RGB Stock, and our client
keeps no state, so a malicious server could still burn allocations it hides from us. It could not
move them anywhere.

It is not a drop-in either. rgb-node-api doesn't return the data the checks need, rgb-verify is
built on an older RGB release than ours, and it doesn't support witness (`wvout`) sends.

## What is blind today

[`verify.ts`](../../packages/client-sdk/src/verify.ts) runs five checks over the bitcoin side of a
prepared PSBT, and `sign.ts` refuses to sign unless they pass. The opret commitment is opaque to
it. In RGB, spending a colored input authorizes whatever transition the transaction commits to, so
the server can commit a transition that sends both the payment and our change to seals it
controls, and the PSBT still passes all five checks. The Kotlin SDK documents the same boundary
(`rgb-sdk-kotlin-light` `SECURITY.md:169-171`), and none of the sibling SDKs (Kotlin, Swift, web,
RN) verify the RGB side today.

## How rgb-verify works

rgb-verify is a Rust crate with a C FFI that deliberately doesn't link rgb-lib. The plugin calls it
between rgb-lib's `send_begin` and signing, and fails the transfer on any error
([`RGBWalletService.cs:2545`](https://github.com/UTEXO-Protocol/rgb-btcpay-plugin/blob/c2670ea/Services/RGBWalletService.cs#L2545)).
Its inputs are the unsigned PSBT, the invoice, the recipient consignment, the fascia and MPC
entropy from `send_begin`, an indexer URL, the account xpubs, and copies of the wallet's RGB Stock
and BDK store made before `send_begin`.

The checks, split between
[`validate_v2.rs`](https://github.com/UTEXO-Protocol/rgb-btcpay-plugin/blob/c2670ea/native/rgb-verify/src/validate_v2.rs#L97)
and the C#
[`RgbIntentVerifier`](https://github.com/UTEXO-Protocol/rgb-btcpay-plugin/blob/c2670ea/Services/RgbIntentVerifier.cs#L12):

1. **The commitment is complete.** Recompute the MPC root from every contract and bundle id in
   the fascia plus the entropy, and require it to equal the opret bytes in the PSBT
   ([`commitment.rs:65`](https://github.com/UTEXO-Protocol/rgb-btcpay-plugin/blob/c2670ea/native/rgb-verify/src/commitment.rs#L65)).
   Nothing can be committed that the client doesn't see.
2. **Every transition is disclosed.** Each opid in a bundle's input map must have a disclosed
   transition that hashes to it. A bundle id commits only to its input map (`rgb-consensus`
   0.11.1-rc.11, `src/operation/bundle.rs:145`) and an opid is the transition's hash, so checks 1
   and 2 together show every transition the signature authorizes.
3. **The main transfer matches the intent.** There is exactly one transfer transition. Its
   recipient leg carries the invoice's blinded seal and amount. Every other leg goes to a colored
   output re-derived from our xpubs, and a leg on an existing outpoint must also be unspent at the
   indexer.
4. **Other transitions are carry-forwards.** Every other committed transition moves one input to
   one wallet-owned seal
   ([`inputs.rs:426`](https://github.com/UTEXO-Protocol/rgb-btcpay-plugin/blob/c2670ea/native/rgb-verify/src/inputs.rs#L426)).
5. **History validates.** rgb-ops validates the recipient consignment and every committed
   contract against the indexer.
6. **Inputs are fully accounted for.** Every allocation the Stock records on the spent outpoints
   is consumed by a disclosed transition
   ([`inputs.rs:181`](https://github.com/UTEXO-Protocol/rgb-btcpay-plugin/blob/c2670ea/native/rgb-verify/src/inputs.rs#L181)).
7. **There is no second commitment.** Every taproot output must be a plain wallet key, which rules
   out a hidden tapret commitment
   ([`RgbIntentVerifier.cs:106`](https://github.com/UTEXO-Protocol/rgb-btcpay-plugin/blob/c2670ea/Services/RgbIntentVerifier.cs#L106)).
   Invoice expiry, network and transport endpoints are checked as well.

## What carries over

The plugin is a custodial hot wallet. It defends against a compromised rgb-lib in the same
process, and the Stock it snapshots
([`RGBWalletService.cs:2248`](https://github.com/UTEXO-Protocol/rgb-btcpay-plugin/blob/c2670ea/Services/RGBWalletService.cs#L2248))
is the merchant's own file, so it is ground truth. Our Stock lives in rgb-node-api, the party we're
trying not to trust. Fetching a Stock from the server doesn't help: the dangerous lie is an
omission, and RGB has no proof that an outpoint carries no allocation.

| Guarantee                                               | Checks | Stateless client?                                                                        |
| ------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| Server can't redirect allocations                       | 1–4, 7 | Yes. Needs the fascia and entropy from the server and the invoice from the user.         |
| Server can't burn disclosed allocations via bad history | 5      | Yes, but heaviest: consignments with history, and an indexer we trust for confirmations. |
| Server can't burn allocations it never discloses        | 6      | No. That needs our own record of every allocation, which is a Stock.                     |

The first row holds without a Stock because stealing requires a committed transition that assigns
state to the attacker. Checks 1 and 2 expose every committed transition, and checks 3, 4 and 7
require every assigned seal to be the recipient's or ours. An allocation on a spent input that no
committed transition consumes is destroyed with the spend: the user loses it and nobody gains it.
For this row, check 4 only needs every assignment to land on our seals. Matching a carry-forward's
amount to its input needs the history from check 5.

## What it would take

**Server data.** rgb-lib-bfa's `send_begin` already returns `details.fascia_path` and
`details.entropy`
([`objects.rs:1932`](https://github.com/UTEXO-Protocol/rgb-lib-bfa/blob/v0.3.0-beta.7-upstream-dev-bfa.3/src/wallet/objects.rs#L1932)),
and `create_consignments(psbt)` builds consignments before signing
([`rust_only.rs:291`](https://github.com/UTEXO-Protocol/rgb-lib-bfa/blob/v0.3.0-beta.7-upstream-dev-bfa.3/src/wallet/rust_only.rs#L291)).
rgb-node-api forwards only `val.psbt`
([`wallet_thread.rs:585`](https://github.com/UTEXO-Protocol/rgb-node-api/blob/65e1caf/src/wallet/wallet_thread.rs#L585)).
We'd add the fascia bytes and entropy, plus the consignments if we want check 5, to `sendbegin`
and to the gateway's send-asset prepare response. These are additive fields, so the response
contract doesn't break, and they describe only the requesting user's own transfer.

**A Rust core on our RGB release.** rgb-verify pins `rgb-ops` and `rgb-consensus`
`=0.11.1-rc.10` and parses the fascia as JSON. rgb-node-api's lockfile resolves both to
`0.11.2-rc.1` under rgb-lib-bfa `0.3.0-beta.7`, and that rgb-lib writes the fascia strict-encoded.
We'd port the logic of `commitment.rs`, `inputs.rs` and the leg checks to our release and drop the
Stock, BDK store and filesystem inputs. Reimplementing it in TypeScript would be a mistake: bundle
ids and opids are strict-encoding commitment hashes, and any divergence from the crate means
rejected sends at best.

**Packaging.** The Kotlin and Swift SDKs already ship a native Rust signing core, so the verifier
fits there. The web SDK would need WASM. `rgb-lib-wasm` shows that `rgb-ops` compiles to `wasm32`
and validates consignments in a browser by prefetching witness transactions
(`src/utils.rs:883`). Its release test binary is about 19 MB before `wasm-opt`. A verifier-only
build would be smaller, but we haven't measured one, and it will still be far past the 500 KB
budget in `bundle-size.test.ts`, so it has to be a separate module loaded at send time. React
Native's Hermes engine has not historically run WebAssembly, so RN probably needs the native core;
check that against our RN version.

**Witness sends.** rgb-verify only accepts blinded (`utxob`) recipients: `VerifyRecipientLeg`
requires a confidential seal and check 7 rejects any taproot output that isn't ours. For `wvout`
invoices we'd write our own rule: the recipient leg's vout must pay the script encoded in the
invoice.

## Side finding: the witness output's script is unchecked

This one doesn't depend on RGB validation. For a witness asset send, `verify.ts` check 2 accepts
exactly one foreign output of `witnessAmountSat`
([`verify.ts:316-326`](../../packages/client-sdk/src/verify.ts#L316-L326)) without comparing its
script to the invoice. `prepareSendAsset` compares only the `recipientId` string
([`gateway.ts:487`](../../packages/client-sdk/src/gateway.ts#L487)), and `invoice.ts` doesn't
decode the `wvout` payload. A hostile server can pay those sats to its own script, which breaks
the architecture doc's claim that every bitcoin-value movement is verified. The amount is small,
and the fix needs no RGB stack: a `wvout` payload is an address-type byte plus a key or hash
(`rgb-invoicing` `Pay2Vout`), which gives the expected script.

## Recommendation

1. Fix the witness-output binding in `verify.ts` now.
2. Build checks 1–4 and 7 as one Rust core, shared by the native SDKs and loaded as an opt-in WASM
   module on web, and add the fascia and entropy to the send-begin and prepare responses.
3. Treat check 5 as later hardening. Check 6 stays out of reach while the client is stateless, so
   the design doc's limitation would narrow from "the server can redirect" to "the server can
   burn", and the existing server-side controls remain the answer to that.
