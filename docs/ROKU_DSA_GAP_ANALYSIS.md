# Roku Advertising Data Partner Agreement — Gap Analysis

**Agreement:** Advertising Data Partner Agreement (Roku ↔ UDONIS d.o.o.)
**Effective Date:** July 20, 2026
**Source file:** `UDONIS d.o.o_ - Data Sharing Agreement - July 20, 2026 (6a4d65dc6b) (version 3).docx`
**Incorporated by reference:** [Ad Partner Data Processing Policy](https://docs.roku.com/published/adpartnerprocessingpolicy/en/us) ("DPP") — DSA §15 definition
**Reviewed against:** this repo at `main`

---

## Verdict

The agreement is sufficient to **sign**. It is **not** sufficient to **build**.

It is a data-license cover page plus boilerplate. Every technical detail is
delegated to documents that were not attached, and one entire subsystem already
built in this repo (`/call` → Conversions API) is **not licensed by it**.

Three things gate us:

| Gate | Blocks |
|---|---|
| **A1** — Roku ad platform technical specs (Data Processing Flag) | Correct COPPA / privacy-signal handling |
| **B1 + B2 + A5** — call-attribution approval, CAPI entitlement, CAPI docs | ~40% of the repo (`call.ts`, `match.ts`, `capi.ts`, `recent.ts`) |
| **A6 / B3** — Cloudflare as a Pre-Approved Vendor | Any deployment at all |

---

## The primary blocker: `/call` → CAPI is out of scope

The cover page scopes **Company Services** to:

> "Measure and provide reports on the effectiveness and reach, sales lift,
> conversions site visit lift of advertising campaigns running on the Roku Platform"

That is *reporting*. Our call-attribution path does more than report:

| Restriction | Our code | Conflict |
|---|---|---|
| **DPP §4(f)(i)** — may not associate Roku Data with PI that directly identifies an individual | `src/lib/capi.ts:85-104` | Associates a RIDA + device IP with a caller's phone number |
| **DPP §4(d)(ii)** — no cross-device tracking | `src/lib/match.ts` | Probabilistic phone ↔ CTV-device join on time + geo |
| **DPP §15** — Roku Measurement Tools (Pixel, Conversion API) granted only "if You are an advertiser or acting on behalf of or for the benefit of an advertiser" | `src/lib/capi.ts`, `src/lib/capi_ua.ts` | This DSA makes us a **measurement partner**, not an advertiser. Nothing here entitles us to a CAPI token |
| **DPP §15(a)(ii)** — may not use API tokens generated for one advertiser for any other advertiser | `CAPI_API_KEY` is a single global secret | Needs to be per-advertiser, or we need our own partner-scoped token |

This requires a separate written approval or an addendum to the DSA. Until then
`CAPI_MODE` must stay `test`.

---

## A. Documents to request from Roku

| # | Document | Why we can't build without it | Cited |
|---|---|---|---|
| A1 | **Roku ad platform technical documentation & specifications** | The only normative source for the `Data Processing Flag` — the parameter that signals when COPPA / Child-Directed terms apply. DSA §5 makes our entire child-data obligation conditional on it. We have **no field for it at all**; `src/lib/beacon.ts:71` fakes it via a KV value we set ourselves, which does not satisfy §5 or DPP §10 | DSA §15 def. "Data Processing Flag"; §5 |
| A2 | **RAF macro reference for third-party impression trackers** | Confirms exact tokens. Our tag assumes `[[[RIDA]]]`, `[[[LMT]]]`, `[[[CACHEBUSTER]]]`, `[[[APPID]]]` — flagged unconfirmed at `docs/ROKU_IMPRESSION_TAG.md:87`. Wrong tokens = pixel fires with literal strings | DSA §2(b) |
| A3 | **Pixel technical certification / QA procedure** | §2(b)(2) makes certification a precondition to going live; §2(b)(3) freezes the pixel afterward (no changes without re-certification). We need the checklist *before* finalizing the URL shape | DSA §2(b)(2)-(3) |
| A4 | **Privacy Signals technical spec** | DPP §10 requires us to honor *and pass downstream* every opt-out / LDU / "do not sell" / "do not share" signal. We only handle `lmt`. Unknown how CCPA signals arrive | DPP §10 |
| A5 | **Conversions API documentation** | Endpoint, auth scheme, `event_group_id` provisioning, event schema, and rate limits (DPP §15(a)(viii) makes exceeding them a breach). `CAPI_EVENT_GROUP_ID` is still `REPLACE_WITH_EVENT_GROUP_ID` in `wrangler.toml` | DPP §15 |
| A6 | **Pre-Approved Vendor list + approval process** | DPP §11: no third party may Process Roku Data without written Roku approval. Our entire stack is Cloudflare — Workers, R2, KV, Durable Objects, Analytics Engine | DPP §11 |
| A7 | **International Data Transfer Terms** | Incorporated by reference at DPP §6 but not attached. Company is in **Croatia (EEA)** processing US-user data — directly load-bearing, not boilerplate | DPP §6 |
| A8 | **Data Request / Regulatory Inquiry intake procedure** | DPP §7 requires we notify Roku *immediately* and **not respond without Roku's written consent**. Our `/admin/dsar` erases unilaterally. Need contact + SLA | DPP §7; §9(ii) |
| A9 | **Security Incident notification contact & procedure** | DPP §8 requires prompt notification and forbids public statement without consent. No named contact anywhere in the agreement | DPP §8 |
| A10 | **Audit expectations / evidence format** | DPP §13 grants Roku audit rights. Cheaper to know the evidence shape now than retrofit logging later | DPP §13 |

---

## B. Written approvals needed (decisions, not documents)

| # | Approval | What it unblocks |
|---|---|---|
| B1 | **Call-attribution use case** — joining a qualified inbound phone call to a CTV impression | `src/call.ts`, `src/lib/match.ts`, `src/lib/capi.ts`, `src/recent.ts`. Currently unlicensed — see "primary blocker" above |
| B2 | **CAPI entitlement as a measurement partner**, with our own partner-scoped token | Any live conversion send. DPP §15 grants Measurement Tools only to advertisers or agents thereof; §15(a)(ii) forbids sharing tokens across advertisers |
| B3 | **Cloudflare as a Pre-Approved Vendor** | Any deployment at all (DPP §11) |
| B4 | **Naming Roku as the data source in reports** | DSA §3(b) — advertiser-facing reports may not identify Roku or the Roku Platform without prior written consent. Affects `/admin/report/*` output and any client-facing deck |
| B5 | **Data Match Provider** — confirm we are staying out of scope | DSA §2(a) requires pre-approval by email plus a flow-down contract. Not currently in scope; confirm in writing |

---

## C. Cover-page amendments to request

DSA §14(i) allows changes to **Campaign Data**, **Data Sharing Method**, and
**Specific Inventory** with Roku's written approval **via email** — no
re-signature required. Do this before ingesting anything.

### Currently licensed Campaign Data

> Advertiser ID, Campaign ID, Creative ID, RIDA, Device IP, Timestamp, Cache
> buster, aggregated/approximate geo, App ID and Limit Ad Tracking signals

### Fields to add

| Field | Status in code | Note |
|---|---|---|
| `Data Processing Flag` | **absent entirely** | Must be added to the cover page *and* to `src/lib/beacon.ts` |
| `hh_id` (household ID) | collected `src/index.ts:111`, stored `src/recent.ts` | Not on the licensed list |
| `region` / `city` | collected `src/index.ts:117-118` | "aggregated/approximate geo" is ambiguous — get these named explicitly |
| `postal` | collected `src/index.ts:119` | **Highest risk.** DPP §5 classes "an end user's precise geo-location" as **Sensitive Data**, which we are flatly barred from Processing. Either get postal named explicitly as approximate, or **drop it** |

### Clarifications to request on the same email

1. Whether **Device IP may be retained raw** for the attribution window (we hold
   it in `RecentImpressions`, `src/recent.ts`) or must be hashed at ingest.
2. Whether **RIDA may be retained raw** for the same window (`recent.ts` does).
   DSA §3(b) and DPP §12 restrict *reporting* output; retention limits are unstated.
3. Confirmation that the **Data Sharing Method** stays "Company's pixel" and that
   no data feed / SFTP path is contemplated (DSA §2(c)).

---

## D. Terms worth negotiating

| # | Issue |
|---|---|
| D1 | **DPP §9 (30-day deletion) vs. our 13-month archive.** Our `impression-archive` R2 lifecycle is 395 days. Either get written approval to retain **Aggregated** Data past termination, or accept a hard purge and lose historical reporting |
| D2 | **Indemnity is one-way.** DSA §12 — we indemnify Roku; Roku indemnifies nothing |
| D3 | **Roku's liability capped at $10,000** (DSA §13) while ours is uncapped for indemnity, confidentiality breach, gross negligence, and willful misconduct |
| D4 | **Termination at will, no notice period** (DSA §9). Ask for 30 days so live campaigns can wind down. Note §9 already lets Roku *elect* to keep us bound for active campaigns — asymmetric |
| D5 | **Unilateral amendment** (DSA §14(ii)) — Roku may amend on 30 days' email notice. Acceptable, but route the notice address to someone who reads it |
| D6 | **Governing law: New York, exclusive jurisdiction in New York County.** Company is Croatian. Worth a look |

---

## E. Our own deliverables (nobody sends these — we produce them)

| # | Item | Requirement |
|---|---|---|
| E1 | **Public privacy notice** disclosing our collection / use / disclosure practices | DPP §2 requires we publish *and maintain* one. `docs/PRIVACY.md` is internal and does not satisfy this |
| E2 | **Security program documentation** | DPP §8 — physical, administrative, technical and organizational measures, **plus** confidentiality duties and completed privacy/security training for all personnel *before* they access Roku Data |
| E3 | **Flow-down contracts** for downstream recipients | DSA §3(b) — advertisers receiving reports must be bound to confidentiality + use restrictions at least as protective as the DSA |
| E4 | **Termination purge runbook** | DPP §9 — (i) ≤30 days post-termination, (ii) ≤15 days on a Data Request. A bucket lifecycle rule is not a runbook |

---

## F. Code conformance gaps (fixable without Roku input)

| # | Gap | Location | Requirement |
|---|---|---|---|
| F1 | **Market not enforced.** Accepts any country and stamps `"XX"` | `src/lib/beacon.ts:82-83` | DSA §3(a) license is Market-limited (United States). Non-US should be rejected, not counted |
| F2 | **No flight-date enforcement.** `exp` is a rolling TTL (30d), not campaign end date; KV holds no dates | `src/lib/beacon.ts`, `CAMPAIGNS` KV | DSA §2(b)(1) — collect "only for the duration of the advertising campaign" |
| F3 | **No global kill switch.** Nothing can disable ingestion on demand | `src/index.ts`, `src/admin.ts` | DSA §2(b) — Roku may demand Pixel removal at any time and we "will promptly comply" |
| F4 | **DSAR flow is backwards.** Erases unilaterally | `src/admin.ts` `/admin/dsar` | DPP §7 — notify Roku immediately, do **not** act without written consent |
| F5 | **No Data Processing Flag handling** | `src/lib/beacon.ts:65-77` | DSA §5 / DPP §10 — COPPA treatment must be driven by Roku's signal, not our own KV value |
| F6 | **No downstream signal pass-through** | — | DPP §10 — must honor *and pass on* Privacy Signals to any Downstream Ad Partner |
| F7 | **No Roku-attribution guard on reports** | `src/query.ts`, `src/admin.ts` | DSA §3(b) — reports may not identify Roku as the data source absent written consent |
| F8 | **`reachEstimate` does `count(DISTINCT rida)`** | `src/query.ts:91-99` | Device-level. Safe *only* because output is aggregated. Never expose the underlying rows (DPP §12) |

---

## G. Draft email to Roku

> **To:** Roku Measurement Partnerships / Ad Platform Onboarding
> **Cc:** Mickey Knan &lt;mickey@udonis.co&gt;
> **Subject:** UDONIS d.o.o. — Advertising Data Partner Agreement (eff. July 20, 2026): technical documentation & scope confirmations before integration

Hi &lt;name&gt;,

Thanks for getting the Advertising Data Partner Agreement over to us. We've
reviewed it alongside the Ad Partner Data Processing Policy referenced in §15.

Before we begin any integration work we need a handful of items that the
agreement references but doesn't include, plus written confirmation on two scope
questions. Grouping them so it's easy to route internally.

**1. Technical documentation referenced in the agreement**

- **Ad platform technical documentation and specifications** — specifically the
  `Data Processing Flag` described in the §15 definition. §5 makes our entire
  Child-Directed Content handling conditional on this signal, so we need the
  parameter name, its possible values, and how it is delivered on the beacon.
- **RAF macro reference** for third-party impression trackers, so we can confirm
  the exact tokens. We are currently assuming `[[[RIDA]]]`, `[[[LMT]]]`,
  `[[[CACHEBUSTER]]]` and `[[[APPID]]]`.
- **Pixel technical certification / QA procedure** per §2(b)(2). Since §2(b)(3)
  freezes the pixel once certified, we'd like the checklist before we finalize
  the tag.
- **Privacy Signals specification** per DPP §10 — how opt-out, "do not sell",
  "do not share" and LDU signals reach us, and the expected downstream
  pass-through format.
- **International Data Transfer Terms**, incorporated at DPP §6. UDONIS is
  established in Croatia, so this one is material for us.

**2. Operational contacts**

- Intake contact and SLA for Data Requests and Regulatory Inquiries, per DPP §7.
  We note we must notify you and must not respond without your written consent —
  we want that wired into our runbook correctly from day one.
- Security Incident notification contact, per DPP §8.
- Any expectations on audit evidence format, per DPP §13, so we can instrument
  for it up front rather than retrofit.

**3. Pre-Approved Vendor confirmation (DPP §11)**

Our measurement infrastructure runs on **Cloudflare** — Workers for edge
ingestion, R2 for storage, Workers KV, Durable Objects, and Workers Analytics
Engine. No other subprocessor touches Roku Data. Please confirm Cloudflare is an
approved vendor, or let us know the approval process.

**4. Scope confirmation — call-based conversion measurement**

This is the one we'd most like to talk through. Beyond impression reporting, the
service our advertisers are buying measures **inbound phone calls** as the
conversion event: an advertiser's CTV creative carries a tracking number, and we
report on qualified calls attributable to that campaign.

Mechanically this means matching a qualified inbound call to a recent impression
on a probabilistic basis (time window plus approximate geo) and reporting the
result. We want to be explicit that we read DPP §4(d)(ii) and §4(f)(i) as
potentially covering this, and the cover-page Company Services description as
scoped to reporting, so we are **not** treating it as authorized today. We would
like either:

- written confirmation that this use case falls within our Permitted Purpose and
  the "conversions" element of the Company Services description; or
- guidance on the addendum you'd want in place.

Related: DPP §15 grants access to Roku Measurement Tools including the
Conversion API to advertisers or parties acting on their behalf. As a
measurement partner we'd like confirmation of whether we are entitled to use the
Conversion API in this role and, if so, how tokens are provisioned — §15(a)(ii)
prohibits reusing an advertiser's token across advertisers, so we assume a
partner-scoped credential. We'd also need the endpoint, auth scheme,
`event_group_id` provisioning, event schema, and documented rate limits.

Until this is resolved our conversion path stays in test mode and posts nothing
to production.

**5. Cover-page amendment request (§14(i), email sufficient)**

The Campaign Data list reads: *Advertiser ID, Campaign ID, Creative ID, RIDA,
Device IP, Timestamp, Cache buster, aggregated/approximate geo, App ID and Limit
Ad Tracking signals.* We'd like to add or clarify:

- **Data Processing Flag** — per item 1 above.
- **Household ID**, if one is exposed to partner impression trackers.
- **Region and city** — we read these as within "aggregated/approximate geo" but
  would rather have them named.
- **Postal code** — we'd like your read here. DPP §5 treats precise
  geo-location as Sensitive Data. If postal code isn't comfortably "approximate"
  for you, we'll drop it rather than carry the ambiguity.

Two retention clarifications while we're in the cover page:

- Whether **Device IP** may be retained in raw form for a bounded attribution
  window, or must be hashed at ingest.
- The same question for **RIDA**.

**6. Reporting attribution (§3(b))**

§3(b) restricts identifying Roku or the Roku Platform as the data source in
reports without prior written consent. Our advertiser-facing reports currently
label the channel. Happy to suppress it — just confirm which you prefer.

Finally, two commercial notes we'd like to raise with whoever owns the paper:
DPP §9 requires deletion of Roku Data within 30 days of termination, which
conflicts with the 13-month retention our advertisers expect for aggregated
reporting — we'd like to discuss whether Aggregated Data may be retained. And
we'd appreciate a 30-day notice period on termination under §9 so live campaigns
can wind down cleanly.

Happy to take any of this on a call. We can move quickly once items 1–4 are
settled.

Best,
&lt;signer&gt;
UDONIS d.o.o.
J.J. Strossmayer 168, 31000 Osijek, Croatia

---

### Notes on sending

- **Formal notice** under DSA §14 must go by first-class, registered or private
  courier to *Roku, Inc., Attn: General Counsel, 1701 Junction Court, Suite #100,
  San Jose, CA 95112*. The email above is **not** formal notice — but §14(i)
  explicitly permits Campaign Data / Data Sharing Method / Specific Inventory
  amendments by email, so section 5 of the email is effective on Roku's written
  reply.
- Keep Roku's reply. It is the written approval record for items B1–B5 and the
  §14(i) amendment.
- Section 4 is deliberately self-reporting. Flagging the conflict ourselves is
  cheaper than having it found in a DPP §13 audit.
