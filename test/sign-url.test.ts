import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { verifyTagSignature } from "../src/lib/crypto";

/**
 * The tag generator and the Worker's verifier are two separate HMAC
 * implementations: `scripts/sign-url.mjs` uses `node:crypto`, while
 * `verifyTagSignature` uses WebCrypto in the Worker runtime. Nothing forces
 * them to agree, and the failure mode when they disagree is nasty — the
 * generator emits a URL that looks correct, Roku fires it, the beacon returns
 * a 200 GIF because the pixel must always render, and the impression is
 * silently rejected as `reject_bad_signature`.
 *
 * These tests run the real script and hand its output to the real verifier, so
 * signing-message drift (field order, separator, advertiser binding, the
 * `exp` arithmetic) fails here instead of during certification.
 */

// Resolved from the vitest root rather than import.meta.url: the project
// compiles against @cloudflare/workers-types, whose global `URL` is not
// assignable to the one `node:url` expects.
const SCRIPT = resolve(process.cwd(), "scripts/sign-url.mjs");
// Deliberately not hex-shaped: a 64-char hex literal here is indistinguishable
// from a real signing key to a secret scanner. The HMAC accepts any string.
const KEY = "not-a-real-key-for-signer-interop-tests-only";

// The project compiles against @cloudflare/workers-types, whose global `URL`
// differs from Node's, so the parsed tag is reduced to plain strings rather
// than typed as either runtime's URL.
function sign(args: string[], key = KEY): { pathname: string; params: Record<string, string> } {
  const out = execFileSync("node", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, HMAC_SIGNING_KEY: key },
  }).trim();
  // Macro placeholders are appended raw and are not URL-legal, so strip them
  // before parsing; the signed fields all live before that tail.
  const [head, query = ""] = out.split("&ifa=")[0].split("?");
  const params: Record<string, string> = {};
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq > 0) params[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  return { pathname: head.replace(/^https?:\/\/[^/]+/, ""), params };
}

const baseArgs = [
  "--base",
  "https://pixels.example",
  "--advertiser",
  "adv_udonis",
  "--campaign",
  "camp_roku_test",
  "--creative",
  "cre_roku_cert",
  "--ttl",
  "3600",
];

describe("sign-url.mjs interoperates with the Worker verifier", () => {
  it("produces a signature the Worker accepts", async () => {
    const url = sign(baseArgs);
    const exp = Number(url.params.exp);
    const sig = url.params.sig ?? "";
    const now = Math.floor(Date.now() / 1000);

    const res = await verifyTagSignature(
      KEY,
      url.params.advertiser_id ?? "",
      url.params.campaign_id ?? "",
      url.params.creative_id ?? "",
      exp,
      sig,
      now,
    );

    expect(res).toEqual({ ok: true });
    // `exp` must be unix SECONDS, and must honour --ttl. A millisecond value
    // still signs and still verifies — it just expires ~57000 years out, so a
    // tag that should have lapsed after an hour never does. Asserting the
    // window lands where --ttl put it (allowing a second of clock drift) is
    // what distinguishes the two units.
    expect(exp).toBeGreaterThan(now);
    expect(exp).toBeLessThanOrEqual(now + 3600);
    expect(exp).toBeGreaterThanOrEqual(now + 3600 - 5);
  });

  it("emits the canonical versioned path", () => {
    // DSA §2(b)(3) freezes the beacon URL at certification, so the generator
    // must hand out the versioned path rather than the legacy alias.
    expect(sign(baseArgs).pathname).toBe("/v1/pixel");
  });

  it("binds the signature to the advertiser", async () => {
    // A tag URL is public (it is the ad markup), so without this binding
    // anyone who saw a tag could re-point beacons at another advertiser.
    const url = sign(baseArgs);
    const res = await verifyTagSignature(
      KEY,
      "someone-else",
      url.params.campaign_id ?? "",
      url.params.creative_id ?? "",
      Number(url.params.exp),
      url.params.sig ?? "",
      Math.floor(Date.now() / 1000),
    );
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("does not verify under a different signing key", async () => {
    // Guards the test itself: if verification passed with the wrong key, the
    // assertions above would prove nothing about the signature.
    const url = sign(baseArgs);
    const res = await verifyTagSignature(
      "a-completely-different-key",
      url.params.advertiser_id ?? "",
      url.params.campaign_id ?? "",
      url.params.creative_id ?? "",
      Number(url.params.exp),
      url.params.sig ?? "",
      Math.floor(Date.now() / 1000),
    );
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });
});
