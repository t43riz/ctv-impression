# Register Roku tracking numbers by Roku creative ID

Instructions for registering each Roku Ads Manager creative's phone number so
inbound calls are matched against that creative's impressions only.

## Background (read first)

- Every Roku Ads Manager campaign uses **one shared signed tag**, so the tag's
  own `creative_id` (`cre_roku_cert`) is identical for every creative.
- Roku fills in its **native creative ID** on each impression through the tag's
  `roku_creative_id=%ecid!` macro. Since deploy `81766f3` (2026-11-12),
  impressions are filed for call matching under `roku-creative:<Roku creative ID>`.
- A tracking number is matched only against the creative named in its
  registry entry's `rokuCreativeId`. Without `rokuCreativeId`, a Roku number
  only matches impressions whose Roku macro did not expand, which is almost
  certainly wrong.

## Hard rules

1. **Do not change the impression tag.** The signature covers the advertiser,
   campaign, creative and expiry. Editing any value before `sig` stops the tag
   counting.
2. **One number → one Roku creative.** A number must appear only in that
   creative and only on Roku (not on Samsung, linear TV, or the web).
   Otherwise calls can't be attributed to the creative.
3. **Don't touch the `CAMPAIGNS` namespace** or any other config. Only write
   `NUMBERS` keys.
4. **Don't delete registry entries.** When a creative ends, leave its entry in
   place: late calls still arrive. Ask the owner before removing anything.
5. **Production only:** always pass `--env production`. The project uses
   Wrangler 3.x, where `kv` commands write to the remote (live) namespace by
   default. The production `NUMBERS` namespace ID is
   `08295a39c4414ff1a8490edeb645cb4d`.

## Step 1: Get the Roku creative IDs

Get each creative's ID from **Roku Ads Manager** (the creative's ID in the
campaign). Then confirm it is the value Roku actually sends in impressions. An
ID that never appears in impressions will never match a call.

Confirm with Workers Analytics Engine (account `3511194edb891ad4725cd2065c4c5cc1`):

```sql
SELECT blob11 AS roku_advertiser_id,
       blob12 AS roku_campaign_id,
       blob13 AS roku_creative_id,
       sum(_sample_interval) AS impressions,
       max(timestamp) AS last_seen
FROM impression_events
WHERE timestamp > NOW() - INTERVAL '30' DAY
  AND blob9 = 'roku'
GROUP BY roku_advertiser_id, roku_campaign_id, roku_creative_id
ORDER BY impressions DESC
```

Send it with `POST /accounts/<account>/analytics_engine/sql`, `Content-Type: text/plain`.
Always use `sum(_sample_interval)`, never `count()`.

**Ignore these test values:** `verify_capture`, `verify_deploy_b39e84f`,
`verify_rokucre_81766f3`, `roku-test-*`, and rows where the advertiser and
campaign are `0` (browser test fires). A blank `roku_creative_id` means the
macro didn't expand, and those impressions can't be matched by creative.

The only real ID seen as of 2026-11-12 is `138618142935` (Roku advertiser
`46530509`, campaign `3118495809`, served on 2026-10-05). New campaigns' IDs
appear here once they start serving.

## Step 2: Build each registry entry

| Field | Value | Rule |
|---|---|---|
| key | `number:+1XXXXXXXXXX` | Exactly as Sparrow stores it (`tracking_numbers.phone_number`, E.164 with `+`). The lookup is an exact string match with no reformatting. |
| `rokuCreativeId` | Roku creative ID, e.g. `138618142935` | **Required for Roku.** `^[A-Za-z0-9_-]{1,64}$` |
| `creativeId` | `roku_<Roku creative ID>` | Internal label, sent as the conversion's content ID. Same pattern. |
| `campaignId` | `roku_<Roku campaign ID>` | Labels call outcomes by campaign. Same pattern. |
| `advertiserId` | `adv_udonis` | Same pattern. |
| `platform` | `"roku"` | Must be `roku` or `ua`. |
| `qualifySeconds` | omit, or e.g. `60` | Optional. A number from 0 to 86400. Omit to use the default (60 s). |

An entry that fails these rules is not skipped silently: every call to that
number is refused with `bad_number_mapping`. Validate before writing.

## Step 3: Validate, then write

Validate the JSON locally (mirrors `isValidNumberMapping` in `src/call.ts`):

```bash
ENTRY='{"creativeId":"roku_138618142935","campaignId":"roku_3118495809","advertiserId":"adv_udonis","platform":"roku","rokuCreativeId":"138618142935"}'
node -e '
const m = JSON.parse(process.argv[1]); const id = /^[A-Za-z0-9_-]{1,64}$/;
const ok = id.test(m.creativeId ?? "") && id.test(m.rokuCreativeId ?? "")
  && (m.campaignId === undefined || id.test(m.campaignId))
  && (m.advertiserId === undefined || id.test(m.advertiserId))
  && (m.platform === undefined || ["roku","ua"].includes(m.platform))
  && (m.qualifySeconds === undefined || (Number.isFinite(m.qualifySeconds) && m.qualifySeconds >= 0 && m.qualifySeconds <= 86400));
console.log(ok ? "VALID" : "INVALID"); process.exit(ok ? 0 : 1);' "$ENTRY"
```

Write it (run from the repo root, `/Users/riz/ctv-impression`):

```bash
WRANGLER_SEND_METRICS=false npx wrangler kv key put \
  --binding NUMBERS --env production \
  "number:+1XXXXXXXXXX" "$ENTRY"
```

## Step 4: Verify

```bash
WRANGLER_SEND_METRICS=false npx wrangler kv key list --binding NUMBERS --env production
WRANGLER_SEND_METRICS=false npx wrangler kv key get --binding NUMBERS --env production "number:+1XXXXXXXXXX"
```

Confirm that each key exists and its value parses to the intended entry.

**Calls can't confirm it end to end yet.** Sparrow doesn't send calls to the
tracker yet, so verification stops at the registry. Don't place test calls
expecting a match.

## Report back

For each number, report the number, the Roku creative ID, the Roku campaign ID,
whether that creative ID appeared in the impression query (yes/no, with the
impression count), and the `kv key get` output.
