import { describe, it, expect } from "vitest";
import {
  scoreCandidates,
  gateForDeviceIds,
  DEFAULT_MIN_MATCH_CONFIDENCE,
  DEFAULT_MAX_MATCH_CANDIDATES,
} from "../src/lib/match";
import type { ImpressionRecord } from "../src/types";

function imp(p: Partial<ImpressionRecord> & { ts: number }): ImpressionRecord {
  return {
    ip: "1.2.3.4",
    rida: "rida-x",
    hhId: "",
    region: "California",
    city: "San Jose",
    postal: "95110",
    lmt: false,
    ...p,
  };
}

const CALL_TS = 10_000;
const WINDOW = 60; // minutes

describe("scoreCandidates", () => {
  it("returns no match when there are zero in-window impressions", () => {
    const r = scoreCandidates([], CALL_TS, WINDOW, "California", "");
    expect(r.matched).toBe(false);
    expect(r.best).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it("excludes impressions outside the window or after the call", () => {
    const old = imp({ ts: CALL_TS - WINDOW * 60 - 1 }); // just outside
    const future = imp({ ts: CALL_TS + 5 }); // after the call
    const r = scoreCandidates([old, future], CALL_TS, WINDOW, "California", "");
    expect(r.matched).toBe(false);
  });

  it("gives high confidence for a single recent in-state candidate", () => {
    const only = imp({ ts: CALL_TS - 60 }); // 1 min before
    const r = scoreCandidates([only], CALL_TS, WINDOW, "California", "");
    expect(r.matched).toBe(true);
    expect(r.candidateCount).toBe(1);
    expect(r.confidence).toBeGreaterThan(0.9);
    expect(r.best?.ip).toBe("1.2.3.4");
  });

  it("lowers confidence as candidate count grows", () => {
    const single = scoreCandidates([imp({ ts: CALL_TS - 60 })], CALL_TS, WINDOW, "", "");
    const many = scoreCandidates(
      Array.from({ length: 16 }, (_, i) => imp({ ts: CALL_TS - 60 - i })),
      CALL_TS,
      WINDOW,
      "",
      "",
    );
    expect(many.confidence).toBeLessThan(single.confidence);
  });

  it("prefers the geo-agreeing candidate", () => {
    const inState = imp({ ts: CALL_TS - 600, ip: "9.9.9.9", region: "California", postal: "" });
    const outState = imp({ ts: CALL_TS - 60, ip: "8.8.8.8", region: "Texas", postal: "" });
    const r = scoreCandidates([inState, outState], CALL_TS, WINDOW, "California", "");
    expect(r.best?.ip).toBe("9.9.9.9");
  });

  it("prefers the most recent when scores tie (no geo info)", () => {
    const older = imp({ ts: CALL_TS - 600, ip: "1.1.1.1", region: "", postal: "" });
    const newer = imp({ ts: CALL_TS - 30, ip: "2.2.2.2", region: "", postal: "" });
    const r = scoreCandidates([older, newer], CALL_TS, WINDOW, "", "");
    expect(r.best?.ip).toBe("2.2.2.2");
  });
});

describe("device-identifier gate", () => {
  it("allows device ids for an unambiguous single candidate", () => {
    const r = scoreCandidates([imp({ ts: CALL_TS - 30 })], CALL_TS, WINDOW, "California", "");
    expect(r.deviceIds).toBe(true);
    expect(r.gate).toBe("ok");
  });

  it("withholds device ids when the caller cannot be disambiguated", () => {
    // 50 candidates in-window: picking one IP out of 50 is a guess. Both bounds
    // are breached here; the candidate ceiling is reported because it is
    // checked first.
    const many = Array.from({ length: 50 }, (_, i) => imp({ ts: CALL_TS - 1 - i }));
    const r = scoreCandidates(many, CALL_TS, WINDOW, "California", "");
    expect(r.matched).toBe(true);
    expect(r.deviceIds).toBe(false);
    expect(r.gate).toBe("too_many_candidates");
    expect(r.candidateCount).toBe(50);
    // Confidence alone would also have blocked this: it is below the floor.
    expect(r.confidence).toBeLessThan(DEFAULT_MIN_MATCH_CONFIDENCE);
  });

  it("withholds device ids just past the candidate ceiling", () => {
    const n = DEFAULT_MAX_MATCH_CANDIDATES + 1;
    const cands = Array.from({ length: n }, (_, i) => imp({ ts: CALL_TS - 1 - i }));
    const r = scoreCandidates(cands, CALL_TS, WINDOW, "California", "");
    expect(r.deviceIds).toBe(false);
  });

  it("withholds device ids on a weak score even with few candidates", () => {
    // Few candidates but stale, and geo actively disagrees.
    const stale = Array.from({ length: 3 }, (_, i) =>
      imp({ ts: CALL_TS - WINDOW * 60 + 30 + i, region: "Texas", postal: "" }),
    );
    const r = scoreCandidates(stale, CALL_TS, WINDOW, "California", "");
    expect(r.deviceIds).toBe(false);
    expect(r.gate).toBe("low_confidence");
  });

  it("never allows device ids without a match", () => {
    const r = scoreCandidates([], CALL_TS, WINDOW, "California", "");
    expect(r.deviceIds).toBe(false);
    expect(r.gate).toBe("no_match");
  });

  it("is configurable through explicit thresholds", () => {
    const many = Array.from({ length: 50 }, (_, i) => imp({ ts: CALL_TS - 1 - i }));
    const r = scoreCandidates(many, CALL_TS, WINDOW, "California", "", undefined, 0.1, 100);
    expect(r.deviceIds).toBe(true);
  });
});

describe("gateForDeviceIds", () => {
  it("orders its checks so the reason is the binding constraint", () => {
    expect(gateForDeviceIds(false, 0.99, 1)).toEqual({ deviceIds: false, gate: "no_match" });
    expect(gateForDeviceIds(true, 0.99, 999)).toEqual({
      deviceIds: false,
      gate: "too_many_candidates",
    });
    expect(gateForDeviceIds(true, 0.1, 1)).toEqual({
      deviceIds: false,
      gate: "low_confidence",
    });
    expect(gateForDeviceIds(true, 0.99, 1)).toEqual({ deviceIds: true, gate: "ok" });
  });

  it("treats the max/count bounds as inclusive", () => {
    expect(gateForDeviceIds(true, DEFAULT_MIN_MATCH_CONFIDENCE, DEFAULT_MAX_MATCH_CANDIDATES)).toEqual(
      { deviceIds: true, gate: "ok" },
    );
    expect(gateForDeviceIds(true, DEFAULT_MIN_MATCH_CONFIDENCE, DEFAULT_MAX_MATCH_CANDIDATES + 1).deviceIds).toBe(
      false,
    );
  });
});
