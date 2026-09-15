# Impression Tracker Integration — Universal Ads Onboarding

**Audience:** Universal Ads Ad Operations / Measurement onboarding team
**Purpose:** Provide the sample impression pixel, the full list of macros we
require, and a concrete example of the recorded output, so Universal Ads /
FreeWheel can validate our partner impression tracker.

---

## 0. TL;DR — Direct Answers to Your Questions

> **Q1: "Send a sample of your impression tracker."**
> See [§2 Sample Impression Pixel](#2-sample-impression-pixel). It is a single
> HTTPS `GET` to a 1×1 GIF endpoint, no spaces, impression-only, fired on the
> VAST **Impression** event.

> **Q2: "And all the macros that you require."**
> See [§3 Macros We Require](#3-macros-we-require). We need the device
> advertising ID, limit-ad-tracking, and cachebuster macros (IAB/VAST), plus an
> optional household ID and app/bundle. Everything else (`campaign_id`,
> `creative_id`, `advertiser_id`, `exp`, `sig`) is **pre-filled by us** when we
> hand you the tag.

> **Q3: "Do you have an example of an output of what that would look like in
> your recording?"**
> Yes — see [§5 Example Recorded Output](#5-example-recorded-output). We show the
> raw request we receive, the row we write to our analytics store, and the daily
> aggregated export record.

---

## 1. Tag Properties (Compliance Checklist)

| Requirement | Our Tag | Status |
|-------------|---------|--------|
| Tag type | Impression only (no click / quartile / VAST wrapper / VPAID) | ✅ |
| Protocol | HTTPS only (HTTP is rejected) | ✅ |
| Spaces in URL | None | ✅ |
| Placement | Attached to creative at the ad-server level; fires on VAST **Impression** event | ✅ |
| Unwrapped | Single direct beacon, no redirects/wrapping | ✅ |
| Tags per creative | 1 | ✅ |
| Response | `200 OK`, 1×1 transparent GIF, `Cache-Control: no-store` | ✅ |
| Method | `GET` | ✅ |
| Partner tracker permitted on creative | **[CONFIRM WITH UA]** during certification | ⏳ |

The endpoint is served on Cloudflare's global edge, so the beacon resolves to
the nearest PoP for low latency.

---

## 2. Sample Impression Pixel

This is exactly what we will deliver into the creative's impression tracker
field. Universal Ads / FreeWheel replaces the VAST macros at fire time.

**Tag as delivered to UA (with macros unfilled):**

```
https://tracker.example.com/pixel?advertiser_id=adv_acme&campaign_id=camp_spring24&creative_id=cre_30s_hero&exp=1735689600&sig=9f1c2a7b4e8d3056c1a9f4b2e7d80c5316a2b9f4e1c7d0a3b6e9f2c5d8a1b4e7f0&ifa=[IFA]&ifa_type=[IFATYPE]&lmt=[LIMITADTRACKING]&app_id=[APPBUNDLE]&cb=[CACHEBUSTING]
```

> The `sig` is a 64-char hex string; the real tag contains no spaces.
> **[CONFIRM WITH UA]** the exact macro tokens; the `[IFA]` / `[LIMITADTRACKING]`
> / `[CACHEBUSTING]` / `[APPBUNDLE]` above are the IAB/VAST defaults and we will
> regenerate to match FreeWheel's tokens if they differ.

**Same tag, after UA/FreeWheel fills the macros on a real device:**

```
https://tracker.example.com/pixel?advertiser_id=adv_acme&campaign_id=camp_spring24&creative_id=cre_30s_hero&exp=1735689600&sig=9f1c2a7b4e8d3056c1a9f4b2e7d80c5316a2b9f4e1c7d0a3b6e9f2c5d8a1b4e7f0&ifa=a1b2c3d4-e5f6-7890-abcd-ef1234567890&ifa_type=rida&lmt=0&app_id=com.example.channel&cb=8675309421
```

### 2.1 Why some params are pre-filled by us

We sign each tag with an HMAC so impressions cannot be spoofed or a captured URL
re-pointed to a different campaign. That means **we generate the per-creative tag
for you** with `advertiser_id`, `campaign_id`, `creative_id`, `exp` (expiry), and
`sig` (signature) already embedded. The signed message is
`advertiser_id|campaign_id|creative_id|exp`, so the `sig` depends on the
advertiser the tag is issued to; the values in the examples above are
illustrative and the real one comes from `npm run sign`. You only need to ensure the ad server fills
the device-level macros in §3.

---

## 3. Macros We Require

### 3.1 IAB / VAST macros UA/FreeWheel must populate

| URL param | VAST macro (proposed) | Required? | Why we need it |
|-----------|-----------------------|-----------|----------------|
| `ifa` | `[IFA]` | **Required** | Device advertising ID (RIDA/IDFA/AAID). Used (hashed) for deduplication, reach, and attribution. |
| `ifa_type` | `[IFATYPE]` | Recommended | Identifies the ID namespace/device type. |
| `lmt` | `[LIMITADTRACKING]` | **Required** | Limit-Ad-Tracking flag. We honor opt-out: when `lmt=1` we drop the identifier. |
| `cb` | `[CACHEBUSTING]` | **Required** | Cachebuster — guarantees no cached pixel is served. |
| `app_id` | `[APPBUNDLE]` | Recommended | App/channel/bundle ID, for per-app reporting. |
| `hh_id` | **[CONFIRM WITH UA]** | Optional | Household ID for first-party matching, if exposed to partner trackers. |

> If your macro tokens differ, tell us the exact tokens and we will regenerate
> the tag to match. We do **not** require click, quartile, or VAST wrapper
> macros.

### 3.2 Params we pre-fill (no action needed from UA)

| URL param | Source | Description |
|-----------|--------|-------------|
| `advertiser_id` | Set by us | Advertiser UID (from your account mapping or our own ID). |
| `campaign_id` | Set by us | Campaign UID. |
| `creative_id` | Set by us | Creative UID. |
| `exp` | Set by us | Unix-seconds expiry for the signature (typically campaign flight end). |
| `sig` | Set by us | HMAC-SHA256 over `campaign_id\|creative_id\|exp`. |

---

## 4. End-to-End Flow

```
 ┌──────────────────────────────┐
 │  Universal Ads / FreeWheel   │  Ad server renders ad, fires the VAST
 │  ad server (CTV / Linear)    │  Impression event → our tracker.
 └──────────────┬───────────────┘  Macros [IFA],[LIMITADTRACKING],
                │                   [APPBUNDLE],[CACHEBUSTING] substituted here.
                │  HTTPS GET /pixel?...
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
 └──────────────┬───────────────────────────────┘
                │  (async, non-blocking — step 7 returns immediately)
                ▼
 ┌───────────────────────────┐   ┌───────────────────────────┐
 │ Workers Analytics Engine  │   │ R2 (daily NDJSON export)   │
 │ real-time, 3-mo retention │──▶│ long-term, aggregated      │
 └───────────────────────────┘   └───────────────────────────┘
```

**Latency:** The GIF is returned before steps 5–6 complete (those run
asynchronously via `waitUntil`), so the device sees a fast response.

**Privacy at ingest:** We never persist the raw `ifa`. It is salted-hashed for
dedup/reach, and when `lmt=1` (or the IFA is zeroed) we discard it entirely and
mark the impression non-attributable.

---

## 5. Example Recorded Output

### 5.1 What we receive (raw request log)

```json
{
  "ts": "2026-01-15T18:42:07.512Z",
  "method": "GET",
  "path": "/pixel",
  "edge_pop": "LAX",
  "query": {
    "advertiser_id": "adv_acme",
    "campaign_id": "camp_spring24",
    "creative_id": "cre_30s_hero",
    "exp": "1735689600",
    "sig": "9f1c2a7b4e8d3056c1a9f4b2e7d80c5316a2b9f4e1c7d0a3b6e9f2c5d8a1b4e7f0",
    "ifa": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "ifa_type": "rida",
    "lmt": "0",
    "app_id": "com.example.channel",
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
    "camp_spring24",                                  // campaign_id
    "cre_30s_hero",                                   // creative_id
    "4c2a...e91b (sha256(salt|ifa), 64 hex chars)",  // ifa_hash
    "US",                                            // country
    "com.example.channel",                           // app_id
    "adv_acme",                                      // advertiser_id
    "1"                                              // ifa_present
  ],
  "doubles": [1],
  "timestamp": "2026-01-15T18:42:07Z"
}
```

If the same device fires the same creative again within the dedup window
(default 24h), we record it as a `duplicate` in reconciliation and do **not** add
a second impression.

### 5.3 The daily aggregated export (R2, one record)

```json
{"hour":"2026-01-15T18:00:00Z","campaign_id":"camp_spring24","creative_id":"cre_30s_hero","country":"US","app_id":"com.example.channel","advertiser_id":"adv_acme","ifa_present":"1","impressions":1}
```

After a day of traffic that same hour/creative line would read e.g.
`"impressions": 4821` — computed as `sum(_sample_interval)` so it correctly
extrapolates through analytics sampling.

### 5.4 Example reporting query result

"Impressions by campaign, last 7 days":

```json
[
  { "campaign_id": "camp_spring24", "impressions": 1284553 },
  { "campaign_id": "camp_winter24", "impressions": 904118 }
]
```

---

## 6. Validation / Test Plan with Universal Ads

1. **You send us your exact macro tokens** if they differ from §3.1, and confirm
   partner-tracker allowance on the target creative.
2. We deliver a signed test tag for a dedicated `campaign_id=camp_ua_test`.
3. UA/FreeWheel fires test beacons from a certification device/environment.
4. We confirm, in near-real-time, the recorded rows (as in §5.2) and share a
   reconciliation report: beacons received vs. counted vs. deduplicated.
5. We compare our counts to UA's ad-server counts and resolve any discrepancy
   before going live.

A quick manual test you can run yourself (returns a 1×1 GIF):

```
curl -i "https://tracker.example.com/pixel?advertiser_id=adv_acme&campaign_id=camp_ua_test&creative_id=cre_test&exp=<future_unix>&sig=<provided>&ifa=test-device-001&lmt=0&app_id=com.example.channel&cb=12345"
```

We will provide the matching `exp`/`sig` for the test campaign.

---

## 7. FAQ

**Does the beacon ever redirect or wrap another vendor?**
No. It is a single, direct, unwrapped GET, fired on the VAST Impression event.

**Do you store IP or PII?**
We do not persist the raw IFA or device IP. We use a salted hash of the IFA
purely for deduplication/reach, and we honor `LMT=1` by dropping the identifier.

**What happens under Limit Ad Tracking (`lmt=1`)?**
We still return the pixel and count the impression, but we discard the identifier
and flag the row `ifa_present=0` (counts toward totals, excluded from
device-level reach).

**Why is there a signature on the tag?**
To prevent impression spoofing and stop a captured URL from being re-pointed to
another campaign. It does not change anything the ad server has to do.

**What is your retention?**
Real-time store 3 months; aggregated daily export 13 months; raw hashed-IFA tier
30 days; no raw device identifiers retained at rest.

---

## 8. Contact

For macro confirmation, certification/test scheduling, or the signed test tag,
reply to this thread and we'll turn it around the same day.
