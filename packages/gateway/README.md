# @utexo/lightsdk-gateway

TypeScript API gateway in front of a private
[rgb-node-api](https://github.com/UTEXO-Protocol/rgb-node-api) service, which hosts one
**watch-only** rgb-lib wallet per user. The gateway owns per-user auth, per-user FIFO
queues with a global concurrency cap, idempotency keys on money-moving routes, the
on-chain prepare → client-signs → complete flows with their intent summaries, and the
user↔resource scoping map. rgb-node-api holds no keys and never signs; neither does the
gateway.

Design authority: `docs/design/lightsdk-architecture.md` (repo root). Trust invariants: no secret ever reaches the gateway (I1), one watch-only wallet per user (I2),
no cross-user visibility (I3), only the gateway can reach the wallet service (I4).

## Running

Requirements: Node 20+, pnpm, and an rgb-node-api instance reachable only from the
gateway (see [rgb-node-api](#rgb-node-api) below for the routes and settings it needs).

```sh
RGB_NODE_API_URL=http://127.0.0.1:34000 \
ELECTRUM_URL=tcp://127.0.0.1:50001 \
RGB_PROXY_URL=rpc://127.0.0.1:3000/json-rpc \
GATEWAY_SQLITE_PATH=/var/lib/lightsdk-gateway/gateway.sqlite \
GATEWAY_OPERATOR_TOKEN=<random, 16+ chars> \
node dist/main.js   # or: pnpm --filter @utexo/lightsdk-gateway start
```

The production entrypoint (`src/main.ts`) runs `loadConfig` → `buildServer` with the
background completions worker → `listen`. `buildServer` starts the worker only when
called with `startWorkers: true` — `main.ts` does this; a library embedding must opt in
explicitly.

Users are created by the operator via `POST /v1/users` (guarded by the operator token);
the response contains the user's opaque bearer token exactly once — only its hash is
stored.

## API

The full reference is [`openapi.json`](openapi.json) (OpenAPI 3.1): every route's request
and response schema, and every error code it can return. It is generated from the route
schemas, so regenerate it after changing a route or schema with
`pnpm --filter @utexo/lightsdk-gateway openapi`; `pnpm test` fails while it is stale.

Auth is one of: the operator token (`x-operator-token` header), the user's bearer token
(`Authorization: Bearer <token>`), or none. Money-moving routes additionally require an
`Idempotency-Key` header of 1–128 characters, scoped to the user (400
`IDEMPOTENCY_KEY_REQUIRED` without it): a replay of the same key **and** the same request
(method, route and body) returns the stored response, error responses included, with an
`x-idempotent-replay: true` header. Completed rows are garbage-collected after 7 days.

Request bodies are JSON of at most 64 KiB. Unknown fields in a body or query string are
removed before the request is processed, not rejected. A route that takes a body needs
one even when every field is optional: send `{}`.

Two details matter for retries. Responses with status ≥ 500 or 429 are deliberately
**not** cached — the claim is released so the request can be retried — and an in-flight
claim whose request never stored a response is reclaimable after 15 minutes, but only by
a retry of the _same_ request (a different body under that key is always 409
`IDEMPOTENCY_KEY_REUSED`). After a 5xx on a `complete` the retry is therefore answered by
the operation's own state rather than by a cached body (see
[Recovering a lost on-chain completion](#recovering-a-lost-on-chain-completion)).

| Method | Path                                | Auth     | Idempotency-Key |
| ------ | ----------------------------------- | -------- | --------------- |
| GET    | `/v1/health`                        | none     | —               |
| POST   | `/v1/users`                         | operator | —               |
| GET    | `/v1/me`                            | bearer   | —               |
| POST   | `/v1/wallet/xpubs`                  | bearer   | —               |
| GET    | `/v1/wallet/address`                | bearer   | —               |
| GET    | `/v1/wallet/balances`               | bearer   | —               |
| GET    | `/v1/wallet/unspents`               | bearer   | —               |
| GET    | `/v1/wallet/transfers`              | bearer   | —               |
| GET    | `/v1/wallet/transactions`           | bearer   | —               |
| POST   | `/v1/wallet/receive`                | bearer   | —               |
| POST   | `/v1/wallet/sync`                   | bearer   | —               |
| POST   | `/v1/onchain/send-btc/prepare`      | bearer   | required        |
| POST   | `/v1/onchain/send-btc/complete`     | bearer   | required        |
| POST   | `/v1/onchain/send-asset/prepare`    | bearer   | required        |
| POST   | `/v1/onchain/send-asset/complete`   | bearer   | required        |
| POST   | `/v1/onchain/create-utxos/prepare`  | bearer   | required        |
| POST   | `/v1/onchain/create-utxos/complete` | bearer   | required        |
| GET    | `/v1/onchain/operations/:opId`      | bearer   | —               |
| GET    | `/v1/onchain/fee-estimate`          | bearer   | —               |

Every response carries an `x-request-id` header (a fresh random UUID per
request; a caller-supplied one is never adopted). Error bodies carry only `code`
and `message` — the wallet failure they were mapped from is logged under that id
and nowhere else, so it is the handle to quote when asking an operator about a
`COMPLETE_AMBIGUOUS`.

### Errors

Every error the gateway raises is `{"error": {"code", "message"}}`; a path it does not
serve answers Fastify's default 404 body instead. Notable codes (`openapi.json` lists all
of them, per route):

| Code                              | Status | Meaning                                                                                                                                                                                                                                        |
| --------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QUEUE_FULL`                      | 429    | Per-user queue depth exceeded; a `retry-after` header accompanies it.                                                                                                                                                                          |
| `TRANSPORT_ENDPOINT_NOT_ALLOWED`  | 400    | Consignment endpoint outside `GATEWAY_RGB_TRANSPORT_ALLOWLIST` (SSRF guard).                                                                                                                                                                   |
| `WALLET_REQUEST_REJECTED`         | 400    | rgb-lib rejected the request itself — bad recipient id, asset id, address, fee rate or transport endpoint. Detail stays server-side.                                                                                                           |
| `INSUFFICIENT_FUNDS`              | 400    | Not enough confirmed bitcoins, assets or allocation slots for an on-chain operation.                                                                                                                                                           |
| `PSBT_REJECTED` / `PSBT_MISMATCH` | 400    | The signed PSBT was rejected, or does not correspond to the prepared operation.                                                                                                                                                                |
| `IDEMPOTENCY_KEY_REUSED`          | 409    | Same key, different request body.                                                                                                                                                                                                              |
| `IDEMPOTENCY_IN_FLIGHT`           | 409    | A request with this key is still running.                                                                                                                                                                                                      |
| `XPUBS_MISMATCH`                  | 409    | Different xpubs are already registered for this user; registration is permanent.                                                                                                                                                               |
| `FINGERPRINT_IN_USE`              | 409    | Another user already registered this master fingerprint. rgb-node-api keys wallets by fingerprint alone, so it cannot be shared (I3).                                                                                                          |
| `OP_EXPIRED`                      | 410    | The prepared on-chain operation passed `GATEWAY_ONCHAIN_OP_TTL_SECONDS`; prepare again.                                                                                                                                                        |
| `AMOUNT_NOT_REPRESENTABLE`        | 502    | The wallet holds an amount above 2^53−1, which JSON numbers cannot carry exactly. Permanent, and not the caller's fault: reported rather than silently rounded (see Known limitations).                                                        |
| `FEE_ESTIMATE_UNAVAILABLE`        | 502    | The indexer gave no usable fee estimate. Detail stays server-side.                                                                                                                                                                             |
| `WALLET_OPERATION_UNSUPPORTED`    | 501    | The configured rgb-node-api has no route for this operation (see [rgb-node-api](#rgb-node-api)). Nothing was attempted. Detail stays server-side.                                                                                              |
| `COMPLETE_AMBIGUOUS`              | 502    | The wallet failed while completing an on-chain op, after rgb-lib may already have broadcast. The op stays pending with its txid recorded; read it back with `GET /v1/onchain/operations/:opId` and retry `complete` to finish the bookkeeping. |

## What the wallet reads carry for a verifying client

A client that keeps its own keys has to be able to check what the gateway tells it, and to
act on RGB state afterwards. Three things in the wallet responses exist for that:

- `GET /v1/wallet/address` returns `derivation` — `account`, `keychain`, `index`,
  `derivationPath` and `scriptHex` — so the address can be re-derived from the client's own
  seed before it is shown as a deposit target. `null` means the gateway could not attribute
  it; see Known limitations.
- `GET /v1/wallet/transfers` and `POST /v1/wallet/receive` return `batchTransferIdx`.
  rgb-lib keys refresh, fail and delete by the **batch** index, not by `idx`, so without it
  a client cannot address the transfer it just read or created.
- `GET /v1/wallet/unspents` returns `pendingBlinded` per UTXO, and every allocation carries
  its full `assignment` (`{kind, amount}`) alongside the fungible `amount` summary. Free
  allocation slots cannot be counted from `allocations` alone — a pending blind receive
  reserves a slot before it holds an allocation — and a non-fungible assignment has no
  `amount` to summarize.

`assignment.kind` is the rgb-lib variant name verbatim (`Fungible`, `Any`,
`InflationRight`, `NonFungible`, ...), so a variant added upstream arrives named rather
than dropped.

## On-chain transactions

`GET /v1/wallet/transactions` lists the wallet's on-chain transactions; rgb-node-api
syncs against the indexer first, so there is no skip-sync variant. `?txid=<64 lowercase
hex>` narrows it to that one transaction, and an unknown txid answers an empty list, not
an error. rgb-node-api has no lookup by txid, so the gateway filters the full list.

Each entry is `{transactionType, txid, receivedSat, sentSat, feeSat, confirmationTime}`.
`transactionType` is rgb-lib's variant verbatim (`Incoming`, `SendBtc`, `CreateUtxos`,
`RgbSend`, `Drain`, …). `confirmationTime` is `{height, timestamp}`, or `null` while
unconfirmed. `sentSat` and `receivedSat` follow BDK: the value of the wallet's own inputs
the transaction spent and of the outputs it pays back to the wallet, change included.
They are not net amounts — what left the wallet is `sentSat - receivedSat`, fee included.

## Fee estimates

`GET /v1/onchain/fee-estimate?blocks=N` (default `N=6`, range 1..1008) answers
`{blocks, feeRateSatPerVb, sourceBlocks}` from the shared Electrum indexer
(`blockchain.estimatefee` on `ELECTRUM_URL`). Clients cannot reach the indexer themselves
— it sits behind the gateway with rgb-node-api and the RGB proxy — so without this they
either hardcode a rate or send none and take the 2 sat/vB default.

`feeRateSatPerVb` is a whole sat/vB in the same 1..1000 range every fee-taking route
accepts, so it can be passed straight back. The indexer's rate is rounded **up**, never
down, so a client signing at exactly this rate does not under-pay the estimate. The
indexer is asked for exactly the requested target, so `sourceBlocks` always equals
`blocks`. Each target's answer is cached for 30s, so a burst of clients is one indexer
call. It needs no `Idempotency-Key`, no registered wallet, and is not queued behind the
per-user wallet work: a client needs a fee rate _before_ it can prepare anything.

An indexer that gives no usable estimate answers 502 `FEE_ESTIMATE_UNAVAILABLE`. That is
normal on a quiet test chain, where the indexer's bitcoind has seen too few transactions
to estimate; send the 2 sat/vB default or a rate of your own. An indexer that does not
answer within 10 seconds answers 504 `UPSTREAM_TIMEOUT`.

## Recovering a lost on-chain completion

`complete` can leave a client without an answer: a client-side timeout, a crash, or the
502 `COMPLETE_AMBIGUOUS` the gateway returns when the wallet fails _after_ rgb-lib may
already have broadcast (rgb-lib broadcasts before it writes its bookkeeping). The
operation row is the durable record of what happened, and
`GET /v1/onchain/operations/:opId` reads it back.

```jsonc
{
  "opId": "…", "kind": "send_btc",
  "state": "pending",              // pending | completed | expired
  "txid": "…",                     // final when completed; possibly-broadcast otherwise
  "mayHaveBroadcast": true,        // state != completed AND a txid is recorded
  "intent": { … },                 // the same summary prepare returned
  "createdAt": 1700000000000, "expiresAt": 1700000900000
}
```

How to read it:

| `state`     | `mayHaveBroadcast` | Meaning                                           | Do                                                                                      |
| ----------- | ------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `completed` | `false`            | Done; `txid` is final                             | nothing                                                                                 |
| `pending`   | `false`            | Prepared, never broadcast                         | sign and `complete`, or let it expire                                                   |
| `pending`   | `true`             | **The transaction may already be on the network** | nothing — **the gateway finishes this itself** (below); poll until it reads `completed` |
| `expired`   | `false`            | Past TTL, never broadcast                         | prepare again                                                                           |
| `expired`   | `true`             | Past TTL while ambiguous                          | same: the gateway still finishes it, and completion is not blocked by the TTL           |

Three properties worth relying on. It takes **no** `Idempotency-Key` and is not queued
behind the per-user wallet work, so it answers even while the `complete` you are asking
about is still running — safe to poll. It never echoes the PSBT; the client already holds
it from `prepare`. And an operation belonging to another user is reported as `404
OP_NOT_FOUND`, identical to one that does not exist (I3).

Expiry is **derived** on read, never written: an op past `expiresAt` reports `expired`
here while the stored row stays `pending` until it is completed.

### The gateway resolves ambiguous completions itself

A client that gets a 502 is entitled never to retry: a 5xx is not proof the send failed,
and a retry it cannot prove safe could, for all it knows, send twice. So the side that
_can_ prove it is safe does it. On the ambiguous path the gateway retains the signed PSBT
next to the recorded txid, and a background worker (`src/workers/completions.ts`) replays
the wallet's end-call until the bookkeeping lands. Replaying is safe because rgb-lib
re-broadcasts and treats a transaction the indexer already knows as success, so the retry
only redoes the write that failed.

Three boundaries on that:

- It only ever replays a PSBT **the client itself already submitted** to `complete`, for
  an op whose txid is already recorded. It never prepares, re-signs, or broadcasts
  anything the client did not authorize, and an op that never reached broadcast (no txid)
  is left alone.
- The retained PSBT must still be the transaction the row's txid names, checked before any
  wallet call; otherwise the op is left for an operator rather than completed under a
  transaction its intent does not describe.
- It stops after `GATEWAY_COMPLETIONS_MAX_ATTEMPTS`. An op that runs out of attempts stays
  `pending` with its txid and needs a human: check the chain (a block explorer for your
  network) for the recorded txid, then mark the row completed or resolve it by hand. `CompletionsWorker.unresolved()` lists
  exactly those rows and is what a health check should alert on.

The op TTL deliberately does **not** apply here. The TTL exists so an _unsigned_ PSBT
stops being completable; an ambiguous op's transaction is signed and probably confirmed,
and refusing to record that after ten minutes would strand the bookkeeping for money that
already moved.

## Configuration reference

All configuration comes from environment variables (`src/config.ts`).

Required:

| Variable                 | Meaning                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `RGB_NODE_API_URL`       | Base URL of the rgb-node-api service hosting the user wallets (reachable only from the gateway).                                  |
| `RGB_PROXY_URL`          | Default RGB consignment proxy for asset sends. Keep it identical to rgb-node-api's `proxy_address`, which receive invoices carry. |
| `GATEWAY_SQLITE_PATH`    | Path to the gateway SQLite database (`:memory:` for tests).                                                                       |
| `GATEWAY_OPERATOR_TOKEN` | Guards the bootstrap-only `POST /v1/users` route. Minimum 16 characters.                                                          |

Optional (default in parentheses):

| Variable                                      | Meaning                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ELECTRUM_URL` (unset)                        | Electrum server for `GET /v1/onchain/fee-estimate`, as `tcp://host:port` or `ssl://host:port`. Use rgb-node-api's `indexer_address` ([Indexer requirements](#indexer-requirements)). Unset, the gateway starts with a warning and that route answers 502 `FEE_ESTIMATE_UNAVAILABLE`; a malformed value still stops startup. |
| `GATEWAY_HOST` (`127.0.0.1`)                  | Interface the gateway listens on.                                                                                                                                                                                                                                                                                           |
| `GATEWAY_PORT` (`8480`)                       | Gateway HTTP port.                                                                                                                                                                                                                                                                                                          |
| `GATEWAY_WALLET_SERVICE_TIMEOUT_MS` (`60000`) | Per-call timeout for rgb-node-api requests. A `complete` that times out is reported as `COMPLETE_AMBIGUOUS`, since the service may still finish it.                                                                                                                                                                         |
| `GATEWAY_BITCOIN_NETWORK` (`Regtest`)         | Network of the user wallets: `Mainnet`, `Testnet`, `Testnet4`, `Signet`, `SignetCustom`, `Regtest`. Must match rgb-node-api's `network`; the gateway uses it to decode addresses and attribute deposit addresses. **UTEXO's signet runs as `SignetCustom`**; `Signet` means Bitcoin's _default_ signet — see below.         |
| `GATEWAY_WALLET_MAX_OPEN` (`32`)              | LRU capacity of the open-wallet pool. An evicted wallet is also dropped from rgb-node-api's memory (`/wallet/drop`), so this bounds what that service keeps loaded.                                                                                                                                                         |
| `GATEWAY_ONCHAIN_OP_TTL_SECONDS` (`600`)      | Seconds an unsigned prepare-step PSBT stays completable before expiring.                                                                                                                                                                                                                                                    |
| `GATEWAY_RGB_TRANSPORT_ALLOWLIST` (empty)     | Comma-separated extra RGB consignment-proxy endpoints users may pin in send-asset requests. `RGB_PROXY_URL` is always allowlisted; anything else is rejected with 400 `TRANSPORT_ENDPOINT_NOT_ALLOWED` (SSRF guard — the wallet service dials these).                                                                       |
| `GATEWAY_COMPLETIONS_INTERVAL_MS` (`30000`)   | Poll interval of the ambiguous-completion worker.                                                                                                                                                                                                                                                                           |
| `GATEWAY_COMPLETIONS_MAX_ATTEMPTS` (`5`)      | Attempts at finishing one ambiguous operation before it is left to an operator.                                                                                                                                                                                                                                             |
| `GATEWAY_QUEUE_GLOBAL_CONCURRENCY` (`4`)      | Max downstream operations running at once across all users.                                                                                                                                                                                                                                                                 |
| `GATEWAY_QUEUE_PER_USER_DEPTH` (`16`)         | Max queued+running operations per user before 429.                                                                                                                                                                                                                                                                          |

## rgb-node-api

### It is gateway-only

rgb-node-api has no authentication: a request names a wallet by three headers
(`xpub-van`, `xpub-col`, `master-fingerprint`), so anyone who can reach it and knows a
user's xpubs can read that wallet and prepare spends from it. It must therefore be
reachable **only from the gateway** — bind it to localhost on the same host, or keep it on
a private network segment with the gateway as the sole peer. **Never expose it
publicly** (invariant I4). The same applies to the indexer and RGB proxy it uses.

It also keys the wallets it has loaded — in memory and on disk — by master fingerprint
alone. The gateway therefore lets each fingerprint be registered by exactly one user and
answers any other with 409 `FINGERPRINT_IN_USE` before calling rgb-node-api at all (a
`UNIQUE` index backs this up). Do not let anything but the gateway register wallets on the
same rgb-node-api instance.

### Routes the gateway calls

All `POST /wallet/<route>` with JSON bodies:

| Gateway call                | rgb-node-api route                                    |
| --------------------------- | ----------------------------------------------------- |
| address, balances, unspents | `address`, `btcbalance`, `listassets`, `listunspents` |
| transfers for one asset     | `listtransfers` `{asset_id}`                          |
| on-chain transactions       | `listtransactions`                                    |
| blind receive               | `blindreceive`                                        |
| witness receive             | `witnessreceive`                                      |
| send BTC                    | `sendbtcbegin` → `{psbt}`, `sendbtcend` → `{txid}`    |
| send asset                  | `sendbegin`, `sendend`                                |
| create UTXOs                | `createutxosbegin`, `createutxosend`                  |
| sync + refresh              | `refresh`                                             |
| pool eviction / shutdown    | `drop`                                                |

All of them are in rgb-node-api from `0280e0e` on. The `v0.2.1` release predates
`witnessreceive`, `sendbtcbegin` and `sendbtcend`; against it, `POST /v1/wallet/receive`
with `mode: "witness"` and `POST /v1/onchain/send-btc/prepare` answer 501
`WALLET_OPERATION_UNSUPPORTED`.

`listtransfers` requires an asset id, so `GET /v1/wallet/transfers` without `assetId`
lists the wallet's assets and then each asset's transfers (see Known limitations).

### Settings to align

- `network` must match `GATEWAY_BITCOIN_NETWORK`. For `SignetCustom` that takes an
  rgb-node-api that accepts `network = "SignetCustom"`. As of `0d81897` it does not: it
  knows `mainnet`, `testnet`, `testnet4`, `signet` and `regtest`, and treats any other
  value as mainnet, so wallets on a custom signet fail to open.
- `indexer_address` must be the Electrum server `ELECTRUM_URL` names, so wallets and fee
  estimates read the same chain.
- `proxy_address` is what receive invoices carry as their transport endpoint; keep
  `RGB_PROXY_URL` identical to it.
- Leave `bfa_enabled` off: the gateway passes asset schemas through verbatim and the
  mobile client rejects a `bfa` asset.
- rgb-node-api supports the NIA and (off mainnet) IFA schemas only. CFA and UDA assets
  cannot be received through it.

### RGB proxy protocol 1.0

rgb-node-api main is built on rgb-lib-bfa, which speaks RGB proxy protocol **1.0** and
nothing else: the proxy at `proxy_address` must report `protocol_version` `1.0`, as
`rgb-proxy-server` 0.4.0 does (0.3.0 speaks 0.2). Check with
`curl -s -X POST <proxy>/json-rpc -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":"1","method":"server.info","params":null}'`.

Protocol 1.0 encrypts each consignment to its recipient, so an invoice carries the
receiver's Ed25519 key as `pk`:

- `POST /v1/wallet/receive` returns that key as `publicKey`.
- A sender passes the recipient invoice's `pk`, `expiry` and (when present) `enc` to
  `POST /v1/onchain/send-asset/prepare` as `recipientPublicKey`,
  `recipientExpirationTimestamp` and `recipientEncryption`; the intent echoes them. Without
  the key the send answers 400 `INVALID_RECIPIENT_PUBLIC_KEY`.

### Indexer requirements

The gateway and rgb-node-api share one Electrum indexer: rgb-node-api's `indexer_address`
and the gateway's `ELECTRUM_URL` name the same server, as `tcp://host:port` or
`ssl://host:port`. It must be a full Electrum server, such as romanz/electrs (what the
regtest stack runs) or Fulcrum, because rgb-lib checks three things when a wallet opens:

- the server's genesis block matches the configured network;
- a probe transaction can be fetched. That is a fixed, known transaction on mainnet,
  testnet, testnet4, the default signet and regtest, and the coinbase of block 1 on
  `SignetCustom`;
- the server returns verbose transactions (`blockchain.transaction.get` with `verbose`).

Blockstream/mempool `electrs` fails the last check over its Electrum port (`verbose
transactions are unsupported by the provided electrum service`), so it cannot be the
indexer. rgb-node-api also accepts an esplora REST URL as `indexer_address`; don't use
one, since the gateway reads its fee estimates over Electrum and both must read the same
chain.

### Signet: `SignetCustom`

UTEXO's signet is its own signet, with its own challenge, not Bitcoin's default public
signet, so it runs as **`SignetCustom`**: set `GATEWAY_BITCOIN_NETWORK=SignetCustom` and
rgb-node-api's `network` to match. `Signet` means only the default public signet.

The two are distinct chains to RGB, and they tag invoices differently: `sb` for `Signet`,
`sbc` for `SignetCustom`. Assets and invoices made under one are not valid under the
other. Every signet has the same genesis block, so the genesis check cannot tell them
apart. Over Electrum, `Signet` on a custom signet fails the probe-transaction check
instead, because its probe is a default-signet transaction.

### Diagnosing a failed `POST /v1/wallet/xpubs`

Both mistakes surface as a wallet-open failure on rgb-node-api that names neither the
setting nor the fix. The gateway log carries the rgb-lib variant
(`rgb-node-api /wallet/address -> 500 InvalidIndexer: …`); rgb-node-api's own log
carries the detail:

```
InvalidIndexer { details: "resolver is for another chain-network pair" }
InvalidIndexer { details: "... verbose transactions are unsupported ..." }
```

If that route fails on a fresh deployment while every other route works, check these two
first. Two commands settle it:

```sh
# 1. Does the indexer return verbose transactions?
#    (result = usable, error = not a full Electrum server: use romanz/electrs or Fulcrum)
printf '{"jsonrpc":"2.0","id":1,"method":"blockchain.transaction.get","params":["<a txid on your chain>",true]}\n' | nc <host> <port>

# 2. Is this the DEFAULT signet? (error = a custom signet, so use SignetCustom)
printf '{"jsonrpc":"2.0","id":1,"method":"blockchain.transaction.get","params":["8153034f45e695453250a8fb7225a5e545144071d8ed7b0d3211efa1f3c92ad8",false]}\n' | nc <host> <port>
```

For an `ssl://` indexer, use `openssl s_client -quiet -connect <host>:<port>` in place of
`nc <host> <port>`.

## The custody boundary, honestly

Every user fund is at rest on user keys: on-chain BTC and RGB allocations on user UTXOs
cannot move without a client signature, and there is no custodial balance. Neither the
gateway nor rgb-node-api can sign. The one stated limitation, verbatim from
`docs/design/lightsdk-architecture.md`:

> Stated limitation — **send-time trust for RGB state**. The opret commitment bytes are
> opaque to the client, and in RGB the bitcoin-level spend of a colored input _is_ the
> authorization of whatever transition the server committed to it. The checks above verify
> all _bitcoin-value_ movement, but a compromised server can reassign **every RGB
> allocation on the spent inputs — amount sent and change alike — to seals it controls**,
> and such a transfer validates fine at its recipient: redirection (theft), not merely a
> burn, and the client cannot bound it (the server does coin selection). So RGB is safe
> **at rest** — nothing moves without a client signature — while every server-prepared
> colored spend exposes its inputs' allocations. Interim controls are server-side (hardened
> wallet service, independent consignment audit); removing the trust means shipping RGB
> validation client-side.

## Known limitations

- **Pending receives without an asset are not listed.** A receive created without an
  `assetId` has no asset until the sender's transfer arrives, and rgb-node-api lists
  transfers by asset only. Until then, `GET /v1/wallet/transfers` leaves it out; the
  client already holds its `recipientId` and `batchTransferIdx` from the
  `POST /v1/wallet/receive` response. Once the transfer arrives it is listed under its
  asset.
- **rgb-node-api runs every wallet operation on one thread.** All users' calls, and its
  periodic background refresh of every loaded wallet, are serialized on a single worker,
  so one slow indexer sync stalls everyone. `GATEWAY_QUEUE_GLOBAL_CONCURRENCY` bounds how
  much the gateway queues there, but not that service's throughput.
- **Amounts above 2^53−1 are reported, not rounded.** rgb-lib counts assets in u64 while
  JSON numbers are doubles, so a balance or assignment above `Number.MAX_SAFE_INTEGER`
  cannot round-trip. It is detected exactly (any such u64 decodes to at least 2^53) and
  answered with 502 `AMOUNT_NOT_REPRESENTABLE` rather than served as a wrong number.
  Carrying such amounts losslessly needs decimal-string fields on the wire, which is a
  breaking change to the wallet read routes and is deferred; until then an asset with a
  supply that large is unusable through this gateway rather than silently mis-reported.
- **Address attribution is best-effort.** `GET /v1/wallet/address` reports the derivation
  it recovered by re-deriving candidates from the registered xpub and matching the script,
  because rgb-lib's `get_address` returns only the encoded address. The scan follows the
  user's own high-water mark plus a window, so it covers sequential use; a wallet restored
  far past that window reports `derivation: null` (rgb-node-api builds its wallets with
  `reuse_addresses = false`). A client that needs ownership proof must treat null as
  unproven — it is the same position it was in when the route returned a bare string.
