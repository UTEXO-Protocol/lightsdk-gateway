# Claude Review Guidance

This repository is the core `lightsdk-gateway` workspace (pnpm): a REST gateway in front of
a private rgb-node-api service (one watch-only rgb-lib wallet per user), the TypeScript
client SDK, and a regtest e2e suite. It is on-chain only. Test with `pnpm test`.

- `packages/gateway` is the REST gateway in front of rgb-node-api. Its native mobile
  client is the separate `rgb-sdk-kotlin-light` repository, which ships its own Rust
  signing core. Treat the gateway's HTTP surface as a published contract: response
  schemas are strict (`additionalProperties: false`), so removing or retyping a field is
  breaking, while adding one is not.
- `packages/client-sdk` is the TypeScript client (web / React Native) and the behavioural
  reference for that contract; `packages/e2e` is the regtest journey suite.
- The parity fixture `packages/client-sdk/test/fixtures/rgblib-parity.json` is
  rgb-lib-authored ground truth: read by relative path, never copied or regenerated here.
- The regtest suites run against the repo's own stack in `regtest/` (bitcoind, electrs,
  esplora, RGB proxy, rgb-node-api), driven by `regtest/regtest.sh`.
- Invariants to enforce in review: no secret ever reaches the gateway (I1), one watch-only
  rgb-lib wallet per user (I2), no cross-user visibility (I3), only the gateway can reach
  rgb-node-api (I4). rgb-node-api keys wallets by master fingerprint alone, so a
  fingerprint must never be shared between users. No `SdkError`, error body or log line
  may render a mnemonic, seed, xprv, private key or bearer token.

Repository conventions:

- Keep changes minimal and scoped to the PR goal.
- Prefer explicit errors over silent fallback behavior.
- Avoid introducing breaking API changes unless the PR explicitly requires it.
- Keep CI/workflow changes conservative and deterministic.
