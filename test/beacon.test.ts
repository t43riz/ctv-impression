import { describe, it, expect } from "vitest";
import {
  extractImpression,
  dedupKey,
  prevSaltDedupKey,
  nonAttributableDedupKey,
} from "../src/lib/beacon";
import { signMessage, hashIfa } from "../src/lib/crypto";
import type { Env, Impression } from "../src/types";

const KEY = "test-key";
const SALT = "test-salt";

function makeEnv(
  allowlisted: string[],
  signatureRequired = true,
  overrides: Partial<Record<string, string>> = {},
  campaignValues: Record<string, string> = {},
): Env {
  const store = new Map(allowlisted.map((c) => [`campaign:${c}`, campaignValues[c] ?? "active"]));
  return {
    HMAC_SIGNING_KEY: KEY,
    IFA_HASH_SALT: SALT,
    SIGNATURE_REQUIRED: signatureRequired ? "true" : "false",
    DEDUP_WINDOW_HOURS: "24",
    CAMPAIGNS: {
      get: async (k: string) => store.get(k) ?? null,
    } as unknown as KVNamespace,
    ...overrides,
  } as unknown as Env;
}

async function signedUrl(params: Record<string, string>, exp: number) {
  const sig = await signMessage(
    KEY,
    `${params.advertiser_id}|${params.campaign_id}|${params.creative_id}|${exp}`,
  );
  const sp = new URLSearchParams({ ...params, exp: String(exp), sig });
  return new URL(`https://t.example.com/pixel?${sp.toString()}`);
}

const cf = { country: "US" } as unknown as IncomingRequestCfProperties;
const NOW = 1_000;
const FUTURE = 2_000_000_000;

describe("extractImpression", () => {
  it("accepts a valid signed, allowlisted beacon and hashes IFA", async () => {
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: "dev-1", app_id: "app1" },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.impression.country).toBe("US");
      expect(res.impression.ifaPresent).toBe(true);
      expect(res.impression.ifaHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("rejects a non-allowlisted campaign", async () => {
    const env = makeEnv([]); // empty allowlist
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: "dev-1" },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res).toEqual({ ok: false, reason: "not_allowlisted" });
  });

  it("rejects missing/invalid required params", async () => {
    const env = makeEnv(["camp1"], false);
    const url = new URL("https://t.example.com/pixel?campaign_id=camp1");
    const res = await extractImpression(url, cf, env, NOW);
    expect(res).toEqual({ ok: false, reason: "missing_params" });
  });

  it("rejects a missing signature when required", async () => {
    const env = makeEnv(["camp1"]);
    const sp = new URLSearchParams({ advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1" });
    const url = new URL(`https://t.example.com/pixel?${sp.toString()}`);
    const res = await extractImpression(url, cf, env, NOW);
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("anonymizes IFA when LMT=1 (opt-out honored)", async () => {
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: "dev-1", lmt: "1" },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.impression.ifaPresent).toBe(false);
      expect(res.impression.ifaHash).toBe("anon");
    }
  });

  it("treats a zeroed IFA as opt-out", async () => {
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: "00000000-0000-0000-0000-000000000000" },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok && res.impression.ifaPresent).toBe(false);
  });

  it("treats an all-F GUID as unset rather than as a real device", async () => {
    // The unset sentinel is dashed, so a single-character-repeat test that sees
    // the raw string would not match it and every such beacon would be hashed
    // into one shared pseudo-device — collapsing them into a single impression.
    const env = makeEnv(["camp1"]);
    for (const sentinel of [
      "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
    ]) {
      const url = await signedUrl(
        { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: sentinel },
        FUTURE,
      );
      const res = await extractImpression(url, cf, env, NOW);
      expect(res.ok && res.impression.ifaPresent, sentinel).toBe(false);
      expect(res.ok && res.impression.ifaHash, sentinel).toBe("anon");
    }
  });

  it("still accepts a real identifier that merely repeats one character per group", async () => {
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: "aa11bb22-cc33-dd44-ee55-ff66aa77bb88" },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok && res.impression.ifaPresent).toBe(true);
  });

  it("falls back to XX for unknown geo", async () => {
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: "dev-1" },
      FUTURE,
    );
    const res = await extractImpression(url, undefined, env, NOW);
    expect(res.ok && res.impression.country).toBe("XX");
  });

  it("parses UA params: pf=ua, ifa_type, dotted app bundle", async () => {
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      {
        advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1",
        ifa: "dev-1", ifa_type: "RIDA", pf: "ua", app_id: "com.example.channel",
      },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.impression.platform).toBe("ua");
      expect(res.impression.ifaType).toBe("rida");
      expect(res.impression.appId).toBe("com.example.channel");
    }
  });

  it("defaults platform to roku and empty ifa_type", async () => {
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: "dev-1" },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok && res.impression.platform).toBe("roku");
    expect(res.ok && res.impression.ifaType).toBe("");
  });

  it("treats child_directed campaigns as LMT (COPPA)", async () => {
    const env = makeEnv(["camp_kids"], true, {}, { camp_kids: "child_directed" });
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp_kids", creative_id: "cre1", ifa: "dev-1", lmt: "0" },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.impression.ifaPresent).toBe(false);
      expect(res.impression.ifaHash).toBe("anon");
    }
  });
});

describe("prevSaltDedupKey (salt rotation)", () => {
  it("returns the previous-salt key during a rotation window", async () => {
    const env = makeEnv(["camp1"], true, { IFA_HASH_SALT_PREV: "old-salt" });
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: "dev-1" },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const alt = await prevSaltDedupKey(env, url, res.impression);
    const expectedHash = await hashIfa("old-salt", "dev-1");
    expect(alt).toBe(`${expectedHash}|camp1|cre1`);
  });

  it("returns null without a previous salt or for non-attributable impressions", async () => {
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: "dev-1" },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(await prevSaltDedupKey(env, url, res.impression)).toBeNull();
  });
});

describe("dedupKey", () => {
  it("returns null for non-attributable impressions", () => {
    expect(
      dedupKey({
        advertiserId: "a", campaignId: "c", creativeId: "cr",
        ifaHash: "anon", ifaPresent: false, lmt: true, appId: "app", country: "US",
        ifaType: "", platform: "roku",
      }),
    ).toBeNull();
  });

  it("builds a key from ifaHash without raw identifiers", () => {
    const k = dedupKey({
      advertiserId: "a", campaignId: "c", creativeId: "cr",
      ifaHash: "abc123", ifaPresent: true, lmt: false, appId: "app", country: "US",
      ifaType: "", platform: "roku",
    });
    expect(k).toBe("abc123|c|cr");
  });
});

describe("unexpanded ad-server macros", () => {
  const MACRO_IFA = "[[[RIDA]]]";

  it("does not treat an unexpanded Roku RAF macro as a device identifier", async () => {
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: MACRO_IFA },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.impression.ifaPresent).toBe(false);
      expect(res.impression.ifaHash).toBe("anon");
    }
  });

  it("gives every macro-polluted beacon the same non-identifier, not one shared device", async () => {
    const env = makeEnv(["camp1"]);
    const a = await extractImpression(
      await signedUrl({ advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: MACRO_IFA }, FUTURE),
      cf, env, NOW,
    );
    const b = await extractImpression(
      await signedUrl({ advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: MACRO_IFA }, FUTURE),
      cf, env, NOW,
    );
    if (!a.ok || !b.ok) throw new Error("expected ok");
    // Neither is attributable, and crucially neither yields a dedup key that
    // would collapse all macro traffic into a single pseudo-device.
    expect(a.impression.ifaPresent).toBe(false);
    expect(dedupKey(a.impression)).toBeNull();
    expect(dedupKey(b.impression)).toBeNull();
  });

  it("does not treat an unexpanded IAB/VAST macro as an identifier", async () => {
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      {
        advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1",
        ifa: "[IFA]", ifa_type: "[IFATYPE]", pf: "ua",
      },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.impression.ifaPresent).toBe(false);
      expect(res.impression.ifaType).toBe("");
    }
  });

  it("fails closed when the LMT macro did not expand", async () => {
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      {
        advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1",
        ifa: "dev-1", lmt: "[[[LMT]]]",
      },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) {
      // An unreadable opt-out signal must never be read as consent.
      expect(res.impression.ifaPresent).toBe(false);
      expect(res.impression.ifaHash).toBe("anon");
    }
  });

  it("still accepts a real UUID-shaped IFA", async () => {
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      {
        advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1",
        ifa: "8f14e45f-ceea-467a-9e4e-1c0f1a2b3c4d", lmt: "0",
      },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok && res.impression.ifaPresent).toBe(true);
  });

  it("treats a bare '-' as an unresolved macro, not a device identifier", async () => {
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: "-" },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    // "-" is a null sentinel emitted when an ad-server macro failed to expand.
    // Hashing it would mint one shared pseudo-device for every affected beacon.
    expect(res.ok && res.impression.ifaPresent).toBe(false);
    expect(res.ok && res.impression.ifaHash).toBe("anon");
  });
});

describe("placeholder configuration", () => {
  const PLACEHOLDER = "0".repeat(64);

  it("refuses tagged traffic when the signing key is still a placeholder", async () => {
    const env = makeEnv(["camp1"], true, { HMAC_SIGNING_KEY: PLACEHOLDER });
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: "dev-1" },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res).toEqual({ ok: false, reason: "not_configured" });
  });

  it("anonymizes every IFA when the hash salt is still a placeholder", async () => {
    const env = makeEnv(["camp1"], true, { IFA_HASH_SALT: "1".repeat(64) });
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: "dev-1" },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok).toBe(true);
    // Counting still works; a weakly-salted hash is never stored.
    if (res.ok) expect(res.impression.ifaHash).toBe("anon");
  });
});

describe("ifa_type reporting", () => {
  it("keeps reporting ifa_type under LMT so platform mix stays measurable", async () => {
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      {
        advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1",
        ifa: "dev-1", lmt: "1", ifa_type: "rida", pf: "ua",
      },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.impression.ifaPresent).toBe(false);
      expect(res.impression.ifaType).toBe("rida");
    }
  });
});

describe("nonAttributableDedupKey", () => {
  const imp: Impression = {
    advertiserId: "a", campaignId: "c", creativeId: "cr",
    ifaHash: "anon", ifaPresent: false, lmt: true, appId: "app", country: "US",
    ifaType: "", platform: "roku",
  };

  it("caps frequency for non-attributable traffic without storing an identifier", async () => {
    const env = makeEnv(["c"]);
    const k = await nonAttributableDedupKey(env, imp, "203.0.113.9", 10_000, true);
    expect(k).not.toBeNull();
    // Same device, same hour, same creative => same key.
    expect(await nonAttributableDedupKey(env, imp, "203.0.113.9", 10_000, true)).toBe(k);
    // Raw IP must not appear in the key.
    expect(k?.includes("203.0.113.9")).toBe(false);
    // Different hour bucket rotates the key.
    expect(await nonAttributableDedupKey(env, imp, "203.0.113.9", 14_000, true)).not.toBe(k);
    // Different device differs.
    expect(await nonAttributableDedupKey(env, imp, "203.0.113.10", 10_000, true)).not.toBe(k);
  });

  it("returns null when disabled or when the IP is unknown", async () => {
    const env = makeEnv(["c"]);
    expect(await nonAttributableDedupKey(env, imp, "203.0.113.9", 10_000, false)).toBeNull();
    expect(await nonAttributableDedupKey(env, imp, "", 10_000, true)).toBeNull();
  });

  it("never collides with an attributable key namespace", async () => {
    const env = makeEnv(["c"]);
    const attributable = await hashIfa(env.IFA_HASH_SALT, "203.0.113.9");
    const nonAttr = await nonAttributableDedupKey(env, imp, "203.0.113.9", 10_000, true);
    expect(nonAttr).not.toBe(`${attributable}|c|cr`);
  });

  it("ignores a placeholder IP_CAP_SALT rather than pepper with it", async () => {
    // Every other secret refuses its shipped placeholder. This one silently
    // accepted it, so a deploy that set the example value got a pepper that is
    // public knowledge — and the fallback it was meant to improve on is safer.
    const placeholder = "3".repeat(64);
    const withPlaceholder = makeEnv(["c"]);
    (withPlaceholder as { IP_CAP_SALT?: string }).IP_CAP_SALT = placeholder;
    const fallback = makeEnv(["c"]);

    expect(
      await nonAttributableDedupKey(withPlaceholder, imp, "203.0.113.9", 10_000, true),
    ).toBe(await nonAttributableDedupKey(fallback, imp, "203.0.113.9", 10_000, true));
  });

  it("uses a real IP_CAP_SALT so rotating IFA_HASH_SALT leaves the cap intact", async () => {
    const dedicated = makeEnv(["c"]);
    (dedicated as { IP_CAP_SALT?: string }).IP_CAP_SALT = "a-real-dedicated-ip-cap-salt";
    const rotated = makeEnv(["c"]);
    (rotated as { IP_CAP_SALT?: string }).IP_CAP_SALT = "a-real-dedicated-ip-cap-salt";
    (rotated as { IFA_HASH_SALT: string }).IFA_HASH_SALT = "rotated-ifa-salt";

    // The IFA salt rotated; the frequency-cap bucket must not move with it.
    expect(await nonAttributableDedupKey(rotated, imp, "203.0.113.9", 10_000, true)).toBe(
      await nonAttributableDedupKey(dedicated, imp, "203.0.113.9", 10_000, true),
    );
  });
});
