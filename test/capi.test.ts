import { describe, it, expect } from "vitest";
import { buildCapiPayload, sendToCapi } from "../src/lib/capi";
import type { Env, CallEvent, NumberMapping, MatchResult, ImpressionRecord } from "../src/types";

const env = {
  CAPI_EVENT_GROUP_ID: "grp_default",
  CAPI_EVENT_NAME: "LEAD",
} as unknown as Env;

const mapping: NumberMapping = {
  creativeId: "cre_hero",
  campaignId: "camp_spring",
  advertiserId: "adv_acme",
};

const call: CallEvent = {
  callId: "call-1",
  dnis: "18005550100",
  ani: "+1 415 555 0142",
  startTime: 1_700_000_000,
  durationSeconds: 120,
};

function probabilisticMatch(over: Partial<ImpressionRecord> = {}): MatchResult {
  return {
    matched: true,
    candidateCount: 1,
    confidence: 0.95,
    deviceIds: true,
    gate: "ok",
    best: {
      ts: 1_699_999_400,
      ip: "203.0.113.7",
      rida: "rida-abc",
      hhId: "",
      region: "California",
      city: "SF",
      postal: "94103",
      lmt: false,
      ...over,
    },
  };
}

describe("buildCapiPayload", () => {
  it("sends best-guess IP + RIDA + hashed phone on a probabilistic match", async () => {
    const p = await buildCapiPayload(env, call, mapping, probabilisticMatch());
    const ev = p.events[0];
    expect(p.event_group_id).toBe("grp_default");
    expect(ev.event_name).toBe("LEAD");
    expect(ev.event_source).toBe("phone_call");
    expect(ev.event_type).toBe("conversion");
    expect(ev.user_data.client_ip_address).toBe("203.0.113.7");
    expect(ev.user_data.aRI).toBe("rida-abc");
    expect(ev.user_data.ph).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.user_data.st).toBe("California");
    expect(ev.opt_out).toBe("false");
    expect(ev.event_id).toBe("call_call-1_cre_hero");
    expect((ev.custom_data as Record<string, unknown>).match_type).toBe("probabilistic_ip");
  });

  it("omits RIDA and the IP, and sets opt_out, under LMT", async () => {
    // LMT is honored whether or not the gate would have allowed device
    // identifiers, and it applies to the matched device's IP as well as its
    // RIDA: both are device identifiers under PRIVACY §2.1.
    const p = await buildCapiPayload(env, call, mapping, probabilisticMatch({ rida: "", lmt: true }));
    const ev = p.events[0];
    expect(ev.user_data.client_ip_address).toBeUndefined();
    expect(ev.user_data.aRI).toBeUndefined();
    expect(ev.opt_out).toBe("true");
    // The hashed phone is not derived from the device and still goes.
    expect(ev.user_data.ph).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to hashed phone + area-code state when no impression matched", async () => {
    const noMatch: MatchResult = {
      matched: false,
      best: null,
      candidateCount: 0,
      confidence: 0,
      deviceIds: false,
      gate: "no_match",
    };
    const p = await buildCapiPayload(env, call, mapping, noMatch);
    const ev = p.events[0];
    expect(ev.user_data.client_ip_address).toBeUndefined();
    expect(ev.user_data.aRI).toBeUndefined();
    expect(ev.user_data.ph).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.user_data.st).toBe("California"); // 415 -> California
    expect((ev.custom_data as Record<string, unknown>).match_type).toBe("phone_only");
  });

  it("includes sale value when provided", async () => {
    const p = await buildCapiPayload(env, { ...call, saleValue: 49.99, currency: "USD" }, mapping, probabilisticMatch());
    const cd = p.events[0].custom_data as Record<string, unknown>;
    expect(cd.value).toBe(49.99);
    expect(cd.currency).toBe("USD");
  });

  it("honors per-number event_group_id override", async () => {
    const p = await buildCapiPayload(env, call, { ...mapping, eventGroupId: "grp_override" }, probabilisticMatch());
    expect(p.event_group_id).toBe("grp_override");
  });
});

describe("device-identifier gate", () => {
  it("sends phone-only when the match is gated, and labels it honestly", async () => {
    const gated: MatchResult = {
      ...probabilisticMatch(),
      deviceIds: false,
      gate: "too_many_candidates",
    };
    const p = await buildCapiPayload(env, call, mapping, gated);
    const ev = p.events[0];
    expect(ev.user_data.client_ip_address).toBeUndefined();
    expect(ev.user_data.aRI).toBeUndefined();
    expect(ev.user_data.ph).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.user_data.st).toBe("California"); // area-code fallback
    const cd = ev.custom_data as Record<string, unknown>;
    // The platform must not be told this was device-resolved.
    expect(cd.match_type).toBe("phone_only");
    expect(cd.match_gate).toBe("too_many_candidates");
    // The candidate-ceiling short-circuit never loads rows, so there is no
    // score to report. Omitting it beats shipping 0, which is indistinguishable
    // from a real score.
    expect(cd.match_confidence).toBeUndefined();
  });

  it("still reports the score on gates that did evaluate candidates", async () => {
    const gated: MatchResult = {
      ...probabilisticMatch(),
      deviceIds: false,
      gate: "low_confidence",
    };
    const cd = (await buildCapiPayload(env, call, mapping, gated)).events[0]
      .custom_data as Record<string, unknown>;
    expect(cd.match_gate).toBe("low_confidence");
    expect(cd.match_confidence).toBe(0.95);
  });

  it("still honours LMT when the match is gated", async () => {
    const gated: MatchResult = {
      ...probabilisticMatch({ lmt: true, rida: "" }),
      deviceIds: false,
      gate: "low_confidence",
    };
    const p = await buildCapiPayload(env, call, mapping, gated);
    expect(p.events[0].opt_out).toBe("true");
    expect(p.events[0].user_data.aRI).toBeUndefined();
  });

  it("reports match_gate=ok when identifiers are attached", async () => {
    const p = await buildCapiPayload(env, call, mapping, probabilisticMatch());
    expect((p.events[0].custom_data as Record<string, unknown>).match_gate).toBe("ok");
  });
});

describe("sendToCapi configuration guards", () => {
  it("skips rather than sending a placeholder event_group_id", async () => {
    const badEnv = {
      ...env,
      CAPI_MODE: "live",
      CAPI_API_KEY: "live-key",
      CAPI_EVENT_GROUP_ID: "REPLACE_WITH_EVENT_GROUP_ID",
    } as unknown as Env;
    const p = await buildCapiPayload(badEnv, call, mapping, probabilisticMatch());
    const r = await sendToCapi(badEnv, p);
    expect(r.skipped).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.body).toContain("placeholder");
  });

  it("skips a live send with no API key", async () => {
    const noKey = { ...env, CAPI_MODE: "live", CAPI_API_KEY: "" } as unknown as Env;
    const p = await buildCapiPayload(noKey, call, mapping, probabilisticMatch());
    const r = await sendToCapi(noKey, p);
    expect(r.skipped).toBe(true);
    expect(r.body).toContain("CAPI_API_KEY");
  });
});
