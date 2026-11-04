# Impression Tag Integration — Roku Onboarding

## Shared Roku macro tag (2026-09-30)

The signer now appends all nine macros in Roku's published Ads Manager list.
The signed `advertiser_id`, `campaign_id`, `creative_id`, `exp`, and `sig`
remain fixed **tracking credentials**. The independently substituted
`roku_advertiser_id`, `roku_campaign_id`, `roku_creative_id` (plain
`[[[CREATIVEID_URL]]]`) and `roku_creative_id_encoded` (base64
`[[[CREATIVEID]]]`) are reporting fields, not signing or allowlist inputs.
This permits reuse across Roku creatives but **does not authenticate the
Roku-reported campaign or creative ID**. The current signed values still
name the test campaign; do not confuse them with Roku production UIDs.

`device_ip`, `country`, and `dma` retain their existing meanings.
`cb`, the encoded creative ID, and `roku_postal_code` are stored on each
counted raw R2 impression for 30 days. The three plain Roku UIDs also
appear in Analytics Engine and the daily aggregate. The cachebuster and
encoded creative ID are not aggregate dimensions (they would make the daily
export nearly one row per impression). Postal code is not exported to the
long-term aggregate. The user reports written Roku approval for collecting
postal code; retain that approval with the agreement before deploying this
tag. Previous test tags are unchanged and do not supply these additional
fields.

The section below describes the **earlier test tag** and its original
privacy position; it is preserved as historical onboarding context.

**Audience:** Roku Ad Operations / Measurement onboarding team
**Purpose:** Provide the sample impression pixel, the full list of macros we require, and a concrete example of the recorded output, so Roku can validate our third-party impression tag.

---

## 0. TL;DR — Direct Answers to Your Questions

> **Q1: "Send a sample of your impression pixel."**
> See [§2 Sample Impression Pixel](#2-sample-impression-pixel). It is a single
> HTTPS `GET` to a 1×1 GIF endpoint, no spaces, impression-only.

> **Q2: "And all the macros that you require."**
> See [§3 Macros We Require](#3-macros-we-require). Every macro we use is from
> your Ads Manager supported list: `[[[DEVICE_IP]]]`, `[[[COUNTRY]]]`,
> `[[[METRO_CODE]]]` and `[[[CACHEBUSTER]]]`. Everything else (`campaign_id`,
> `creative_id`, `advertiser_id`, `exp`, `sig`) is **pre-filled by us** when we
> hand you the tag — you do not populate those.

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
https://pixels.postbackx.com/v1/pixel?advertiser_id=adv_udonis&campaign_id=camp_roku_test&creative_id=cre_roku_cert&exp=1821558200&sig=c2bac6d98d08968cc637c9fdcfca6b1a298dfae8d464f7cd61e49a3c3ebf49d9&device_ip=[[[DEVICE_IP]]]&country=[[[COUNTRY]]]&dma=[[[METRO_CODE]]]&cb=[[[CACHEBUSTER]]]
```

> **This tag is verified live.** Re-fired against production on 2026-09-21
> after switching to the Ads Manager macro set: recorded in the reconciliation
> ledger as `counted` (not `reject_bad_signature`). The signature is valid
> through **2027-09-21 20:23 UTC** (`exp=1821558200`). Tell us the campaign
> flight dates and we will reissue with a matching expiry.
>
> Only the four macros above are sent, all from your supported list. We removed
> `[[[RIDA]]]`, `[[[LMT]]]` and `[[[APPID]]]` from an earlier draft once you
> confirmed Ads Manager does not support them.
>
> Note when testing: the endpoint returns `200` and a 1×1 GIF for *every*
> request, including a rejected one. That is deliberate — the beacon must
> never leak validation state to the device — so a `200` alone does not prove
> an impression was counted. Confirmation comes from the ledger.

**Same tag, after RAF fills the macros on a real device:**

```
https://pixels.postbackx.com/v1/pixel?advertiser_id=adv_udonis&campaign_id=camp_roku_test&creative_id=cre_roku_cert&exp=1821558200&sig=c2bac6d98d08968cc637c9fdcfca6b1a298dfae8d464f7cd61e49a3c3ebf49d9&device_ip=203.0.113.44&country=US&dma=501&cb=8675309421
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
The macro-filled params (`device_ip`, `country`, `dma`, `cb`) can never be
covered by the signature — Ads Manager substitutes them on the device after the
tag is served — so those are protected by the per-IP rate limit and the dedup
window instead.

---

## 3. Macros We Require

### 3.1 Roku macros RAF must populate

All four are on the Ads Manager supported list. We send nothing else.

| URL param | Roku macro | Required? | Why we need it |
|-----------|------------|-----------|----------------|
| `device_ip` | `[[[DEVICE_IP]]]` | **Required** | The only device-level signal available to us. Salted-hashed at ingest for deduplication and reach; also carries the opt-out signal (see below). |
| `cb` | `[[[CACHEBUSTER]]]` | **Required** | Guarantees the device/CDN does not serve a cached pixel. |
| `country` | `[[[COUNTRY]]]` | **Required** | Market enforcement. Our data agreement licenses the United States only, so we need the served country from you rather than inferring it from the connecting IP. |
| `dma` | `[[[METRO_CODE]]]` | Recommended | DMA-level reporting, which is what advertisers buying CTV actually ask for. |

**We do not request `[[[POSTAL_CODE]]]`, by choice.** Your Ad Partner Data
Processing Policy §5 treats precise geo-location as Sensitive Data that
partners may not process, and postal code is not on our agreement's Campaign
Data list. DMA is coarse enough for the reporting we owe advertisers, so we
would rather not carry the ambiguity. Tell us if you read that differently.

We also do not use `[[[CREATIVEID]]]` or `[[[CREATIVEID_URL]]]`: the creative
identity is already bound into the signed tag we issue per creative.

### 3.1.1 How opt-out is honored without an LMT macro

Ads Manager exposes no `LMT` macro, so we take the signal from `[[[DEVICE_IP]]]`
exactly as your documentation describes it:

| Value received | Our treatment |
|---|---|
| A valid IPv4 address | Salted-hashed as the device identity. The raw address is never written to our analytics or export tiers. |
| `0.0.0.0` (device opted out, or geographic privacy rules apply) | Treated as an **opt-out**: no identifier is stored, the impression is flagged non-attributable and excluded from reach, and no device identifier is ever sent to a conversion API. The impression is still counted in aggregate totals. |
| Anything else (e.g. an unexpanded macro) | Identifier discarded, impression counted as non-attributable. We do **not** record it as a user opt-out, because no opt-out was actually signalled. |

Opted-out and unidentifiable traffic is still frequency-capped, so it cannot
inflate counts without bound.

### 3.2 Params we pre-fill (no action needed from Roku)

| URL param | Source | Description |
|-----------|--------|-------------|
| `advertiser_id` | Set by us | Advertiser UID (from your `[[[ADVERTISERID]]]` mapping or our own ID). |
| `campaign_id` | Set by us | Campaign UID. |
| `creative_id` | Set by us | Creative UID (plain, non-encoded). |
| `exp` | Set by us | Unix-seconds expiry for the signature (typically campaign flight end). |
| `sig` | Set by us | HMAC-SHA256 over `advertiser_id\|campaign_id\|creative_id\|exp`. |

---

## 4. End-to-End Flow

```
 ┌──────────────────────┐
 │  Roku CTV Device     │  Ad renders, fires impression beacon.
 │                      │  Macros [[[DEVICE_IP]]],[[[COUNTRY]]],
 └──────────┬───────────┘  [[[METRO_CODE]]],[[[CACHEBUSTER]]] substituted here.
            │  HTTPS GET /v1/pixel?...
            ▼
 ┌──────────────────────────────────────────────┐
 │  Cloudflare Worker (nearest edge PoP)        │
 │  1. Validate params (format + required)      │
 │  2. Verify HMAC signature + expiry           │
 │  3. Check campaign is active (allowlist)     │
 │  4. device_ip=0.0.0.0 → opt-out, no identity │
 │     else salted-hash the IP as the identity  │
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

**Privacy at ingest:** The raw device IP is never written to our analytics or
export tiers. It is salted-SHA-256 hashed for dedup/reach, and when
`device_ip=0.0.0.0` we discard it entirely and mark the impression
non-attributable.

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
    "device_ip": "203.0.113.44",
    "country": "US",
    "dma": "501",
    "cb": "8675309421"
  },
  "response_status": 200,
  "response_content_type": "image/gif"
}
```

### 5.2 The row we store (Analytics Engine data point)

Note the device IP is **gone** — replaced by a salted SHA-256 hash.
`ifa_present=1` means the device was identifiable (a real IP, not `0.0.0.0`).

```json
{
  "dataset": "impression_events",
  "indexes": ["camp_spring24"],
  "blobs": [
    "camp_spring24",                                                   // campaign_id
    "cre_30s_hero",                                                    // creative_id
    "4c2a...e91b (sha256(salt|'ip:'+device_ip), 64 hex chars)",        // identity hash
    "US",                                                              // country
    "unknown",                                                         // app_id (no APPID macro on Ads Manager)
    "adv_acme",                                                        // advertiser_id
    "1",                                                               // ifa_present
    "ip",                                                              // identity namespace
    "roku",                                                            // platform
    "501"                                                              // dma
  ],
  "doubles": [1],
  "timestamp": "2025-01-15T18:42:07Z"
}
```

An opted-out impression (`device_ip=0.0.0.0`) is written the same way except
the identity hash is the literal `"anon"` and `ifa_present` is `"0"`. It counts
toward impression totals and is excluded from reach.

If the same device fires the same creative again within the dedup window
(default 24h), we record it as a `duplicate` in our reconciliation counter and
do **not** add a second impression.

### 5.3 The daily aggregated export (R2, one record)

Each night we roll the day up to hourly buckets and write NDJSON to R2 (one
JSON object per line). A single line for the impression above:

```json
{"hour":"2025-01-15T18:00:00Z","campaign_id":"camp_spring24","creative_id":"cre_30s_hero","country":"US","app_id":"unknown","advertiser_id":"adv_acme","ifa_present":"1","platform":"roku","dma":"501","impressions":1}
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

1. ~~You send us your exact macro tokens~~ — **done.** The tag now uses only
   the Ads Manager supported set you sent.
2. ~~We deliver a signed test tag~~ — **done.** The tag in §2 is live on
   `campaign_id=camp_roku_test` and has been verified end to end on our side:
   valid beacon counted, repeat beacon from the same device deduplicated,
   `device_ip=0.0.0.0` counted as an opt-out with no identifier stored,
   unexpanded-macro beacon counted as non-attributable without being recorded
   as a user opt-out, and a bad-signature beacon rejected.
3. Roku fires test beacons from a certification device.
4. We confirm, in near-real-time, the recorded rows (as in §5.2) and share a
   reconciliation report: beacons received vs. counted vs. deduplicated.
5. We compare our counts to Roku's ad-server counts and resolve any discrepancy
   before going live.

A quick manual test you can run yourself (returns a 1×1 GIF):

```
curl -i "https://pixels.postbackx.com/v1/pixel?advertiser_id=adv_udonis&campaign_id=camp_roku_test&creative_id=cre_roku_cert&exp=1821558200&sig=c2bac6d98d08968cc637c9fdcfca6b1a298dfae8d464f7cd61e49a3c3ebf49d9&device_ip=203.0.113.44&country=US&dma=501&cb=12345"
```

No coordination needed — that command works right now.

---

## 7. FAQ

**Does the beacon ever redirect or wrap another vendor?**
No. It is a single, direct, unwrapped GET, as Roku certification requires.

**Do you store IP or PII?**
Nothing in our analytics or export tier contains a raw IP address. The value
from `[[[DEVICE_IP]]]` is salted-SHA-256 hashed at ingest and only the hash is
stored. A zeroed IP is dropped entirely.

For call attribution we hold the raw device IP in a short-lived edge store,
scoped to a bounded matching window (currently 60 minutes) and then discarded.
Records are written with no identifier when the device opted out, so opted-out
devices are never retained. We have asked you to confirm in writing whether
this bounded raw retention is acceptable or whether the IP must be hashed at
ingest; we will conform to whichever you specify. Note that our conversion path
is **not live** and is not covered by the current agreement — see the scope
question in our onboarding email.

**What happens when a device opts out?**
`[[[DEVICE_IP]]]` arrives as `0.0.0.0`. We still return the pixel and count the
impression, but we store no identifier and flag the row `ifa_present=0`, so it
counts toward totals and is excluded from reach.

**Can you still report reach and frequency?**
Only approximately, and we would rather state the limit than overstate the
product. Without a RIDA, the hashed device IP is the only identity available,
and an IP is a **household**, not a device: every TV, phone and laptop behind
one router shares it. Dynamic IP reassignment splits one household across
several hashes, and carrier-grade NAT collapses several households into one.

So we report *impressions* with confidence, and we label anything reach- or
frequency-shaped as an approximate household estimate rather than device reach.
If Roku can expose a stable device or household identifier to impression tags,
or offers deduplicated reach through another route, we would like to hear about
it.

**Why is there a signature on the tag?**
To prevent impression spoofing and stop a captured URL from being re-pointed to
another campaign or advertiser. It does not change anything Ads Manager has to
do — the macros are substituted exactly as normal.

**What is your retention?**
Real-time analytics store ~90 days (hashed identifiers only); a 30-day
hashed-identifier tier for reach/frequency and DSAR erasure; aggregated daily
export retained 395 days. Both storage tiers have hard expiry lifecycle rules
enforced at the bucket level. The raw device IP persists only in the 60-minute
matching window described above.

---

## 8. Contact

For macro confirmation, test scheduling, or the signed test tag, reply to this
thread and we'll turn it around the same day.
