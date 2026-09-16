# Custom CTV Impression Tracking System

## Technical Specification

> **Revision note (v0.2):** This spec was revised after an expert review and
> verification against current Cloudflare docs. Corrected build-blocking errors
> (AE read path, sampling math, export aggregation, cost figures, AE limits) and
> added authenticity, deduplication, and privacy designs. See
> [§13 Scope & Non-Goals](#13-scope--non-goals) for an explicit statement of
> what this system is and is **not**.

---

### 1. Executive Summary

This document provides a complete technical specification for building a custom impression tracking system for Connected TV (CTV) advertising, specifically designed to receive tracking beacons from platforms like Roku. The system is built on **Cloudflare Workers** for global, low-latency ingestion, **Workers Analytics Engine** for real-time time-series analytics, and **R2** for long-term data archival.

The system is designed to:
- Replace third-party vendor fees with a cost-effective, owned infrastructure
- Provide full control over first-party impression data
- Scale elastically to handle high-volume CTV ad traffic
- Comply with Roku's technical requirements for impression tags

---

### 2. System Overview

#### 2.1 Problem Statement

CTV advertising generates millions of impression events daily. Third-party measurement vendors charge per-impression fees and limit data access. A custom solution enables:
- **Cost savings**: No per-impression vendor fees
- **Data ownership**: Full access to raw impression data
- **Flexibility**: Custom attribution models and reporting
- **Privacy compliance**: Full control over data handling

#### 2.2 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Roku CTV Device                         │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  RAF (Roku Advertising Framework) fires impression beacon │  │
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
│  • Real-time time-series data │ │  • Daily Parquet exports      │
│  • 90-day retention           │ │  • Long-term archival         │
│  • SQL/GraphQL query API      │ │  • Cost-effective storage     │
└───────────────────────────────┘ └───────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Visualization & Reporting                  │
│  • Grafana dashboards (real-time)                              │
│  • Custom SQL queries via API                                  │
│  • Scheduled reports (daily/weekly)                            │
└─────────────────────────────────────────────────────────────────┘
```

---

### 3. Roku Integration Requirements

#### 3.1 Impression Tag Compliance

Roku has specific requirements for third-party impression tags:

| Requirement | Specification |
|-------------|---------------|
| **Tag Type** | Impression tags only (no click tags, quartile tags, VAST/VPAID) |
| **Protocol** | HTTPS only (HTTP will be rejected) |
| **Format** | No spaces in URLs |
| **Limit** | Maximum 20 unique tracking tags per creative |

#### 3.2 Supported Macros

Roku provides the following macros for impression tags:

| Macro | Description | Encoding |
|-------|-------------|----------|
| `[[[ADVERTISERID]]]` | Advertiser UID | Plain |
| `[[[CAMPAIGNID]]]` | Campaign UID | Plain |
| `[[[CREATIVEID]]]` | Creative UID | Base64 encoded |
| `[[[CREATIVEID_URL]]]` | Creative UID | Plain (non-encoded) |
| `[[[DEVICE_IP]]]` | Device IP from Open RTB | Returns "0.0.0.0" if LMT=1 or privacy restrictions apply |
| `[[[CACHEBUSTER]]]` | Cachebuster (numeric or alphanumeric) |

#### 3.3 RAF Requirements

Per Roku's certification requirements, all ad measurement beacons must be fired directly by RAF client-side (they may not be wrapped). This automatically applies the **Roku Advertising Watermark** to beacons, which attests they originated from authentic Roku devices.

All apps that monetize advertising must integrate RAF to pass certification.

---

### 4. Technical Architecture

#### 4.1 Cloudflare Workers (Ingestion Layer)

The Worker serves as the global entry point for impression beacons.

**Endpoint:** `GET /pixel`

**Query Parameters** (populated by Roku macros):

| Parameter | Source Macro | Required | Description |
|-----------|--------------|----------|-------------|
| `advertiser_id` | `[[[ADVERTISERID]]]` | Yes | Advertiser UID |
| `campaign_id` | `[[[CAMPAIGNID]]]` | Yes | Campaign UID |
| `creative_id` | `[[[CREATIVEID_URL]]]` | Yes | Creative UID (plain) |
| `creative_id_b64` | `[[[CREATIVEID]]]` | Optional | Creative UID (base64) |
| `device_ip` | `[[[DEVICE_IP]]]` | Optional | Device IP (may be "0.0.0.0") |
| `cachebuster` | `[[[CACHEBUSTER]]]` | Recommended | Prevents caching |
| `ifa` | Custom | Recommended | Identifier for Advertisers (for deduplication) |
| `ifa_type` | Custom | Optional | Type of identifier (e.g., "roku_ifa") |
| `app_id` | Custom | Recommended | Roku app/channel ID |
| `session_id` | Custom | Optional | Session identifier |

**Response:** 1x1 transparent GIF pixel (base64 encoded) with appropriate cache-control headers.

#### 4.2 Workers Analytics Engine (Real-Time Analytics)

Analytics Engine provides time-series analytics at scale, optimized for aggregated queries over high-cardinality data. Writes are non-blocking and do not impact request latency.

**Dataset:** `impression_events`

**Data Point Structure**:

| Field | Type | Description |
|-------|------|-------------|
| `blobs` | string[] | Dimensions for grouping/filtering |
| `doubles` | number[] | Numeric metrics |
| `indexes` | string[] | Sampling key (single value only) |

**Blob Schema** (ordered array):

| Index | Field | Description |
|-------|-------|-------------|
| 0 | `campaign_id` | Campaign UID |
| 1 | `creative_id` | Creative UID |
| 2 | `ifa` | Device identifier |
| 3 | `country` | Geolocation (from `request.cf.country`) |
| 4 | `app_id` | Roku app/channel ID |
| 5 | `advertiser_id` | Advertiser UID |

> **Correction (v0.2):** We store a **salted hash of the IFA** (`ifa_hash`),
> never the raw identifier, and add an `ifa_present` flag (blob index 6). When
> querying via SQL, blobs are **1-indexed** (`blob1`…`blob20`) — there is no
> `blob0`. Our actual blob order is:
> `1=campaign_id, 2=creative_id, 3=ifa_hash, 4=country, 5=app_id, 6=advertiser_id, 7=ifa_present, 8=ifa_type, 9=platform`.
> Blobs 8–9 were appended for the Universal Ads integration; rows written
> before the addition read back as `''` and queries must tolerate that.

**Doubles Schema** (ordered array):

| Index | Field | Description |
|-------|-------|-------------|
| 0 | `count` | Always 1. Impression totals are computed as `sum(_sample_interval)`, **not** `sum(double0)`, because WAE samples. |

**Index** (sampling key):
- Use `campaign_id` as the single index
- This ensures equitable sampling per campaign, preventing high-volume campaigns from drowning out smaller ones

**Verified Analytics Engine limits** (per Cloudflare docs):

| Limit | Value |
|-------|-------|
| Blobs per data point | 20 max |
| Doubles per data point | 20 max |
| Indexes per data point | exactly 1, ≤ 96 bytes |
| Total blob size | ≤ 16 KB per data point |
| `writeDataPoint` calls per invocation | 250 max |
| Retention | 3 months |

> **Correction (v0.2):** The AE binding (`env.ANALYTICS`) is **write-only** —
> it exposes only `writeDataPoint()`. All reads (reporting + the daily export)
> go through the **SQL API** over HTTPS with an account-scoped Bearer token, not
> the binding. See §5.4 and `src/lib/sql.ts`.

#### 4.3 R2 Storage (Long-Term Archival)

Analytics Engine has a retention period (typically 90 days). For long-term storage and compliance:

- **Format:** Apache Parquet (columnar, efficient for analytics)
- **Schedule:** Daily export via scheduled Worker (Cron Trigger)
- **Partitioning:** `dt=YYYY-MM-DD/` folder structure
- **Retention:** Configurable (e.g., 7 years for compliance)

---

### 5. Implementation

#### 5.1 Project Setup

```bash
npm create cloudflare@latest ctv-impression-tracker
cd ctv-impression-tracker
```

#### 5.2 Wrangler Configuration (`wrangler.toml`)

```toml
name = "ctv-impression-tracker"
main = "src/index.js"
compatibility_date = "2024-12-18"

[[analytics_engine_datasets]]
binding = "ANALYTICS"
dataset = "impression_events"

[[r2_buckets]]
binding = "ARCHIVE"
bucket_name = "impression-archive"

[triggers]
crons = ["0 2 * * *"]  # Daily export at 2 AM UTC
```

#### 5.3 Worker Implementation

> **Implemented in `src/index.ts` + `src/lib/*.ts`.** The original inline
> snippet had three defects, now fixed:
>
> 1. **`Buffer` is undefined in Workers** without `nodejs_compat`. We decode the
>    GIF with `atob` into a `Uint8Array` (`src/lib/pixel.ts`).
> 2. **No validation/authenticity.** The endpoint now verifies an HMAC signature
>    + expiry, validates parameter formats, and checks a campaign allowlist
>    before counting (`src/lib/beacon.ts`).
> 3. **No dedup or LMT handling.** We deduplicate per device/campaign/creative
>    via a Durable Object (`src/dedup.ts`) and honor `lmt=1` by discarding the
>    identifier.
>
> The pixel is returned immediately; validation, dedup, and the AE write run
> asynchronously via `ctx.waitUntil`, so request latency is unaffected.

#### 5.4 Scheduled Export Worker

> **Implemented in `src/export.ts`.** The original inline snippet had two
> build-blocking defects, now fixed:
>
> 1. **AE cannot be queried via the binding.** Reads go through the **SQL API**
>    over HTTPS with a Bearer token (`src/lib/sql.ts`).
> 2. **`GROUP BY … timestamp` defeats aggregation** (one row per event) and
>    `sum(double0)` undercounts. We bucket by hour (`toStartOfHour(timestamp)`)
>    and weight by `sum(_sample_interval)`.
>
> The export is **memory-safe** (paginates the query, streams NDJSON — Parquet
> conversion runs downstream off the 128 MB isolate), **idempotent**
> (deterministic key `dt=YYYY-MM-DD/impressions.ndjson`, overwrite-safe),
> supports **backfill**, and writes a freshness marker for monitoring.

---

### 6. Querying and Analytics

#### 6.1 SQL API Examples

**Total Impressions by Campaign (Last 7 Days):**

```sql
SELECT
    blob0 AS campaign_id,
    sum(_sample_interval) AS total_impressions
FROM impression_events
WHERE timestamp > now() - INTERVAL '7' DAY
GROUP BY campaign_id
ORDER BY total_impressions DESC;
```

**Impressions by Country (Last 24 Hours):**

```sql
SELECT
    blob3 AS country,
    sum(_sample_interval) AS impressions
FROM impression_events
WHERE timestamp > now() - INTERVAL '1' DAY
GROUP BY country
ORDER BY impressions DESC;
```

**Unique Devices by Campaign (Reach) — ESTIMATE ONLY:**

> **Correction (v0.2):** `count(DISTINCT)` on a non-index, sampled field is
> **not reliable** and cannot be reweighted by `_sample_interval`. Treat this as
> a rough estimate. For accreditable reach/frequency, derive it from the
> unsampled dedup store or the raw R2 rows — not from AE. Note the field is
> `blob3` (ifa_hash, 1-indexed) and we filter to attributable rows.

```sql
SELECT
    blob1 AS campaign_id,
    count(DISTINCT blob3) AS unique_devices_estimate
FROM impression_events
WHERE timestamp > now() - INTERVAL '30' DAY
  AND blob7 = '1'   -- ifa_present (attributable only)
GROUP BY campaign_id;
```

**Hourly Impression Trend:**

```sql
SELECT
    date_trunc('hour', timestamp) AS hour,
    sum(_sample_interval) AS impressions
FROM impression_events
WHERE timestamp > now() - INTERVAL '24' HOUR
GROUP BY hour
ORDER BY hour;
```

#### 6.2 Sampling Considerations

> **Correction (v0.2):** Analytics Engine samples at **both write time and read
> time** — not "at read time" only. (1) Writes are sampled if data points are
> written too fast into one index; (2) Adaptive Bit Rate (ABR) sampling applies
> again at query time for long time ranges. The `_sample_interval` column is the
> per-row weight (inverse of the sample rate) and **must** be used in
> aggregations — `sum(_sample_interval)` for counts, `sum(x * _sample_interval)`
> for sums. Multiplying by a single constant factor is incorrect because the
> interval varies per row.

**Best Practices:**
- Use `campaign_id` as the index so each campaign is sampled equitably
- `count(DISTINCT field)` is only accurate for the **index** field; for other
  fields (e.g. ifa_hash) it is an estimate — see the reach note in §6.1
- Querying across many index values at once lowers resolution
- For high-precision / accreditable reporting, use the raw R2 data, not AE

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

> **Correction (v0.2):** "Analytics Engine write failures > 0" is **not
> observable** — `writeDataPoint()` is fire-and-forget and returns no status,
> and sampling silently sheds data. Instead we **reconcile**: a separate
> `ingest_recon` dataset counts `received` vs `counted` vs `duplicate` vs
> `reject_*` outcomes (`src/monitor.ts`), and we alert on the counted ratio and
> on export freshness — both of which *can* actually fire.

#### 7.2 Security

| Concern | Mitigation |
|---------|------------|
| Impression spoofing | **HMAC-signed tag URLs** with expiry; signature binds `campaign\|creative\|exp` so a captured URL cannot be re-pointed. Unsigned/invalid beacons are not counted. |
| Tag hijacking / injection | Validate + allowlist `campaign_id`/`creative_id`; format-check all params |
| Replay | Dedup store (Durable Object) rejects repeats within the window |
| DDoS | Cloudflare's built-in DDoS protection (add per-IP/IFA rate limiting for low-and-slow inflation) |
| Data privacy | **IFA is salted-hashed, never stored raw**; raw device IP not persisted; `lmt=1` honored |
| Unauthorized read access | AE SQL API token scoped to "Account Analytics Read"; stored as a secret |

> **Correction (v0.2):** The original "No PII stored" claim was inaccurate — the
> IFA (RIDA) is personal data. We now never persist it raw (salted SHA-256
> only), and we honor Limit-Ad-Tracking. The Roku watermark, by itself, is not a
> verification mechanism unless validated server-side; until we are a
> Roku-recognized measurement partner with verification tooling, our authenticity
> control is the HMAC signature above. See `docs/PRIVACY.md`.

#### 7.3 Data Retention

| Storage Tier | Retention | Purpose |
|--------------|-----------|---------|
| Analytics Engine | 3 months (fixed by platform) | Real-time dashboards, recent analysis |
| R2 (aggregated NDJSON/Parquet) | 13 months (aggregate, no raw IFA) | Long-term trend analysis |
| R2 (raw, hashed IFA) | 30 days | Reach/frequency, debugging, replay |

> **Correction (v0.2):** AE retention is **3 months**, not configurable to 90+
> by us. We avoid 7-year identifier-level retention (storage minimization): the
> long-term tier holds **aggregates without raw identifiers**, and only the
> 30-day raw tier holds hashed (never raw) IFAs. DSAR/erasure is handled by
> dropping a device's hashed key from the raw tier and dedup store; aggregates
> contain no identifier. See `docs/PRIVACY.md`.

---

### 8. Cost Analysis

#### 8.1 Cloudflare Pricing (corrected against live pricing)

> **Correction (v0.2):** Verified unit prices: AE **writes** = first 10M/mo
> included, then **$0.25/M**; AE **read queries** = first 1M/mo included, then
> **$1.00 per million queries** (billed per query, not per row); R2 storage =
> **$0.015/GB-mo** (1 TB ≈ $15). Note we write **2 data points per impression**
> (one to `impression_events`, one to `ingest_recon`), so 30M impressions ≈ 60M
> writes.

| Service | Monthly Cost (30M impressions) | Basis |
|---------|-------------------------------|-------|
| Workers Requests | ~$5–9 | 30M requests; $0.30/M after 10M included (Paid plan base $5) |
| Analytics Engine Writes | ~$12.50 | ~60M data points: (60M − 10M) × $0.25/M |
| Analytics Engine Queries | ~$1–5 | Per-query; depends on dashboard/export frequency |
| R2 Storage | ~$15 | ~1 TB aggregated + raw, $0.015/GB-mo |
| **Total (infrastructure)** | **~$35–45/month** | Order-of-magnitude, not $15 |

#### 8.2 Cost Comparison (infrastructure only)

| Solution | Monthly Cost (30M impressions) |
|----------|-------------------------------|
| Third-party vendor | $3,000 - $15,000 |
| Custom Cloudflare solution | ~$35-45 (infrastructure) |

> **Correction (v0.2):** This is an **apples-to-oranges** comparison and should
> be framed as *infrastructure cost*, not total cost of equivalent capability.
> Vendor fees buy MRC/IVT accreditation, brand lift, panels, and cross-publisher
> reach — none of which this system provides (see §13). The honest headline is
> "dramatically cheaper infrastructure for first-party aggregate telemetry," not
> a 99.5% saving on equivalent measurement.

---

### 9. Comparison: Custom vs. Third-Party

| Dimension | Custom Solution | Third-Party Vendor |
|-----------|-----------------|-------------------|
| **Cost** | ~$35-45/month infra (30M impressions) | $3,000 - $15,000/month |
| **Data Ownership** | Full control | Limited access |
| **Platform Certification** | Requires self-certification | Pre-certified partners |
| **Measurement Capabilities** | Basic to advanced (custom) | Brand lift, attribution, panels |
| **Implementation Effort** | High (2-4 weeks) | Low (hours) |
| **Maintenance** | Self-managed | Vendor-managed |
| **Scalability** | Elastic (Cloudflare) | Elastic |
| **Privacy Compliance** | Full control | Vendor-dependent |

---

### 10. Deployment Roadmap

| Phase | Duration | Activities |
|-------|----------|------------|
| **Phase 1: Core Ingestion** | Week 1 | Worker implementation, Analytics Engine setup, basic dashboard |
| **Phase 2: Testing** | Week 2 | Load testing, Roku tag validation, UAT |
| **Phase 3: Production** | Week 3 | Deploy to production, monitor, optimize |
| **Phase 4: Archival** | Week 4 | R2 export setup, long-term storage configuration |
| **Phase 5: Advanced Analytics** | Week 5+ | Custom dashboards, attribution models, alerting |

---

### 11. Success Criteria

| Metric | Target |
|--------|--------|
| Request latency (p95) | < 150ms |
| Request success rate (HTTP) | > 99.9% |
| Count accuracy (campaign daily totals) | ±2% at 95% CI vs. raw reconciliation |
| Counted/received reconciliation ratio | within expected band per campaign |
| Dashboard query time | < 5 seconds |
| R2 export success | 100% daily (enforced via freshness alert) |

> **Correction (v0.2):** "Data loss = 0%" is **not achievable** on Analytics
> Engine — it samples by design and writes are fire-and-forget. The honest,
> measurable SLO is a **count-accuracy target with a confidence interval**,
> validated against the raw reconciliation counts, not a zero-loss guarantee.

---

### 12.5 Call-to-Impression Attribution (Roku CAPI)

The system also attributes **inbound phone calls** (one tracking number per
creative) back to impressions and fires conversions to Roku's Conversions API.

Because a call provides **only the caller's phone number — no device ID**,
matching is **probabilistic**: the dialed number maps to a creative, and we
select the best-guess in-window impression (scored by time proximity + coarse
area-code geo) and send Roku its IP/RIDA + a confidence score. When no
impression is in-window, we fall back to the hashed caller phone so the
conversion still fires. A short-lived `RecentImpressions` Durable Object holds
raw IP/RIDA for the attribution window only (AE cannot do 1:1 matching).

Full design, CAPI payload mapping, PBX webhook contract, and accuracy/limitation
notes are in **`docs/ATTRIBUTION.md`**.

> **Probabilistic, not deterministic.** The IP/RIDA sent to Roku is a best
> guess, not a confirmed device. Disambiguation degrades as in-window
> impressions per creative grow; the confidence score reflects this.

---

### 13. Scope & Non-Goals

**This system IS:** a first-party, owned, low-cost pipeline for **aggregate**
CTV impression telemetry — campaign/creative/geo/app totals and trends, with
authenticity (HMAC), deduplication, and privacy controls — **plus probabilistic
call-to-impression attribution** that fires conversions to Roku CAPI
(see §12.5 / `docs/ATTRIBUTION.md`).

**This system is NOT:**
- **MRC/IAB-accredited.** It does not perform accredited valid-impression
  measurement or general invalid traffic (GIVT/SIVT) filtration beyond basic
  validation. Counts are "valid, deduplicated, signed beacons," not accredited
  impressions.
- **Sampled-free.** AE counts are statistical estimates (`_sample_interval`);
  use the raw R2 tier for high-precision/reach.
- **A reach panel or brand-lift product.** No panels, no cross-publisher
  identity graph, no attribution beyond what the beacon carries.
- **Self-attesting via Roku watermark** unless/until we integrate Roku's
  verification tooling as a recognized partner.

A **Phase 0 reconciliation pilot** against Roku's own ad-server counts is
recommended before this becomes a system of record.

---

### 12. References

- Roku Help Center: [Measuring Campaigns with Third Party Solutions](https://help.ads.roku.com/en/articles/10386309-measuring-campaigns-with-third-party-solutions)
- Roku Developer Docs: [Advertising Overview](https://developer.roku.com/dev/docs/advertising)
- Roku Developer Docs: [Roku Advertising Requirements](https://developer.roku.com/dev/docs/ad-requirements)
- Cloudflare Docs: [Workers Analytics Engine - Get Started](https://developers.cloudflare.com/analytics/analytics-engine/get-started/)
- Cloudflare Docs: [Write to Analytics Engine](https://developers.cloudflare.com/workers/examples/analytics-engine/)
- Cloudflare Docs: [Workers Analytics Engine FAQs](https://developers.cloudflare.com/analytics/analytics-engine/faq/)
