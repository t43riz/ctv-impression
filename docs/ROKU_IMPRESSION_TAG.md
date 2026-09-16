# Impression Tag Integration — Roku Onboarding

**Audience:** Roku Ad Operations / Measurement onboarding team
**Purpose:** Provide the sample impression pixel, the full list of macros we require, and a concrete example of the recorded output, so Roku can validate our third-party impression tag.

---

## 0. TL;DR — Direct Answers to Your Questions

> **Q1: "Send a sample of your impression pixel."**
> See [§2 Sample Impression Pixel](#2-sample-impression-pixel). It is a single
> HTTPS `GET` to a 1×1 GIF endpoint, no spaces, impression-only.

> **Q2: "And all the macros that you require."**
> See [§3 Macros We Require](#3-macros-we-require). We need **3 Roku macros**
> (`RIDA`, `LMT`, `CACHEBUSTER`) plus an optional 4th (`APPID`). Everything else
> (`campaign_id`, `creative_id`, `advertiser_id`, `exp`, `sig`) is **pre-filled
> by us** when we hand you the tag — you do not populate those.

> **Q3: "Do you have an example of an output of what that would look like in
> your recording?"**
> Yes — see [§5 Example Recorded Output](#5-example-recorded-output). We show
> the raw request we receive, the row we write to our analytics store, and the
> daily aggregated export record.

---

## 1. Tag Properties (Roku Compliance Checklist)

| Requirement | Our Tag | Status |
|-------------|---------|--------|
| Tag type | Impression only (no click / quartile / VAST / VPAID) | ✅ |
| Protocol | HTTPS only (HTTP is rejected) | ✅ |
| Spaces in URL | None | ✅ |
| Fired by RAF client-side, unwrapped | Yes — single direct beacon, no redirects/wrapping | ✅ |
| Tags per creative | 1 | ✅ (well under the 20 limit) |
| Response | `200 OK`, 1×1 transparent GIF, `Cache-Control: no-store` | ✅ |
| Method | `GET` | ✅ |

The endpoint is served on Cloudflare's global edge, so the beacon resolves to
the nearest PoP to the Roku device for low latency.

---

## 2. Sample Impression Pixel

This is exactly what we will deliver into the creative's third-party impression
tracker field. Roku's RAF replaces the `[[[...]]]` macros at fire time.

**Tag as delivered to Roku (with macros unfilled):**

```
https://pixels.postbackx.com/v1/pixel?advertiser_id=adv_udonis&campaign_id=camp_roku_test&creative_id=cre_roku_cert&exp=1805121458&sig=3983d8b1fdd329a265499edd5868b182c5d0267c282a372b94ed6777a378b4b8&ifa=[[[RIDA]]]&ifa_type=rida&lmt=[[[LMT]]]&app_id=[[[APPID]]]&cb=[[[CACHEBUSTER]]]
```

> **This tag is verified live.** Fired against production on 2026-09-16, it
> was recorded in the reconciliation ledger as `counted` (not
> `reject_bad_signature`), and the signature is valid through **2027-03-15 14:37 UTC**
> (`exp=1805121458`). Tell us the campaign flight dates and we will reissue with a
> matching expiry.
>
> Note when testing: the endpoint returns `200` and a 1×1 GIF for *every*
> request, including a rejected one. That is deliberate — the beacon must
> never leak validation state to the device — so a `200` alone does not prove
> an impression was counted. Confirmation comes from the ledger.

**Same tag, after RAF fills the macros on a real device:**

```
https://pixels.postbackx.com/v1/pixel?advertiser_id=adv_udonis&campaign_id=camp_roku_test&creative_id=cre_roku_cert&exp=1805121458&sig=3983d8b1fdd329a265499edd5868b182c5d0267c282a372b94ed6777a378b4b8&ifa=a1b2c3d4-e5f6-7890-abcd-ef1234567890&ifa_type=rida&lmt=0&app_id=12345&cb=8675309421
```

### 2.1 Why some params are pre-filled by us

We sign each tag with an HMAC so impressions cannot be spoofed or a captured URL
re-pointed to a different campaign **or advertiser**. That means **we generate
the per-creative tag for you** with `advertiser_id`, `campaign_id`,
`creative_id`, `exp` (expiry), and `sig` (signature) already embedded. You only
need to ensure RAF fills the device-level macros in §3.

The signed message is `advertiser_id|campaign_id|creative_id|exp`, so the
`sig` value depends on which advertiser the tag is issued to. The `sig` above is
a real, ledger-verified signature for `adv_udonis`; reissue for any other
advertiser, campaign or creative with
`npm run sign -- --campaign ... --creative ... --advertiser ...`.
`test/sign-url.test.ts` runs that generator against the Worker's own verifier,
so the two cannot drift into emitting plausible-looking tags that are rejected.
`ifa` and `lmt`
can never be covered by the signature — the ad server substitutes them on the
device after the tag is served — so those are protected by the per-IP rate limit
and the dedup window instead.

---

## 3. Macros We Require

### 3.1 Roku macros RAF must populate

| URL param | Roku macro | Required? | Why we need it |
|-----------|------------|-----------|----------------|
| `ifa` | `[[[RIDA]]]` | **Required** | Roku ID for Advertisers. Used (hashed) for deduplication and reach. |
| `lmt` | `[[[LMT]]]` | **Required** | Limit-Ad-Tracking flag. We honor opt-out: when `lmt=1` we drop the identifier. |
| `cb` | `[[[CACHEBUSTER]]]` | **Required** | Cachebuster — guarantees the device/CDN does not serve a cached pixel. |
| `app_id` | `[[[APPID]]]` | Recommended | Roku app/channel ID, for per-app reporting. |

> If your macro tokens differ from `[[[RIDA]]]` / `[[[LMT]]]` / `[[[APPID]]]` /
> `[[[CACHEBUSTER]]]`, tell us the exact tokens and we will regenerate the tag
> to match. We do **not** require click, quartile, or VAST macros.

### 3.2 Params we pre-fill (no action needed from Roku)

| URL param | Source | Description |
|-----------|--------|-------------|
| `advertiser_id` | Set by us | Advertiser UID (from your `[[[ADVERTISERID]]]` mapping or our own ID). |
| `campaign_id` | Set by us | Campaign UID. |
| `creative_id` | Set by us | Creative UID (plain, non-encoded). |
| `exp` | Set by us | Unix-seconds expiry for the signature (typically campaign flight end). |
| `sig` | Set by us | HMAC-SHA256 over `campaign_id|creative_id|exp`. |

---

## 4. End-to-End Flow

```
 ┌──────────────────────┐
 │  Roku CTV Device     │  RAF renders ad, fires impression beacon.
 │  (RAF, watermarked)  │  Macros [[[RIDA]]],[[[LMT]]],[[[APPID]]],
 └──────────┬───────────┘  [[[CACHEBUSTER]]] are substituted here.
            │  HTTPS GET /v1/pixel?...
            ▼
 ┌──────────────────────────────────────────────┐
 │  Cloudflare Worker (nearest edge PoP)        │
 │  1. Validate params (format + required)      │
 │  2. Verify HMAC signature + expiry           │
 │  3. Check campaign is active (allowlist)     │
 │  4. Honor LMT → hash IFA, or anonymize       │
 │  5. Deduplicate (per device/campaign/window) │
 │  6. Write impression to Analytics Engine     │
 │  7. Return 1×1 GIF (200, no-store)           │
 └──────────┬───────────────────────────────────┘
            │  (async, non-blocking — step 7 returns immediately)
            ▼
 ┌───────────────────────────┐   ┌───────────────────────────┐
 │ Workers Analytics Engine  │   │ R2 (daily NDJSON export)   │
 │ real-time, ~90d retention │──▶│ long-term, aggregated      │
 └───────────────────────────┘   └───────────────────────────┘
```

**Latency:** The GIF is returned before steps 5–6 complete (those run
asynchronously via `waitUntil`), so the device sees a fast response.

**Privacy at ingest:** We never persist the raw `ifa`. It is salted-hashed for
dedup/reach, and when `lmt=1` (or the IFA is zeroed) we discard it entirely and
mark the impression non-attributable.

---

## 5. Example Recorded Output

This section answers *"what would that look like in your recording?"* We show
the same single impression at three stages.

### 5.1 What we receive (raw request log)

```json
{
  "ts": "2025-01-15T18:42:07.512Z",
  "method": "GET",
  "path": "/v1/pixel",
  "edge_pop": "LAX",
  "query": {
    "advertiser_id": "adv_acme",
    "campaign_id": "camp_spring24",
    "creative_id": "cre_30s_hero",
    "exp": "1735689600",
    "sig": "9f1c2a7b4e8d3056c1a9f4b2e7d80c5316a2b9f4e1c7d0a3b6e9f2c5d8a1b4e7f0",
    "ifa": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "lmt": "0",
    "app_id": "12345",
    "cb": "8675309421"
  },
  "cf_country": "US",
  "response_status": 200,
  "response_content_type": "image/gif"
}
```

### 5.2 The row we store (Analytics Engine data point)

Note the raw IFA is **gone** — replaced by a salted SHA-256 hash. `ifa_present=1`
means the device was trackable (LMT off).

```json
{
  "dataset": "impression_events",
  "indexes": ["camp_spring24"],
  "blobs": [
    "camp_spring24",                                                    // campaign_id
    "cre_30s_hero",                                                     // creative_id
    "4c2a...e91b (sha256(salt|ifa), 64 hex chars)",                    // ifa_hash
    "US",                                                              // country
    "12345",                                                           // app_id
    "adv_acme",                                                        // advertiser_id
    "1"                                                                // ifa_present
  ],
  "doubles": [1],
  "timestamp": "2025-01-15T18:42:07Z"
}
```

If the same device fires the same creative again within the dedup window
(default 24h), we record it as a `duplicate` in our reconciliation counter and
do **not** add a second impression.

### 5.3 The daily aggregated export (R2, one record)

Each night we roll the day up to hourly buckets and write NDJSON to R2 (one
JSON object per line). A single line for the impression above:

```json
{"hour":"2025-01-15T18:00:00Z","campaign_id":"camp_spring24","creative_id":"cre_30s_hero","country":"US","app_id":"12345","advertiser_id":"adv_acme","ifa_present":"1","impressions":1}
```

After a day of traffic, that same hour/creative line would read e.g.
`"impressions": 4821` — the count is computed as `sum(_sample_interval)` so it
correctly extrapolates through analytics sampling.

### 5.4 Example reporting query result

"Impressions by campaign, last 7 days":

```json
[
  { "campaign_id": "camp_spring24", "impressions": 1284553 },
  { "campaign_id": "camp_winter24", "impressions": 904118 }
]
```

---

## 6. Validation / Test Plan with Roku

1. **You send us your exact macro tokens** if they differ from §3.1.
2. ~~We deliver a signed test tag~~ — **done.** The tag in §2 is live on
   `campaign_id=camp_roku_test` and has been verified end to end on our side
   (valid beacon counted, repeat beacon deduplicated, `lmt=1` beacon counted
   with the identifier dropped, bad-signature beacon rejected).
3. Roku fires test beacons from a certification device (RAF watermark applied).
4. We confirm, in near-real-time, the recorded rows (as in §5.2) and share a
   reconciliation report: beacons received vs. counted vs. deduplicated.
5. We compare our counts to Roku's ad-server counts and resolve any discrepancy
   before going live.

A quick manual test you can run yourself (returns a 1×1 GIF):

```
curl -i "https://pixels.postbackx.com/v1/pixel?advertiser_id=adv_udonis&campaign_id=camp_roku_test&creative_id=cre_roku_cert&exp=1797273063&sig=ab068b0ecb31b53bc801097e9d6159b9dc7eb338d9b8cb2bb7e08b929876b0cf&ifa=test-device-001&lmt=0&app_id=12345&cb=12345"
```

No coordination needed — that command works right now.

---

## 7. FAQ

**Does the beacon ever redirect or wrap another vendor?**
No. It is a single, direct, unwrapped GET, fired client-side by RAF, as Roku
certification requires.

**Do you store IP or PII?**
Nothing in our analytics or export tier contains a raw identifier: the RIDA is
salted-SHA-256 hashed at ingest, and device IP is never written there at all.
We honor `LMT=1` by dropping the identifier entirely.

For attribution we hold raw device IP and RIDA in a short-lived edge store,
scoped to a bounded matching window (currently 60 minutes) and then discarded.
Records are written with empty identifiers when `lmt=1`, so opted-out devices
are never retained. We have asked Roku to confirm in writing whether this
bounded raw retention is acceptable or whether both fields must be hashed at
ingest; we will conform to whichever you specify.

**What happens under Limit Ad Tracking (`lmt=1`)?**
We still return the pixel and count the impression, but we discard the
identifier and flag the row `ifa_present=0` (counts toward totals, excluded from
device-level reach).

**Why is there a signature on the tag?**
To prevent impression spoofing and stop a captured URL from being re-pointed to
another campaign. It does not change anything RAF has to do.

**What is your retention?**
Real-time analytics store ~90 days (hashed identifiers only); a 30-day
hashed-identifier tier for reach/frequency and DSAR erasure; aggregated daily
export retained 395 days. Both storage tiers have hard expiry lifecycle rules
enforced at the bucket level. Raw identifiers persist only in the 60-minute
matching window described above.

---

## 8. Contact

For macro confirmation, test scheduling, or the signed test tag, reply to this
thread and we'll turn it around the same day.
