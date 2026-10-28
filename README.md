# lightsdk-gateway

This is the core `lightsdk-gateway` repository: a pnpm workspace implementing the lightweight
SDK architecture described in [`docs/design/lightsdk-architecture.md`](docs/design/lightsdk-architecture.md).
It contains a TypeScript API gateway (`packages/gateway`) in front of a private
[rgb-node-api](https://github.com/UTEXO-Protocol/rgb-node-api) service, the lightweight
browser/mobile client SDK (`packages/client-sdk`) that keeps all key material client-side
(verify-before-sign), and a regtest e2e suite (`packages/e2e`).

rgb-node-api is the only service the gateway depends on. Build, lint and unit tests need
nothing from it; the regtest suites run it from this repository's own regtest stack (see
[Regtest stack](#regtest-stack)). The gateway is on-chain only: BTC and RGB assets on user
UTXOs, with no custodial balance.

## Architecture

```
browser / mobile app
  └─ client SDK  (keys, PSBT verify + sign, RGB invoice decode)
        │  HTTPS (REST)
  lightsdk-gateway  (per-user auth, per-user scoping + FIFO queue, idempotency keys)
        └─ rgb-node-api  (private; one watch-only rgb-lib wallet per user:
              │            PSBT preparation, balances, receives, broadcast)
              └─ shared indexer (electrs / esplora) + RGB proxy
```

The server prepares transactions on the user's watch-only wallet; the client verifies
against its stated intent and signs; the server broadcasts. Neither the gateway nor
rgb-node-api holds a key. Package READMEs: `packages/gateway/README.md` (config
reference, deployment, what the gateway needs from rgb-node-api, the custody boundary)
and `packages/client-sdk/README.md` (quickstart, the verify-before-sign contract);
`packages/e2e/README.md` covers the regtest journey suite.

- **The gateway's HTTP surface is a published contract with out-of-repo consumers** — the
  Kotlin and Swift mobile SDKs. Response schemas are strict (`additionalProperties: false`),
  so removing a field, retyping one, or narrowing an accepted range is breaking; adding a
  field is not. Those clients validate response shapes strictly and refuse anything they
  cannot map, so a silent default is worse than an explicit error.
- **`packages/client-sdk` is the in-repo reference for that contract.** It is the
  behavioural spec the gateway is tested against and the only client exercised by
  `packages/e2e`; web and React Native use it. It also reads the rgb-lib-authored
  `packages/client-sdk/test/fixtures/rgblib-parity.json`, which is what keeps this repo's
  reading of BIP-86 and the RGB coin types honest.

## Deliberately deferred

- **Lightning** — the gateway is on-chain only.
- **Listing pending receives that have no asset yet** — rgb-node-api lists transfers by
  asset only, so `GET /v1/wallet/transfers` omits them until the sender's transfer
  arrives.
- **VSS / encrypted client backup** — the client is stateless between sessions; its only
  durable secret is the mnemonic, backed up as a seed phrase.
- **GraphQL/gRPC front-end** — a gateway-layer swap that changes no SDK surface.

The design doc's "Known gaps and deferred work" section lists the rest, including the
rgb-node-api limits (asset schemas, one wallet thread).

## Workspace commands

```sh
pnpm install
pnpm build   # tsc build of all packages
pnpm test    # unit tests (gateway + client-sdk + the e2e package's
             # infra-free smoke test; the regtest journey is excluded)
pnpm lint    # eslint + prettier check
pnpm format  # prettier --write
pnpm e2e     # regtest e2e journey (requires the regtest stack, see below)
```

Two gateway suites additionally exercise the **real** rgb-node-api against regtest and are
skipped unless opted in (`describe.runIf(process.env['WALLET_REGTEST'] === '1')`):

```sh
./regtest/regtest.sh start   # on a fresh chain
WALLET_REGTEST=1 pnpm --filter @utexo/lightsdk-gateway test wallet-integration
WALLET_REGTEST=1 pnpm --filter @utexo/lightsdk-gateway test onchain-integration
```

Run `wallet-integration` first: the two share a fixture account, and the on-chain suite
creates colorable UTXOs that would break the other's `INSUFFICIENT_FUNDS` assertion.

### Generated files

- `packages/client-sdk/test/fixtures/rgblib-parity.json` — regenerate with
  `pnpm --filter @utexo/lightweight-client-sdk generate:fixtures` on an `@utexo/rgb-lib`
  bump (linux-x64 only: the native module is that package's optional dependency).

## Regtest stack

`regtest/` holds a self-contained docker compose stack — bitcoind, electrs, esplora, the
RGB proxy and rgb-node-api — driven by `regtest/regtest.sh`. It is used by `pnpm e2e` and
the `WALLET_REGTEST` suites.

```sh
./regtest/regtest.sh start                       # fresh chain, all services up
./regtest/regtest.sh mine <blocks>               # mine to the miner wallet
./regtest/regtest.sh sendtoaddress <addr> <btc>  # pay from the miner wallet
./regtest/regtest.sh stop                        # stop and delete all data
```

- rgb-node-api is built from source on the first `start`
  (`https://github.com/UTEXO-Protocol/rgb-node-api.git#main`, several minutes). Some of its
  pinned git dependencies are private, so the build fetches them over SSH with your
  forwarded ssh-agent: the agent needs a key with read access to the UTEXO-Protocol
  repositories. Set `RGB_NODE_API_CONTEXT` to a local checkout or another git ref to test a
  different revision, and rebuild with
  `docker compose -f regtest/compose.yaml build rgb-node-api`.
- Only rgb-node-api (`http://127.0.0.1:34000`) and esplora (`http://127.0.0.1:3002`) are
  published on the host; move them with `REGTEST_RGB_NODE_API_PORT` /
  `REGTEST_ESPLORA_PORT` if those ports are taken. bitcoind, electrs and the RGB proxy are
  reached by rgb-node-api over the compose network, which is why invoices carry
  `rpc://proxy:3000/json-rpc` and the regtest suites configure the gateway's
  `RGB_PROXY_URL` to match.
- rgb-node-api has no authentication and is published on localhost only. Never expose it
  publicly (design doc invariant I4).

To run the gateway by hand against the stack:

```sh
RGB_NODE_API_URL=http://127.0.0.1:34000 \
ESPLORA_URL=http://127.0.0.1:3002 \
RGB_PROXY_URL=rpc://proxy:3000/json-rpc \
GATEWAY_SQLITE_PATH=/tmp/lightsdk-gateway.sqlite \
GATEWAY_OPERATOR_TOKEN=<random, 16+ chars> \
pnpm --filter @utexo/lightsdk-gateway start
```
