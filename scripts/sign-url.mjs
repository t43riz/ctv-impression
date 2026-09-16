#!/usr/bin/env node
/**
 * Generate a signed /v1/pixel tag URL for a campaign/creative.
 *
 * Usage:
 *   HMAC_SIGNING_KEY=... node scripts/sign-url.mjs \
 *     --base https://pixels.postbackx.com \
 *     --advertiser adv1 --campaign camp1 --creative cre1 \
 *     --ttl 2592000 [--platform roku|ua]
 *
 * The printed URL embeds platform macros for runtime params (ifa, app_id,
 * etc.) and an `exp`+`sig` that the Worker verifies. `exp`/`sig` are fixed at
 * generation time, so set --ttl to the campaign flight length.
 *
 * Platforms:
 *   roku (default) — Roku RAF macros [[[RIDA]]] etc. (docs/ROKU_IMPRESSION_TAG.md)
 *   ua             — IAB/VAST macros [IFA] etc. for Universal Ads / FreeWheel
 *                    (docs/UA_IMPRESSION_TAG.md; confirm exact tokens with UA)
 */
import { createHmac } from "node:crypto";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const key = process.env.HMAC_SIGNING_KEY;
if (!key) {
  console.error("Set HMAC_SIGNING_KEY env var.");
  process.exit(1);
}

const base = arg("base", "https://pixels.postbackx.com");
const advertiser = arg("advertiser", "ADVERTISER");
const campaign = arg("campaign");
const creative = arg("creative");
const ttl = Number(arg("ttl", "2592000")); // default 30 days
const platform = arg("platform", "roku");

if (!campaign || !creative) {
  console.error("--campaign and --creative are required.");
  process.exit(1);
}
if (platform !== "roku" && platform !== "ua") {
  console.error("--platform must be 'roku' or 'ua'.");
  process.exit(1);
}

const exp = Math.floor(Date.now() / 1000) + ttl;
// Must match `verifyTagSignature` in src/lib/crypto.ts exactly: the advertiser
// is bound so a captured tag URL cannot be re-pointed at another advertiser.
const sig = createHmac("sha256", key)
  .update(`${advertiser}|${campaign}|${creative}|${exp}`)
  .digest("hex");

const params = new URLSearchParams({
  advertiser_id: advertiser,
  campaign_id: campaign,
  creative_id: creative,
  exp: String(exp),
  sig,
});
if (platform === "ua") params.set("pf", "ua");

// Append macro placeholders raw (URLSearchParams would percent-encode brackets).
// Roku: RAF macros. UA: IAB/VAST tokens (confirm exact tokens with UA and
// regenerate if they differ).
const macroTail =
  platform === "ua"
    ? "&ifa=[IFA]" +
      "&ifa_type=[IFATYPE]" +
      "&lmt=[LIMITADTRACKING]" +
      "&app_id=[APPBUNDLE]" +
      "&cb=[CACHEBUSTING]"
    : // Roku's identifier is always a RIDA, so the namespace is a constant here
      // rather than a macro (RAF has no ifa_type token). Without it the column
      // is empty and platform mix is unmeasurable. Verified against production:
      // the signature does not cover ifa_type, so adding it does not
      // invalidate a tag.
      "&ifa=[[[RIDA]]]" +
      "&ifa_type=rida" +
      "&lmt=[[[LMT]]]" +
      "&app_id=[[[APPID]]]" +
      "&cb=[[[CACHEBUSTER]]]";

// Emits the canonical versioned path. The signed message is
// `advertiser|campaign|creative|exp` (src/lib/crypto.ts) and does not cover the
// path, so tags already issued against "/pixel" keep verifying — that path
// stays served as a permanent alias.
console.log(`${base}/v1/pixel?${params.toString()}${macroTail}`);
