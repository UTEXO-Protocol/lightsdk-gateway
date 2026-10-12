# rln-gateway

This is the core `rln-gateway` repository: a pnpm workspace implementing the lightweight
SDK architecture described in `docs/design/lightweight-sdk-and-lightweight-rln.md`. It
contains a TypeScript API gateway (`packages/gateway`) in front of one shared RLN
instance, the lightweight browser/mobile client SDK (`packages/client-sdk`) that keeps all
key material client-side (verify-before-sign), and a regtest e2e suite (`packages/e2e`).

RLN itself lives in the rgb-lightning-node repository. Build, lint and unit tests need
nothing from it; the regtest suites and RLN type generation use a local checkout (see
[The rgb-lightning-node checkout](#the-rgb-lightning-node-checkout)).

## Architecture

From the design doc:

```
browser / mobile app
  └─ lightweight TS SDK  (keys, PSBT verify + sign, invoice decode)
        │  HTTPS (REST today; GraphQL/gRPC are gateway-layer options)
  API gateway  (per-user auth, per-user scoping + FIFO queue, idempotency keys)
        ├─ per-user watch-only rgb-lib wallets  (PSBT preparation, balances, receives)
        └─ single RLN instance  (admin token; LN channels, swaps, RGB transfers)
              └─ shared esplora + RGB proxy
```

The server prepares transactions on the user's watch-only wallet; the client verifies
against its stated intent and signs; the server broadcasts. Package READMEs:
`packages/gateway/README.md` (config reference, deployment, float caps, the custody
boundary) and `packages/client-sdk/README.md` (quickstart, the verify-before-sign
contract); `packages/e2e/README.md` covers the regtest journey suite.

### Native mobile: rgb-sdk-kotlin-light

Natively written Android apps fill the same client role from a **separate repository**,
`rgb-sdk-kotlin-light` (`com.utexo.rgb.sdk`), which ships its own Rust signing core and
speaks the REST surface above:

```
Android app (Kotlin)
  └─ rgb-sdk-kotlin-light   (Keystore seed custody, operation journal, local PSBT
        │                    verify + sign via its own `utexo-local-signer` core)
        │  HTTPS / OkHttp
     API gateway  (same REST surface as above)
```

Two consequences for work in this repository:

- **The gateway's HTTP surface is a published contract with an out-of-repo consumer.**
  Response schemas are strict (`additionalProperties: false`), so removing a field,
  retyping one, or narrowing an accepted range is breaking; adding a field is not. That
  client validates response shapes strictly and refuses anything it cannot map, so a
  silent default is worse than an explicit error.
- **`packages/client-sdk` is the in-repo reference for that contract.** It is the
  behavioural spec the gateway is tested against and the only client exercised by
  `packages/e2e`; web and React Native keep using it (185.5 KB of pure JS). It also reads
  the rgb-lib-authored `packages/client-sdk/test/fixtures/rgblib-parity.json`, which is
  what keeps this repo's reading of BIP-86 and the RGB coin types honest.

## Deliberately deferred

- **RLN-side Block-3 fixes** (design doc items 4–7) — Rust changes that belong to
  rgb-lightning-node; they ship there as a separate PR series before scaling user count.
- **Auto-sweep** of the LN float to user keys — the capped float bounds custodial
  exposure first; sweeping adds a client-signing round-trip worth designing properly.
- **Submarine/atomic swaps** for trust-minimized float in/out — weeks of effort on the
  existing swap API; the capped float is the interim control.
- **BOLT12 offers** — stay unexposed to avoid the known double-pay on retry
  (rgb-lightning-node `src/routes.rs:5093-5095`).
- **VSS / encrypted client backup** — the client is stateless between sessions; its only
  durable secret is the mnemonic, backed up as a seed phrase.
- **GraphQL/gRPC front-end** — REST is what RLN speaks today; other transports are a
  gateway-layer swap that changes no SDK surface.

## Workspace commands

```sh
pnpm install
pnpm build   # tsc build of all packages
pnpm test    # unit tests (gateway + client-sdk + the e2e package's
             # infra-free smoke test; the regtest journey is excluded)
pnpm lint    # eslint + prettier check
pnpm format  # prettier --write
pnpm e2e     # regtest e2e journey (requires local infra, see below)
```

Two gateway suites additionally exercise the **real** rgb-lib backend against regtest and
are skipped unless opted in (`describe.runIf(process.env['WALLET_REGTEST'] === '1')`):

```sh
ESPLORA=1 ./regtest.sh start   # from $RLN_REPO, on a fresh chain
WALLET_REGTEST=1 pnpm --filter @utexo/rln-gateway test wallet-integration
WALLET_REGTEST=1 pnpm --filter @utexo/rln-gateway test onchain-integration
```

Run `wallet-integration` first: the two share a fixture account, and the on-chain suite
creates colorable UTXOs that would break the other's `INSUFFICIENT_FUNDS` assertion.

### Generated files

- `packages/gateway/src/rln/openapi.ts` — regenerate with
  `pnpm --filter @utexo/rln-gateway generate:rln-types` whenever rgb-lightning-node's
  `openapi.yaml` (read from `$RLN_REPO`) changes an endpoint the gateway calls.
- `packages/client-sdk/test/fixtures/rgblib-parity.json` — regenerate with
  `pnpm --filter @utexo/lightweight-client-sdk generate:fixtures` on an `@utexo/rgb-lib`
  bump.

## The rgb-lightning-node checkout

Operations that need RLN itself use an rgb-lightning-node checkout named by `RLN_REPO`
(default `../rgb-lightning-node`, a sibling of this repository):

- the regtest stack — its `regtest.sh` and compose file (bitcoind, electrs, RGB proxy,
  esplora) and the `regtest.sh` fund/mine helpers, used by `pnpm e2e`, the
  `WALLET_REGTEST` suites and `scripts/preflight-a.cjs`;
- the RLN binary the e2e journey starts, `$RLN_REPO/target/debug/rgb-lightning-node`
  (`cargo build` there first);
- `openapi.yaml`, the input of `generate:rln-types`.

The unit tests, build and lint need none of it.

## Regtest bring-up (verified 2026-09-09, Preflight B)

From the rgb-lightning-node checkout (`$RLN_REPO`):

```sh
# 1. start bitcoind + electrs (tcp://localhost:50001) + RGB proxy (http://localhost:3000);
#    ESPLORA=1 additionally starts the esplora REST API on http://localhost:3002
ESPLORA=1 ./regtest.sh start

# 2. build (if needed) and start an RLN instance
cargo build
mkdir -p /tmp/rln-data
target/debug/rgb-lightning-node /tmp/rln-data --daemon-listening-port 3101 \
    --ldk-peer-listening-port 9835 --network regtest --disable-authentication

# 3. init + unlock, then verify the node answers
curl -X POST http://localhost:3101/init -H 'Content-Type: application/json' \
    -d '{"password":"nodepassword"}'
curl -X POST http://localhost:3101/unlock -H 'Content-Type: application/json' -d '{
  "password": "nodepassword",
  "ldk_chain_sync": {"mode": "BlockSync", "config": {
    "bitcoind_rpc_username": "user", "bitcoind_rpc_password": "password",
    "bitcoind_rpc_host": "localhost", "bitcoind_rpc_port": 18443}},
  "indexer_url": "127.0.0.1:50001",
  "proxy_endpoint": "rpc://127.0.0.1:3000/json-rpc",
  "announce_addresses": []}'
curl http://localhost:3101/nodeinfo

# teardown (stops containers and deletes data dirs)
./regtest.sh stop
```

`--disable-authentication` is acceptable strictly because RLN listens on localhost and
only the gateway talks to it (design doc invariant I4); never expose RLN publicly.

Fund/mine helpers: `./regtest.sh sendtoaddress <addr> <amount>`, `./regtest.sh mine <blocks>`.

## rgb-lib binding status (verified 2026-09-09, Preflight A)

`@utexo/rgb-lib@0.3.0-beta.18` supports **watch-only** (mnemonic-less) wallets, but its
published JS `wrapper.js` is stale: the compiled native module takes
`rgblib_new_wallet(walletData, keys)` (2 args) while the wrapper passes 1, and several
signatures differ (`send_begin` takes 8 args incl. `expiration_timestamp_opt`,
`blind_receive`/`witness_receive` take an expiration timestamp instead of a duration).
The gateway therefore calls the native module
(`@utexo/rgb-lib-linux-x64/rgblib`) directly through its own thin shim. Verified on
regtest end-to-end with an external signer: watch-only construction
(`keys.mnemonic: null`), `getAddress`, `listUnspents`, `issueAssetNIA`, `blindReceive`,
`witnessReceive`, `createUtxosBegin` → external `signPsbt` → `createUtxosEnd`, and
`sendBegin` → external `signPsbt` → `sendEnd` with the transfer settling on the
recipient. Marshalling rules for the shim:

- all numbers are passed as strings (`feeRate`, `minConfirmations`, `num`, `size`);
- JSON payloads are camelCase (`WalletData`, `SinglesigKeys`, `Recipient`);
- `Assignment` is externally tagged with a JSON number: `{"Fungible": 100}`;
- JS `null` maps to a NULL pointer ONLY for params compiled with the nullable typemap
  (`asset_id_opt`, `num`/`size` opts); `expiration_timestamp_opt` is NOT nullable — always
  pass a concrete unix-timestamp string;
- `send_begin` returns a JSON-serialized object (take `.psbt`), while
  `create_utxos_begin` returns the raw PSBT base64 string.
