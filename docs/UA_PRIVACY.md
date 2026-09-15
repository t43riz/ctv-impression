# Privacy & Data Protection — Universal Ads

This document describes how the CTV/Linear impression tracker handles personal
data for the **Universal Ads (Comcast / NBCUniversal)** integration.

> Adapted from the Roku `PRIVACY.md`. The controls are identical; the
> differences are the identifiers involved (device IFA and/or **household ID**)
> and that the conversion recipient is **Universal Ads** via its Conversions
> API.

## 1. What data we handle

| Field | Classification | At rest? |
|-------|----------------|----------|
| `ifa` (device advertising ID) — analytics/reporting | **Personal data** (online identifier) | **Never stored raw** in AE/exports — salted SHA-256 hash only |
| `ifa` / device IP / `household_id` — **call-matching store** | Personal / pseudonymous | **Raw, window-scoped only** (see §2.1); purged after the attribution window |
| Device IP — analytics/reporting | Personal data | **Not persisted** in AE/exports; reduced to country |
| `household_id` (if provided) | Pseudonymous ID | Not persisted in analytics; window-scoped in matching store only |
| `country` / coarse geo | Coarse geo (from Cloudflare edge) | Stored (not identifying on its own) |
| Caller phone (ANI) | Personal data | **Never stored raw**; hashed (SHA-256) only when sent to UA |
| `campaign_id`, `creative_id`, `advertiser_id`, `app_id` | Non-personal | Stored |

The IFA is online personal data under GDPR (Art. 4) and a "unique identifier"
under CCPA. There is no "No PII stored" claim — the IFA and household ID are
handled as personal/pseudonymous data with the minimization controls below.

## 2. How we minimize

- **Hashing:** the IFA is hashed with a rotating server-side salt
  (`IFA_HASH_SALT`) before any storage. The raw value never leaves the request
  handler. The hash is used only for deduplication and reach.
- **LMT enforcement:** when `lmt=1` (Limit Ad Tracking) or the IFA is zeroed, we
  discard the identifier entirely and mark the impression `ifa_present=0`. Such
  impressions count toward totals but are excluded from device-level reach.
- **No IP persistence (analytics):** for AE/reporting, geolocation is reduced to
  a 2-letter country code; the raw IP is never written there.

## 2.1 Call-matching store (raw IP/IFA/household ID, window-scoped)

To attribute phone calls to impressions and send conversions to Universal Ads
CAPI (which matches on **unhashed** IP, IFA, and/or household ID), the
`RecentImpressions` Durable Object holds the **raw device IP, raw IFA, and
household ID** — but **only**:

- for the attribution window (`MATCH_WINDOW_MINUTES`, default 60 min),
- scoped per creative,
- purged by an alarm once older than the window.

LMT/opt-out impressions store **no IFA** (empty) and are never device-matched;
any resulting conversion is sent with UA's opt-out/LDU flag **[CONFIRM WITH UA —
exact token]**. The caller's phone number is **hashed** (never stored raw) and
used only to satisfy UA's identifier requirement on zero-match conversions.

This is the only component holding raw identifiers at rest, and it is short-lived
by design (storage minimization for the matching purpose).

## 3. Retention

| Tier | Retention | Contents |
|------|-----------|----------|
| RecentImpressions DO | attribution window (~60 min) | **raw** IP/IFA/household ID + geo (call matching only) |
| Analytics Engine | 3 months (platform fixed) | hashed IFA + dimensions |
| R2 raw | 30 days | hashed IFA + dimensions (reach/replay) |
| R2 aggregated | 13 months | **no identifiers** — hour/dimension rollups only |

### Data shared with Universal Ads (CAPI)

On a qualified call we send Universal Ads: matched impression IP, IFA (non-LMT
only), household ID (if provided), hashed caller phone, and coarse geo
(state/zip). This is a server-to-server disclosure to UA as a measurement
partner; document it in your privacy notice and processing terms. LMT
impressions are sent with the opt-out/LDU flag.

Impression and attribution data held by Universal Ads is governed by UA under its
own policies (attribution windows of 7 / 14 / 30 days). We do not retain
identifier-level data for years — the long-term tier is aggregate-only,
satisfying storage minimization.

## 4. Data subject requests (DSAR / erasure)

Because the IFA is hashed deterministically, a subject's data can be located by
hashing their IFA with the current salt and:
1. Deleting matching keys from the dedup Durable Object store.
2. Deleting matching rows from the 30-day raw R2 tier.
3. The RecentImpressions store self-purges within ~60 minutes (nothing to erase
   beyond that window).
4. Aggregated tiers contain **no identifiers**, so nothing to erase there.

AE rows expire within 3 months and contain only the hash.

## 5. Children's content (COPPA)

For child-directed channels, behavioral identifiers must not be used.
Operationally: campaigns flagged child-directed should be configured to send
`lmt=1` (or omit the IFA), which the Worker already treats as opt-out, so no
identifier is processed for those impressions.

## 6. Lawful basis / DPIA

Before production, document the lawful basis (legitimate interest or consent per
jurisdiction) and complete a DPIA. The technical controls above (hashing, LMT,
minimization, DSAR path) are prerequisites, not a substitute for that assessment.

## 7. Open items to confirm before go-live

- Salt rotation cadence and re-hash strategy.
- **[CONFIRM WITH UA]** Universal Ads' exact opt-out/LDU signaling tokens and how
  they map to our `lmt` handling.
- **[CONFIRM WITH UA]** whether a household ID is exposed to partner impression
  trackers, and its handling/retention expectations.
- Confirm contractual data-processing terms with Universal Ads and advertisers.
