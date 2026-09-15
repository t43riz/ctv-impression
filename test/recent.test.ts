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
  return { do: new RecentImpressions(state), sql, kv, getAlarm };
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

  it("persists the requested window and arms the purge alarm", async () => {
    const { do: store, kv, getAlarm } = makeStore();
    await store.fetch(post("/record?window=30", rec()));
    expect(kv.get("windowMin")).toBe(30);
    expect(getAlarm()).not.toBeNull();
  });

  it("falls back to 60 minutes when the window is not a usable number", async () => {
    // A NaN window made the alarm's cutoff NaN, and `DELETE ... WHERE ts < NaN`
    // matches nothing — raw IP/RIDA would be retained forever.
    for (const bad of ["NaN", "abc", "-5", "0", ""]) {
      const { do: store, kv } = makeStore();
      await store.fetch(post(`/record?window=${bad}`, rec()));
      expect(kv.get("windowMin")).toBe(60);
    }
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

describe("RecentImpressions alarm", () => {
  it("purges impressions older than the stored window", async () => {
    const { do: store, sql } = makeStore();
    const now = Math.floor(Date.now() / 1000);
    await store.fetch(post("/record?window=60", rec({ ts: now - 7200 })));
    await store.fetch(post("/record?window=60", rec({ ts: now - 10 })));

    await store.alarm();

    expect(sql.imp).toHaveLength(1);
    expect(sql.imp[0].ts).toBe(now - 10);
  });

  it("falls back to 60 minutes when storage holds a non-finite window", async () => {
    // Defends against a value written by a previous version of the DO.
    const { do: store, sql, kv, getAlarm } = makeStore();
    const now = Math.floor(Date.now() / 1000);
    kv.set("windowMin", Number.NaN);
    sql.imp.push({ ts: now - 7200, ip: "", rida: "", hh_id: "", region: "", city: "", postal: "", lmt: 0 });

    await store.alarm();

    expect(sql.imp).toHaveLength(0);
    expect(getAlarm()).toBeNull();
  });

  it("reschedules while rows remain", async () => {
    const { do: store, getAlarm } = makeStore();
    await store.fetch(post("/record?window=60", rec({ ts: Math.floor(Date.now() / 1000) })));
    await store.alarm();
    expect(getAlarm()).not.toBeNull();
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
