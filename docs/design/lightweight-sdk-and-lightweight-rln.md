# Lightweight client-side-signing SDK + lightweight RLN

Citations are `path:line` in rgb-lightning-node (tree @ `db194f7`) unless prefixed `rgb-lib`,
which refers to the pinned `rgb-lib-wasm` dependency checkout @ `2610d4a`. Appendix A
consolidates all citations.

## Executive summary

Two ways to put RLN in front of end users:

- **Lightweight SDK** — a 100–500KB TypeScript client (no wasm) that generates keys and
  verifies-then-signs PSBTs on the user's device, driving one shared RLN instance through an
  API gateway. Client keys give self-custody of on-chain BTC and of RGB at rest; each
  server-prepared RGB send trusts the server for the commitment content (Block 1's
  send-time limitation); the Lightning working balance on the shared node stays custodial
  by protocol, bounded by capped float, auto-sweep and swaps (Block 1).
- **Lightweight RLN wasm** — the full node in the browser, self-custody of everything. Two
  config-only build changes take the shipped artifact from today's 23MB to a verified 13MB
  raw / 4.9MB gzip, with ~10MB / ~4MB a realistic next target (Block 2).

Concurrency, in one sentence: RLN is concurrency-avoidant, not concurrency-unstable — a
global lock serializes the entire REST API (a throughput/availability problem a shared node
multiplies), while the fund-safety hazards found are latent behind that lock — so gateway
per-user serialization and idempotency keys are launch prerequisites for the lightweight SDK,
and nothing blocks the lightweight RLN wasm variant (Block 3).

Recommended sequencing: (1) land the Phase-0 build tuning now — one small PR, the largest
size win per line changed; (2) build the lightweight SDK and its gateway — it reuses today's
REST surface and needs no RLN restructuring beyond the small Block-3 fixes; (3) keep the
wasm node as the self-custody end state.

## Block 1 — Lightweight SDK: client-side signing against one shared RLN

### Goal and trust model

Build the smallest possible web/mobile SDK (TypeScript, no wasm, 100–500KB budget) in which
**all key and signing operations run on the user's device**, while wallet state, RGB
transfer logic and Lightning run in **one shared RLN instance** behind an API gateway. This
inverts today's default deployment, which is custodial end to end: `/init` returns the
mnemonic over REST (`src/routes.rs:2879-2906`) and `/unlock` receives the wallet password
(`src/routes.rs:5511`).

The trust model is four invariants, each testable:

- **I1 — No secret leaves the client.** Mnemonic, seed, xprvs, signing keys, backup
  passwords and VSS keys exist only on the user device. Enforceable by schema review: no
  gateway API request or response type contains a key-material field.
- **I2 — The server is watch-only per user.** The server holds at most per-user account
  xpubs + master fingerprint. rgb-lib supports this first-class: `WalletData.mnemonic` is
  `Option` (rgb-lib `src/wallet/offline.rs:953-954`), a `watch_only` wallet mode exists
  (rgb-lib `src/wallet/offline.rs:984,1075`), and descriptors build from xpubs alone
  (rgb-lib `src/utils.rs:335-357`).
- **I3 — No secret is shared between users.** Each user has their own gateway identity and
  credentials; nothing key-related is pooled.
- **I4 — Clients never reach RLN directly.** The RLN admin token is held by the gateway
  only. This is mandatory, not hygiene: RLN is single-tenant — one wallet, one channel set,
  one unlocked state per process (`src/utils.rs:88,146-180,188-221`) — its biscuit auth has
  admin/read-only/custom roles but **no user dimension** (`src/auth.rs:107-145`), and CORS
  is permissive (`src/main.rs:281`). Any client that can reach RLN can act on the whole
  node.

### Architecture

```
browser / mobile app
  └─ lightweight TS SDK  (keys, PSBT verify + sign, invoice decode)
        │  HTTPS (REST today; GraphQL/gRPC are gateway-layer options)
  API gateway  (per-user auth, per-user scoping + FIFO queue, idempotency keys)
        ├─ per-user watch-only rgb-lib wallets  (PSBT preparation, balances, receives)
        └─ single RLN instance  (admin token; LN channels, swaps, RGB transfers)
              └─ shared esplora + RGB proxy
```

REST is what exists today: 70 paths in `openapi.yaml`, registered in
`src/main.rs:167-256`, covering node lifecycle/admin, auth, on-chain wallet, RGB assets and
transfers, LN peers/channels, LN payments/invoices, swaps, async payments, infra checks and
VSS. `@utexo/rgb-sdk-web` already isolates the node behind
`src/interfaces/IRlnNodeBinding.ts`, whose methods map ~1:1 onto these endpoints, so the
SDK surface stays stable while the transport is swapped. GraphQL or gRPC would be a gateway
front-end choice; neither requires RLN changes.

Preparation of user on-chain transactions bypasses RLN: the gateway (or a small wallet
service beside it) runs one **watch-only rgb-lib wallet per user** from that user's xpubs
and drives the existing begin/end split (`send`, `send_btc`, `create_utxos`, `drain_to` —
Appendix C). The server prepares; the client verifies and signs; the server broadcasts.

### The lightweight rgb-lib clone (client side)

Of the 53 methods rgb-lib-wasm exports, only **7 touch secrets** and must run client-side;
39 are stateful and stay server-side watch-only; the rest are constructors or pure decoding
(full classification in Appendix C). The clone implements, in TypeScript over audited
primitives already in the dependency tree (`@scure/bip39`, `@scure/bip32`,
`@scure/btc-signer`):

| Client function                 | Replaces (rgb-lib `bindings/wasm/src/lib.rs`) | Built on                        |
| ------------------------------- | --------------------------------------------- | ------------------------------- |
| Key generation / restore        | `generate_keys:47`, `restore_keys:56`         | `@scure/bip39` + `@scure/bip32` |
| Descriptor + address derivation | (client re-derives to verify change)          | `@scure/bip32`                  |
| PSBT verify + sign              | `sign_psbt:260`                               | `@scure/btc-signer`             |
| PSBT finalize                   | `finalize_psbt:269`                           | `@scure/btc-signer`             |

The remaining secret-touching exports (`backup`/`restore_backup`, `configure_vss_backup` —
Appendix C) get **no client equivalent**: the client is stateless between sessions, its only
durable secret is the mnemonic (backed up as a seed phrase), and server-side state lives in
the gateway's own database, not a VSS-encrypted client archive.

**Signing is deliberately boring.** rgb-lib wallets are plain BIP-86-style taproot:
descriptors are `tr(key)` for both keychains (rgb-lib `src/utils.rs:414-461`), derived at
`m/86'/coin'/0'/0` (standard BTC coin type vanilla-side, RGB coin types 827166/827167
colored-side, rgb-lib `src/utils.rs:14-19`). The RGB
commitment in this fork is **opret**: `send_begin` sets `CloseMethod::OpretFirst` and calls
`rgb_commit()` while building the PSBT, _before_ the PSBT is returned for signing (rgb-lib
`src/wallet/online.rs:1779-1784,1951-1963`); `sign_psbt` is an unmodified BDK sign
(rgb-lib `src/wallet/offline.rs:1939-1959`). So the client performs standard BIP-341
key-path signing of a standard PSBT — no tapret tweaks, no RGB-specific key derivation.

What the client MUST do is **verify before signing** — signing is never blind:

1. Every input is the user's own (script matches a key the client can derive; key-origin
   fingerprint/path in the PSBT matches the user's master fingerprint).
2. Recipient outputs match the user's stated intent (script and amount).
3. Change outputs pay only to scripts the client re-derives from its own descriptors.
4. Fee = inputs − outputs is within the user-approved budget.
5. The OP_RETURN output carries 0 sats.

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
validation client-side, i.e. the wasm variant.

### Per-user isolation mechanics

Per-user isolation lives entirely in the gateway; RLN has none to offer. Inside one RLN
process the wallet, channel set and payment/transfer state are inherently shared
(`src/utils.rs:188-221`) — there is no per-user storage-dir or namespace. Therefore:

- Each user gets their own gateway credential; if biscuit tokens are minted per user, they
  use **per-user keypairs** so one user's token can never verify as another's. RLN itself
  only ever sees the gateway's admin token (I4).
- The gateway owns the user↔resource map (invoices, payment hashes, allocations, swap ids)
  in its own database and filters every RLN response through it — never proxying raw, since
  RLN list endpoints return the whole node's state. Per-user watch-only wallets (I2)
  isolate on-chain state without touching RLN.

### The custody boundary, honestly

Client-held keys cover **at-rest user funds**: on-chain BTC and RGB allocations on user
UTXOs cannot move without a client signature (for RGB, subject to the send-time limitation
above). They do **not** cover the Lightning working balance — an LN protocol constraint,
not an implementation gap: channel funds are controlled by the channel keys and the shared
node is their single owner, so balances inside its channels (in-flight HTLCs, routed
float, funds awaiting sweep) are custodial.

Mitigations, cheapest first (effort classes are estimates):

| Mitigation                                                                                                                                                                                                        | Where                      | Effort       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------ |
| Capped float: hard per-user + global ceiling on custodial LN balance                                                                                                                                              | gateway policy             | days         |
| Auto-sweep: above a threshold, prepare on-chain sweep to user keys, client signs                                                                                                                                  | gateway + client SDK       | days         |
| Submarine/atomic swaps for trust-minimized in/out via the existing swap API (`/makerinit`, `/makerexecute`, `/taker`, `src/main.rs:228-229,246`) and UTEXO thunder-swap                                           | gateway + existing RLN API | weeks        |
| Per-user signer over a WebSocket `ExternalSignerTransport` (`src/signer/transport.rs:56`; today framed TCP + mTLS, `src/signer/remote/mod.rs`, browser-unreachable; `/initexternalsigner`: `src/main.rs:255-256`) | RLN + SDK                  | weeks        |
| Per-user RLN nodes, or the wasm node in the browser (Block 2) — full self-custody                                                                                                                                 | infra / SDK                | weeks–months |

### Deliberately NOT in the client

- **RGB validation** — consignment validation drags in the full RGB stack; that is the wasm
  variant, not the lightweight SDK approach.
- **Chain sync** — requires persistent wallet state and indexer access; the server syncs
  watch-only and the client stays stateless between sessions.
- **LN state** — channel keys and state belong to a node; a client-side LN node is the wasm
  variant.
- **PSBT construction / coin selection** — needs the full UTXO-and-allocation database;
  the client only needs to _verify_ the result, which requires no state beyond its keys.

## Block 2 — Lightweight RLN wasm: build and ship best practices

### Where the size goes (measured)

| Build                         | Raw   | Gzip  | What it is                                                                                                                                                                                                    |
| ----------------------------- | ----- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stale local dev artifact      | 69MB  | —     | `--no-opt` (default `E2E_WASM_PACK_NO_OPT=1`, `scripts/ci/wasm_regular_rln_e2e.sh:31`): 48.5MB unoptimized code + ~17MB debug `name` section; also leaks absolute local build paths in panic strings (~0.5MB) |
| CI / npm today                | 23MB  | 7.5MB | plain `wasm-pack --release`, no profile tuning (`.github/workflows/wasm-artifacts.yaml:31`); published `@utexo/rln-wasm` 0.11.0-beta.3 is the same build name-stripped (24MB)                                 |
| Tuned rebuild — **verified**  | 13MB  | 4.9MB | `opt-level="z"` + thin LTO + `wasm-bindgen` + `wasm-opt -Oz`                                                                                                                                                  |
| Phase-1 target — **estimate** | ~10MB | ~4MB  | checklist items 7–10 below                                                                                                                                                                                    |

Reference points: LDK's official wasm (LN engine only, no wallet) is 14.5MB raw / 4.5MB gz;
Mutiny's full browser node shipped 8.6–19MB raw. Tuned RLN is already in that band.

Per-crate attribution of the tuned build (13.7MB code): the `lightning` fork **35%**;
`alloc`+`core` **~23%** (BTreeMap/sort monomorphization and panic/fmt machinery);
`strict_encoding` 5.8%; `serde_json` 4.2%; `miniscript` 3.8%; own SDK code only ~4%.
Duplicate crate versions are not a factor, and the 569 wasm-bindgen exports pin the whole
call graph — nothing dead-strips while everything stays exported. The lightning fork
depends on rgb-lib-wasm itself, so no LN-only slice is buildable.

### Build checklist

Phase 0 — config-only, lands in one small PR; items 1+2 together are the verified step
in the table above:

1. **Add `[profile.release]`** — `opt-level = "z"`, `lto = "thin"`, `strip = "debuginfo"` in
   `bindings/wasm-sdk/Cargo.toml` (its own workspace has only `[profile.reldebug]`,
   `Cargo.toml:51`). Cost: 4 lines.
2. **Pin `wasm-opt`** — `[package.metadata.wasm-pack.profile.release] wasm-opt = ["-Oz",
"--strip-debug", "--strip-producers"]` in the same `Cargo.toml`. Cost: 2 lines.
3. **Flip the `--no-opt` default** to `0` in `scripts/ci/wasm_regular_rln_e2e.sh:31` (keep
   the env override for fast local iteration). Kills the 69MB artifact class. Cost: 1 char.
4. **`--remap-path-prefix`** via `RUSTFLAGS` in `.github/workflows/wasm-artifacts.yaml` and
   the e2e script: fixes the build-path privacy leak (~0.5MB) and is a prerequisite for
   reproducible builds. Cost: 1 line.
5. **Serve pre-compressed Brotli** with the gzip fallback — hosting/CDN config, no build
   change; estimate: 10–15% under gzip, i.e. ~4.3MB over the wire from the verified 4.9MB.
6. **Try fat LTO + `codegen-units = 1`** in CI only — estimate: low single-digit % beyond
   thin LTO, paid in CI minutes; keep only if it measures above ~2%.

Phase 1 — code and toolchain changes, the ~10MB / ~4MB **estimate**:

7. **`-Zbuild-std` + `panic_immediate_abort`** (nightly, CI-only lane): attacks the ~23%
   `alloc`/`core` share by rebuilding std at `opt-level="z"` and dropping panic formatting.
   Days, including a soak of the panic-behavior change.
8. **Trim the 569-export surface** of `bindings/wasm-sdk/src/lib.rs`/`sdk_facade.rs`: every
   export roots a call graph, so gating must happen at the export layer for the optimizer
   to see dead code at all. Days.
9. **Feature-gate swaps / VSS / async-payments / onion** in the SDK crate so integrators who
   don't use them don't ship them. Note on the "dead modules": `onion_runtime.rs` is
   compiled but is a validate-only stub that never sends anything (`src/lib.rs:30`,
   `sdk_facade.rs:327`) — gate or delete it; `ldk_live_backend_wasm.rs`,
   `ldk_live_backend_nonwasm.rs` and `wasm_ldk_peer_engine.rs` have no `mod` declaration
   and are **already not compiled** — deleting them is repo hygiene, zero bytes. Days.
10. **Fork-level gating of router/gossip/blinded-paths** in the lightning fork plus Rapid
    Gossip Sync offload to a server: the only lever on the 35% `lightning` share. Weeks;
    do last, after items 1–9 are banked.

### Load UX

The realistic floor is megabytes, so treat load as a product surface: instantiate with
`WebAssembly.instantiateStreaming` behind a progress splash (compile overlaps download);
serve the hash-named `.wasm` with `Cache-Control: immutable` so the cost is first-visit
only; prefetch during landing/signup pages before the wallet screen needs it; and
optionally boot in REST-read-only mode against the gateway (the Block 1 surface) so
balances render while the wasm warms.

### From LDK's playbook

Adopt: their **host-injected services** stance as feature-gate thinking (chain data, fees,
broadcast, persistence, sockets come from the JS host — anything injectable is gateable,
which is what items 8–10 exploit); their **RGS server** model (item 10); and their
**reproducible-build** discipline (pinned toolchain + `--remap-path-prefix`, item 4). Do
NOT adopt their C-bindings architecture: per feature shipped it is less dense than our
wasm-bindgen build (LN-only vs LN + wallet + RGB at comparable size).

## Block 3 — Concurrency: verdict and what to do about it

### Verdict: partially confirmed — RLN is concurrency-avoidant, not concurrency-unstable

The suspicion is **partially confirmed, with a refinement that changes the response**: the
daemon does not race requests — it refuses to run them concurrently at all. Nearly every
REST handler goes through `check_unlocked`, which returns the guard of a single
`TokioMutex<Option<Arc<UnlockedAppState>>>` (`src/utils.rs:88`,
`src/routes.rs:1688-1698`); 48 of its 57 call sites hold that guard for their entire body,
awaits included (the other 9 drop it early or at end-of-statement) — deliberately (commit
`c73908c`, "fix lock usage to prevent concurrent APIs"). The consequences split cleanly:

**Fund-safety: no live REST-side hazard found, but latent debt behind the mutex.**

- REST-vs-REST races are structurally prevented today. The known TOCTOU — issue #52, the
  hodl-invoice `payment_hash` check and insert being two separate lock acquisitions
  (`src/routes.rs:3808-3820`, `3854-3873`) — is **masked** by the global lock (no await
  between check and insert) and goes live the moment anyone relaxes it.
- The locking convention is hand-enforced and silently skippable: three handlers take no
  lock at all because the guard future is never awaited (`src/routes.rs:2490,2522,5412` —
  two pure decoders and `shutdown`) — harmless today, but proof that safety rests on
  convention, not structure.
- The only true concurrency today is background-vs-REST: the LDK event pipeline and sweeper
  call RGB wallet ops directly (`src/ldk.rs:2108,2408,3402,3482-3487`), serialized per-call
  by the wallet's own mutex (`src/rgb.rs:563-566`). Multi-step invariants (UTXO allocation
  across `send_begin`→`send_end`) rest on rgb-lib's internal reservation accounting —
  suspected safe, **unverified**.
- Client retries can double-pay on one path: BOLT11 sends key `PaymentId` on the payment
  hash (`src/routes.rs:5161`) so retries deduplicate, but BOLT12 offers use a random
  `PaymentId` (`src/routes.rs:5093-5095`) — a retried offer payment pays twice. No endpoint
  has idempotency keys.
- Crash consistency is in good shape: 38 mutating handlers are cancellation-proof via
  `no_cancel` (`src/utils.rs:654-668`), and PR #138 made local mutation + replication
  intent commit in one SQLite transaction (`src/synced_kv_store.rs:64-67`). The fixed-race
  history (#28 funding, #109 silent background-processor death, #110 VSS backup snapshot
  ordering, the hodl settlement race) shows this class gets found and fixed; still open:
  #52 (latent, above), #31 (async-payment replay across restart), upstream RGB-Tools#158
  (channel-ID/txid collisions — identity-collision, not request-parallelism).

**Throughput and availability: this is where the real trouble is.**

- Head-of-line blocking on the whole API: while any handler runs, everything else queues.
  Long holders: `/refreshtransfers` holds the global lock across a full network refresh
  (`src/routes.rs:4862-4872`); `/sync` runs a full chain sync inline on the async executor
  under the lock (`src/routes.rs:5434-5447`); `/openchannel` holds it across a peer TCP
  connect with a 10s timeout, a VSS-reachability await and an RGB dry-run
  (`src/routes.rs:4330-4333,4471-4473,4571-4584`). Estimate (labeled): shared-node
  throughput ≈ 1 / mean-handler-latency — roughly ten active users with normal polling
  saturate the queue, and one user's slow RGB proxy stalls everyone.
- Panics are fail-fast by design: the background-processor watchdog turns any event-path
  panic into node exit code 70 (`src/ldk.rs:4370-4412`) — correct for one user, a full
  multi-user outage on a shared node. Panic sites remain in the event path
  (`src/ldk.rs:3466,3482-3487`), and two poison cascades are possible: the RGB wallet
  mutex recovers from poisoning only under `uniffi` (`src/rgb.rs:578-592`), and
  payment-map persistence `.unwrap()`s kv-store errors while holding the map lock
  (`src/ldk.rs:757-767`) — one SQLite error bricks all payment ops until restart
  (suspected, not observed).

### Relevance per variant

**Lightweight SDK (one shared node, many users) — the critical variant; fix before launch.**
N users multiply the load behind one mutex, every availability hazard becomes user-visible,
and a gateway that auto-retries makes the offers double-pay real. Items 1–2 below are
**launch prerequisites**, items 4–5 next; monitoring alone is not enough. The tempting
quick fix — dropping the guard early for throughput — instantly un-masks the #52-class
races, so lock granularity must not be relaxed before check-then-act sites are made
atomic (item 4 strictly precedes item 7).

**Lightweight RLN wasm (one user per browser node) — convention + monitoring; no
blockers.** Protocol-level request concurrency disappears (single user, single-threaded
wasm; the TokioMutex pattern is not in the wasm path). What remains is re-entrancy across
awaits — RefCell borrows held over await points and overlapping periodic loops — and the
tree has already hardened the known sites: non-panicking `try_borrow` with a retryable
"wallet is busy" error (`bindings/wasm-sdk/src/sdk_facade.rs:2461-2469`), a single-flight
background sync loop (`bindings/wasm-sdk/src/chain_sync.rs:264-289`) and a single-flight
VSS replicator (`bindings/wasm-sdk/src/vss_replicator.rs:377`).

### Fixes for the lightweight SDK variant, cheapest first

| #   | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Lives in                 | Effort     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------- |
| 1   | Per-user FIFO queue + global concurrency cap: keeps today's serialization safety story while bounding cross-user interference                                                                                                                                                                                                                                                                                                                                                                   | gateway                  | hours–days |
| 2   | Idempotency keys on money-moving endpoints (`sendpayment`, `sendbtc`, `sendrgb`, `openchannel`, `closechannel`, `taker`): request-hash → cached response; fixes the offers double-pay without touching RLN                                                                                                                                                                                                                                                                                      | gateway                  | days       |
| 3   | Per-wallet operation queue in front of each user's watch-only rgb-lib wallet (Block 1): covers what the request-level FIFO (item 1) cannot — gateway-initiated background syncs interleaving with request-driven PSBT preparation                                                                                                                                                                                                                                                               | gateway / wallet service | days       |
| 4   | Make check-then-act sites atomic in one lock scope — the #52 fix (inflight-hash set with RAII guard); the model exists: `add_outbound_payment` does check+insert under one acquisition (`src/ldk.rs:626-643`)                                                                                                                                                                                                                                                                                   | RLN                      | hours      |
| 5   | Panic hygiene: return errors instead of `.unwrap()` on persistence writes (`src/ldk.rs:757-767`), handle wallet-mutex poisoning fail-closed in every build — surface it as a fatal error into the existing watchdog/exit path (`src/ldk.rs:4370-4412`) rather than extending the fail-open `uniffi` recovery, which `src/rgb.rs:573-592` documents as an FFI-abort workaround that continues on possibly inconsistent wallet state — and remove event-path panics (`src/ldk.rs:3466,3482-3487`) | RLN                      | days       |
| 6   | Timeout budget on every await held under the global lock (peer connect, VSS reachability, proxy IO) so one hung dependency cannot freeze the API                                                                                                                                                                                                                                                                                                                                                | RLN                      | days       |
| 7   | Lock-granularity audit: move read-only endpoints to the existing Arc-clone + `drop(guard)` pattern (`src/routes.rs:1762-1764`); keep money-moving endpoints coarse until item 4 lands                                                                                                                                                                                                                                                                                                           | RLN                      | days–weeks |
| 8   | Load-test harness: regtest, N simulated users driving `lninvoice` / `sendpayment` / `refreshtransfers` / `invoicestatus` in parallel; assert p95 latency, zero 5xx, zero panics. Build on the existing concurrent-openchannel test (commit `026dc9b`) plus an HTTP load driver (`oha` or `k6`)                                                                                                                                                                                                  | CI / tooling             | days       |

Every RLN-side item above is a small, scoped change (a lock scope, an error return, a
timeout wrapper) — none restructures the daemon, per rgb-lightning-node's repository
convention.

### Fixes for the lightweight RLN wasm variant

- **Mechanize the borrow rule** (SDK; hours): enable clippy's `await_holding_refcell_ref`
  in the wasm-sdk crate and keep the review rule "copy state out, drop the borrow, then
  await"; the `try_borrow` + retryable-error sites in `sdk_facade.rs:2461-2469` are the
  pattern to follow, not one-off fixes.
- **Single-flight every periodic driver** (SDK; hours per loop): any new tick / refresh /
  persist loop copies the guard pattern of `chain_sync.rs:264-289` and
  `vss_replicator.rs:377` so overlapping runs are impossible by construction.
- **Test re-entrancy in the browser suite** (SDK tests; days): keep and extend scenarios
  that fire user actions during background ticks — the existing two-player duel e2e already
  covers the borrow-panic class; add invoice-pay-during-sync and refresh-during-refresh.

## Appendix

### A. Citation index

All verified in the rgb-lightning-node tree @ `db194f7`; `rgb-lib` = pinned checkout @ `2610d4a`.

- Custody flow: `/init` returns mnemonic `src/routes.rs:2879-2906`; `/unlock` takes
  password `src/routes.rs:5511,5545`
- Single-tenant state: `src/utils.rs:85-95` (AppState; global mutex at `:88`),
  `:146-180` (StaticState), `:188-221` (UnlockedAppState)
- Auth roles, no user dimension: `src/auth.rs:107-145`; disable flag `:40-43`; permissive
  CORS `src/main.rs:281`; route registration (70 paths, poll-only) `src/main.rs:167-256`
- Remote signer: framed TCP + optional mTLS `src/signer/remote/mod.rs:17,60-61`,
  `src/signer/remote/tls.rs:66`; transport seam `src/signer/transport.rs:56`;
  `/initexternalsigner` `src/main.rs:255-256`; swap routes `src/main.rs:228-229,246`
- Watch-only rgb-lib wallets: rgb-lib `src/wallet/offline.rs:953-954,984,1075`,
  `src/utils.rs:335-357`
- Signing model: descriptors rgb-lib `src/utils.rs:414-461`, coin types `:14-19`; opret
  commit inside `send_begin` rgb-lib `src/wallet/online.rs:1779-1784,1951-1963`; plain BDK
  sign rgb-lib `src/wallet/offline.rs:1939-1959`
- Build config: `--no-opt` default `scripts/ci/wasm_regular_rln_e2e.sh:31` (applied
  `:287-288`); no `[profile.release]` `bindings/wasm-sdk/Cargo.toml:51`; CI plain
  `--release` `.github/workflows/wasm-artifacts.yaml:31`; onion stub
  `bindings/wasm-sdk/src/lib.rs:30`, `sdk_facade.rs:327`
- Locking: `check_unlocked` `src/routes.rs:1688-1698`; drop-early pattern `:1762-1764`;
  long holders `:4862-4872` (refresh), `:5434-5447` (sync),
  `:4330-4333,4471-4473,4571-4584` (openchannel); unpolled guards `:2490,2522,5412`
- Races/idempotency: #52 TOCTOU `src/routes.rs:3808-3820,3854-3873`; BOLT11 dedup `:5161`
  vs BOLT12 random `PaymentId` `:5093-5095`; atomic model `src/ldk.rs:626-643`
- Background-vs-REST: `src/ldk.rs:2108,2408,3402,3482-3487`; wallet mutex
  `src/rgb.rs:563-566`, uniffi-only poison recovery `:578-592`
- Crash/panic: `no_cancel` `src/utils.rs:654-668`; one-transaction persistence
  `src/synced_kv_store.rs:64-67`; payment-map unwrap `src/ldk.rs:757-767`; watchdog exit 70
  `src/ldk.rs:4370-4412`; event-path panic `src/ldk.rs:3466`
- wasm re-entrancy hardening: `bindings/wasm-sdk/src/sdk_facade.rs:2461-2469`,
  `chain_sync.rs:264-289`, `vss_replicator.rs:377`; concurrent-openchannel test commit
  `026dc9b`

### B. Measured numbers

| Number                                                                                         | Status                      |
| ---------------------------------------------------------------------------------------------- | --------------------------- |
| 69MB — stale local `--no-opt` artifact (48.5MB code + ~17MB name section, ~0.5MB path strings) | measured                    |
| 23MB raw / 7.5MB gz — CI and npm today (npm name-stripped: 24MB)                               | measured                    |
| 13MB raw / 4.9MB gz — `opt-level="z"` + thin LTO + `wasm-opt -Oz`                              | measured (verified rebuild) |
| Per-crate attribution of the tuned 13.7MB code + 569 exports (see Block 2)                     | measured                    |
| ~10MB / ~4MB — after Phase-1 items                                                             | estimate                    |
| ~4.3MB — Brotli over the wire                                                                  | derived estimate            |
| LDK wasm 14.5MB / 4.5MB gz; Mutiny 8.6–19MB raw                                                | reference                   |

### C. rgb-lib-wasm method classification (53/53)

Source: rgb-lib `bindings/wasm/src/lib.rs` (5 free functions + 45 `WasmWallet` +
3 `WasmInvoice` methods).

- **Secret-touching — client only (7):** `generate_keys:47`, `restore_keys:56`,
  `sign_psbt:260`, `finalize_psbt:269`, `backup:703`, `restore_backup:712`,
  `configure_vss_backup:736` (takes a raw signing key)
- **Mode-dependent — secret only if constructed with a mnemonic (3):** `WasmWallet.new:74`,
  `create:88`, `get_wallet_data:111`
- **Stateful — server-side watch-only (39):** `flush`, `issue_asset_nia`, `issue_asset_ifa`,
  `get_btc_balance`, `get_asset_metadata`, `get_asset_balance`, `list_assets`,
  `list_transfers`, `list_unspents`, `list_transactions`, `list_unspents_vanilla`,
  `blind_receive`, `witness_receive`, `get_address`, `rotate_address`, `delete_transfers`,
  `go_online`, `sync`, `full_scan`, `create_utxos_begin`/`_end`, `send_begin`/`_end`,
  `send_btc_begin`/`_end`, `refresh`, `fail_transfers`, `get_fee_estimation`,
  `drain_to_begin`/`_end`, `inflate_begin`/`_end`, `backup_info`, `disable_vss_backup`,
  `vss_backup`, `vss_restore_backup`, `vss_backup_info`, `check_proxy_url`,
  `validate_consignment_offchain` — the `vss_*` trio runs wherever the VSS key lives;
  unused in the lightweight variant, which has no VSS (Block 1)
- **Pure/neutral — either side (4):** `init:28` (bootstrap), `WasmInvoice.new:811`,
  `invoice_data:819`, `invoice_string:825` (invoice decode — the client also needs this
  for verify-before-sign)
