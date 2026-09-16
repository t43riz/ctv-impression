# Call-to-Impression Attribution & Roku Conversions API

How a phone call driven by a CTV ad is matched back to an impression and sent to
Roku as a conversion.

---

## 1. The problem & the approach

CTV impressions and phone calls share **no common identifier**:

- An **impression** gives us: device IP, RIDA (IFA), creative, geo, timestamp.
- A **phone call** gives us: dialed number (DNIS), caller number (ANI), time,
  duration. **No IP, no RIDA.**

The only direct link is **dialed number → creative** (one tracking number per
creative). We have **no device identifier from the call** — only the phone
number — so we cannot do a deterministic device match. Instead we use a
**probabilistic time + geo match** against the impressions of that creative,
pick the single best-guess impression, and send Roku its **IP + RIDA +
timestamp** (Roku matches on IP/RIDA) together with a **confidence score**. When
no impression is in-window, we still fire a conversion using the **hashed caller
phone** so the event is not lost.

> **This is probabilistic attribution, not deterministic identity resolution.**
> The IP/RIDA we send is a best guess, not a confirmed device; confidence is
> scored and sent with every event. See §6 for accuracy notes.

---

## 2. End-to-end flow

```
 Impression (RAF beacon)                      Qualified call (PBX webhook)
 ───────────────────────                      ────────────────────────────
 GET /pixel?...                               POST /call  (HMAC-signed)
   • count + dedup (as before)                  1. verify HMAC of body
   • ALSO record into RecentImpressions DO      2. DNIS → creative (NUMBERS KV)
     (keyed by creativeId):                     3. qualify: duration ≥ threshold
       ts, RAW ip, RAW rida, region,            4. match vs RecentImpressions[creative]
       city, postal, lmt                           within MATCH_WINDOW_MINUTES,
   • window-scoped; purged after window            nudged by caller area-code geo
                                                 5. pick ONE best candidate + confidence
                                                 6. build Roku CAPI event, POST it
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

This DO is also the **only** place we hold the **raw** IP and **raw** RIDA —
Roku's CAPI requires them unhashed — and only for the attribution window. An
alarm purges expired rows.

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

## 5. Roku CAPI mapping (`src/lib/capi.ts`)

Per the [Conversions API spec](https://help.ads.roku.com/en/articles/8880744-conversions-api):

- **Endpoint:** `POST https://events.ads.rokuapi.net/v1/events`
  (test mode → `/v1/test_events`, validate-only). Controlled by `CAPI_MODE`.
- **Auth:** `Authorization: Bearer <CAPI_API_KEY>`.
- **Event:** `event_name=LEAD` (configurable), `event_type=conversion`,
  `event_source=phone_call`, `event_time=call start (unix s)`.
- **`event_id`:** deterministic `call_{callId}_{creativeId}` for Roku's 10-min
  dedup.
- **`user_data`** (must contain ≥1 identifier):

| Field | When sent |
|-------|-----------|
| `client_ip_address` | best-guess impression IP (probabilistic, withheld under LMT) |
| `aRI` (RIDA) | best-guess impression RIDA (probabilistic, withheld under LMT) |
| `ph` (sha256 of normalized phone) | **always** — the only certain identifier; satisfies Roku's requirement on zero-match |
| `st` / `zp` | from best-guess impression geo, else caller area-code state |

- **`opt_out: "true"`** (Roku LDU) when the best-guess impression was LMT. Under
  LMT both device identifiers (`client_ip_address`, `aRI`) are withheld; the IP
  is a device identifier for this purpose, so it follows the RIDA.
- **`custom_data`** carries `content_ids=[creativeId]`, the `match_confidence`,
  `match_candidates`, `match_type` (`probabilistic_ip`|`phone_only`), call
  duration, and optional `value`/`currency` for qualified sales.
  `match_confidence` is omitted when the candidate-ceiling short-circuit fired,
  because no score was computed (omitting beats sending a 0 that is
  indistinguishable from a real one).

### Example event (probabilistic IP match)

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
      "aRI": "a1b2c3d4-...",
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

- **Disambiguation depends on volume.** 1 in-window impression for the creative
  → near-certain. Thousands → the single IP we send is a best guess.
- **`match_confidence` is a ranking heuristic, not a probability.** Its time and
  geo terms act as additive floors, so a weak match plateaus near 0.5 instead of
  decaying toward 0. Do not read 0.5 as "50% likely to be the right device".
- **Device identifiers are gated.** A conversion carries the best-guess
  `client_ip_address` / `aRI` only when the match clears *both*
  `MIN_MATCH_CONFIDENCE` (default 0.6) and `MAX_MATCH_CANDIDATES` (default 10).
  Otherwise the event is sent phone-only — hashed phone + coarse geo — and
  `match_type` is reported as `phone_only` with `match_gate` naming the binding
  bound (`low_confidence` | `too_many_candidates` | `no_match`).
  At typical CTV volume a per-creative candidate set often exceeds the ceiling,
  so **expect most calls to be phone-only** until the real candidate
  distribution is measured in production and the thresholds are tuned.
- **Area-code geo is approximate** (portability/mobile). It nudges, never gates.
- **Every match is a best guess, never a confirmed device** — we only ever have
  the caller's phone number, so even a high-confidence single-candidate match is
  probabilistic, not deterministic.
- **Zero-match conversions** (phone-only) let Roku attribute on hashed phone /
  geo, but are weaker than an in-window probabilistic match — flagged
  `match_type=phone_only`.
- **LMT** impressions never contribute a RIDA and fire with `opt_out=true`.

---

## 7. PBX webhook contract (`POST /call`)

The PBX posts JSON on call end, signed with `CALL_HMAC_KEY`.

**Headers:**
- `x-timestamp: <unix seconds>`
- `x-signature: <hex HMAC-SHA256 of "<x-timestamp>.<raw body>">`

The timestamp is part of the signed message and must be within
`CALL_MAX_SKEW_SECONDS` (default 300) of the edge clock, so a captured payload
cannot be replayed into a second conversion. This is a **breaking change** from
the earlier body-only signature — the PBX must be updated in lockstep, otherwise
every call returns `unauthorized`.

Replays are also absorbed by `callId`: on first sight the call is claimed in the
dedup store for `CALL_DEDUP_HOURS` (default 48) and later copies return
`{"status":"duplicate"}`. Qualification runs **before** the claim, so a
sub-threshold call does not consume it, and the claim is released on every path
where no conversion landed (send failure, internal error, or a `skipped` send),
so a genuine retry can still succeed.

`callId` is percent-encoded into the claim key rather than narrow-charset
validated: a PBX may legitimately forward its SIP `Call-ID`
(`localpart@host`). Only control characters and a length above 128 are rejected.
The body is read through a 64 KiB cap enforced while streaming, independent of
`content-length`, since a chunked request declares no length, and within
`CALL_BODY_TIMEOUT_MS` (default 10 s). The deadline matters because the HMAC
cannot be verified until the body has arrived: without it, an unauthenticated
caller that opens a body and trickles bytes holds the isolate open for free. An
expired or unreadable body is refused with `bad_request` (400) and recorded in
the ledger like any other outcome.

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

**Responses:** `fired` | `skipped` (dry-run mode, or live without a key / with a
placeholder `event_group_id`) | `not_qualified` | `duplicate` | `unauthorized` |
`stale_timestamp` | `unknown_number` | `bad_fields` | `bad_json` |
`not_configured` (placeholder `CALL_HMAC_KEY`) | `payload_too_large` |
`rate_limited` (HTTP 429) | `capi_error` (HTTP 502) |
`internal_error` (HTTP 503).

**Three statuses are safe for the PBX to retry, and it must retry all three:**

| Status | Code | Why it is retryable |
|---|---|---|
| `rate_limited` | 429 | Per-IP budget (`CALL_RATE_LIMIT_PER_MINUTE`, default 60/min) exceeded. Answered *before* the signature is checked, so nothing was sent or claimed. |
| `capi_error` | 502 | The conversion API rejected the send. The idempotency claim is released first, so a retry runs the send again. |
| `internal_error` | 503 | A dependency (KV, Durable Object, matching store) failed. Any claim taken is released before responding. |

`502` and `503` both carry **`Retry-After: 30`**. The distinction is deliberate:
`502` means a genuine upstream answered badly, `503` means the fault may be
ours. A PBX that treats any of the three as final silently drops billable
conversions. Any retry of `fired` or `duplicate` is idempotent by `callId`.

`skipped` means **nothing was sent**, and the claim is released so the PBX's
next attempt runs again once the configuration is fixed — a deployment that
shipped in test mode must not block conversions for the whole dedup window.
Treat `skipped` as "not acknowledged", not as success.

`fired` means the platform accepted the event. Its `capi.mode` says whether that
was delivery (`live`) or validation only (`test`); the ledger distinguishes the
two as `call_fired` and `call_dry_run`, so a Worker left on test mode is not
reported as a fully-delivered conversion path.

**Match diagnostics are off by default.** With `CALL_DEBUG_RESPONSE=true` every
response except `capi_error` also carries `matched`/`candidates`/`gate`, and
`confidence` when a score was actually computed (the candidate-ceiling
short-circuit returns `confidenceOmitted: "candidate_ceiling"` instead, so a
bare `0` can never be mistaken for a real score). They are suppressed in
production because `candidates` is the count of impressions the creative served
inside the match window, which discloses delivery volume to anyone who can reach
the endpoint. Do not enable it against a shared or public deployment.

Every outcome is also recorded in the reconciliation ledger as `call_*`
(`call_fired`, `call_dry_run`, `call_skipped`, `call_rate_limited`,
`call_unauthorized`, `call_unknown_number`, `call_bad_request`,
`call_not_qualified`, `call_bad_number_mapping`, `call_not_configured`,
`call_duplicate`, `call_capi_error`, `call_internal_error`), which is what makes
a silent "every call is refused" or "all conversions skipped" state visible on
`/admin/health`. Health gates on failed sends and on refusals (including
`call_rate_limited`), but deliberately not on absorbed replays or an
intentionally skipped/dry-run send.

---

## 8. Configuration

| Setting | Where | Purpose |
|---------|-------|---------|
| `MATCH_WINDOW_MINUTES` | var | Impression→call attribution window (default 60) |
| `QUALIFY_SECONDS` | var | Min call duration to qualify (default 60) |
| `MIN_MATCH_CONFIDENCE` | var | Score floor before device ids are sent (default 0.6) |
| `MAX_MATCH_CANDIDATES` | var | Candidate ceiling before device ids are sent (default 10) |
| `CALL_MAX_SKEW_SECONDS` | var | Accepted clock skew on `x-timestamp` (default 300) |
| `CALL_DEDUP_HOURS` | var | How long a processed `callId` is remembered (default 48) |
| `CALL_BODY_TIMEOUT_MS` | var | Deadline for reading a webhook body (default 10000) |
| `CALL_RATE_LIMIT_PER_MINUTE` | var | Per-IP `/call` budget, applied before the body is read; `0` disables (default 60). **Must exceed the PBX's peak calls per minute**, or 429s drop conversions |
| `CALL_DEBUG_RESPONSE` | var | `true` echoes match diagnostics in the response. Off by default: the candidate count discloses the creative's in-window delivery volume |
| `IP_CAP_SALT` | secret | Pepper for the coarse IP+hour frequency cap on non-attributable (LMT / child-directed) traffic. Falls back to `IFA_HASH_SALT`, but setting it means a salt rotation does not reset that cap |
| `HTTP_TIMEOUT_MS` | var | Outbound CAPI/SQL request timeout (default 5000) |
| `CAPI_MAX_ATTEMPTS` | var | Conversion send attempts (default 2; UA uses `UA_CAPI_MAX_ATTEMPTS`, default 1) |
| `CAPI_MODE` | var | `test` (default, no ingestion) or `live` |
| `CAPI_EVENT_GROUP_ID` | var | Default Roku event group (overridable per number) |
| `CAPI_EVENT_NAME` | var | `LEAD` (configurable) |
| `CAPI_API_KEY` | secret | Roku CAPI bearer token |
| `CALL_HMAC_KEY` | secret | PBX webhook signing key |
| `NUMBERS` | KV | `number:{e164}` → `{creativeId,campaignId,advertiserId,...}` |

Register a tracking number:

```bash
wrangler kv key put --binding NUMBERS "number:18005550100" \
  '{"creativeId":"cre_hero","campaignId":"camp_spring","advertiserId":"adv_acme"}'
```

---

## 9. Go-live checklist

1. Keep `CAPI_MODE=test` and confirm payloads via `/v1/test_events` responses.
2. Get the **API key** + **event_group_id** from Roku Ads Manager → Events → CAPI.
3. Set `CAPI_API_KEY` secret and `CAPI_EVENT_GROUP_ID`; flip `CAPI_MODE=live`.
4. Validate a few real calls end-to-end; confirm conversions appear in Roku.
5. Reconcile conversion volume vs. qualified-call volume.
6. Confirm the PBX's peak calls per minute and set
   `CALL_RATE_LIMIT_PER_MINUTE` above it, then confirm with the PBX team that it
   retries **429**, **502** and **503**, honouring `Retry-After` on the last
   two. None of the three sent or claimed the conversion, so a PBX that treats
   any of them as final loses it silently.
7. Confirm the registry entries in `NUMBERS` pass validation: `creativeId`,
   `campaignId`, `advertiserId` and `eventGroupId` must match
   `^[A-Za-z0-9_-]{1,64}$`, `platform` must be `roku` or `ua`, and
   `qualifySeconds` must be a number in `0..86400`. A malformed entry is
   answered `bad_number_mapping` (500) rather than silently defaulting.
8. Set `IP_CAP_SALT` and keep it stable across `IFA_HASH_SALT` rotations. A
   placeholder value is ignored, falling back to `IFA_HASH_SALT`.
9. Set `ALERT_WEBHOOK_URL` so a red nightly health check reaches a human.
   Without it the result is only written to `_status/health.json`, which nothing
   reads on a schedule.
