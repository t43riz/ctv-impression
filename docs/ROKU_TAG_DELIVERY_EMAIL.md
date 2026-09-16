# Roku tag delivery email

Ready to send. Operational email that hands Roku the impression tag and asks the
two questions that gate it.

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
**Subject:** UDONIS d.o.o. — third-party impression tag for testing + two setup questions (vendor domain, RIDA/LMT macros)

---

Hi &lt;name&gt;,

We have our impression endpoint built and running, and we'd like to get it
tested against a live creative. The tag is below, along with two questions we
need answered before it can serve.

## 1. The tag

```
https://pixels.postbackx.com/v1/pixel?advertiser_id=adv_udonis&campaign_id=camp_roku_test&creative_id=cre_roku_cert&exp=1805121458&sig=3983d8b1fdd329a265499edd5868b182c5d0267c282a372b94ed6777a378b4b8&ifa=[[[RIDA]]]&ifa_type=rida&lmt=[[[LMT]]]&app_id=[[[APPID]]]&cb=[[[CACHEBUSTER]]]
```

HTTPS, single line, no spaces. The signature is valid through **2027-03-15
14:37 UTC**; tell us the campaign flight dates and we'll reissue with a matching
expiry.

We fired this end to end on 2026-09-16 and confirmed it was recorded as a
counted impression on our side, with the device identifier, app ID and country
all landing correctly.

**Two notes if you test it yourselves:**

- **A `200` response does not confirm an impression was counted.** The endpoint
  returns `200` and a 1×1 GIF for *every* request, including ones it rejects.
  That is deliberate: the beacon must never leak validation state back to the
  device. If you fire the tag and want confirmation it counted, tell us roughly
  when and we'll confirm from our side.
- **Allow 60–90 seconds.** Our analytics ingestion is not instant, so an
  immediate check can show nothing even on a successful fire.

## 2. Is `pixels.postbackx.com` approvable as a vendor domain?

Your "Measuring Campaigns with Third Party Solutions" article lists approved
provider domains and states that only tags from those providers on those domains
are accepted. `pixels.postbackx.com` isn't on that list, and the article points
here for adding a new approved vendor.

So: what do you need from us to get `pixels.postbackx.com` approved? Happy to
provide whatever technical or security detail helps. We'd rather start this now
than discover it at creative review.

For context on the stack: the endpoint is a Cloudflare Worker, and Cloudflare is
the only subprocessor that touches Roku data. We're raising Pre-Approved Vendor
confirmation separately under DPP §11 with the partnerships team, so feel free
to route this part to whoever owns that.

## 3. Are `[[[RIDA]]]`, `[[[LMT]]]` and `[[[APPID]]]` available to us?

This is the one that materially changes what we can deliver.

The macro list in that same article covers `[[[ADVERTISERID]]]`,
`[[[CAMPAIGNID]]]`, `[[[CREATIVEID]]]`, `[[[CREATIVEID_URL]]]`,
`[[[DEVICE_IP]]]`, `[[[CACHEBUSTER]]]`, `[[[COUNTRY]]]`, `[[[METRO_CODE]]]` and
`[[[POSTAL_CODE]]]`. `[[[RIDA]]]`, `[[[LMT]]]` and `[[[APPID]]]` are not on it,
but the tag above uses all three, and RIDA and Limit Ad Tracking signals are
both named in the Campaign Data list on our Advertising Data Partner Agreement
cover page.

We tested what happens when those macros don't resolve. The impression is still
counted correctly, and we deliberately refuse to treat an unsubstituted macro as
a device identifier, so there's no risk of corrupt data. But the impression is
recorded with no device identifier, which removes device-level attribution
entirely.

Three possible answers, all workable, we just need to know which:

1. **They're supported** for third-party impression tags on our account, and the
   tag above is complete as-is.
2. **The tokens differ.** Send us the exact strings and we'll reissue the tag the
   same day. Our signature doesn't cover the macro portion of the URL, so this is
   a fast change.
3. **They're not available** to third-party impression tags. Then we'd switch to
   `[[[DEVICE_IP]]]` and `[[[METRO_CODE]]]` from the supported list and set
   expectations accordingly.

If option 3, we'd also want to confirm whether `[[[POSTAL_CODE]]]` is something
you'd expect a measurement partner to collect. We've held off on it because the
Data Processing Policy treats precise geo-location as Sensitive Data, and we'd
rather not carry that ambiguity.

## 4. What we're asking for

- Confirmation on the vendor domain (item 2) and the macros (item 3)
- The pixel certification / QA checklist referenced at §2(b)(2) of our
  agreement — since §2(b)(3) freezes the tag once certified, we'd like the
  checklist before we finalize the URL
- A creative to attach the tag to for a live test, whenever it suits you

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
| Tag records a counted impression | Fired 2026-09-16 18:41 UTC; `ingest_recon` returned `received` then `counted`, and `impression_events` recorded `ifa_present=1`, `ifa_type=rida`, `app_id=12345`, `country=US` |
| Signature valid to 2027-03-15 14:37 UTC | `exp=1805121458`, 179 days remaining at time of writing |
| HTTPS, single line, no spaces | Roku's stated tag requirements; checked against the string |
| `200` returned for rejected requests | Fired a deliberately invalid signature at production: `HTTP 200`, `image/gif`, recorded as `reject_bad_signature` |
| 60–90s ingestion lag | Observed twice: a check at 20s showed nothing, at ~95s the row was present |
| Supported macro list | Roku, "Measuring Campaigns with Third Party Solutions", updated 2026-03-02 |
| `pixels.postbackx.com` absent from approved domains | Same article's approved-partner table |
| Unresolved macros still count, without an identifier | Fired the tag with `[[[RIDA]]]`/`[[[LMT]]]`/`[[[APPID]]]` unsubstituted: counted, with `ifa_present=0`, `app_id='unknown'`, hash `anon` |
| RIDA and LMT named in our Campaign Data | DSA cover page, quoted in `ROKU_DSA_GAP_ANALYSIS.md` §C |
| Tag freeze at certification | DSA §2(b)(2)–(3) |
| Precise geo as Sensitive Data | Ad Partner Data Processing Policy §5 |

**Open item not raised here:** the `Data Processing Flag` (DSA §15 definition,
§5) is the per-impression signal for Child-Directed Content. We have no field
for it and currently infer child-directed status from our own campaign
configuration, which does not satisfy §5. That request sits in the DSA email
rather than this one, because it needs the partnerships/legal thread, but it
remains a live compliance gap.
