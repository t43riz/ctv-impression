# Full Implementation Plan

**Date:** 2026-07-20
**Status update (same day):** All code phases implemented — raw R2 tier
(`src/raw.ts`), admin/ops surface (`src/admin.ts`), rate limiting
(`src/ratelimit.ts`), DSAR erase (dedup `/erase` + raw-tier scan), health cron,
UA beacon params + blob 8–9 schema, `hhId` in the matching store, UA CAPI
client (`src/lib/capi_ua.ts`, gated on `UA_CAPI_ENDPOINT`), platform-routed
`/call`, dual-salt rotation, COPPA `child_directed`, tag generator
`--platform ua`.

**Correctness-hardening pass:** a review pass then closed the defects the
implementation audit found (ledger discipline and claim release on `/call`, raw
tier fail-closed, LMT withholding the matched IP, `advertiser_id` bound into the
tag signature, DSAR `{}`-metadata hole, config parsing, SIP-safe `callId`,
streaming body caps, conversion-path observability). Unit suite: **258 passing**
(`npx vitest run`, typecheck clean). Remaining work is **operational**: Phase 0
provisioning (KV IDs, secrets, R2 lifecycle rules, staging env), Phase 4.2/4.3
validation, Phase 5 go-live, and all `[CONFIRM WITH UA]` items.

**Basis:** Audit of all docs (`SPEC.md`, `ATTRIBUTION.md`, `PRIVACY.md`,
`ROKU_IMPRESSION_TAG.md`, `ROKU_MEASUREMENT_DISCLOSURE.md`, `UA_SPEC.md`,
`UA_ATTRIBUTION.md`, `UA_IMPRESSION_TAG.md`, `UA_PRIVACY.md`) against the
current codebase (`src/`, `test/`, `wrangler.toml`).

---

## 1. Current State (verified)

**Built and passing** (typecheck ✅, 32/32 unit tests ✅ *at the time of this
audit; the suite is now 258 tests — see the status update above*):

| Area | Files | Status |
|------|-------|--------|
| `/pixel` ingest: validate → HMAC verify → allowlist → LMT/IFA hash → dedup → AE write → recon write → RecentImpressions record → 1×1 GIF | `src/index.ts`, `src/lib/beacon.ts`, `src/lib/crypto.ts`, `src/lib/pixel.ts` | ✅ Done |
| Dedup Durable Object (SQLite, TTL purge alarm) | `src/dedup.ts` | ✅ Done |
| RecentImpressions DO (window-scoped raw IP/RIDA, purge alarm) | `src/recent.ts` | ✅ Done |
| `/call` webhook: HMAC auth → DNIS→creative → qualify → probabilistic match → Roku CAPI | `src/call.ts`, `src/lib/match.ts`, `src/lib/phone.ts`, `src/lib/areacodes.ts`, `src/lib/capi.ts` | ✅ Done (Roku only) |
| Daily R2 export (SQL API, hourly buckets, `sum(_sample_interval)`, idempotent, paginated) + `backfill()` function | `src/export.ts`, `src/lib/sql.ts` | ✅ Done (backfill not routable) |
| Reporting queries + reconciliation summary | `src/query.ts` | ✅ Done (not exposed) |
| Recon health + export freshness checks | `src/monitor.ts` | ✅ Done (never invoked) |
| Tag signer CLI | `scripts/sign-url.mjs` | ✅ Done |
| Unit tests: crypto, beacon, match, phone, capi | `test/*.test.ts` | ✅ 32 passing |

**Documented but NOT implemented** (the gaps this plan closes):

1. **Universal Ads integration** (all four UA_* docs) — no `ifa_type` / `hh_id` /
   `device_ip` beacon params, no household ID in the matching store, no UA CAPI
   client, no per-number platform routing.
2. **R2 raw 30-day tier** — `RAW` bucket is bound in `wrangler.toml`/`Env` and
   promised in SPEC §7.3 / PRIVACY §3 ("hashed IFA + dimensions, reach/replay,
   30 days") but **nothing ever writes to `env.RAW`**.
3. **Ops surface** — `monitor.ts` checks and `query.ts` reports have no route;
   `backfill()` has no invocation path ("one-off Worker route" promised in
   `export.ts` comment).
4. **Rate limiting** — SPEC §7.2: "add per-IP/IFA rate limiting for
   low-and-slow inflation." Not present.
5. **R2 retention enforcement** — 30-day raw / 13-month aggregate lifecycle
   rules not configured anywhere.
6. **DSAR / erasure path** — PRIVACY §4 describes locating-by-hash and deleting
   from the dedup DO + raw R2 tier; no tooling exists (dedup DO has no delete
   endpoint).
7. **Salt rotation** — PRIVACY §7 open item; no mechanism.
8. **Integration tests** — `@cloudflare/vitest-pool-workers` is installed but
   unused; DOs, `/pixel` E2E, `/call` E2E, and export are untested.
9. **Provisioning placeholders** — KV namespace IDs, `CAPI_EVENT_GROUP_ID`
   still `REPLACE_WITH_*`.

---

## 2. Phased Plan

### Phase 0 — Provisioning & configuration (blocking everything else)

- [ ] Create real resources and replace placeholders in `wrangler.toml`:
  - `wrangler kv namespace create CAMPAIGNS` / `NUMBERS` → paste IDs
  - `wrangler r2 bucket create impression-archive` / `impression-raw`
- [ ] Set all secrets (`CF_API_TOKEN` scoped to Account Analytics Read,
  `ACCOUNT_ID`, `HMAC_SIGNING_KEY`, `IFA_HASH_SALT`, `CALL_HMAC_KEY`;
  `CAPI_API_KEY` deferred until CAPI go-live).
- [ ] Configure **R2 lifecycle rules**: `impression-raw` → delete after 30 days;
  `impression-archive` → delete after 13 months (SPEC §7.3). Via dashboard or
  `wrangler r2 bucket lifecycle` — document the applied rules in `README.md`.
- [ ] Add a `staging` environment (`[env.staging]` in `wrangler.toml`) with its
  own dataset names (`impression_events_stg`, `ingest_recon_stg`), buckets, and
  KV so the Roku/UA test plans don't pollute production data.

### Phase 1 — Close the Roku-side implementation gaps

**1.1 Raw R2 tier (30-day, hashed IFA)** — `src/raw.ts` (new)
- On each *counted* impression, buffer and write raw event rows
  (`ts, campaign, creative, ifa_hash, ifa_present, country, app_id`) to
  `env.RAW`. Workers can't batch across requests cheaply, so write per-event
  NDJSON objects keyed `dt=YYYY-MM-DD/hh=HH/{uuid}.ndjson` **or** (preferred)
  route through a small buffering DO / queue that flushes every N seconds.
  Decision point: per-event PUTs at 30M/mo is ~30M Class A operations. R2 bills
  Class A at $4.50/million, so that is ~$130/month after the 1M free tier (an
  earlier revision of this plan said ~$4.50, understating it by ~29x).
  Acceptable for the pilot; buffer through a DO or Queue before scaling past it.
- This tier is what makes the documented "accreditable reach/frequency from raw
  rows" and DSAR erasure claims true.

**1.2 Ops/admin endpoints** — `src/admin.ts` (new), wired in `src/index.ts`
- `GET /admin/health` → `checkReconHealth` + `checkExportFreshness` JSON
  (this is what external alerting polls; SPEC §7.1 thresholds).
- `GET /admin/report/campaigns|countries|hourly|reach` → thin wrappers over
  `src/query.ts`.
- `POST /admin/backfill?date=YYYY-MM-DD` → `backfill()` from `src/export.ts`.
  Future dates are refused; re-exporting the **current UTC day** is allowed but
  the response carries `partial: true`, because the day is still open and the
  object holds only the rows written so far.
- Auth: `Authorization: Bearer <ADMIN_TOKEN>` (new secret), timing-safe
  compare. Return 404 (not 401) on failure to avoid advertising the surface.

**1.3 Rate limiting** — `src/lib/ratelimit.ts` (new)
- Per-IP and per-ifa_hash counters using the Workers **rate-limiting binding**
  (or a counter in the DedupStore DO if the binding is unavailable on the
  plan). Over-limit beacons: still return the pixel (never reveal outcome),
  record `recon: reject_rate_limited`, don't count.

**1.4 Dedup DO erasure endpoint (DSAR prerequisite)** — `src/dedup.ts`
- Add `POST /erase?prefix=<ifaHash>` to `DedupStore` deleting matching keys
  (`DELETE FROM seen WHERE k LIKE ?||'%'`), plus an admin route
  `POST /admin/dsar` that: hashes a provided IFA with the current salt, calls
  erase on the sharded DO(s), and lists/deletes matching rows in the 30-day
  raw tier (Phase 1.1). Document runbook in `PRIVACY.md`.

**1.5 Scheduled health check** — `src/index.ts`
- Add a second cron (`30 3 * * *`) that runs `checkExportFreshness` /
  `checkReconHealth` and writes `_status/health.json` to `ARCHIVE`; external
  monitor (Grafana/Uptime) alerts on staleness or `healthy: false`.
- Ledger discipline: every received beacon writes exactly **one** terminal
  outcome (`counted` | `duplicate` | `reject_*` | `disabled`). `monitor.ts` gates
  health on that ledger closing exactly (`received === accounted`) plus zero
  `reject_internal`, zero `alert_*` side-channel outcomes, and a bounded reject
  ratio. It deliberately does **not** gate on a counted/received ratio: with a
  24 h dedup window a healthy CTV creative legitimately sees a large duplicate
  share, so any floor there would be either permanently red or meaningless.
  `countedRatio` is reported for visibility only.
- `/call` outcomes share the ledger under a `call_*` namespace (`call_fired`,
  `call_dry_run`, `call_skipped`, `call_capi_error`, ...) and are reported in
  `_status/health.json` as `callFired`/`callDryRun`/`callSkipped`/
  `callRejections`/`callDuplicates`/`callErrors`. The conversion path previously
  had no observability at all outside the PBX's own logs. Health gates on the
  conversion path separately from the beacon ledger, so an idle pixel path
  cannot mask a failing conversion path, and it gates on **both** halves of that
  path: failed sends (`callErrors / callAttempts`) and calls refused before a
  send was ever attempted (`callRejections / callAttempts`). Counting only send
  failures left a wrong shared HMAC key (100% `call_unauthorized`), a stale
  number registry (100% `call_unknown_number`) and a malformed PBX payload
  (100% `call_bad_request`) all reporting healthy. Absorbed replays
  (`call_duplicate`) and intentionally skipped/dry-run sends are reported but
  never gated.
- A test-mode send is recorded as `call_dry_run`, not `call_fired`: the platform
  validates it but delivers nothing, so counting it as delivered made a Worker
  left on `CAPI_MODE=test` look like a healthy, fully-attributed conversion path.
- `alerts` is gated as a **ratio** (default 1% of received), not `alerts === 0`:
  raw-tier writes are best-effort, and a single transient R2 error used to turn
  health red for a whole day, which is how an alert gets muted. Alerts with no
  `received` rows at all are reported as a full-rate failure, not as 0%.
- Every health ceiling (`HEALTH_MAX_REJECT_RATIO`, `HEALTH_MAX_ALERT_RATIO`,
  `HEALTH_MAX_CALL_ERROR_RATIO`, `HEALTH_MAX_CALL_REJECT_RATIO`) is read from
  the environment with the documented default as a fallback.
- Export freshness compares the marker's **date** as well as its age. The age
  check alone was not enough: `runExport` rewrites the freshness marker for
  whatever day it is asked to export, so a backfill of a month-old day leaves a
  marker that is seconds old while the nightly job may have been dead for
  weeks.

### Phase 2 — Universal Ads (Comcast/FreeWheel) integration

Design principle: **one Worker, one pipeline, platform-parameterized** — the UA
docs state the architecture is identical; only macros and the conversion API
differ.

**2.1 Beacon: accept UA params** — `src/lib/beacon.ts`, `src/types.ts`
- Parse `ifa_type` (free-form short token, validate `/^[a-z0-9_-]{0,16}$/i`),
  `hh_id`, `device_ip` (used only if `CF-Connecting-IP` is a proxy — normally
  ignored). Zero-IFA/LMT handling unchanged.
- Extend AE blob schema (backward-compatible, append-only):
  `8=ifa_type`, `9=platform` (`roku`|`ua`, derived from tag or an explicit
  `pf=` param we pre-fill when generating the tag). Update `docs/SPEC.md` /
  `UA_SPEC.md` blob tables and `src/export.ts` + `src/query.ts` selects.
- `scripts/sign-url.mjs`: add `--platform ua` to emit the UA tag shape with
  IAB macros (`[IFA]`, `[IFATYPE]`, `[LIMITADTRACKING]`, `[APPBUNDLE]`,
  `[CACHEBUSTING]`) per `UA_IMPRESSION_TAG.md` §2.

**2.2 Matching store: household ID** — `src/types.ts`, `src/recent.ts`
- Add `hhId: string` to `ImpressionRecord`; new column in the DO SQLite table
  (additive `ALTER TABLE`-safe: recreate with `IF NOT EXISTS` including the
  column — table is ephemeral ≤60 min, so a schema change is safe to deploy).
- Populate from `hh_id` param in `src/index.ts` (empty for Roku traffic).

**2.3 CAPI abstraction** — `src/lib/capi.ts` → split
- `src/lib/capi_roku.ts` (existing logic) and `src/lib/capi_ua.ts` (new),
  behind a common `buildPayload/send` interface selected by
  `NumberMapping.platform: "roku" | "ua"` (new field, default `"roku"`).
- UA client per `UA_ATTRIBUTION.md` §5: same event shape, `ifa` +
  `household_id` in `user_data`; endpoint/auth/opt-out token behind new vars
  `UA_CAPI_ENDPOINT`, `UA_CAPI_API_KEY`, `UA_CAPI_MODE` — **all gated
  [CONFIRM WITH UA]**; until confirmed, UA mode is `test`-only and the client
  is validated by unit tests against the proposed schema.
- `src/call.ts`: route by `mapping.platform`; response unchanged.

**2.4 UA open items tracker**
- Keep `UA_SPEC.md` §14 as the checklist; wire each `[CONFIRM WITH UA]` answer
  into: macro tokens (tag generator), tracker allowance, `hh_id` availability,
  CAPI endpoint/schema/dedup key, opt-out token, certification steps.

### Phase 3 — Privacy operations

- [ ] **Salt rotation runbook** (PRIVACY §7): dual-salt support in
  `hashIfa` — accept `IFA_HASH_SALT` + optional `IFA_HASH_SALT_PREV`; dedup
  checks both hashes during a rotation window; document cadence (e.g.
  quarterly). Small change in `src/lib/crypto.ts` + `src/lib/beacon.ts`.
- [x] **DSAR runbook** (Phase 1.4; see `PRIVACY.md` §8 for the implemented
  runbook). The raw-tier step fails closed with HTTP 500
  `{"error":"raw_erase_failed"}` when an object's `customMetadata` cannot be
  read, so an unverifiable erase is never reported as a success.
- [ ] **COPPA config**: document (and optionally enforce via a
  `campaign:{id}` KV value `child_directed`) that child-directed campaigns are
  treated as LMT regardless of the `lmt` param.
- [ ] DPIA / lawful-basis documentation — business task, tracked but not code.

### Phase 4 — Testing & validation

**4.1 Integration tests**
- **Done (node env, `test/`)**: `test/helpers/fakes.ts` supplies Durable Object
  SQL/storage/namespace stand-ins, KV, R2 and Analytics Engine. The fakes
  implement exactly the statements/queries the code issues and throw on anything
  else, so a changed query fails loudly instead of silently returning nothing.
  Covered:
  - `/pixel` E2E through `worker.fetch` with real DO instances behind the
    bindings: counted / duplicate / rejected / kill-switch / rate-limited /
    LMT-non-attributable, plus the two failure paths
    (`reject_internal` with an exact one-terminal-outcome ledger, and
    `alert_raw_write_error` / `alert_recent_write_error` as side-channels).
  - `DedupStore`: first sighting, repeat, expiry, window pinned against sliding,
    **salt-rotation alias seeding**, `/erase` prefix + LIKE-wildcard escaping,
    alarm purge/reschedule, and the `isFirstSeen`/`eraseByHash` client wiring.
  - `RecentImpressions`: record/match, candidate-ceiling short-circuit,
    confidence gate, LMT, window validation (non-finite → 60) and alarm purge.
  - `/call`: HMAC auth, stale timestamp, oversized body, unknown number,
    qualify-before-claim, claim held on success, claim **released** on throw and
    on CAPI failure.
  - `admin.ts`: 404 masking, range clamping, campaign-id validation,
    health 200/503, backfill guard + partial-day marking, DSAR erase and the
    fail-closed `raw_erase_failed` path.
  - `http.ts`: `configInt`/`configFloat` edge cases, retry policy (retryable vs
    definitive statuses), abort signal, header merge.
- **Remaining**: run the same suite under `@cloudflare/vitest-pool-workers`
  against real workerd SQLite (`vitest.workspace.ts`, keeping the node project
  for the pure logic) so the DO fakes are validated against the real runtime.
- **4.2 Load & latency validation** (SPEC §11)
- `wrangler dev`/staging soak: confirm p95 < 150 ms on `/pixel`, DO hot-spot
  check (dedup shards by campaign — verify one hot campaign doesn't serialize;
  if it does, shard `idFromName(campaignId + bucket(ifaHash))`).

**4.3 Platform validation**
- Roku: execute `ROKU_IMPRESSION_TAG.md` §6 test plan (signed test tag for
  `camp_roku_test`, reconciliation report received/counted/deduped, compare vs
  Roku ad-server counts). Complete `ROKU_MEASUREMENT_DISCLOSURE.md` §7
  [TO COMPLETE] legal fields.
- UA: execute `UA_IMPRESSION_TAG.md` §6 once macro tokens are confirmed.
- CAPI: Roku `CAPI_MODE=test` → validate payloads → set key/event_group →
  flip `live` (ATTRIBUTION §9). Same later for UA.

### Phase 5 — Deployment, monitoring, go-live

- [ ] Deploy staging → run Phase 4 validation → deploy production.
- [ ] Point the production tracking domain (custom domain route on the Worker,
  HTTPS-only) and record it in the Roku disclosure §7.
- [ ] Dashboards: Grafana (or equivalent) over the AE SQL API using
  `src/query.ts` queries; panels = SPEC §7.1 table (error rate, p95,
  daily volume ±20%, counted/received ratio, export freshness).
- [ ] Alerts wired to `/admin/health` (Phase 1.2) + `_status/health.json`.
- [ ] **Phase 0 reconciliation pilot** (SPEC §13): run 2–4 weeks against
  Roku's ad-server counts before treating this as a system of record; publish
  the ±2%-at-95%-CI accuracy result (SPEC §11).
- [ ] Roku CAPI live flip per go-live checklist; UA go-live blocked on §14
  confirmations.

---

## 3. Dependency order

```
Phase 0 ──► Phase 1 (1.1–1.5 independent of each other)
   │            │
   │            ├──► Phase 3 (needs 1.1 raw tier + 1.4 erase)
   │            └──► Phase 4.1/4.2 (tests target Phase 1 surface)
   └──► Phase 2 (2.1→2.2→2.3; 2.3 live-blocked on UA answers)
                     │
Phase 4.3 ◄──────────┘ (Roku track can start immediately)
Phase 5 last; Roku go-live does NOT wait for UA.
```

## 4. Risks / decision points

| Risk | Mitigation |
|------|------------|
| UA CAPI schema unknown ([CONFIRM WITH UA]) | Build behind interface + test mode; no live sends until confirmed |
| Raw-tier PUT volume cost/limits at scale | Start with direct per-event PUT; switch to buffering DO/Queues if Class A ops grow |
| Dedup DO hot shard on a mega-campaign | Measure in 4.2; shard key change is a one-line fix |
| AE blob schema change (blobs 8–9) mid-flight | Append-only; old rows read as empty string — queries must tolerate `''` |
| `count(DISTINCT)` reach expectations | Already documented as estimate; raw tier (1.1) provides the accurate path |

## 5. Acceptance criteria (definition of done)

1. All `REPLACE_WITH_*` placeholders resolved; staging + production deployed.
2. `env.RAW` receives raw rows; lifecycle rules enforce 30 d / 13 mo.
3. `/admin/*` endpoints live, token-protected; backfill works for an arbitrary date.
4. Rate limiting active with `reject_rate_limited` visible in recon.
5. DSAR runbook executable end-to-end (dedup + raw tier erase).
6. UA tag accepted by beacon; platform-routed CAPI abstraction merged; UA live
   toggles exist but stay off pending UA confirmations.
7. Integration test suite green in CI covering all routes + both DOs.
8. Roku test-plan reconciliation report produced; counted-vs-ad-server delta
   within ±2% at 95% CI.
