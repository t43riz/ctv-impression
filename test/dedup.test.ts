import { describe, it, expect } from "vitest";
import { DedupStore, isFirstSeen, eraseByHash } from "../src/dedup";
import { fakeDoState, fakeDoNamespace, type RecordedFetch } from "./helpers/fakes";

const TTL = 86_400;

const request = (path: string, init?: RequestInit) =>
  new Request(`https://dedup${path}`, init);

function makeStore() {
  const { state, sql } = fakeDoState();
  return { do: new DedupStore(state), sql, state };
}

describe("DedupStore /check", () => {
  it("reports the first sighting as not-duplicate and seeds the key", async () => {
    const { do: store, sql } = makeStore();
    const res = await store.fetch(request("/check?key=k1&ttl=86400"));
    expect(await res.json()).toEqual({ duplicate: false });
    expect(sql.seen.has("k1")).toBe(true);
  });

  it("reports a repeat inside the window as duplicate", async () => {
    const { do: store } = makeStore();
    await store.fetch(request("/check?key=k1&ttl=86400"));
    const res = await store.fetch(request("/check?key=k1&ttl=86400"));
    expect(await res.json()).toEqual({ duplicate: true });
  });

  it("admits exactly one winner when the same key arrives concurrently", async () => {
    // The dedup guarantee rests on the SELECT and the INSERT in /check running
    // without an interleaving point. This catches an `await` introduced between
    // them, but it cannot catch the runtime half of the property: `fakeSql.exec`
    // is synchronous by construction, so it holds regardless of what
    // `SqlStorage.exec` does. That half is asserted against real `workerd` in
    // test/workers/dedup.workers.test.ts.
    const { do: store } = makeStore();
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        store
          .fetch(request("/check?key=same&ttl=86400"))
          .then((r) => r.json() as Promise<{ duplicate: boolean }>),
      ),
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(24);
  });

  it("keeps distinct keys independent under concurrency", async () => {
    const { do: store, sql } = makeStore();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store
          .fetch(request(`/check?key=k${i}&ttl=86400`))
          .then((r) => r.json() as Promise<{ duplicate: boolean }>),
      ),
    );
    expect(results.every((r) => !r.duplicate)).toBe(true);
    expect(sql.seen.size).toBe(10);
  });

  it("does not slide the window on repeats", async () => {
    // If the expiry were refreshed on every hit, a steadily-served device would
    // never expire and would be suppressed indefinitely.
    const { do: store, sql } = makeStore();
    await store.fetch(request("/check?key=k1&ttl=100"));
    const first = sql.seen.get("k1");
    await store.fetch(request("/check?key=k1&ttl=100"));
    expect(sql.seen.get("k1")).toBe(first);
  });

  it("is not a duplicate once the window has expired, and re-seeds", async () => {
    const { do: store, sql } = makeStore();
    sql.seen.set("k1", Math.floor(Date.now() / 1000) - 10);
    const res = await store.fetch(request("/check?key=k1&ttl=86400"));
    expect(await res.json()).toEqual({ duplicate: false });
    expect(sql.seen.get("k1")).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("treats an expired alias as absent", async () => {
    const { do: store, sql } = makeStore();
    sql.seen.set("old", Math.floor(Date.now() / 1000) - 10);
    const res = await store.fetch(request("/check?key=new&alt=old&ttl=86400"));
    expect(await res.json()).toEqual({ duplicate: false });
  });

  it("schedules a purge alarm only on the first insert", async () => {
    const { do: store, state } = makeStore();
    expect(await state.storage.getAlarm()).toBeNull();
    await store.fetch(request("/check?key=k1&ttl=86400"));
    const first = await state.storage.getAlarm();
    expect(first).not.toBeNull();
    await store.fetch(request("/check?key=k2&ttl=86400"));
    expect(await state.storage.getAlarm()).toBe(first);
  });
});

describe("DedupStore salt rotation", () => {
  it("seeds the current-salt key when only the previous-salt alias matched", async () => {
    // Regression: tracking only the alias let a device be counted a second time
    // once the rotation window closed and the alias stopped being sent.
    const { do: store, sql } = makeStore();
    sql.seen.set("old-salt", Math.floor(Date.now() / 1000) + TTL);

    const res = await store.fetch(request("/check?key=new-salt&alt=old-salt&ttl=86400"));
    expect(await res.json()).toEqual({ duplicate: true });
    expect(sql.seen.has("new-salt")).toBe(true);
  });

  it("still reports the device as duplicate after the alias is dropped", async () => {
    const { do: store, sql } = makeStore();
    sql.seen.set("old-salt", Math.floor(Date.now() / 1000) + TTL);
    await store.fetch(request("/check?key=new-salt&alt=old-salt&ttl=86400"));
    // Rotation over: only the current-salt key is sent from now on.
    const res = await store.fetch(request("/check?key=new-salt&ttl=86400"));
    expect(await res.json()).toEqual({ duplicate: true });
  });
});

describe("DedupStore /erase", () => {
  it("deletes only keys under the given prefix", async () => {
    const { do: store, sql } = makeStore();
    sql.seen.set("abc1", 1);
    sql.seen.set("abc2", 1);
    sql.seen.set("abd1", 1);
    const res = await store.fetch(request("/erase?prefix=abc", { method: "POST" }));
    expect(await res.json()).toEqual({ deleted: 2 });
    expect([...sql.seen.keys()]).toEqual(["abd1"]);
  });

  it("treats LIKE wildcards in the prefix as literal characters", async () => {
    // An unescaped `_` would match any single character and delete a sibling
    // hash that was never the subject of the request.
    const { do: store, sql } = makeStore();
    sql.seen.set("a_c1", 1);
    sql.seen.set("abc1", 1);
    const res = await store.fetch(request("/erase?prefix=a_c", { method: "POST" }));
    expect(await res.json()).toEqual({ deleted: 1 });
    expect([...sql.seen.keys()]).toEqual(["abc1"]);
  });

  it("treats a percent sign in the prefix as literal too", async () => {
    const { do: store, sql } = makeStore();
    sql.seen.set("a%c1", 1);
    sql.seen.set("abc1", 1);
    await store.fetch(request("/erase?prefix=a%25c", { method: "POST" }));
    expect([...sql.seen.keys()]).toEqual(["abc1"]);
  });

  it("rejects an empty prefix without touching any key", async () => {
    const { do: store, sql } = makeStore();
    sql.seen.set("abc1", 1);
    const res = await store.fetch(request("/erase?prefix=", { method: "POST" }));
    expect(await res.json()).toEqual({ deleted: 0 });
    expect(sql.seen.size).toBe(1);
  });
});

describe("DedupStore alarm", () => {
  it("purges expired keys and reschedules while rows remain", async () => {
    const { do: store, sql, state } = makeStore();
    const now = Math.floor(Date.now() / 1000);
    sql.seen.set("stale", now - 10);
    sql.seen.set("live", now + 10_000);

    await store.alarm();

    expect([...sql.seen.keys()]).toEqual(["live"]);
    expect(await state.storage.getAlarm()).not.toBeNull();
  });

  it("stops rescheduling once the store is empty", async () => {
    const { do: store, sql, state } = makeStore();
    sql.seen.set("stale", 1);
    await store.alarm();
    expect(sql.seen.size).toBe(0);
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

describe("isFirstSeen / eraseByHash client wiring", () => {
  it("sends the shard, key, ttl and encoded alternate key", async () => {
    const calls: RecordedFetch[] = [];
    const ns = fakeDoNamespace(
      async () => Response.json({ duplicate: false }),
      calls,
    );
    await isFirstSeen(ns, "camp1", "key with spaces", TTL, "old/salt+1");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/check");
    // The shard is the campaign, so one campaign's keys cannot collide with
    // another's.
    expect(url.searchParams.get("key")).toBe("key with spaces");
    expect(url.searchParams.get("ttl")).toBe(String(TTL));
    expect(url.searchParams.get("alt")).toBe("old/salt+1");
  });

  it("omits the alt parameter when there is no previous salt", async () => {
    const calls: RecordedFetch[] = [];
    const ns = fakeDoNamespace(async () => Response.json({ duplicate: false }), calls);
    await isFirstSeen(ns, "camp1", "k", TTL, null);
    expect(new URL(calls[0].url).searchParams.has("alt")).toBe(false);
  });

  it("inverts `duplicate` into `first seen`", async () => {
    const dup = fakeDoNamespace(async () => Response.json({ duplicate: true }));
    const fresh = fakeDoNamespace(async () => Response.json({ duplicate: false }));
    expect(await isFirstSeen(dup, "c", "k", TTL)).toBe(false);
    expect(await isFirstSeen(fresh, "c", "k", TTL)).toBe(true);
  });

  it("erases via POST /erase with the prefix encoded", async () => {
    const calls: RecordedFetch[] = [];
    const ns = fakeDoNamespace(async () => Response.json({ deleted: 3 }), calls);
    expect(await eraseByHash(ns, "camp1", "hash+with/slash")).toBe(3);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/erase");
    expect(url.searchParams.get("prefix")).toBe("hash+with/slash");
    expect(calls[0].init?.method).toBe("POST");
  });
});

describe("DedupStore unknown routes", () => {
  it("404s anything else", async () => {
    const { do: store } = makeStore();
    const res = await store.fetch(request("/nope"));
    expect(res.status).toBe(404);
  });
});
