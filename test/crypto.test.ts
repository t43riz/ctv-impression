import { describe, it, expect } from "vitest";
import {
  signMessage,
  verifyTagSignature,
  hashIfa,
  isPlaceholderSecret,
  verifyTimestampedSignature,
} from "../src/lib/crypto";

const KEY = "test-key-0123456789";
const SALT = "test-salt-abcdef";

/** The canonical signed message for a tag URL. */
const tagMessage = (advertiser: string, campaignId: string, creativeId: string, exp: number) =>
  `${advertiser}|${campaignId}|${creativeId}|${exp}`;

describe("HMAC tag signatures", () => {
  it("verifies a valid signature before expiry", async () => {
    const exp = 2_000_000_000; // far future
    const sig = await signMessage(KEY, tagMessage("adv1", "camp1", "cre1", exp));
    const res = await verifyTagSignature(KEY, "adv1", "camp1", "cre1", exp, sig, 1_000);
    expect(res.ok).toBe(true);
  });

  it("rejects an expired signature", async () => {
    const exp = 1_000; // past
    const sig = await signMessage(KEY, tagMessage("adv1", "camp1", "cre1", exp));
    const res = await verifyTagSignature(KEY, "adv1", "camp1", "cre1", exp, sig, 2_000);
    expect(res).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a tampered campaign id (repointing attack)", async () => {
    const exp = 2_000_000_000;
    const sig = await signMessage(KEY, tagMessage("adv1", "camp1", "cre1", exp));
    const res = await verifyTagSignature(KEY, "adv1", "EVIL", "cre1", exp, sig, 1_000);
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a swapped advertiser id, so counts cannot be re-credited", async () => {
    // The tag URL is public (it is the ad markup), so the advertiser has to be
    // inside the signed message or anyone who saw the tag could re-point the
    // beacon at another advertiser.
    const exp = 2_000_000_000;
    const sig = await signMessage(KEY, tagMessage("adv1", "camp1", "cre1", exp));
    const res = await verifyTagSignature(KEY, "someone-else", "camp1", "cre1", exp, sig, 1_000);
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("binds the fields in a way that cannot be re-split", async () => {
    // `adv|camp` + `cre` must not verify as `adv` + `camp|cre`.
    const exp = 2_000_000_000;
    const sig = await signMessage(KEY, tagMessage("adv|camp1", "cre1", "x", exp));
    const res = await verifyTagSignature(KEY, "adv", "camp1", "cre1", exp, sig, 1_000);
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a bad signature", async () => {
    const res = await verifyTagSignature(
      KEY,
      "adv1",
      "camp1",
      "cre1",
      2_000_000_000,
      "deadbeef",
      1_000,
    );
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("IFA hashing", () => {
  it("is deterministic and salted", async () => {
    const a = await hashIfa(SALT, "device-123");
    const b = await hashIfa(SALT, "device-123");
    const c = await hashIfa("other-salt", "device-123");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not leak the raw ifa", async () => {
    const h = await hashIfa(SALT, "secret-device");
    expect(h.includes("secret-device")).toBe(false);
  });
});

describe("placeholder detection", () => {
  it("flags the values shipped in .dev.vars.example", () => {
    expect(isPlaceholderSecret("0".repeat(64))).toBe(true);
    expect(isPlaceholderSecret("1".repeat(64))).toBe(true);
    expect(isPlaceholderSecret("2".repeat(64))).toBe(true);
    expect(isPlaceholderSecret("3".repeat(64))).toBe(true);
    expect(isPlaceholderSecret("REPLACE_WITH_EVENT_GROUP_ID")).toBe(true);
    expect(isPlaceholderSecret("your-analytics-read-token")).toBe(true);
  });

  it("flags missing and empty secrets", () => {
    expect(isPlaceholderSecret(undefined)).toBe(true);
    expect(isPlaceholderSecret(null)).toBe(true);
    expect(isPlaceholderSecret("")).toBe(true);
    expect(isPlaceholderSecret("   ")).toBe(true);
  });

  it("accepts a real secret", () => {
    expect(isPlaceholderSecret("9f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f")).toBe(false);
  });
});

describe("timestamped webhook signatures", () => {
  const KEY = "call-hmac-key";
  const BODY = JSON.stringify({ callId: "c1" });
  const TS = "1700000000";
  const NOW = 1_700_000_010;

  it("accepts a fresh, correctly signed payload", async () => {
    const sig = await signMessage(KEY, `${TS}.${BODY}`);
    const res = await verifyTimestampedSignature(KEY, TS, BODY, sig, NOW, 300);
    expect(res.ok).toBe(true);
  });

  it("rejects a replayed payload once the timestamp is stale", async () => {
    const sig = await signMessage(KEY, `${TS}.${BODY}`);
    const res = await verifyTimestampedSignature(KEY, TS, BODY, sig, NOW + 3600, 300);
    expect(res).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a body-only signature (no timestamp binding)", async () => {
    const sig = await signMessage(KEY, BODY);
    const res = await verifyTimestampedSignature(KEY, TS, BODY, sig, NOW, 300);
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered timestamp even when the body is signed", async () => {
    const sig = await signMessage(KEY, `${TS}.${BODY}`);
    const res = await verifyTimestampedSignature(KEY, "1700000001", BODY, sig, NOW, 300);
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a missing timestamp or signature", async () => {
    const sig = await signMessage(KEY, `${TS}.${BODY}`);
    expect(await verifyTimestampedSignature(KEY, "", BODY, sig, NOW, 300)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await verifyTimestampedSignature(KEY, TS, BODY, "", NOW, 300)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });
});
