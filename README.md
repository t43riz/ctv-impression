# CTV Impression Tracker

A custom Connected TV (CTV) impression tracking system on **Cloudflare Workers**
+ **Workers Analytics Engine** + **R2**, built to receive Roku RAF impression
beacons. Edge ingestion, real-time analytics, long-term archival.

> Scope: first-party **aggregate** impression telemetry with authenticity,
> deduplication, and privacy controls. **Not** MRC-accredited measurement.
> See [`docs/SPEC.md` §13](docs/SPEC.md) for scope/non-goals.

## Documentation

| Doc | Purpose |
|-----|---------|
| [`docs/ROKU_DSA_GAP_ANALYSIS.md`](docs/ROKU_DSA_GAP_ANALYSIS.md) | **Read first** — Data Partner Agreement gaps, blockers, draft email to Roku |
| [`docs/ROKU_IMPRESSION_TAG.md`](docs/ROKU_IMPRESSION_TAG.md) | **Roku-facing** — sample pixel, required macros, example recorded output |
| [`docs/ATTRIBUTION.md`](docs/ATTRIBUTION.md) | Call→impression matching + Roku Conversions API (CAPI) |
| [`docs/SPEC.md`](docs/SPEC.md) | Full technical spec (v0.2, post-review) |
| [`docs/PRIVACY.md`](docs/PRIVACY.md) | Data handling, IFA hashing, LMT, retention, DSAR |

## Architecture

```
Roku device (RAF beacon)
   └─ GET /pixel?... (HMAC-signed, macros filled)
        └─ Cloudflare Worker (edge)
             1. validate + verify signature + allowlist
             2. honor LMT, hash IFA
             3. deduplicate (Durable Object)
             4. write to Analytics Engine (async)
             5. record into RecentImpressions DO (for call matching)
             6. return 1x1 GIF immediately
        ├─ Analytics Engine  → real-time SQL queries (read via SQL API)
        └─ R2 (daily export) → long-term aggregated NDJSON

PBX (qualified call — phone number only, no device ID)
   └─ POST /call (HMAC-signed)
        └─ Cloudflare Worker
             1. verify HMAC, resolve DNIS → creative, qualify by duration
             2. PROBABILISTIC match vs RecentImpressions[creative] (time + geo)
             3. fire Roku CAPI conversion (best-guess IP/RIDA + confidence,
                or phone-only fallback)
```

> **Matching is probabilistic, not deterministic.** An inbound call gives us only
> the caller's phone number — never a device ID. We pick the best-guess
> impression (by time + geo) and, **only when the match clears both
> `MIN_MATCH_CONFIDENCE` and `MAX_MATCH_CANDIDATES`**, send its IP/RIDA to Roku
> with a confidence score; otherwise the event goes phone-only with the hashed
> phone as the only certain identifier. See
> [`docs/ATTRIBUTION.md`](docs/ATTRIBUTION.md).

## Ingest controls

| Var | Default | Effect |
|-----|---------|--------|
| `INGEST_DISABLED` | `false` | `true` keeps serving the pixel but stops counting/matching (kill switch, DSA §2(b)) |
| `DEDUP_NON_ATTRIBUTABLE` | `true` | Coarse salted-IP + hour frequency cap for LMT/child-directed/macro-polluted impressions |
| `RATE_LIMIT_PER_MINUTE` | `120` | Per-IP beacon budget; `0` disables |
| `DEDUP_WINDOW_HOURS` | `24` | Impression dedup window |
| `SIGNATURE_REQUIRED` | `true` | Require the HMAC tag signature |
| `CALL_BODY_TIMEOUT_MS` | `10000` | Deadline for reading a `/call` body (the HMAC cannot be checked until it arrives) |

Health ceilings are configurable too, each as a fraction of traffic
(`HEALTH_MAX_REJECT_RATIO` `0.5`, `HEALTH_MAX_ALERT_RATIO` `0.01`,
`HEALTH_MAX_CALL_ERROR_RATIO` `0.5`, `HEALTH_MAX_CALL_REJECT_RATIO` `0.5`); an
unset, blank or out-of-range value falls back to the default.

An unexpanded ad-server macro (`[[[RIDA]]]`, `[IFA]`) is treated as a **missing**
identifier, never as a device id — hashing it would collapse every affected
beacon into one pseudo-device and silently discard the rest as duplicates.

## Layout

```
src/
  index.ts        Worker entry: /pixel + /call + /admin/* + /healthz + crons
  dedup.ts        DedupStore Durable Object (seen-key set + TTL purge + DSAR erase)
  recent.ts       RecentImpressions DO (window-scoped raw IP/IFA/hh_id for matching)
  ratelimit.ts    RateLimiter DO (per-IP fixed-window budget, fails open)
  raw.ts          Raw 30-day R2 tier (unsampled hashed-IFA rows + DSAR erase)
  call.ts         /call ingest: auth, qualify, match, fire CAPI (Roku or UA)
  admin.ts        Token-protected ops: health, reports, backfill, DSAR
  export.ts       Daily R2 export (SQL API, hourly aggregation, idempotent)
  query.ts        Reporting queries (sum(_sample_interval) based)
  monitor.ts      Reconciliation + export-freshness health checks
  types.ts        Env + Impression/Call/Match types
  lib/
    crypto.ts     HMAC sign/verify, salted IFA hash + rotation (WebCrypto)
    beacon.ts     Parse / authenticate / validate a beacon (Roku + UA params)
    pixel.ts      1x1 GIF (Uint8Array, no Node Buffer)
    sql.ts        Analytics Engine SQL API client (read path)
    match.ts      Candidate scoring + confidence (pure, testable)
    phone.ts      Phone normalize/hash + area-code→state
    areacodes.ts  NANP area code → US state map
    capi.ts       Roku Conversions API client + payload builder
    capi_ua.ts    Universal Ads CAPI client (gated until UA endpoint confirmed)
scripts/
  sign-url.mjs    Generate a signed tag URL (--platform roku|ua)
test/             Vitest unit tests (crypto, beacon, match, phone, capi, capi_ua,
                  call, dedup, recent, raw, export, monitor, http, admin, index)
test/helpers/     Fakes for Durable Object SQL/storage/namespaces, KV, R2 and
                  Analytics Engine (fail loudly on unsupported SQL)
```

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in local secrets
```

Create the resources and wire IDs into `wrangler.toml`:

```bash
wrangler kv namespace create CAMPAIGNS
wrangler r2 bucket create impression-archive
wrangler r2 bucket create impression-raw
```

Set production secrets:

```bash
wrangler secret put CF_API_TOKEN       # "Account Analytics Read" token
wrangler secret put ACCOUNT_ID
wrangler secret put HMAC_SIGNING_KEY    # openssl rand -hex 32
wrangler secret put IFA_HASH_SALT       # openssl rand -hex 32
wrangler secret put CALL_HMAC_KEY       # openssl rand -hex 32 (PBX webhook)
wrangler secret put CAPI_API_KEY        # Roku CAPI bearer (leave unset in test mode)
wrangler secret put ADMIN_TOKEN         # openssl rand -hex 32 (protects /admin/*)
# During a salt rotation window only:
#   wrangler secret put IFA_HASH_SALT_PREV
# Once Universal Ads provisions the CAPI:
#   wrangler secret put UA_CAPI_API_KEY
```

Configure R2 lifecycle rules (retention enforcement, SPEC §7.3):

```bash
# impression-raw: delete objects after 30 days
# impression-archive: delete objects after 13 months (395 days)
# Apply via dashboard (R2 > bucket > Settings > Object lifecycle rules)
# or `wrangler r2 bucket lifecycle add <bucket> ...`
```

Allowlist a campaign and register a tracking number:

```bash
wrangler kv key put --binding CAMPAIGNS "campaign:camp_spring24" active
# COPPA: child-directed campaigns are forced to LMT treatment:
#   wrangler kv key put --binding CAMPAIGNS "campaign:camp_kids" child_directed
wrangler kv key put --binding NUMBERS "number:18005550100" \
  '{"creativeId":"cre_30s_hero","campaignId":"camp_spring24","advertiserId":"adv_acme"}'
# Universal Ads numbers route conversions to the UA CAPI:
#   ... '{"creativeId":"cre_x","campaignId":"camp_y","advertiserId":"adv_z","platform":"ua"}'
```

> Call attribution starts in **`CAPI_MODE=test`** (posts to Roku's
> `/v1/test_events`, no ingestion). Flip to `live` once you set `CAPI_API_KEY`
> and `CAPI_EVENT_GROUP_ID`. See [`docs/ATTRIBUTION.md`](docs/ATTRIBUTION.md).

## Generate a signed tag for Roku

```bash
HMAC_SIGNING_KEY=$(cat .hmac_key) npm run sign -- \
  --base https://pixels.postbackx.com \
  --advertiser adv_acme --campaign camp_spring24 --creative cre_30s_hero \
  --ttl 2592000
```

Deliver the printed URL to Roku. See `docs/ROKU_IMPRESSION_TAG.md`.
For Universal Ads add `--platform ua` (IAB/VAST macros; see
`docs/UA_IMPRESSION_TAG.md`).

## Ops endpoints (`Authorization: Bearer $ADMIN_TOKEN`)

```
GET  /admin/health                           recon + export freshness (503 if unhealthy)
GET  /admin/report/campaigns?days=7          impressions by campaign
GET  /admin/report/countries?hours=24        impressions by country
GET  /admin/report/hourly?hours=24           hourly trend
GET  /admin/report/reach?campaign=X&days=30  reach (estimate)
POST /admin/backfill?date=YYYY-MM-DD         re-run a day's export
POST /admin/dsar  {"ifa":"...","campaigns":["camp1"]}   DSAR erasure
```

A second cron (03:30 UTC) writes `_status/health.json` to the archive bucket
for external monitors.

## Develop / test / deploy

```bash
npm run typecheck
npm test
npm run dev
npm run deploy
```

## Key corrections from the original spec

- AE binding is **write-only**; reads go through the **SQL API** (`src/lib/sql.ts`).
- Counts use `sum(_sample_interval)`, never `sum(double0)`.
- Export aggregates by **hour bucket** (not raw timestamp), is idempotent, and
  orders by **every** grouping key so `LIMIT`/`OFFSET` paging cannot skip rows.
- Beacons are **HMAC-signed**; IFA is **hashed**, never stored raw; **LMT honored**.
- "0% data loss" replaced with a **CI-bounded accuracy** SLO; write-failure
  alerting replaced with **reconciliation** + **export freshness**.
- Reconciliation now counts **ledger gaps** (received minus terminal outcomes)
  rather than scoring expected duplicates and rejects as failures. Each beacon
  produces exactly **one** terminal outcome, and health requires the ledger to
  close exactly, so a double-recorded or dropped beacon is visible.
- `/call` is **replay-resistant** (signed timestamp) and **idempotent** per
  `callId`; a missing `durationSeconds` is rejected instead of silently passing
  qualification. Qualification runs **before** the idempotency claim, and the
  claim is released if any later step fails, so a sub-threshold call cannot
  block a later qualifying event and a failed send is retryable rather than
  reported as a duplicate.
- Raw-tier DSAR erasure is **key-shard scoped per day**, so it completes instead
  of restarting a whole-bucket scan on every invocation, and it **fails closed**
  (HTTP 500) if an object's `customMetadata` cannot be read — an unverifiable
  erase is never reported as a success.
- LMT withholds the matched device's **IP as well as its RIDA/IFA** from the
  conversion payload; the IP is a device identifier for that purpose.
- `/call` bodies are read through a byte cap (independent of `content-length`)
  and a read deadline, and the `callId` is percent-encoded into the idempotency
  key, so SIP-style identifiers (`localpart@host`) are accepted rather than
  rejected. Without the deadline an unauthenticated caller could hold the
  isolate open by trickling a body that the HMAC cannot be checked against.
- The tag signature binds `advertiser_id` as well as campaign/creative/expiry,
  so a captured (public) tag URL cannot be re-pointed at another advertiser.
  `ifa`/`lmt` cannot be bound — the ad server substitutes them on the device.
- `/call` outcomes are recorded in the same reconciliation ledger (`call_*`),
  so a silent "every qualified call skipped" state is visible at all. Health
  gates on **both** failed sends and calls refused before a send (a wrong shared
  HMAC key or a stale number registry is 100% refusals, not 100% healthy), but
  never on absorbed replays. A `test`-mode send is recorded as `call_dry_run`,
  not as a delivered conversion.
- Export freshness compares the marker's **date**, not just its age: a re-run or
  backfill rewrites that marker for any day, so an age-only check reports a
  healthy export while the nightly job has been dead for weeks.
- Every ingest path's terminal outcome is written by a **one-shot recorder**
  (`terminalOutcomeRecorder`), unit-tested directly rather than only through a
  path that cannot reach the guard.
- Secret placeholders (`REPLACE_WITH_*`, the `.dev.vars.example` keys) are
  detected and refused rather than used to sign or send.
