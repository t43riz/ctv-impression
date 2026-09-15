import { describe, it, expect } from "vitest";
import { buildUaCapiPayload, sendToUaCapi } from "../src/lib/capi_ua";
import type { Env, CallEvent, NumberMapping, MatchResult, ImpressionRecord } from "../src/types";

const env = {
  CAPI_EVENT_GROUP_ID: "grp_default",
  CAPI_EVENT_NAME: "LEAD",
  UA_CAPI_MODE: "test",
  UA_CAPI_ENDPOINT: "",
} as unknown as Env;

const mapping: NumberMapping = {
  creativeId: "cre_hero",
  campaignId: "camp_spring",
  advertiserId: "adv_acme",
  platform: "ua",
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
      rida: "ifa-abc",
      hhId: "hh_5f3c",
      region: "California",
      city: "SF",
      postal: "94103",
      lmt: false,
      ...over,
    },
  };
}

describe("buildUaCapiPayload", () => {
  it("sends best-guess IP + ifa + household_id + hashed phone on a match", async () => {
    const p = await buildUaCapiPayload(env, call, mapping, probabilisticMatch());
    const ev = p.events[0];
    expect(p.event_group_id).toBe("grp_default");
    expect(ev.user_data.client_ip_address).toBe("203.0.113.7");
    expect(ev.user_data.ifa).toBe("ifa-abc");
    expect(ev.user_data.household_id).toBe("hh_5f3c");
    expect(ev.user_data.ph).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.opt_out).toBe("false");
    expect(ev.event_id).toBe("call_call-1_cre_hero");
    expect((ev.custom_data as Record<string, unknown>).match_type).toBe("probabilistic_ip");
  });

  it("omits ifa and sets opt_out under LMT; omits empty household_id", async () => {
    const p = await buildUaCapiPayload(
      env,
      call,
      mapping,
      probabilisticMatch({ rida: "", hhId: "", lmt: true }),
    );
    const ev = p.events[0];
    expect(ev.user_data.ifa).toBeUndefined();
    expect(ev.user_data.household_id).toBeUndefined();
    expect(ev.opt_out).toBe("true");
  });

  it("falls back to hashed phone + area-code state on zero match", async () => {
    const noMatch: MatchResult = {
      matched: false,
      best: null,
      candidateCount: 0,
      confidence: 0,
      deviceIds: false,
      gate: "no_match",
    };
    const p = await buildUaCapiPayload(env, call, mapping, noMatch);
    const ev = p.events[0];
    expect(ev.user_data.client_ip_address).toBeUndefined();
    expect(ev.user_data.ifa).toBeUndefined();
    expect(ev.user_data.st).toBe("California");
    expect((ev.custom_data as Record<string, unknown>).match_type).toBe("phone_only");
  });
});

describe("sendToUaCapi", () => {
  it("skips when UA_CAPI_ENDPOINT is not configured", async () => {
    const p = await buildUaCapiPayload(env, call, mapping, probabilisticMatch());
    const r = await sendToUaCapi(env, p);
    expect(r.skipped).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("refuses a live send without an API key", async () => {
    const liveEnv = {
      ...env,
      UA_CAPI_ENDPOINT: "https://capi.example.com",
      UA_CAPI_MODE: "live",
    } as unknown as Env;
    const p = await buildUaCapiPayload(liveEnv, call, mapping, probabilisticMatch());
    const r = await sendToUaCapi(liveEnv, p);
    expect(r.skipped).toBe(true);
    expect(r.body).toContain("UA_CAPI_API_KEY");
  });
});
