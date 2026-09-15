# Call-to-Impression Attribution & Universal Ads Conversions API

How a phone call driven by a CTV/Linear ad is matched back to an impression and
sent to Universal Ads as a conversion.

> **Adapted for Universal Ads (Comcast / NBCUniversal), built on FreeWheel ad
> technology.** The matching model is identical to the Roku design; the
> differences are the identifiers available (device IFA and/or **household ID**)
> and the **Universal Ads Conversions API** endpoint/schema, which are
> provisioned during onboarding. Those specifics are marked **[CONFIRM WITH
> UA]**.

---

## 1. The problem & the approach

CTV/Linear impressions and phone calls share **no common identifier**:

- An **impression** gives us: device IP, IFA, household ID (if provided),
  creative, geo, timestamp.
- A **phone call** gives us: dialed number (DNIS), caller number (ANI), time,
  duration. **No IP, no IFA, no household ID.**

The only direct link is **dialed number → creative** (one tracking number per
creative). We have **no device identifier from the call** — only the phone
number — so we cannot do a deterministic device match. Instead we use a
**probabilistic time + geo match** against the impressions of that creative, pick
the single best-guess impression, and send Universal Ads its **IFA / household ID
+ IP + timestamp** together with a **confidence score**. When no impression is
in-window, we still fire a conversion using the **hashed caller phone** so the
event is not lost.

> **This is probabilistic attribution, not deterministic identity resolution.**
> The IFA/IP/household ID we send is a best guess, not a confirmed device;
> confidence is scored and sent with every event. See §6 for accuracy notes.

---

## 2. End-to-end flow

```
 Impression (VAST beacon)                     Qualified call (PBX webhook)
 ───────────────────────                      ────────────────────────────
 GET /pixel?...                               POST /call  (HMAC-signed)
   • count + dedup (as before)                  1. verify HMAC of body
   • ALSO record into RecentImpressions DO      2. DNIS → creative (NUMBERS KV)
     (keyed by creativeId):                     3. qualify: duration ≥ threshold
       ts, RAW ip, RAW ifa, hh_id,              4. match vs RecentImpressions[creative]
       region, city, postal, lmt                   within MATCH_WINDOW_MINUTES,
   • window-scoped; purged after window            nudged by caller area-code geo
                                                 5. pick ONE best candidate + confidence
                                                 6. build UA CAPI event, POST it
```

`RecentImpressions` is a Durable Object **per creative** (`idFromName(creativeId)`),
so all of a creative's impressions and its call lookups land on one instance with
a small, recent working set.

---

## 3. Why a separate matching store (not Analytics Engine)

Analytics Engine is **sampled** and explicitly cannot return individual rows, so
it cannot do 1:1 matching. The `RecentImpressions` DO holds a **full-fidelity,
short-lived** set (only the last `MATCH_WINDOW_MINUTES`) purely for matching. AE
remains the system of record for aggregate reporting.

This DO is also the **only** place we hold the **raw** IP, **raw** IFA, and
household ID — the Universal Ads CAPI matches on these unhashed — and only for the
attribution window. An alarm purges expired rows.

---

## 4. Matching & confidence (`src/lib/match.ts`)

We pick one best candidate and score confidence in `[0,1]` from three factors:

| Factor | Weight | Intuition |
|--------|--------|-----------|
| Scarcity | 0.5 | 1 candidate in-window → 1.0; decays as candidates grow |
| Time proximity | 0.3 | Closer to the call → higher |
| Geo agreement | 0.2 | Impression region/postal matching caller area-code → bonus |

- Caller geo comes from the **area code → state** map (`src/lib/areacodes.ts`),
  compared against Cloudflare's `cf.region` (full state name).
- Geo is a **soft** signal (number portability / mobile), so disagreement is a
  mild penalty, never a disqualifier.
- Ties break toward the **most recent** impression.

---

## 5. Universal Ads CAPI mapping (`src/lib/capi.ts`)

> **[CONFIRM WITH UA]** the Conversions API endpoint, authentication, event
> schema, required identifier fields, hashing/encoding, and dedup key. The
> mapping below is our **proposed default** modeled on standard CTV CAPIs,
> pending UA onboarding / Marketing API provisioning.

- **Endpoint:** `POST https://<ua-capi-endpoint>/v1/events` **[CONFIRM WITH UA]**
  (test mode → validate-only endpoint). Controlled by `CAPI_MODE`.
- **Auth:** `Authorization: Bearer <CAPI_API_KEY>` **[CONFIRM WITH UA]**.
- **Event:** `event_name=LEAD` (configurable), `event_type=conversion`,
  `event_source=phone_call`, `event_time=call start (unix s)`.
- **`event_id`:** deterministic `call_{callId}_{creativeId}` for UA dedup.
- **`user_data`** (must contain ≥1 identifier):

| Field | When sent |
|-------|-----------|
| `client_ip_address` | best-guess impression IP (probabilistic, withheld under LMT) |
| `ifa` (device advertising ID) | best-guess impression IFA (probabilistic, withheld under LMT) |
| `household_id` | best-guess impression household ID, if provided **[CONFIRM WITH UA]** |
| `ph` (sha256 of normalized phone) | **always** — the only certain identifier; satisfies UA's requirement on zero-match |
| `st` / `zp` | from best-guess impression geo, else caller area-code state |

- **Opt-out / LDU flag** when the best-guess impression was LMT **[CONFIRM WITH
  UA — exact token]**. Under LMT both device identifiers (`client_ip_address`,
  `ifa`) are withheld; the IP is a device identifier for this purpose, so it
  follows the IFA.
- **`custom_data`** carries `content_ids=[creativeId]`, the `match_confidence`,
  `match_candidates`, `match_type` (`probabilistic_ip`|`phone_only`), call
  duration, and optional `value`/`currency` for qualified sales.
  `match_confidence` is omitted when the candidate-ceiling short-circuit fired,
  because no score was computed.

### Example event (probabilistic match)

```json
{
  "event_group_id": "grp_default",
  "events": [{
    "event_id": "call_abc123_cre_hero",
    "event_name": "LEAD",
    "event_type": "conversion",
    "event_time": 1700000000,
    "event_source": "phone_call",
    "user_data": {
      "is_hashed": true,
      "ph": "9f...e4",
      "client_ip_address": "203.0.113.7",
      "ifa": "a1b2c3d4-...",
      "household_id": "hh_5f3c...",
      "st": "California",
      "zp": "94103"
    },
    "custom_data": {
      "content_ids": ["cre_hero"],
      "content_type": "product",
      "match_confidence": 0.95,
      "match_candidates": 1,
      "match_type": "probabilistic_ip",
      "call_duration_seconds": 120
    },
    "opt_out": "false"
  }]
}
```

---

## 6. Accuracy & limitations

- **Disambiguation depends on volume.** 1 in-window impression for the creative →
  near-certain. Thousands → the single IFA/IP we send is a best guess.
- **`match_confidence` is a ranking heuristic, not a probability.** Its time and
  geo terms act as additive floors, so a weak match plateaus near 0.5 rather than
  decaying toward 0. Do not read 0.5 as "50% likely to be the right device".
- **Device identifiers are gated.** A conversion carries the best-guess
  `client_ip_address` / `ifa` only when the match clears *both*
  `MIN_MATCH_CONFIDENCE` (default 0.6) and `MAX_MATCH_CANDIDATES` (default 10).
  Otherwise the event is sent phone-only (hashed phone + coarse geo) with
  `match_type=phone_only` and `match_gate` naming the binding bound. At typical
  CTV volume **expect most calls to be phone-only** until the real candidate
  distribution is measured and the thresholds tuned.
- **Area-code geo is approximate** (portability/mobile). It nudges, never gates.
- **Every match is a best guess, never a confirmed device** — we only ever have
  the caller's phone number, so even a high-confidence single-candidate match is
  probabilistic, not deterministic.
- **Zero-match conversions** (phone-only) let UA attribute on hashed phone / geo,
  but are weaker than an in-window probabilistic match — flagged
  `match_type=phone_only`.
- **LMT** impressions never contribute an IFA and fire with the UA opt-out/LDU
  flag set.

---

## 7. PBX webhook contract (`POST /call`)

The in-house PBX posts JSON on call end, signed with `CALL_HMAC_KEY`.

**Headers:**
- `x-timestamp: <unix seconds>`
- `x-signature: <hex HMAC-SHA256 of "<x-timestamp>.<raw body>">`

The timestamp is part of the signed message and must be within
`CALL_MAX_SKEW_SECONDS` (default 300) of the edge clock, so a captured payload
cannot be replayed into a second conversion. This is a **breaking change** from
the earlier body-only signature. A repeat `callId` returns
`{"status":"duplicate"}` for `CALL_DEDUP_HOURS` (default 48).

**Body:**

```json
{
  "callId": "unique-call-id",
  "dnis": "18005550100",
  "ani": "+14155550142",
  "startTime": 1700000000,
  "durationSeconds": 120,
  "saleValue": 49.99,
  "currency": "USD"
}
```

`saleValue`/`currency` are optional. `dnis` must exist in the `NUMBERS` registry
(`number:{e164}` → `NumberMapping`). Calls shorter than the qualify threshold
return `{"status":"not_qualified"}` and do not fire.

**Responses:** `fired` | `skipped` (live mode without key, endpoint not
configured, or a placeholder `event_group_id`) | `not_qualified` | `duplicate` |
`unauthorized` | `stale_timestamp` | `unknown_number` | `bad_fields` |
`bad_json` | `not_configured` | `capi_error` (HTTP 502, retryable). Responses
carry `matched`/`confidence`/`candidates`/`gate` diagnostics.

---

## 8. Configuration

| Setting | Where | Purpose |
|---------|-------|---------|
| `MATCH_WINDOW_MINUTES` | var | Impression→call attribution window (default 60) |
| `QUALIFY_SECONDS` | var | Min call duration to qualify (default 60) |
| `CAPI_MODE` | var | `test` (default, no ingestion) or `live` |
| `CAPI_EVENT_GROUP_ID` | var | Default UA event group (overridable per number) |
| `CAPI_EVENT_NAME` | var | `LEAD` (configurable) |
| `CAPI_API_KEY` | secret | Universal Ads CAPI bearer token |
| `CALL_HMAC_KEY` | secret | PBX webhook signing key |
| `NUMBERS` | KV | `number:{e164}` → `{creativeId,campaignId,advertiserId,...}` |

Register a tracking number:

```bash
wrangler kv key put --binding NUMBERS "number:18005550100" \
  '{"creativeId":"cre_hero","campaignId":"camp_spring","advertiserId":"adv_acme"}'
```

---

## 9. Go-live checklist

1. Keep `CAPI_MODE=test` and confirm payloads via UA's validate-only endpoint.
2. Get the **API key**, **endpoint**, **event schema**, and **event_group_id**
   from Universal Ads onboarding → Conversions API **[CONFIRM WITH UA]**.
3. Set `CAPI_API_KEY` secret and `CAPI_EVENT_GROUP_ID`; flip `CAPI_MODE=live`.
4. Validate a few real calls end-to-end; confirm conversions appear in Universal
   Ads reporting.
5. Reconcile conversion volume vs. qualified-call volume.
