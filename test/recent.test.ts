import { describe, it, expect } from "vitest";
import { RecentImpressions, recordRecent, matchRecent } from "../src/recent";
import type { ImpressionRecord, MatchResult } from "../src/types";
import { fakeDoState, fakeDoNamespace, type RecordedFetch } from "./helpers/fakes";

const NOW = 1_700_000_000;

const rec = (over: Partial<ImpressionRecord> = {}): ImpressionRecord => ({
  ts: NOW - 60,
  ip: "203.0.113.7",
  rida: "rida-abc",
  hhId: "",
  region: "California",
  city: "SF",
  postal: "94103",
  lmt: false,
  ...over,
});

function makeStore() {
  const { state, sql, kv, getAlarm } = fakeDoState();
  return { do: new RecentImpressions(state), state, sql, kv, getAlarm };
}

const post = (path: string, body: unknown) =>
  new Request(`https://recent${path}`, { method: "POST", body: JSON.stringify(body) });

describe("RecentImpressions /record", () => {
  it("stores the raw identifiers needed by the conversion APIs", async () => {
    const { do: store, sql } = makeStore();
    const res = await store.fetch(post("/record?window=60", rec()));
    expect(res.status).toBe(204);
    expect(sql.imp).toHaveLength(1);
    expect(sql.imp[0].ip).toBe("203.0.113.7");
    expect(sql.imp[0].rida).toBe("rida-abc");
    expect(sql.imp[0].lmt).toBe(0);
  });

  it("never arms a purge alarm, whatever window is passed", async () => {
    for (const w of ["30", "15", "90", "NaN", ""]) {
      const { do: store, getAlarm } = makeStore();
      await store.fetch(post(`/record?window=${w}`, rec()));
      expect(getAlarm(), `window=${w}`).toBeNull();
    }
  });

  it("cancels an alarm left armed by the previous purging version", async () => {
    const { do: store, state, getAlarm } = makeStore();
    // Simulate the old build having armed a purge alarm on this instance.
    await state.storage.setAlarm(Date.now() + 60_000);
    expect(getAlarm()).not.toBeNull();
    await store.fetch(post("/record?window=60", rec()));
    expect(getAlarm()).toBeNull();
  });

  it("records an LMT impression with no identifier stored", async () => {
    const { do: store, sql } = makeStore();
    await store.fetch(post("/record?window=60", rec({ lmt: true, rida: "", hhId: "" })));
    expect(sql.imp[0].rida).toBe("");
    expect(sql.imp[0].lmt).toBe(1);
  });
});

describe("RecentImpressions /match", () => {
  const seed = async (store: RecentImpressions, n: number, over: Partial<ImpressionRecord> = {}) => {
    for (let i = 0; i < n; i++) {
      await store.fetch(post("/record?window=60", rec({ ts: NOW - 10 - i, ...over })));
    }
  };

  const match = async (store: RecentImpressions, body: Record<string, unknown>) =>
    (await (
      await store.fetch(post("/match", { callTs: NOW, windowMin: 60, callerState: "California", callerPostal: "", ...body }))
    ).json()) as MatchResult;

  it("reports no_match when the window is empty", async () => {
    const { do: store } = makeStore();
    const m = await match(store, {});
    expect(m).toMatchObject({ matched: false, best: null, candidateCount: 0, gate: "no_match" });
  });

  it("matches a device within the window and allows identifiers", async () => {
    const { do: store } = makeStore();
    await seed(store, 1);
    const m = await match(store, {});
    expect(m.matched).toBe(true);
    expect(m.gate).toBe("ok");
    expect(m.deviceIds).toBe(true);
    expect(m.best?.ip).toBe("203.0.113.7");
  });

  it("short-circuits above the candidate ceiling without loading rows", async () => {
    const { do: store } = makeStore();
    await seed(store, 5);
    const m = await match(store, { maxCandidates: 3 });
    expect(m).toMatchObject({
      matched: true,
      best: null,
      candidateCount: 5,
      confidence: 0,
      deviceIds: false,
      gate: "too_many_candidates",
    });
  });

  it("uses the default ceiling when none is supplied", async () => {
    const { do: store } = makeStore();
    await seed(store, 11);
    const m = await match(store, {});
    expect(m.gate).toBe("too_many_candidates");
  });

  it("gates device identifiers when confidence is below the floor", async () => {
    const { do: store } = makeStore();
    await seed(store, 1, { region: "Texas" });
    const m = await match(store, { minConfidence: 0.99 });
    expect(m.matched).toBe(true);
    expect(m.gate).toBe("low_confidence");
    expect(m.deviceIds).toBe(false);
  });

  it("never hands back a RIDA for a device that opted out", async () => {
    const { do: store } = makeStore();
    await seed(store, 1, { lmt: true, rida: "" });
    const m = await match(store, {});
    expect(m.best?.rida).toBe("");
    expect(m.best?.lmt).toBe(true);
  });

  it("ignores impressions outside the window", async () => {
    const { do: store } = makeStore();
    await store.fetch(post("/record?window=60", rec({ ts: NOW - 7200 })));
    const m = await match(store, {});
    expect(m.gate).toBe("no_match");
  });
});

describe("RecentImpressions retention", () => {
  it("never deletes rows, even ones far outside the match window", async () => {
    // Owner decision 2026-11-04: raw IPs are kept permanently. A stale alarm
    // from the old purging build must not remove anything.
    const { do: store, sql, kv } = makeStore();
    const now = Math.floor(Date.now() / 1000);
    kv.set("windowMin", 60);
    await store.fetch(post("/record?window=60", rec({ ts: now - 90 * 86400 })));
    await store.fetch(post("/record?window=60", rec({ ts: now - 7200 })));
    await store.fetch(post("/record?window=60", rec({ ts: now - 10 })));

    await store.alarm();

    expect(sql.imp).toHaveLength(3);
    expect(sql.imp.map((r) => r.ip)).toEqual(["203.0.113.7", "203.0.113.7", "203.0.113.7"]);
  });

  it("still excludes retained old rows from a match (window is a filter, not a delete)", async () => {
    const { do: store } = makeStore();
    await store.fetch(post("/record?window=60", rec({ ts: NOW - 7200 })));
    await store.alarm();
    const m = (await (
      await store.fetch(post("/match", { callTs: NOW, windowMin: 60, callerState: "", callerPostal: "" }))
    ).json()) as MatchResult;
    expect(m.gate).toBe("no_match");
  });
});

describe("recent client wiring", () => {
  it("records into the creative's own shard with the window in the URL", async () => {
    const calls: RecordedFetch[] = [];
    const shards: string[] = [];
    const ns = fakeDoNamespace(async (shard) => {
      shards.push(shard);
      return new Response(null, { status: 204 });
    }, calls);
    await recordRecent(ns, "cre1", rec(), 45);
    expect(shards).toEqual(["cre1"]);
    expect(new URL(calls[0].url).searchParams.get("window")).toBe("45");
  });

  it("sends the requested gate thresholds through to the DO", async () => {
    const calls: RecordedFetch[] = [];
    const ns = fakeDoNamespace(async () => Response.json({ matched: false }), calls);
    await matchRecent(ns, "cre1", NOW, 60, "California", "", 0.8, 4);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toMatchObject({
      callTs: NOW,
      windowMin: 60,
      callerState: "California",
      minConfidence: 0.8,
      maxCandidates: 4,
    });
  });
});
