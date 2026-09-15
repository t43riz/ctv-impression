# Roku Advertising Data Partner Agreement Review

**Agreement:** UDONIS d.o.o. Advertising Data Partner Agreement  
**Stated effective date:** July 20, 2026  
**Review date:** July 29, 2026  
**Purpose:** Contract, privacy, and technical readiness review for the Roku impression-measurement and call-conversion implementation

> This is an operational and technical review, not legal advice. Croatian and U.S. privacy counsel should review the final agreement and data flow before execution or production launch.

## Executive decision

The agreement is sufficient to begin contract redlines, implementation remediation, and synthetic testing. It is **not sufficient to begin collecting live Roku data or submitting real conversion events**.

Before launch, UDONIS should obtain a clean signed agreement, written authorization for the complete conversion workflow and subprocessors, complete Roku certification, and resolve the critical implementation gaps described below.

## Document status

- The signature fields are placeholders, and the document does not appear to be executed.
- The effective date is July 20, 2026, rather than the date of the last signature.
- The document contains a tracked insertion dated July 28, 2026, adding:
  - Cache buster
  - Aggregated/approximate geography
  - App ID
  - Limit Ad Tracking signals
- The embedded metadata identifies Jack Connolly as the creator and Karen Mo as the last modifier.
- Roku's separately hosted Ad Partner Data Processing Policy is incorporated by reference, prevails in a conflict, and may be updated by Roku.

UDONIS should request a clean execution copy with all changes accepted, completed signature blocks, and the effective date defined as the date of the last signature.

## What the agreement currently authorizes

### Campaign data

- Advertiser ID
- Campaign ID
- Creative ID
- RIDA
- Device IP
- Timestamp
- Cache buster
- Aggregated or approximate geography
- App ID
- Limit Ad Tracking signals

### Data-sharing method

UDONIS's impression pixel.

### Permitted services

Measure and report on:

- Advertising effectiveness and reach
- Sales lift
- Conversions
- Site-visit lift

### Recipients and market

- Reports may be provided to Roku and the relevant advertisers.
- The authorized market is the United States.
- Reports must contain only aggregated data and must not contain user-level, household-level, device-level, pseudonymous, or persistent-identifier data.

## Incorporated policy requirements

Roku's current Ad Partner Data Processing Policy adds material obligations, including:

- Process Roku Data only for an expressly permitted purpose.
- Do not create profiles, device graphs, cross-device tracking, or unrelated derivative works.
- Do not combine or commingle Roku Data with other data except where necessary for an approved purpose.
- Do not associate Roku Data with directly identifying personal information.
- Honor Roku privacy, LMT, COPPA, and other Data Processing Flags.
- Maintain accurate public privacy notices.
- Promptly notify Roku of security incidents.
- Delete Roku Data within 30 days after termination or within 15 days after a Roku privacy-request instruction.
- Use only subprocessors and vendors approved by Roku in writing.
- Make reports available only to the advertiser to which they relate.
- Permit Roku compliance audits.
- Apply Limited Data Use based on applicable state privacy requirements and the individual's privacy choices.

The policy also treats Roku Data and advertiser-supplied Conversion API data as separate data flows. The fact that a field is technically supported by Roku's Conversion API does not by itself confirm that the field or attribution method is authorized under this agreement.

## Required contract and implementation annex

Request an attached implementation annex that enumerates the following.

### Pixel collection

- Advertiser ID
- Campaign ID
- Creative ID
- RIDA
- Device IP
- Timestamp
- Cache buster
- Approximate geography
- App ID
- LMT and all other Data Processing Flags

### Temporary attribution store

- Exact fields retained
- Purpose of retaining raw IP and RIDA
- Campaign and advertiser isolation
- Maximum retention window
- LMT and child-directed exclusions
- Deletion and incident procedures

### PBX and call data

- Caller phone number
- Dialed tracking number
- Call ID
- Call time and duration
- Qualification criteria
- Optional conversion value and currency
- Applicable consent, opt-out, and Limited Data Use signals

### Roku Conversion API

- Hashed phone
- Device IP
- RIDA
- Approximate geography
- Event name and source
- Value and currency
- Permitted custom-data fields
- Limited Data Use behavior
- Whether phone-only conversions are permitted
- Whether probabilistic attribution is permitted

### Retention

- Raw device identifiers
- Salted or pseudonymous identifiers
- PBX data
- Analytics Engine data
- Raw R2 data
- Aggregated reports
- Logs and backups
- Post-termination aggregate-data rights

## Contract pushback

### 1. Clarify the complete permitted service

The agreement should expressly include:

- Impression and reach measurement
- Call-conversion measurement
- Hashed-phone Conversion API submissions
- The intended attribution methodology
- Campaign optimization, if conversion events will be used for optimization

The current reference to conversions is not sufficiently detailed to approve the proposed combination of Roku impression data and PBX call data.

### 2. Obtain written vendor approval

Roku's policy requires written approval of vendors that process Roku Data. Request written approval for:

- Cloudflare Workers
- Cloudflare Durable Objects
- Cloudflare Analytics Engine
- Cloudflare R2
- Any externally hosted PBX, telephony platform, monitoring service, or log processor

The approval should identify the services, data categories, regions, and permitted purposes.

### 3. Control policy updates

Request:

- A dated copy of the applicable Data Processing Policy attached to the agreement
- Advance notice of material changes
- A reasonable implementation period
- A right to terminate before materially adverse changes become effective
- Confirmation that changes will not apply retroactively

### 4. Address liability and indemnification

The current position is materially asymmetric:

- UDONIS provides broad indemnification, including for allegations.
- Roku's liability is capped at $10,000.
- UDONIS's indemnification and confidentiality exposure is effectively outside the ordinary liability limitation.

Request:

- A mutual and commercially reasonable liability cap
- Indemnification based on a final judgment or approved settlement
- Control of the defense by the indemnifying party
- Consent before settlement
- Exclusions for claims caused by Roku-supplied data, inaccurate or late flags, specifications, macros, or instructions
- Proportionate responsibility where both parties contributed to a claim

### 5. Clarify deletion

Request an agreed deletion schedule covering:

- Live stores
- Immutable or platform-fixed retention
- Backups
- Logs
- Derived pseudonymous data
- Genuinely aggregated data

The agreement should expressly state whether non-identifiable aggregated reports may be retained after campaign completion or termination.

### 6. Limit audit rights

Request:

- Reasonable advance notice
- No more than one ordinary audit per year
- Existing independent security reports and certifications to be reviewed first
- Protection of source code and other clients' confidential information
- No competitor auditors
- Roku payment of audit costs unless a material breach is found
- Confidential treatment of all audit findings

### 7. Confirm roles and international transfers

Roku's incorporated transfer terms describe the parties as independent controllers. Confirm that this matches:

- UDONIS's advertiser contracts
- UDONIS's privacy notice and legal basis
- Cloudflare's contractual role
- Applicable GDPR and Croatian-law obligations
- Applicable U.S. state privacy-law obligations

### 8. Add operational protections

Request:

- A documented certification and recertification process
- Advance notice of macro, API, flag, and schema changes
- Defined technical contacts and escalation procedures
- A reasonable campaign wind-down period after termination
- Responsibility allocation for incorrect Roku macros, flags, inventory classifications, or documentation

## Critical implementation blockers

### 1. The United States market restriction is not enforced

`src/lib/beacon.ts` accepts any valid two-letter country and falls back to `XX`. Non-U.S. events can therefore be counted, stored, matched, and reported.

**Required action:** Reject non-U.S. and unknown-country impressions, or obtain written confirmation that Roku's campaign targeting is the required and sufficient market control.

### 2. LMT and child-directed impressions still process device IP

The implementation suppresses RIDA under LMT or child-directed treatment, but still stores raw IP and detailed approximate geography in the recent-impression matching store. These records remain eligible for call matching, and the selected IP may be sent through CAPI.

Relevant files:

- `src/index.ts`
- `src/recent.ts`
- `src/lib/match.ts`
- `src/lib/capi.ts`

**Required action:** Exclude LMT, child-directed, and otherwise restricted events from identifier-level attribution unless Roku provides explicit written approval.

### 3. Matching can commingle campaigns and advertisers

The recent-impression Durable Object is keyed only by `creativeId`. It does not isolate records by advertiser, campaign, platform, or child-directed status.

Relevant files:

- `src/recent.ts`
- `src/call.ts`

**Required action:** Partition and validate matching by advertiser, campaign, creative, platform, and applicable privacy classification.

### 4. Phone hashing does not follow Roku's current instructions

Roku's current CAPI instructions require an E.164 phone number, including the leading `+`, before SHA-256 hashing. `src/lib/phone.ts` removes the `+` and hashes digits only.

**Required action:** Correct normalization and update the tests before sending any real events.

### 5. Limited Data Use is derived from the wrong signal

The CAPI `opt_out` value is currently derived from the matched impression's LMT value. Roku states that LDU is based on applicable state privacy requirements and the individual's applicable privacy choices. The PBX event does not provide those signals.

**Required action:** Define a lawful event-source consent and LDU process. Do not assume Roku-device LMT is an adequate substitute for the caller's privacy status.

### 6. Additional fields are collected outside the agreement

The implementation also processes:

- `ifa_type`
- `platform`
- `hh_id`

These fields are not listed as Campaign Data. `hh_id` is especially significant because it is a household identifier.

**Required action:** Remove these fields from Roku processing or add them to the implementation annex with explicit approval.

### 7. The attribution methodology needs explicit approval

The system selects a Roku impression using time and approximate geography, then sends that impression's IP and RIDA with a call from an unconfirmed individual. There is no deterministic shared identifier between the impression and call.

**Required action:** Obtain written Roku approval before using this methodology. If Roku does not approve it, submit only lawfully collected call identifiers through the advertiser's CAPI configuration and allow Roku to perform attribution.

### 8. Unsupported CAPI custom fields are submitted

The implementation sends:

- `match_confidence`
- `match_candidates`
- `match_type`
- `call_duration_seconds`

These are not among the currently documented Roku CAPI custom-data fields. The assumption that Roku silently ignores unknown fields has not been established.

**Required action:** Remove unsupported fields or obtain written schema approval. Keep diagnostic data in internal logs rather than transmitting it to Roku.

### 9. Reporting is not recipient-scoped

One administrator bearer token can access reports across advertisers and campaigns. There is no advertiser entitlement model, user identity, audit log, or role-based access control.

Relevant file:

- `src/admin.ts`

**Required action:** Restrict each advertiser to its own aggregated reports and implement access logging and credential rotation.

### 10. Retention is not technically guaranteed

R2 lifecycle requirements are documented but are not represented in the repository's deployment configuration. There is no end-to-end termination deletion operation.

**Required action:** Verify lifecycle policies in the deployed Cloudflare account and create an auditable termination and deletion runbook.

### 11. DSAR deletion is incomplete

Raw R2 deletion stops after 50,000 objects and does not expose a continuation cursor. It also depends on the requester supplying campaign IDs and cannot immediately remove all identifier data from every store.

Relevant files:

- `src/raw.ts`
- `src/admin.ts`

**Required action:** Implement resumable deletion, campaign discovery, completion records, and store-by-store verification.

### 12. Roku-facing documentation contradicts the implementation

`docs/ROKU_IMPRESSION_TAG.md` and `docs/PRIVACY.md` state that raw IP and RIDA are not persisted, while `src/index.ts` intentionally persists them temporarily for attribution.

**Required action:** Correct the disclosures before sending them to Roku or advertisers.

## Security and validation status

### Passed

- TypeScript typecheck
- Six unit-test files
- Forty-two unit tests
- No production dependency vulnerabilities reported by `npm audit --omit=dev`

### Outstanding

- Worker integration tests
- Durable Object integration tests
- R2 lifecycle and deletion tests
- Recipient-access tests
- LMT, LDU, and child-directed end-to-end tests
- U.S.-market enforcement tests
- Roku pixel certification
- CAPI schema validation with approved synthetic identifiers

The development and deployment toolchain currently reports 13 npm advisories, including two critical and seven high-severity advisories through older Wrangler, Vitest, Miniflare, and related dependencies. These should be remediated and retested before certification or deployment.

## Questions requiring Roku's written response

1. Does this agreement authorize UDONIS to combine Roku impression data with PBX call data for call-conversion attribution?
2. Does Roku approve probabilistic selection of an impression IP or RIDA when there is no deterministic identifier linking the impression to the call?
3. May UDONIS send hashed caller phone numbers, call duration, value, currency, and phone-only conversions?
4. Which CAPI event name should be used for a qualified phone call: `CONTACT`, `LEAD`, or another event?
5. Which custom-data fields are approved for this integration?
6. How must LMT, LDU, state privacy opt-outs, and child-directed flags affect pixel collection, short-term storage, matching, and CAPI?
7. Must LMT or child-directed events exclude device IP from all attribution processing?
8. What is the complete Data Processing Flag schema and how will flags be delivered?
9. How should the U.S.-only market restriction be enforced for unknown geolocation, VPN traffic, and U.S. territories?
10. Does Roku approve Cloudflare and the applicable PBX provider as vendors processing Roku Data?
11. What retention periods does Roku approve for raw IP/RIDA, pseudonymous hashes, PBX data, logs, backups, and aggregates?
12. May genuinely aggregated reports be retained after termination?
13. Which changes require pixel recertification?
14. What exact RAF macro tokens and test procedures should be used?
15. May UDONIS identify Roku as the data source in methodology and advertiser reports?

## Go-live conditions

Do not launch live collection until all of the following are complete:

1. Clean, signed agreement and agreed implementation annex
2. Written approval for Cloudflare and every other processor
3. Written approval for the PBX and CAPI attribution workflow
4. Data Processing Flag implementation
5. U.S.-market enforcement
6. LMT, LDU, and child-directed remediation
7. Campaign and advertiser isolation
8. Correct phone normalization
9. Recipient-scoped reporting and audit logging
10. Verified retention and deletion controls
11. Corrected external disclosures
12. Dependency remediation
13. Integration tests
14. Roku pixel and CAPI certification

## Ready-to-send email

**Subject:** Roku Advertising Data Partner Agreement: implementation clarifications and requested annex

Hi Karen,

Thank you for sending the updated Advertising Data Partner Agreement. We have completed an initial legal, privacy, and technical review against the Roku impression-pixel and call-conversion implementation we discussed.

The agreement gives us enough direction to continue architecture work and synthetic testing, but we need several items clarified in writing before we can execute the agreement or process live Roku data.

The principal issue is that the proposed implementation has two related but distinct data flows:

1. A Roku impression pixel that receives campaign IDs, RIDA, device IP, approximate geography, App ID, timestamp, cache buster, and privacy signals.
2. A server-side call-conversion flow that receives PBX call data and submits conversion events through Roku's CAPI.

Could we please add an implementation annex confirming the authorized fields, purposes, retention periods, and privacy-signal treatment for both flows?

In particular, we need Roku's written confirmation on the following:

- Whether UDONIS may use Roku impression data together with PBX call data for call-conversion attribution.
- Whether Roku permits probabilistic attribution based on campaign/creative, time, and approximate geography where no deterministic identifier connects the impression and call.
- Whether hashed caller phone, call duration, conversion value/currency, and phone-only events are approved CAPI data for this engagement.
- Which event name and custom-data fields Roku wants us to use for qualified calls.
- How LMT, Limited Data Use, state privacy opt-outs, and child-directed flags must affect collection, temporary storage, matching, and CAPI submissions.
- The complete Data Processing Flag schema and the exact RAF macros Roku will provide.
- How Roku expects us to enforce the agreement's United States market limitation.
- Approved retention periods for temporary raw IP/RIDA, pseudonymous identifiers, call data, logs, backups, and aggregated reporting.
- Whether genuinely aggregated reports may be retained after campaign completion or termination.
- Which technical or configuration changes require recertification.

Roku's Data Processing Policy also requires written approval of vendors that process Roku Data. Please confirm approval, or provide the approval process, for our use of Cloudflare Workers, Durable Objects, Analytics Engine, and R2. We will separately identify the PBX provider and any other applicable processor.

We would also like to resolve several agreement-level items:

- Use the last-signature date as the effective date.
- Attach or identify the dated version of the Data Processing Policy that applies.
- Provide notice and a reasonable implementation or termination right for materially adverse policy changes.
- Clarify deletion requirements for platform-fixed retention, backups, and genuinely aggregated data.
- Add reasonable scope, confidentiality, and frequency limits to audit rights.
- Revisit the current liability and indemnification structure, particularly the broad UDONIS indemnity compared with Roku's $10,000 liability cap.

We will continue implementation remediation and can use synthetic identifiers with the test endpoint while these points are resolved. We will not process live Roku impression or caller data until the data scope, vendor approvals, privacy-signal requirements, and certification steps are confirmed.

Please let us know whether you prefer to provide Roku's standard implementation annex or have us send a first draft based on the questions above.

Best,

Mickey Knan  
UDONIS d.o.o.  
mickey@udonis.co
