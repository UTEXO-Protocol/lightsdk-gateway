# Lightweight SDK architecture

Citations are `path:line` in rgb-node-api @ `0280e0e` unless prefixed `rgb-lib`, which refers
to rgb-lib `0.3.0-beta.46-bfa` @ `74a096a`, the revision rgb-node-api pins. Gateway paths are
under `packages/gateway/src` in this repository. Appendix A consolidates all citations.

## Summary

The lightweight SDK puts RGB wallets in front of end users without putting their keys on a
server. Three parts:

- **Client SDKs** — the TypeScript SDK in `packages/client-sdk` (web and React Native, no
  wasm, 500KB bundle budget) and the native Kotlin and Swift SDKs. They generate keys and
  verify-then-sign PSBTs on the user's device.
- **lightsdk-gateway** (`packages/gateway`) — the REST API the SDKs talk to: per-user auth
  and isolation, request queues, idempotency keys and the prepare → sign → complete flows.
- **rgb-node-api** — a private service that hosts one watch-only rgb-lib wallet per user and
  prepares and broadcasts that user's transactions.

Client keys give self-custody of on-chain BTC and of RGB at rest. Each server-prepared RGB
send trusts the server for the commitment content (the send-time limitation below). There is
no custodial balance: the stack is on-chain only.

## Goal and trust model

All key and signing operations run on the user's device. Wallet state, coin selection and RGB
transfer logic run server-side in watch-only wallets that can prepare transactions but never
sign them.

The trust model is four invariants, each testable:

- **I1 — No secret leaves the client.** Mnemonic, seed, xprvs and signing keys exist only on
  the user's device. Enforceable by schema review: no gateway request or response type has a
  key-material field (`schemas/scan.ts` scans every route schema), and no error body or log
  line may render one.
- **I2 — The server is watch-only per user.** The server holds at most a user's account
  xpubs and master fingerprint. rgb-node-api builds each wallet from the three request headers
  with `mnemonic: None` (`src/wallet/state.rs:51`) and has no signing route.
- **I3 — No cross-user visibility.** Each user has their own gateway credential, and no user
  sees or acts on another user's wallet, operations or transfers.
- **I4 — Only the gateway reaches rgb-node-api.** This is mandatory, not hygiene:
  rgb-node-api has no authentication. A request names a wallet by its `xpub-van`, `xpub-col`
  and `master-fingerprint` headers (`src/api/node_api.rs:9-14`), so anyone who can reach it
  and knows a user's xpubs can read that wallet and prepare spends from it, though not sign
  them. It runs on a private network with the gateway as its only peer, and so do the
  indexer and RGB proxy it uses.

## Architecture

```
browser / mobile app
  └─ client SDK  (keys, PSBT verify + sign, RGB invoice decode)
        │  HTTPS (REST)
  lightsdk-gateway  (per-user auth, scoping, FIFO queues, idempotency keys)
        │  HTTP, private network
  rgb-node-api  (one watch-only rgb-lib wallet per user: PSBT preparation,
        │        balances, receives, broadcast)
        └─ shared Electrum indexer (electrs) + RGB proxy
```

The gateway's HTTP surface is a published contract: response schemas are strict, so removing
or retyping a field breaks the mobile clients, while adding one does not. rgb-node-api exposes
a begin/end pair for every money-moving operation (`src/api/mod.rs:42-78`). The server
prepares; the client verifies and signs; the server broadcasts. Appendix B maps every
operation across the three parts.

## The client side

Only the secret-touching operations run on the client:

| Client function                 | Why it stays on the device                                |
| ------------------------------- | --------------------------------------------------------- |
| Key generation / restore        | produces the mnemonic and master key                      |
| Descriptor + address derivation | re-derives deposit and change scripts to check the server |
| PSBT verify + sign              | the only place a signature is made                        |
| PSBT finalize                   | turns signatures into witnesses before submission         |

The TypeScript SDK builds these on audited primitives (`@scure/bip39`, `@scure/bip32`,
`@scure/btc-signer`); the Kotlin and Swift SDKs ship a native signing core. Nothing else
needs client state: the client is stateless between sessions, and its only durable secret is
the mnemonic, backed up as a seed phrase.

**Signing is deliberately boring.** rgb-lib wallets are plain BIP-86 taproot. Descriptors are
built as `<witness version>(key)` (rgb-lib `src/utils.rs:506-529`) and rgb-node-api uses the
default witness version, taproot (`src/wallet/state.rs:54`). Keys derive at
`m/86'/coin'/0'/0`: the standard BTC coin type on the vanilla side, RGB coin types
827166/827167 on the colored side (rgb-lib `src/utils.rs:18-23`, `get_coin_type` at `:278`).
The RGB commitment is **opret**: send-begin sets `CloseMethod::OpretFirst` and calls
`rgb_commit()` while building the PSBT, _before_ the PSBT is returned for signing (rgb-lib
`src/wallet/online.rs:3229-3230`), and signing is an unmodified BDK sign (rgb-lib
`src/wallet/singlesig.rs:271-289`). So the client performs standard BIP-341 key-path signing
of a standard PSBT — no tapret tweaks, no RGB-specific key derivation.

What the client MUST do is **verify before signing** — signing is never blind:

1. Every input is the user's own (script matches a key the client can derive; key-origin
   fingerprint/path in the PSBT matches the user's master fingerprint).
2. Recipient outputs match the user's stated intent (script and amount).
3. Change outputs pay only to scripts the client re-derives from its own descriptors.
4. Fee = inputs − outputs is within the user-approved budget.
5. The OP_RETURN output carries 0 sats.

The gateway returns an intent summary with every prepared operation, built from the request
and its own config rather than parsed back out of the PSBT. The client binds that summary to
what the user actually asked for before check 2 relies on it.

Stated limitation — **send-time trust for RGB state**. The opret commitment bytes are
opaque to the client, and in RGB the bitcoin-level spend of a colored input _is_ the
authorization of whatever transition the server committed to it. The checks above verify
all _bitcoin-value_ movement, but a compromised server can reassign **every RGB
allocation on the spent inputs — amount sent and change alike — to seals it controls**,
and such a transfer validates fine at its recipient: redirection (theft), not merely a
burn, and the client cannot bound it (the server does coin selection). So RGB is safe
**at rest** — nothing moves without a client signature — while every server-prepared
colored spend exposes its inputs' allocations. Interim controls are server-side (hardened
wallet service, independent consignment audit); removing the trust means shipping RGB
validation client-side.

### Deliberately not in the client

- **RGB validation** — consignment validation drags in the full RGB stack; it is what would
  remove the send-time limitation, at the cost of the bundle budget.
- **Chain sync** — needs persistent wallet state and indexer access; rgb-node-api syncs
  watch-only and the client stays stateless.
- **PSBT construction / coin selection** — needs the full UTXO-and-allocation database; the
  client only needs to _verify_ the result, which takes no state beyond its keys.

## Per-user isolation

Isolation lives in the gateway; rgb-node-api only keeps wallets apart by master fingerprint.

- **Credentials.** Each user has an opaque bearer token, returned once at creation and stored
  only as a hash. Users are created by the operator (`POST /v1/users`, operator token).
- **One wallet per user, one user per wallet.** rgb-node-api keys the wallets it has loaded,
  in memory and on disk, by master fingerprint alone (`src/wallet/wallet_thread.rs:206-238`,
  the lookup at `:215`). Two users sharing a fingerprint would therefore share one wallet. The
  gateway lets each fingerprint be registered by exactly one user, claims it before its first
  rgb-node-api call (`wallets/service.ts`), and backs that with a unique index (`db.ts`,
  migration 4). Consequence: the same mnemonic cannot be registered under a second gateway
  user.
- **Ownership map.** The gateway records the recipient id of every receive and the txid of
  every asset send (`scoping.ts`). Prepared operations are scoped to their user: another
  user's operation answers exactly like a missing one (404).
- **Own wallet only.** Balances, unspents, transfers and transactions are read from the
  requesting user's wallet, never from a shared one.

## The custody boundary

Client-held keys cover all user funds: on-chain BTC and RGB allocations on user UTXOs cannot
move without a client signature (for RGB, subject to the send-time limitation above). Neither
the gateway nor rgb-node-api holds a key, and there is no custodial balance.

What a compromised server can do: read balances and history (privacy), refuse or delay
service, and — the one real exposure — redirect the RGB allocations on the inputs of a
colored spend the client signs. It cannot move bitcoin beyond what the client approved,
because checks 1–5 bound every bitcoin-value movement.

## Concurrency and failure handling

rgb-node-api is concurrency-avoidant. One manager thread receives every command for every
wallet and runs it inline (`src/wallet/wallet_thread.rs:200,312`), and a background task asks
that same thread to refresh every loaded wallet every 10 seconds (`src/wallet/context.rs:30-45`,
`src/wallet/wallet_thread.rs:283`). No request races another, but throughput is roughly one
over the mean operation latency across all users, and one slow indexer sync stalls everyone.

The gateway's controls, each in front of that thread:

1. **Per-user FIFO queue with a global concurrency cap** (`queue.ts`) bounds cross-user
   interference; a full queue answers 429 with `retry-after`.
2. **Per-wallet operation queue** (`wallets/queue.ts`) serializes every call on one wallet,
   request-driven or background.
3. **Idempotency keys on money-moving routes** (`idempotency.ts`): request hash → cached
   response. 5xx and 429 answers are not cached, so a retry runs again.
4. **Prepared operations with a TTL** (`wallets/prepare.ts`): an unsigned PSBT expires, and a
   signed PSBT is bound to its operation by txid before anything is broadcast.
5. **Ambiguous completions.** rgb-lib broadcasts before it writes its bookkeeping, so a
   failure after broadcast is answered 502 `COMPLETE_AMBIGUOUS` with the txid recorded. A
   background worker (`workers/completions.ts`) replays the end-call with the PSBT the client
   already signed. It never prepares, signs or broadcasts anything the client did not
   authorize, and it gives up after a bounded number of attempts.
6. **Bounded wallet memory in rgb-node-api.** The gateway keeps an LRU pool of open wallets
   and unloads an evicted one with `/wallet/drop` (`wallets/pool.ts`,
   `wallets/rgbnodeapi.ts`).

Scaling past one rgb-node-api thread needs work on that side: per-wallet worker threads
inside rgb-node-api, or several instances with the gateway routing each fingerprint to one of
them.

## Known gaps and deferred work

- **Pending receives without an asset are not listed.** `/wallet/listtransfers` requires an
  asset id, so a receive created without one stays out of `GET /v1/wallet/transfers` until
  the sender's transfer gives it an asset.
- **Asset schemas.** rgb-node-api supports NIA, IFA off mainnet, and BFA only when opted in
  (`src/wallet/config.rs:25-44`). CFA and UDA cannot be received. BFA must stay off while the
  mobile SDKs reject the `bfa` schema.
- **`SignetCustom` in rgb-node-api.** UTEXO's signet runs as `SignetCustom`, which the
  gateway supports but rgb-node-api's `network` setting does not accept yet: it treats any
  name outside mainnet, testnet, testnet4, signet and regtest as mainnet.
- **Restoring under a new gateway user.** A consequence of the one-user-per-fingerprint rule
  above. Lifting it needs proof that the second user holds the keys, e.g. a signed challenge.
- **No encrypted client backup (VSS).** The client's only durable secret is the mnemonic.
- **Client-side RGB validation**, which would remove the send-time limitation.
- **GraphQL/gRPC front-end** — a gateway-layer swap that changes no SDK surface.

## Appendix

### A. Citation index

rgb-node-api @ `0280e0e`:

- Header identity: `src/api/node_api.rs:9-14`
- Routes: `src/api/mod.rs:34-78` (witness receive `:68`, send-BTC `:70-71`,
  `listtransactions` `:74`, `drop` `:78`)
- Watch-only construction: `src/wallet/state.rs:28-71` (`reuse_addresses: false` `:46`,
  `mnemonic: None` `:51`, default witness version `:54`); blind/witness receive `:74`
- Wallets keyed by fingerprint: `src/wallet/wallet_thread.rs:206-238` (lookup `:215`)
- Single command thread: `src/wallet/wallet_thread.rs:200,312,322`; periodic refresh
  `src/wallet/context.rs:30-45`, `src/wallet/wallet_thread.rs:283`
- Supported asset schemas: `src/wallet/config.rs:25-44`
- Unknown route → 404 `not_found` envelope: `src/api_core/server.rs:136`

rgb-lib `0.3.0-beta.46-bfa` @ `74a096a`:

- Derivation constants: `src/utils.rs:18-23`; `get_coin_type` `:278`; descriptors from xpubs
  `:506-529`
- Opret commitment inside send-begin: `src/wallet/online.rs:3229-3230`
- Plain BDK signing: `src/wallet/singlesig.rs:271-289`
- Watch-only BDK database: `src/wallet/core.rs:335-347`

lightsdk-gateway (`packages/gateway/src`): `queue.ts`, `wallets/queue.ts`, `idempotency.ts`,
`wallets/prepare.ts`, `workers/completions.ts`, `wallets/pool.ts`, `wallets/rgbnodeapi.ts`,
`wallets/service.ts`, `scoping.ts`, `db.ts`, `schemas/scan.ts`.

### B. Operation map

| Operation       | Client               | lightsdk-gateway route                                | rgb-node-api route                      |
| --------------- | -------------------- | ----------------------------------------------------- | --------------------------------------- |
| Keys            | generate / restore   | —                                                     | —                                       |
| Register wallet | sends xpubs only     | `POST /v1/wallet/xpubs`                               | `address` (first call loads the wallet) |
| Deposit address | re-derives to verify | `GET /v1/wallet/address`                              | `address`                               |
| Balances        | —                    | `GET /v1/wallet/balances`                             | `btcbalance`, `listassets`              |
| Unspents        | —                    | `GET /v1/wallet/unspents`                             | `listunspents`                          |
| Transfers       | —                    | `GET /v1/wallet/transfers`                            | `listassets`, `listtransfers` per asset |
| Transactions    | —                    | `GET /v1/wallet/transactions`                         | `listtransactions`                      |
| Receive         | decodes the invoice  | `POST /v1/wallet/receive`                             | `blindreceive` / `witnessreceive`       |
| Sync            | —                    | `POST /v1/wallet/sync`                                | `refresh`                               |
| Send BTC        | verifies + signs     | `POST /v1/onchain/send-btc/prepare` · `/complete`     | `sendbtcbegin` · `sendbtcend`           |
| Send asset      | verifies + signs     | `POST /v1/onchain/send-asset/prepare` · `/complete`   | `sendbegin` · `sendend`                 |
| Create UTXOs    | verifies + signs     | `POST /v1/onchain/create-utxos/prepare` · `/complete` | `createutxosbegin` · `createutxosend`   |
| Fee estimate    | —                    | `GET /v1/onchain/fee-estimate`                        | — (Electrum indexer directly)           |
| Pool eviction   | —                    | —                                                     | `drop`                                  |
