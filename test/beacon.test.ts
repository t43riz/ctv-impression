import { describe, it, expect } from "vitest";
import {
  extractImpression,
  dedupKey,
  prevSaltDedupKey,
  nonAttributableDedupKey,
  parseCampaignConfig,
  licensedMarkets,
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
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: "dev-1", app_id: "app1", pf: "ua" },
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
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: "aa11bb22-cc33-dd44-ee55-ff66aa77bb88", pf: "ua" },
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

  it("counts an unknown-country beacon by default but rejects it when configured", async () => {
    // A US-only buy that sees "XX" is far more likely to have lost the COUNTRY
    // macro than to be genuine foreign delivery, so the default counts it.
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: "dev-1", pf: "ua" },
      FUTURE,
    );
    expect((await extractImpression(url, undefined, makeEnv(["camp1"]), NOW)).ok).toBe(true);

    const strict = makeEnv(["camp1"], true, { REJECT_UNKNOWN_MARKET: "true" });
    const res = await extractImpression(url, undefined, strict, NOW);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toBe("out_of_market");
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

  it("defaults platform to roku and labels the identity namespace 'ip'", async () => {
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", device_ip: "203.0.113.7" },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok && res.impression.platform).toBe("roku");
    // Roku Ads Manager exposes no advertising ID, so identity is the hashed
    // device IP and the namespace says so rather than claiming "rida".
    expect(res.ok && res.impression.ifaType).toBe("ip");
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

describe("Roku Ads Manager identity (DEVICE_IP)", () => {
  it("stores all Roku macro fields without changing the signed tracking identity", async () => {
    const env = makeEnv(["camp1"]);
    const url = await signedUrl({
      advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1",
      device_ip: "203.0.113.7", country: "US", dma: "501",
      roku_advertiser_id: "roku-adv", roku_campaign_id: "roku-camp",
      roku_creative_id: "roku-creative", roku_postal_code: "90210",
      cb: "cache-123",
    }, FUTURE);
    // The encoded macro may contain a literal '+'. URLSearchParams would turn
    // that into a space, silently corrupting the original Roku UID.
    url.search += "&roku_creative_id_encoded=abc+def/==";
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.impression).toMatchObject({
      advertiserId: "adv1", campaignId: "camp1", creativeId: "cre1",
      rokuAdvertiserId: "roku-adv", rokuCampaignId: "roku-camp",
      rokuCreativeId: "roku-creative", rokuCreativeIdEncoded: "abc+def/==",
      rokuPostalCode: "90210", rokuCachebuster: "cache-123",
    });
  });

  it("does not store unresolved Roku UID, postal or cachebuster macros", async () => {
    const url = await signedUrl({
      advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1",
      roku_advertiser_id: "[[[ADVERTISERID]]]",
      roku_campaign_id: "[[[CAMPAIGNID]]]",
      roku_creative_id: "[[[CREATIVEID_URL]]]",
      roku_creative_id_encoded: "[[[CREATIVEID]]]",
      roku_postal_code: "[[[POSTAL_CODE]]]",
      cb: "[[[CACHEBUSTER]]]",
    }, FUTURE);
    const res = await extractImpression(url, cf, makeEnv(["camp1"]), NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.impression).toMatchObject({
      rokuAdvertiserId: "", rokuCampaignId: "", rokuCreativeId: "",
      rokuCreativeIdEncoded: "", rokuPostalCode: "", rokuCachebuster: "",
    });
  });

  it("discards precise postal location on opted-out Roku impressions", async () => {
    const url = await signedUrl({
      advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1",
      device_ip: "0.0.0.0", roku_postal_code: "90210",
    }, FUTURE);
    const res = await extractImpression(url, cf, makeEnv(["camp1"]), NOW);
    expect(res.ok && res.impression.rokuPostalCode).toBe("");
  });

  it("isolates deduplication across Roku campaigns sharing one signed tag", async () => {
    const url = await signedUrl({
      advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1",
      device_ip: "203.0.113.7", roku_campaign_id: "roku-camp-a",
      roku_creative_id: "roku-creative",
    }, FUTURE);
    const env = makeEnv(["camp1"]);
    const first = await extractImpression(url, cf, env, NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    url.searchParams.set("roku_campaign_id", "roku-camp-b");
    const second = await extractImpression(url, cf, env, NOW);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(dedupKey(first.impression)).not.toBe(dedupKey(second.impression));
  });

  it("derives identity from the attested device IP, never from the raw address", async () => {
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", device_ip: "203.0.113.7" },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.impression.ifaPresent).toBe(true);
    expect(res.impression.ifaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.impression.ifaHash).not.toContain("203.0.113.7");
    // Raw IP is returned out-of-band for the attribution window only; it must
    // not be reachable through the Impression written to analytics/raw tiers.
    expect(res.deviceIp).toBe("203.0.113.7");
    expect(JSON.stringify(res.impression)).not.toContain("203.0.113.7");
  });

  it("treats 0.0.0.0 as the opt-out signal Roku documents", async () => {
    // Ads Manager has no LMT macro: Roku zeroes DEVICE_IP when the device
    // opted out or privacy rules forbid sharing, so this is the only
    // opt-out channel and must set lmt, not merely drop the identifier.
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", device_ip: "0.0.0.0" },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.impression.lmt).toBe(true);
    expect(res.impression.ifaPresent).toBe(false);
    expect(res.impression.ifaHash).toBe("anon");
    expect(res.deviceIp).toBe("");
  });

  it("does not fabricate an opt-out when the macro simply failed to expand", async () => {
    // An unexpanded macro is an unusable identifier, but reporting it as a
    // user opt-out would be a false statement about a choice never made.
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", device_ip: "[[[DEVICE_IP]]]" },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.impression.lmt).toBe(false);
    expect(res.impression.ifaPresent).toBe(false);
    expect(res.deviceIp).toBe("");
  });

  it("rejects malformed and non-IPv4 addresses as identities", async () => {
    const env = makeEnv(["camp1"]);
    for (const bad of ["999.1.1.1", "203.0.113", "2001:db8::1", "203.0.113.01", ""]) {
      const url = await signedUrl(
        { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", device_ip: bad },
        FUTURE,
      );
      const res = await extractImpression(url, cf, env, NOW);
      expect(res.ok, bad).toBe(true);
      if (!res.ok) continue;
      expect(res.impression.ifaPresent, bad).toBe(false);
      expect(res.deviceIp, bad).toBe("");
    }
  });

  it("prefers the COUNTRY macro over the edge country and parses METRO_CODE", async () => {
    // The edge only sees where the beacon egressed; Roku attests to where the
    // impression actually served.
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      {
        advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1",
        device_ip: "203.0.113.7", country: "us", dma: "501",
      },
      FUTURE,
    );
    const res = await extractImpression(url, { country: "CA" } as never, env, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.impression.country).toBe("US");
    expect(res.impression.dma).toBe("501");
  });

  it("recovers the metro code from a tag missing the '=' (dma[[[METRO_CODE]]])", async () => {
    // Roku trafficked `&dma[[[METRO_CODE]]]`; substituted it arrives as `&dma501`.
    const env = makeEnv(["camp1"]);
    const base = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", device_ip: "203.0.113.7" },
      FUTURE,
    );
    const ok = await extractImpression(new URL(`${base.toString()}&dma501`), cf, env, NOW);
    expect(ok.ok && ok.impression.dma).toBe("501");
    // An unexpanded macro in the same malformed position stays blank.
    const raw = await extractImpression(
      new URL(`${base.toString()}&dma[[[METRO_CODE]]]`), cf, env, NOW,
    );
    expect(raw.ok && raw.impression.dma).toBe("");
  });

  it("falls back to edge country and blanks an unexpanded METRO_CODE", async () => {
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      {
        advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1",
        device_ip: "203.0.113.7", country: "[[[COUNTRY]]]", dma: "[[[METRO_CODE]]]",
      },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.impression.country).toBe("US"); // from the edge
    expect(res.impression.dma).toBe("");
  });

  it("forces opt-out treatment for child-directed campaigns regardless of IP", async () => {
    const env = makeEnv(["camp_kids"], true, {}, { camp_kids: "child_directed" });
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp_kids", creative_id: "cre1", device_ip: "203.0.113.7" },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.impression.lmt).toBe(true);
    expect(res.impression.ifaPresent).toBe(false);
    expect(res.deviceIp).toBe("");
  });

  it("gives two devices behind different IPs distinct identities", async () => {
    const env = makeEnv(["camp1"]);
    const mk = async (ip: string) => {
      const url = await signedUrl(
        { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", device_ip: ip },
        FUTURE,
      );
      const r = await extractImpression(url, cf, env, NOW);
      if (!r.ok) throw new Error("expected ok");
      return r.impression.ifaHash;
    };
    expect(await mk("203.0.113.7")).not.toBe(await mk("203.0.113.8"));
    expect(await mk("203.0.113.7")).toBe(await mk("203.0.113.7"));
  });
});

describe("prevSaltDedupKey (salt rotation)", () => {
  it("returns the previous-salt key during a rotation window", async () => {
    const env = makeEnv(["camp1"], true, { IFA_HASH_SALT_PREV: "old-salt" });
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: "dev-1", pf: "ua" },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const alt = await prevSaltDedupKey(env, url, res.impression);
    const expectedHash = await hashIfa("old-salt", "dev-1");
    expect(alt).toBe(`${expectedHash}|camp1|cre1`);
  });

  it("hashes the same 'ip:' preimage on Roku so rotation does not lapse dedup", async () => {
    // The live path hashes `ip:<addr>`. If this helper hashed the bare address
    // the alias would never match a stored key, every device would look new
    // for the whole rotation window, and dedup would silently stop working.
    const env = makeEnv(["camp1"], true, { IFA_HASH_SALT_PREV: "old-salt" });
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", device_ip: "203.0.113.7" },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const alt = await prevSaltDedupKey(env, url, res.impression);
    const expectedHash = await hashIfa("old-salt", "ip:203.0.113.7");
    expect(alt).toBe(`${expectedHash}|camp1|cre1`);
  });

  it("returns null without a previous salt or for non-attributable impressions", async () => {
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      { advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1", ifa: "dev-1", pf: "ua" },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(await prevSaltDedupKey(env, url, res.impression)).toBeNull();
  });
});

describe("parseCampaignConfig", () => {
  it("accepts the legacy bare-string form", () => {
    expect(parseCampaignConfig("active")).toEqual({
      childDirected: false, startsAt: null, endsAt: null, markets: [],
    });
    expect(parseCampaignConfig("child_directed")?.childDirected).toBe(true);
  });

  it("widens a bare end date to cover the whole UTC day", () => {
    // "2026-12-31" as an end must include that day's traffic. Parsed as an
    // instant it would expire at 00:00 and silently drop the final 24 hours.
    const cfg = parseCampaignConfig('{"status":"active","start":"2026-10-01","end":"2026-12-31"}');
    expect(cfg?.startsAt).toBe(Date.parse("2026-10-01T00:00:00Z") / 1000);
    expect(cfg?.endsAt).toBe(Date.parse("2026-12-31T23:59:59Z") / 1000);
  });

  it("treats malformed JSON as not allowlisted rather than unrestricted", () => {
    // Failing open here would turn a typo in a flight window into an
    // unbounded, unlicensed collection period.
    expect(parseCampaignConfig('{"status":"active",')).toBeNull();
    expect(parseCampaignConfig("")).toBeNull();
    expect(parseCampaignConfig('{"status":"paused"}')).toBeNull();
  });

  it("keeps only well-formed market codes", () => {
    expect(parseCampaignConfig('{"markets":["us","CA","bogus",7]}')?.markets).toEqual(["US", "CA"]);
  });
});

describe("licensedMarkets", () => {
  it("defaults to US and parses a configured list", () => {
    expect(licensedMarkets({} as Env)).toEqual(["US"]);
    expect(licensedMarkets({ LICENSED_MARKETS: "us, ca " } as unknown as Env)).toEqual(["US", "CA"]);
    // A list that parses to nothing must not mean "no markets allowed".
    expect(licensedMarkets({ LICENSED_MARKETS: "!!" } as unknown as Env)).toEqual(["US"]);
  });
});

describe("flight window and market enforcement (DSA §2(b)(1), §3(a))", () => {
  const FLIGHT = '{"status":"active","start":"2026-10-01","end":"2026-12-31"}';
  const inFlight = Date.parse("2026-11-15T12:00:00Z") / 1000;

  async function rokuUrl() {
    return signedUrl(
      {
        advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1",
        device_ip: "203.0.113.7", country: "US", dma: "501",
      },
      FUTURE,
    );
  }

  it("accepts a beacon inside the flight window", async () => {
    const env = makeEnv(["camp1"], true, {}, { camp1: FLIGHT });
    const res = await extractImpression(await rokuUrl(), cf, env, inFlight);
    expect(res.ok).toBe(true);
  });

  it("rejects before the start and after the end", async () => {
    const env = makeEnv(["camp1"], true, {}, { camp1: FLIGHT });
    const url = await rokuUrl();

    const early = await extractImpression(url, cf, env, Date.parse("2026-09-30T23:59:59Z") / 1000);
    expect(!early.ok && early.reason).toBe("outside_flight");

    const late = await extractImpression(url, cf, env, Date.parse("2027-01-01T00:00:01Z") / 1000);
    expect(!late.ok && late.reason).toBe("outside_flight");
  });

  it("accepts traffic on the final day of the flight", async () => {
    const env = makeEnv(["camp1"], true, {}, { camp1: FLIGHT });
    const res = await extractImpression(
      await rokuUrl(), cf, env, Date.parse("2026-12-31T18:00:00Z") / 1000,
    );
    expect(res.ok).toBe(true);
  });

  it("rejects an impression served outside the licensed market", async () => {
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      {
        advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1",
        device_ip: "203.0.113.7", country: "GB",
      },
      FUTURE,
    );
    const res = await extractImpression(url, cf, env, NOW);
    expect(!res.ok && res.reason).toBe("out_of_market");
  });

  it("honors a per-campaign market override", async () => {
    const env = makeEnv(["camp1"], true, {}, { camp1: '{"status":"active","markets":["GB"]}' });
    const url = await signedUrl(
      {
        advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1",
        device_ip: "203.0.113.7", country: "GB",
      },
      FUTURE,
    );
    expect((await extractImpression(url, cf, env, NOW)).ok).toBe(true);
  });

  it("trusts the COUNTRY macro over the edge for the market check", async () => {
    // The edge sees where the beacon egressed, which on CTV can differ from
    // where the ad served. Roku's macro is the attested value.
    const env = makeEnv(["camp1"]);
    const url = await signedUrl(
      {
        advertiser_id: "adv1", campaign_id: "camp1", creative_id: "cre1",
        device_ip: "203.0.113.7", country: "US",
      },
      FUTURE,
    );
    const res = await extractImpression(url, { country: "DE" } as never, env, NOW);
    expect(res.ok).toBe(true);
  });
});

describe("dedupKey", () => {
  it("returns null for non-attributable impressions", () => {
    expect(
      dedupKey({
        advertiserId: "a", campaignId: "c", creativeId: "cr",
        ifaHash: "anon", ifaPresent: false, lmt: true, appId: "app", country: "US",
        dma: "", ifaType: "", platform: "roku",
      }),
    ).toBeNull();
  });

  it("builds a key from ifaHash without raw identifiers", () => {
    const k = dedupKey({
      advertiserId: "a", campaignId: "c", creativeId: "cr",
      ifaHash: "abc123", ifaPresent: true, lmt: false, appId: "app", country: "US",
      dma: "", ifaType: "", platform: "roku",
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
        ifa: "8f14e45f-ceea-467a-9e4e-1c0f1a2b3c4d", lmt: "0", pf: "ua",
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
    dma: "", ifaType: "", platform: "roku",
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
