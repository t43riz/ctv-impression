# Privacy & Data Protection

This document describes how the CTV impression tracker handles personal data,
and how it satisfies the corrections raised in review.

## 1. What data we handle

| Field | Classification | At rest? |
|-------|----------------|----------|
| `ifa` (Roku RIDA) — analytics/reporting | **Personal data** (online identifier) | **Never stored raw** in AE/exports — salted SHA-256 hash only |
| `ifa` / device IP — **call-matching store** | Personal data | **Raw, window-scoped only** (see §2.1); purged after the attribution window |
| Device IP — analytics/reporting | Personal data | **Not persisted** in AE/exports; reduced to country |
| `country` / coarse geo | Coarse geo (from Cloudflare edge) | Stored (not identifying on its own) |
| Caller phone (ANI) | Personal data | **Never stored raw**; hashed (SHA-256) only when sent to Roku |
| `campaign_id`, `creative_id`, `advertiser_id`, `app_id` | Non-personal | Stored |

The IFA is online personal data under GDPR (Art. 4) and a "unique identifier"
under CCPA. The original spec's "No PII stored" claim was incorrect and has been
removed.

## 2. How we minimize

- **Hashing:** the IFA is hashed with a rotating server-side salt
  (`IFA_HASH_SALT`) before any storage. The raw value never leaves the request
  handler. The hash is used only for deduplication and reach.
- **LMT enforcement:** when `lmt=1` (Limit Ad Tracking), the IFA is zeroed, the
  campaign is child-directed, **or** the identifier arrives as an unexpanded
  ad-server macro (`[[[RIDA]]]`), we discard the identifier entirely and mark the
  impression `ifa_present=0`. Such impressions count toward totals but are
  excluded from device-level reach.
- **Frequency capping without an identifier:** non-attributable impressions
  (the LMT/COPPA/macro cases above) are deduplicated by a coarse key derived
  from `SHA-256(salt | "ip:" + device-IP + ":" + hour-bucket)`. It stores no
  identifier, rotates every hour, lives only in the dedup store for the dedup
  window, and exists so opted-out and child-directed traffic cannot be counted
  without bound. It is **not** addressable by the IFA DSAR path; the short TTL is
  the erasure mechanism. Set `DEDUP_NON_ATTRIBUTABLE=false` to disable it.
- **No IP persistence (analytics):** for AE/reporting, geolocation is reduced to
  a 2-letter country code; the raw IP is never written there.

## 2.1 Call-matching store (raw IP/RIDA, window-scoped)

To attribute phone calls to impressions and send conversions to Roku CAPI (which
matches on **unhashed** IP and RIDA), the `RecentImpressions` Durable Object
holds the **raw device IP and raw RIDA** — but **only**:

- for the attribution window (`MATCH_WINDOW_MINUTES`, default 60 min),
- scoped per creative,
- purged by an alarm once older than the window.

LMT/opt-out impressions store **no RIDA** (empty) and are never device-matched;
any resulting conversion is sent with Roku's `opt_out="true"` (LDU) flag, and
the matched impression's IP is withheld from the payload along with the RIDA.
The caller's phone number is **hashed** (never stored raw) and used only to
satisfy Roku's identifier requirement on zero-match conversions.

This is the only component holding raw identifiers at rest, and it is
short-lived by design (storage minimization for the matching purpose).

## 3. Retention

| Tier | Retention | Contents |
|------|-----------|----------|
| RecentImpressions DO | attribution window (~60 min) | **raw** IP/RIDA + geo (call matching only) |
| Dedup store | dedup window (`DEDUP_WINDOW_HOURS`, 24 h) | salted IFA/IP-derived dedup keys |
| Analytics Engine | 3 months (platform fixed) | hashed IFA + dimensions |
| R2 raw | 30 days | hashed IFA + dimensions (reach/replay) |
| R2 aggregated | 13 months | **no identifiers** — hour/dimension rollups only |

Raw-tier objects are keyed `dt=YYYY-MM-DD/h=<hash prefix>/hh=HH/<campaign>/<uuid>.json`.
The `h=` shard sits directly after the date so a DSAR erasure can list one day
narrowed to 1/65536th of the bucket, rather than scanning the whole tier.

### Data shared with Roku (CAPI)

On a qualified call we send Roku: matched impression IP, RIDA (both non-LMT
only),
hashed caller phone, and coarse geo (state/zip). This is a server-to-server
disclosure to Roku as a measurement partner; document it in your privacy notice
and processing terms. LMT impressions are sent with `opt_out="true"`.

We do not retain identifier-level data for years. The long-term tier is
aggregate-only, satisfying storage minimization.

## 4. Data subject requests (DSAR / erasure)

Because the IFA is hashed deterministically, a subject's data can be located by
hashing their IFA with the current salt and:
1. Deleting matching keys from the dedup Durable Object store (per campaign
   shard).
2. Deleting matching rows from the 30-day raw R2 tier, scanning day by day and
   within each day only the objects under that hash's key shard.
3. The RecentImpressions store self-purges within ~60 minutes (nothing to erase
   beyond that window).
4. Aggregated tiers contain **no identifiers**, so nothing to erase there.

AE rows expire within 3 months and contain only the hash.

Two things the runbook deliberately does **not** do, both documented here so the
DSAR response can state them accurately: coarse IP-derived frequency-cap keys in
the dedup store are not IFA-addressable (they expire with their TTL, at most
`DEDUP_WINDOW_HOURS`), and neither AE rows nor aggregates hold identifiable
data to begin with.

## 5. Children's content (COPPA)

For child-directed Roku channels, behavioral identifiers must not be used.
Operationally: campaigns flagged child-directed should be configured to send
`lmt=1` (or omit the IFA), which the Worker already treats as opt-out, so no
identifier is processed for those impressions.

## 6. Lawful basis / DPIA

Before production, document the lawful basis (legitimate interest or consent per
jurisdiction) and complete a DPIA. The technical controls above (hashing, LMT,
minimization, DSAR path) are prerequisites, not a substitute for that
assessment.

## 7. Open items to confirm before go-live

- Salt rotation cadence (mechanism implemented: set `IFA_HASH_SALT` to the new
  salt and `IFA_HASH_SALT_PREV` to the old one; dedup consults both hashes for
  the rotation window, then unset `IFA_HASH_SALT_PREV`).
- Confirm Roku's exact opt-out signaling tokens map to our `lmt` handling.
- Confirm contractual data-processing terms with Roku and advertisers.

## 8. DSAR runbook (implemented)

`POST /admin/dsar` with `{"ifa": "<raw ifa>", "campaigns": ["camp1", ...]}`:

1. Hashes the IFA with the current salt (and previous salt, if rotating).
2. Deletes matching keys from the dedup Durable Object per campaign shard.
3. Deletes matching rows from the raw R2 tier, scanning `RAW_RETENTION_DAYS`
   (default 31) days and filtering each day by the hash's key shard. The
   response reports `raw_tier.scanned`, `raw_tier.deleted`, `raw_tier.daysScanned`
   and `raw_tier.truncated`; re-run only if `truncated` is true (it means the
   per-invocation safety cap was hit, which implies an implausible number of
   rows for a single identifier).
4. `RecentImpressions` self-purges within the attribution window; AE rows
   expire in 3 months (hash only); aggregates hold no identifiers.

`RAW_RETENTION_DAYS` must be at least the raw bucket's lifecycle rule, otherwise
objects written outside the scanned window would be missed.

The raw-tier step **fails closed**. Each object carries `customMetadata.ifaHash`
and the erase filters on it; if R2 returns an object under the scanned shard
without that metadata, the request cannot be verified and the endpoint answers
`500 {"error":"raw_erase_failed"}` instead of reporting a successful erasure.
**Do not record such a response as a fulfilled DSAR** — it means the raw-tier
writer needs investigating first. `raw_tier.deleted: 0` only means "nothing
found" when the response status is `200`.
