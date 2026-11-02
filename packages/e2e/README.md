# @utexo/lightsdk-gateway-e2e

End-to-end suite for the lightweight SDK: a scripted user journey that talks to the
gateway ONLY through `@utexo/lightweight-client-sdk` over a real HTTP port, while
the harness (`src/setup.ts`) drives the outside world — the regtest faucet and
a counterparty wallet on rgb-node-api whose keys the harness holds.

## Required local infrastructure

- Docker with compose v2, for the repo's regtest stack (`regtest/`): bitcoind,
  electrs, the RGB proxy and rgb-node-api. The rgb-node-api image is built
  from source on first start and needs an ssh-agent key with read access to the
  UTEXO-Protocol repositories (see the workspace README, "Regtest stack").
- Host ports `34000` (rgb-node-api) and `50001` (electrs) free, or moved with
  `REGTEST_RGB_NODE_API_PORT` / `REGTEST_ELECTRUM_PORT`, plus `8490` for the gateway
  (`E2E_GATEWAY_PORT`).
- Node 20+ and pnpm (`pnpm install`).

## Running

From this repository's root:

```sh
pnpm e2e     # builds the workspace, then runs the suite
```

The suite is excluded from the default unit-test command (`pnpm test`); it
only runs via the `e2e` script.

By default the harness runs `./regtest/regtest.sh start` itself (which stops and
wipes any previous regtest state) and leaves the containers running afterwards.
Knobs:

- `E2E_SKIP_STACK=1` — reuse an already-running regtest stack. The counterparty,
  the gateway and the client keys are always fresh, so a reused chain is fine.
- `E2E_STOP_STACK=1` — run `./regtest/regtest.sh stop` during teardown.

## What the journey covers

create user → client-side key generation → register xpubs → fund the vault from
the faucet → create colorable UTXOs (prepare → verify-before-sign → complete) →
receive an RGB asset from the counterparty → send part of it back on chain
(prepare → verify-before-sign → complete; the only coverage of verify-before-sign
against a real rgb-lib **colored** spend) → send BTC on chain to the counterparty,
with an idempotent replay of `complete` that must not send twice.

Invariants asserted throughout: every gateway response is scanned at runtime
for key-material field names and client mnemonics (I1), a second user sees none
of the first user's operations, unspents, balances or transfers and cannot claim
its master fingerprint (I3), and the operator token appears in no response and no
gateway log line (I4).

The send-BTC leg needs rgb-node-api `0280e0e` or later (`sendbtcbegin`/`sendbtcend`); the
`v0.2.1` release does not have those routes.
