# Custom CTV/Linear Impression Tracking System — Universal Ads

## Technical Specification

> **Adapted for Universal Ads (Comcast / NBCUniversal).** This is the
> UA-specific companion to the Roku `SPEC.md`. The architecture is identical
> (Cloudflare edge ingestion + Analytics Engine + R2 + probabilistic
> call-to-impression attribution); the differences are the ad-server integration
> (Comcast / FreeWheel ad technology, VAST impression event, IAB macros) and the
> conversion API (Universal Ads Conversions API). Items provisioned during UA
> onboarding / FreeWheel certification rather than fully published are marked
> **[CONFIRM WITH UA]**.

---

### 1. Executive Summary

This document provides a complete technical specification for a custom impression
tracking system for Connected TV (CTV) and Linear advertising delivered through
**Universal Ads**, which is built on **Comcast / FreeWheel ad technology**. The
system is built on **Cloudflare Workers** for global, low-latency ingestion,
**Workers Analytics Engine** for real-time time-series analytics, and **R2** for
long-term data archival.

The system is designed to:
- Replace third-party vendor fees with a cost-effective, owned infrastructure
- Provide full control over first-party impression data
- Scale elastically to handle high-volume CTV/Linear ad traffic
- Comply with Universal Ads / FreeWheel technical requirements for partner
  impression trackers

---

### 2. System Overview

#### 2.1 Problem Statement

CTV/Linear advertising generates millions of impression events daily.
Third-party measurement vendors charge per-impression fees and limit data
access. A custom solution enables:
- **Cost savings**: No per-impression vendor fees
- **Data ownership**: Full access to raw impression data
- **Flexibility**: Custom attribution models and reporting
- **Privacy compliance**: Full control over data handling

#### 2.2 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│              Universal Ads (Comcast / FreeWheel ad tech)         │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Ad server renders CTV/Linear ad and fires the VAST       │  │
│  │  Impression event, calling our partner impression tracker │  │
│  │  GET https://tracker.example.com/pixel?campaign_id=...    │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Cloudflare Workers (Edge)                    │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  /pixel endpoint - ingests impression beacon             │  │
│  │  • Extracts query parameters (campaign, creative, IFA)   │  │
│  │  • Adds geolocation from request.cf                      │  │
│  │  • Writes to Analytics Engine (non-blocking)             │  │
│  │  • Returns 1x1 transparent GIF pixel                    │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                    │                           │
                    ▼                           ▼
┌───────────────────────────────┐ ┌───────────────────────────────┐
│     Workers Analytics Engine  │ │          R2 Storage           │
│  • Real-time time-series data │ │  • Daily NDJSON/Parquet       │
│  • 3-month retention          │ │  • Long-term archival         │
│  • SQL query API              │ │  • Cost-effective storage     │
└───────────────────────────────┘ └───────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Visualization & Reporting                  │
│  • Dashboards (real-time)                                      │
│  • Custom SQL queries via API                                  │
│  • Scheduled reports (daily/weekly)                            │
└─────────────────────────────────────────────────────────────────┘
```

---

### 3. Universal Ads Integration Requirements

#### 3.1 Impression Tracker Compliance

Universal Ads runs on FreeWheel ad technology. Partner-supplied impression
trackers are subject to certification. Our tag is designed to meet standard
first-party/partner tracker requirements:

| Requirement | Specification |
|-------------|---------------|
| **Tag Type** | Impression tracker only (no click, quartile, or VPAID) |
| **Protocol** | HTTPS only (HTTP will be rejected) |
| **Format** | No spaces in URLs; single unwrapped GET |
| **Placement** | Attached to the creative at the ad-server level; fires on the VAST **Impression** event |
| **[CONFIRM WITH UA]** | That partner-supplied impression trackers are permitted on a given creative, and the maximum number of trackers per creative |

#### 3.2 Supported Macros (IAB / VAST)

Universal Ads / FreeWheel substitutes IAB-standard VAST macros into the tracker
URL at fire time. Our proposed macro set (exact tokens confirmed during
certification):

| Purpose | IAB / VAST macro (proposed) | Encoding | Notes |
|---------|-----------------------------|----------|-------|
| Device advertising ID (IFA) | `[IFA]` | Plain | RIDA / IDFA / AAID per device |
| IFA type | `[IFATYPE]` | Plain | Identifies the ID namespace |
| Limit-ad-tracking (LMT) | `[LIMITADTRACKING]` | Plain | Consent/opt-out signal |
| Cachebuster | `[CACHEBUSTING]` | Plain | Prevents caching |
| Device IP | `[IP]` / server-side `CF-Connecting-IP` | Plain | May be withheld under privacy restrictions |
| Household ID (if provided) | `[CONFIRM WITH UA]` | Plain | UA/FreeWheel first-party identity |
| App / content / network | `[APPBUNDLE]`, `[CONTENTID]` … | Plain | Optional, for reporting |

> **[CONFIRM WITH UA]** the exact macro tokens available on the inventory and
> whether a household ID is exposed to partner trackers. If tokens differ from
> the above, we regenerate the tag to match.

#### 3.3 Certification

Per Universal Ads / FreeWheel certification, partner measurement beacons are
validated before go-live. Unlike Roku's RAF client-side watermark, UA/FreeWheel
authenticity is established during certification and by our own HMAC signature on
the tag (see §7.2). **[CONFIRM WITH UA]** the certification steps and any
watermark/authenticity tokens available.

---

### 4. Technical Architecture

#### 4.1 Cloudflare Workers (Ingestion Layer)

The Worker serves as the global entry point for impression beacons.

**Endpoint:** `GET /pixel`

**Query Parameters** (populated by UA/FreeWheel VAST macros):

| Parameter | Source Macro (proposed) | Required | Description |
|-----------|-------------------------|----------|-------------|
| `advertiser_id` | Set by us (signed) | Yes | Advertiser UID |
| `campaign_id` | Set by us (signed) | Yes | Campaign UID |
| `creative_id` | Set by us (signed) | Yes | Creative UID |
| `ifa` | `[IFA]` | Recommended | Device advertising ID (for dedup/reach/attribution) |
| `ifa_type` | `[IFATYPE]` | Optional | IFA namespace |
| `hh_id` | `[CONFIRM WITH UA]` | Optional | Household ID, if provided |
| `lmt` | `[LIMITADTRACKING]` | Recommended | Limit-ad-tracking flag |
| `device_ip` | `[IP]` | Optional | Device IP (may be withheld) |
| `cachebuster` | `[CACHEBUSTING]` | Recommended | Prevents caching |
| `app_id` | `[APPBUNDLE]` | Optional | App/channel/bundle ID |

**Response:** 1x1 transparent GIF pixel (base64 decoded via `atob` into a
`Uint8Array`) with `Cache-Control: no-store`.

#### 4.2 Workers Analytics Engine (Real-Time Analytics)

Analytics Engine provides time-series analytics at scale, optimized for
aggregated queries over high-cardinality data. Writes are non-blocking and do
not impact request latency.

**Dataset:** `impression_events`

We store a **salted hash of the IFA** (`ifa_hash`), never the raw identifier, and
an `ifa_present` flag. Blob order (1-indexed for SQL — `blob1`…`blob20`, there is
no `blob0`):

`1=campaign_id, 2=creative_id, 3=ifa_hash, 4=country, 5=app_id, 6=advertiser_id, 7=ifa_present, 8=ifa_type, 9=platform`

Impression totals are computed as `sum(_sample_interval)`, **not**
`sum(double0)`, because WAE samples.

**Index** (sampling key): `campaign_id` (single value, ≤ 96 bytes) — ensures
equitable sampling per campaign.

**Verified Analytics Engine limits:**

| Limit | Value |
|-------|-------|
| Blobs per data point | 20 max |
| Doubles per data point | 20 max |
| Indexes per data point | exactly 1, ≤ 96 bytes |
| Total blob size | ≤ 16 KB per data point |
| `writeDataPoint` calls per invocation | 250 max |
| Retention | 3 months |

The AE binding (`env.ANALYTICS`) is **write-only**. All reads (reporting + the
daily export) go through the **SQL API** over HTTPS with an account-scoped Bearer
token.

#### 4.3 R2 Storage (Long-Term Archival)

- **Format:** NDJSON (Parquet conversion downstream)
- **Schedule:** Daily export via scheduled Worker (Cron Trigger)
- **Partitioning:** `dt=YYYY-MM-DD/` folder structure
- **Retention:** 13 months aggregate (no raw identifiers); 30 days raw (hashed
  IFA only)

---

### 5. Implementation

The ingestion Worker verifies an HMAC signature + expiry, validates parameter
formats, and checks a campaign allowlist before counting. It deduplicates per
device/campaign/creative via a Durable Object and honors `lmt=1` by discarding
the identifier. The pixel is returned immediately; validation, dedup, and the AE
write run asynchronously via `ctx.waitUntil`, so request latency is unaffected.

The scheduled export reads via the AE **SQL API**, buckets by hour
(`toStartOfHour(timestamp)`), weights by `sum(_sample_interval)`, streams NDJSON
to R2 (idempotent, backfill-capable), and writes a freshness marker for
monitoring.

---

### 6. Querying and Analytics

**Total Impressions by Campaign (Last 7 Days):**

```sql
SELECT blob1 AS campaign_id, sum(_sample_interval) AS total_impressions
FROM impression_events
WHERE timestamp > now() - INTERVAL '7' DAY
GROUP BY campaign_id ORDER BY total_impressions DESC;
```

**Unique Devices by Campaign (Reach) — ESTIMATE ONLY:**

```sql
SELECT blob1 AS campaign_id, count(DISTINCT blob3) AS unique_devices_estimate
FROM impression_events
WHERE timestamp > now() - INTERVAL '30' DAY AND blob7 = '1'
GROUP BY campaign_id;
```

> `count(DISTINCT)` on a non-index, sampled field is a rough estimate. For
> accreditable reach/frequency, derive it from the unsampled dedup store or the
> raw R2 rows — not from AE.

**Sampling.** Analytics Engine samples at **both write and read time**. The
`_sample_interval` column is the per-row weight and **must** be used in
aggregations — `sum(_sample_interval)` for counts, `sum(x * _sample_interval)`
for sums.

---

### 7. Operational Considerations

#### 7.1 Monitoring and Alerting

| Metric | Alert Threshold | Action |
|--------|-----------------|--------|
| Request error rate | > 1% | Investigate Worker code |
| Request latency (p95) | > 200ms | Check Worker performance |
| Daily impression volume | ±20% deviation | Investigate campaign changes |
| Counted/received ratio (reconciliation) | < 50% | Surge of rejects/dupes — investigate tags |
| Export freshness | No new export by 03:00 UTC | Re-run / backfill export |

`writeDataPoint()` is fire-and-forget and returns no status. We **reconcile** via
a separate `ingest_recon` dataset (`received` vs `counted` vs `duplicate` vs
`reject_*`) and alert on the counted ratio and export freshness.

#### 7.2 Security

| Concern | Mitigation |
|---------|------------|
| Impression spoofing | **HMAC-signed tag URLs** with expiry; signature binds `campaign\|creative\|exp` |
| Tag hijacking / injection | Validate + allowlist `campaign_id`/`creative_id`; format-check all params |
| Replay | Dedup store (Durable Object) rejects repeats within the window |
| DDoS | Cloudflare DDoS protection (add per-IP/IFA rate limiting for low-and-slow inflation) |
| Data privacy | **IFA is salted-hashed, never stored raw**; raw device IP not persisted; `lmt=1` honored |
| Unauthorized read access | AE SQL API token scoped to "Account Analytics Read"; stored as a secret |

We are not MRC/IAB-accredited and do not perform accredited invalid-traffic
(GIVT/SIVT) filtration beyond input validation, signature verification, and
deduplication. See `docs/UA_PRIVACY.md`.

#### 7.3 Data Retention

| Storage Tier | Retention | Purpose |
|--------------|-----------|---------|
| Call-matching store (Durable Object) | ~60 min (attribution window) | **Raw** IP/IFA for call matching only |
| Analytics Engine | 3 months (platform fixed) | Real-time dashboards |
| R2 (aggregated) | 13 months (no raw IFA) | Long-term trends |
| R2 (raw, hashed IFA) | 30 days | Reach/frequency, debugging, replay |

Universal Ads remains the system of record for delivered impressions; our counts
are an independent measurement layer. Impression/attribution data held by UA is
governed by UA under its own policies (attribution windows of 7 / 14 / 30 days).

---

### 8. Cost Analysis (infrastructure only)

| Service | Monthly Cost (30M impressions) | Basis |
|---------|-------------------------------|-------|
| Workers Requests | ~$5–9 | 30M requests; $0.30/M after 10M included |
| Analytics Engine Writes | ~$12.50 | ~60M data points (2 per impression) |
| Analytics Engine Queries | ~$1–5 | Per-query |
| R2 Storage | ~$15 | ~1 TB, $0.015/GB-mo |
| **Total (infrastructure)** | **~$35–45/month** | Order-of-magnitude |

This is *infrastructure cost*, not total cost of equivalent accredited
measurement.

---

### 12.5 Call-to-Impression Attribution (Universal Ads CAPI)

The system attributes **inbound phone calls** (one tracking number per creative)
back to impressions and fires conversions to the **Universal Ads Conversions
API**. Because a call provides **only the caller's phone number — no device ID**,
matching is **probabilistic**: the dialed number maps to a creative, and we
select the best-guess in-window impression (scored by time proximity + coarse
area-code geo) and send UA its IFA / household ID + IP + a confidence score. When
no impression is in-window, we fall back to the hashed caller phone so the
conversion still fires. A short-lived `RecentImpressions` Durable Object holds
raw IP/IFA for the attribution window only.

Full design, CAPI payload mapping, PBX webhook contract, and accuracy notes are
in **`docs/UA_ATTRIBUTION.md`**.

> **Probabilistic, not deterministic.** The IFA/IP sent to UA is a best guess,
> not a confirmed device; the confidence score reflects this.

---

### 13. Scope & Non-Goals

**This system IS:** a first-party, owned, low-cost pipeline for **aggregate**
CTV/Linear impression telemetry, with authenticity (HMAC), deduplication, and
privacy controls, **plus probabilistic call-to-impression attribution** that
fires conversions to Universal Ads CAPI (see `docs/UA_ATTRIBUTION.md`).

**This system is NOT:**
- **MRC/IAB-accredited.** Counts are "valid, deduplicated, signed beacons," not
  accredited impressions.
- **Sampled-free.** AE counts are statistical estimates; use the raw R2 tier for
  high-precision/reach.
- **A reach panel or brand-lift product.**

A **reconciliation pilot** against Universal Ads' own ad-server counts is
recommended before this becomes a system of record.

---

### 14. Open Items — [CONFIRM WITH UA]

- Exact IAB/VAST macro tokens available on UA/FreeWheel inventory.
- Whether partner-supplied impression trackers are permitted per creative, and
  the tracker limit.
- Whether a household ID is exposed to partner impression trackers.
- Universal Ads Conversions API endpoint, authentication, event schema, and
  dedup key.
- Certification steps and any authenticity/watermark tokens.
