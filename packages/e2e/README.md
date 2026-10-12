# @utexo/rln-gateway-e2e

End-to-end suite for the lightweight SDK: a scripted user journey that talks to the
gateway ONLY through `@utexo/lightweight-client-sdk` over a real HTTP port, while
the harness (`src/setup.ts`) drives the outside world — the regtest faucet and
a counterparty RLN node.

## Required local infrastructure

- An rgb-lightning-node checkout at `RLN_REPO` (default: `../rgb-lightning-node`,
  a sibling of this repository). Its `regtest.sh` and `compose.yaml` provide
  bitcoind, electrs on `127.0.0.1:50001`, the RGB proxy on `:3000` and esplora
  on `:3002`.
- The RLN debug binary: `cargo build` in that checkout
  (`$RLN_REPO/target/debug/rgb-lightning-node`).
- Host ports `3000`, `3002`, `18443`, `50001` free (compose), plus `3201`,
  `3202`, `9901`, `9902` (the two RLN nodes) and `8490` (the gateway).
- Node 20+ and pnpm (`pnpm install`).

## Running

From this repository's root:

```sh
(cd "${RLN_REPO:-../rgb-lightning-node}" && cargo build)   # once, for the RLN binary
pnpm e2e     # builds the workspace, then runs the suite
```

The suite is excluded from the default unit-test command (`pnpm test`); it
only runs via the `e2e` script.

By default the harness runs `ESPLORA=1 ./regtest.sh start` itself (which stops
and wipes any previous regtest state) and leaves the containers running
afterwards. Knobs:

- `E2E_SKIP_STACK=1` — reuse an already-running regtest stack (must have been
  started with `ESPLORA=1`). The two RLN nodes and the gateway are always
  started fresh, with fresh data dirs and fresh client keys, so a reused chain
  is fine.
- `E2E_STOP_STACK=1` — run `./regtest.sh stop` during teardown.

## What the journey covers

create user → client-side key generation → register xpubs → fund the vault from
the faucet → create colorable UTXOs (prepare → verify-before-sign → complete) →
receive an RGB asset from the counterparty → send part of it back on chain
(prepare → verify-before-sign → complete; the only coverage of verify-before-sign
against a real rgb-lib **colored** spend) → BTC deposit into the LN float →
pay a counterparty BOLT11 invoice (with an idempotent replay that must not
double-debit) → create an invoice and get paid → withdraw the float back to the
vault → exact ledger reconciliation.

Invariants asserted throughout: every gateway response is scanned at runtime
for key-material field names and client mnemonics (I1), a second user sees none
of the first user's invoices/payments/transfers (I3), and the RLN admin-token
sentinel and operator token appear in no response and no gateway log line (I4).
