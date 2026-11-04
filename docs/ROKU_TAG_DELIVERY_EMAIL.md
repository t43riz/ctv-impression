# Roku tag delivery email

Ready to send. Operational email that hands Roku the **reissued** impression tag
and asks the one question still gating it.

> **Status (2026-09-21):** Roku answered the macro question — Ads Manager
> supports only the documented macro list, so `[[[RIDA]]]`, `[[[LMT]]]` and
> `[[[APPID]]]` are unavailable and the tag has been reissued using
> `[[[DEVICE_IP]]]`, `[[[COUNTRY]]]`, `[[[METRO_CODE]]]` and
> `[[[CACHEBUSTER]]]`. Roku has also confirmed verbally that
> `pixels.postbackx.com` is being added as an approved vendor domain, so §2 now
> asks for that in writing rather than raising it as an open question.
>
> **The signing key was rotated on 2026-09-21, so the tag below replaces any
> tag sent earlier in this thread.** Earlier tags no longer validate. Rotating
> now was deliberate: once Roku certifies a tag, §2(b)(3) freezes it.

Scope note: this is **not** the DSA/legal email. The technical-documentation
requests, Pre-Approved Vendor confirmation for Cloudflare, call-attribution
scope, and CAPI entitlement live in
[`ROKU_DSA_GAP_ANALYSIS.md`](./ROKU_DSA_GAP_ANALYSIS.md) §"Draft email" and go
to Measurement Partnerships / Ad Platform Onboarding. This one goes to Ads
Manager support and is only about getting the tag live and tested.

Before sending, fill in: `<name>`, `<your name>`, and the Ads Manager
campaign/creative names if they differ from the IDs below.

---

**To:** adsmanagersupport@roku.com
**Cc:** Mickey Knan &lt;mickey@udonis.co&gt;
**Subject:** UDONIS d.o.o. — final impression tag for certification (supported macros only)

---

Hi &lt;name&gt;,

Thanks for the macro list, and for confirming you're adding
`pixels.postbackx.com` as an approved vendor domain. We've reissued the tag
using only the macros Ads Manager supports. This is the version we'd like
certified.

## 1. The tag (final — replaces any earlier version)

```
https://pixels.postbackx.com/v1/pixel?advertiser_id=adv_udonis&campaign_id=camp_roku_test&creative_id=cre_roku_cert&exp=1821558200&sig=c2bac6d98d08968cc637c9fdcfca6b1a298dfae8d464f7cd61e49a3c3ebf49d9&device_ip=[[[DEVICE_IP]]]&country=[[[COUNTRY]]]&dma=[[[METRO_CODE]]]&cb=[[[CACHEBUSTER]]]
```

HTTPS, single line, no spaces. Four macros, all from your supported list:
`[[[DEVICE_IP]]]`, `[[[COUNTRY]]]`, `[[[METRO_CODE]]]` and `[[[CACHEBUSTER]]]`.
`[[[RIDA]]]`, `[[[LMT]]]` and `[[[APPID]]]` are gone. The signature is valid
through **2027-09-21 20:23 UTC**; tell us the campaign flight dates and we'll
reissue with a matching expiry.

**Please discard any tag we sent earlier in this thread.** We rotated our
signing key on 2026-09-21, so older tags no longer validate. We did that
deliberately before certification rather than after, since §2(b)(3) freezes the
tag once it's certified.

We fired this exact URL end to end against production on 2026-09-21 and
confirmed it records a counted impression, with country and DMA landing
correctly.

We've also confirmed the opt-out path works the way your documentation
describes it. Since there's no `LMT` macro, we take the signal from
`[[[DEVICE_IP]]]`:

- a real IPv4 address is salted-hashed as the device identity (we never store
  the raw address in analytics or exports);
- `0.0.0.0` is treated as an **opt-out** — the impression still counts in
  aggregate, but no identifier is stored and it is excluded from reach;
- an unexpanded or malformed value is counted as non-attributable, but we
  deliberately do *not* record it as a user opt-out, since no opt-out was
  actually signalled.

We are not requesting `[[[POSTAL_CODE]]]`. Your Data Processing Policy §5
treats precise geo-location as Sensitive Data, and it isn't on our agreement's
Campaign Data list, so DMA is as granular as we'd like to go. Let us know if
you read that differently.

**One consequence worth stating plainly.** Without a RIDA, the hashed device IP
is the only identity available to us, and an IP identifies a *household*, not a
device. Dynamic IP reassignment splits one household across several identities;
carrier-grade NAT collapses several households into one. So we'll report
impressions with confidence, and we'll label anything reach- or
frequency-shaped as an approximate household estimate rather than device reach.
If there's a supported route to a stable device or household identifier, or to
deduplicated reach on your side, we'd like to know about it.

**Two notes if you test the tag yourselves:**

- **A `200` response does not confirm an impression was counted.** The endpoint
  returns `200` and a 1×1 GIF for *every* request, including ones it rejects.
  That is deliberate: the beacon must never leak validation state back to the
  device. If you fire the tag and want confirmation it counted, tell us roughly
  when and we'll confirm from our side.
- **Allow 60–90 seconds.** Our analytics ingestion is not instant, so an
  immediate check can show nothing even on a successful fire.

## 2. Vendor domain — confirming in writing

Thanks for approving `pixels.postbackx.com`. Could you confirm in this thread
once it's live on the approved-provider list, and let us know if it's scoped to
our account or added globally?

We're asking only because the "Measuring Campaigns with Third Party Solutions"
article states that tags are accepted only from approved providers on approved
domains, and we'd rather confirm it's in place than discover the gap at creative
review.

That domain is the only one we'll serve tags from. There are no redirects and no
third-party wrapping. For context on the stack: the endpoint is a Cloudflare
Worker, and Cloudflare is the only subprocessor that touches Roku data. We're
raising Pre-Approved Vendor confirmation separately under DPP §11 with the
partnerships team, so feel free to route that part to whoever owns it.

## 3. Collection limits we enforce in code

Two things from the agreement are enforced server-side rather than by policy,
which may be relevant to your certification review:

- **Flight window (§2(b)(1)).** We collect only for the duration of the
  campaign. Beacons arriving before the start date or after the end date are
  refused and never stored, even if the tag is still live in a creative. This
  is why we're asking for flight dates in item 4 below.
- **Market (§3(a)).** Our licensed Market is the United States, so we use your
  `[[[COUNTRY]]]` value to refuse impressions served outside it.

In both cases the endpoint still returns the 1×1 GIF as normal, so a refusal is
never visible to the device.

## 4. One agreement mismatch to flag

Our Advertising Data Partner Agreement cover page names **RIDA** and **Limit Ad
Tracking signals** in the Campaign Data list, but Ads Manager doesn't expose
either to impression tags. We're not asking you to change the platform — we've
built to what's actually available. We're flagging it so the paper matches
reality, since §14(i) lets us amend the Campaign Data list by email.

We'd suggest the list be amended to reflect what we actually receive: Advertiser
ID, Campaign ID, Creative ID, **Device IP**, Timestamp, Cache buster, Country,
**DMA / Metro Code**. We would drop RIDA, Limit Ad Tracking and App ID from it,
since we never receive them.

Happy to route this to whoever owns the agreement if that's a different team.

## 5. What we're asking for

- **Written confirmation the vendor domain is live** (item 2)
- **The pixel certification / QA checklist** referenced at §2(b)(2). Since
  §2(b)(3) freezes the tag once certified, we'd like to see the checklist
  before you certify this URL
- **A creative to attach the tag to** for a live test, whenever it suits you
- **The campaign flight dates** (start and end), per item 3 — we need these
  loaded before the first impression serves
- Your read on the Campaign Data amendment (item 4)

One thing worth flagging: we only need impression tags. No click, quartile,
video-complete or VAST tagging, which we understand you don't accept anyway.

Thanks,
&lt;your name&gt;
UDONIS d.o.o.

---

## Facts behind this email

Everything asserted above, and where it came from. Anything not on this list
should be treated as unverified.

| Claim | Basis |
|---|---|
| **This exact tag URL** records a counted impression | The URL in §1 was fired verbatim against production 2026-09-21 (macros substituted, `device_ip=198.51.100.30&country=US&dma=803`): worker tail logged no rejection and no exception |
| Repeat beacon deduplicates | Same device IP fired twice: the second reached the dedup check and wrote no matching-store row |
| `0.0.0.0` is treated as opt-out | Unit-tested in `test/beacon.test.ts` and fired at production: no identifier stored, `lmt` true, impression still counted |
| Unexpanded macro is not a fabricated opt-out | Unit-tested: `ifaPresent` false, `lmt` false, identifier discarded |
| Earlier tags no longer validate | `HMAC_SIGNING_KEY` rotated in production 2026-09-21; a tag signed with the prior key was rejected `bad_signature` in the worker tail |
| Signature valid to 2027-09-21 20:23 UTC | `exp=1821558200` |
| Collection is bounded to the flight window | Enforced server-side: a campaign with an elapsed `end` was fired at production and logged `reject outside_flight`. Covered by `test/beacon.test.ts` |
| Collection is bounded to the licensed market | A `country=GB` beacon on a US-licensed campaign logged `reject out_of_market` at production |
| HTTPS, single line, no spaces | Asserted in `test/sign-url.test.ts` against the real generator output |
| Only supported macros are emitted | `test/sign-url.test.ts` fails the build if `[[[RIDA]]]`, `[[[LMT]]]` or `[[[APPID]]]` reappear in a Roku tag |
| `200` returned for rejected requests | Fired a deliberately invalid signature at production: `HTTP 200`, `image/gif`, logged as `reject bad_signature` |
| 60–90s ingestion lag | Observed twice: a check at 20s showed nothing, at ~95s the row was present |
| Supported macro list | Roku, "Measuring Campaigns with Third Party Solutions", updated 2026-03-02, confirmed by Ads Manager support 2026-09-21 |
| `pixels.postbackx.com` was absent from the approved-domain list | Same article's approved-partner table. Roku has since said it is being added; **the written confirmation requested in §2 is what closes this** |
| IP identifies a household, not a device | NAT: all devices behind one router share a public IP. Dynamic reassignment and CGNAT are standard ISP practice |
| RIDA and LMT named in our Campaign Data | DSA cover page, quoted in `ROKU_DSA_GAP_ANALYSIS.md` §C |
| Tag freeze at certification | DSA §2(b)(2)–(3) |
| Precise geo as Sensitive Data | Ad Partner Data Processing Policy §5 |

**Open item not raised here:** the `Data Processing Flag` (DSA §15 definition,
§5) is the per-impression signal for Child-Directed Content. We have no field
for it and currently infer child-directed status from our own campaign
configuration, which does not satisfy §5. That request sits in the DSA email
rather than this one, because it needs the partnerships/legal thread, but it
remains a live compliance gap.
