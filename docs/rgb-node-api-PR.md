# Add BTC send and witness receive endpoints

## Why

lightsdk-gateway, the REST gateway in front of the mobile SDKs, now hosts its per-user
watch-only wallets on rgb-node-api instead of embedding rgb-lib. It needs two operations
rgb-node-api did not expose:

- **Sending BTC** with a client-signed PSBT. The logic was already in the service
  (`SendBtcReq`, `send_btc_begin` / `send_btc_end`) but had no route.
- **Witness receive.** The gateway's receive API accepts a witness mode and the Kotlin SDK
  uses it. It lets a wallet with no colorable UTXO receive an RGB asset: the sender's
  transaction creates the output, so a new user needs no BTC up front.

## Changes

- `POST /wallet/sendbtcbegin` with `{address, amount, fee_rate}` returns `{psbt}`.
- `POST /wallet/sendbtcend` with `{signed_psbt}` broadcasts and returns `{txid}`.
- `POST /wallet/witnessreceive` takes the same body as `/wallet/blindreceive` and returns
  the same `ReceiveData`. Recipient ids look like `bcrt:wvout:…`, and the sender funds the
  output via `witness_data.amount_sat`.
- The receive path now takes a `ReceiveKind` (`Blind` / `Witness`) and calls rgb-lib's
  `blind_receive` or `witness_receive`. `RgbWalletState::blind_receive_token` is renamed
  to `receive_token`.
- Docs: README API table, CHANGELOG (Unreleased → Added), and the swagger spec, which gains
  the new paths plus `SendBtcBeginRequestModel` and `SendBtcResponse`.

Existing routes and response shapes are unchanged, so nothing here is breaking.

## Notes for review

- Unlike the other begin endpoints, `fee_rate` on `sendbtcbegin` has no default. All three
  fields are required.
- `sendbtcend` uses the shared `Psbt` request struct, so it also accepts the legacy
  `signedPsbt` spelling. The spec documents only `signed_psbt`.

## Testing

- `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings` and
  `cargo test` all pass (15 tests). New tests cover the `sendbtcend` response shape and the
  required `sendbtcbegin` fields.
- End to end: lightsdk-gateway's regtest suites and its e2e journey pass against a Docker image
  built from this branch. They cover send-BTC prepare → client signs → complete with the
  funds arriving, and a witness receive on a fresh wallet that has no colorable UTXOs.
