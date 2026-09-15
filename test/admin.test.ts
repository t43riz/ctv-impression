import { describe, it, expect, vi, afterEach } from "vitest";
import { handleAdmin } from "../src/admin";
import { DedupStore } from "../src/dedup";
import type { Env } from "../src/types";
import {
  fakeDoState,
  fakeDoNamespace,
  fakeKv,
  fakeR2,
  fakeAnalytics,
  type RecordedFetch,
} from "./helpers/fakes";

const TOKEN = "admin-token-please-rotate";

interface SqlCall {
  sql: string;
}

/**
 * Build an Env for the admin surface. `sqlData` is returned for every
 * Analytics SQL call; `sqlCalls` captures the SQL text so range clamping can be
 * asserted.
 */
function makeEnv(
  over: Partial<Record<string, unknown>> = {},
  sqlData: Record<string, unknown>[] = [],
  sqlCalls: SqlCall[] = [],
) {
  const dedupState = fakeDoState();
  const dedup = new DedupStore(dedupState.state);
  const raw = fakeR2();
  const archive = fakeR2();

  const env = {
    ADMIN_TOKEN: TOKEN,
    ACCOUNT_ID: "acct-123",
    CF_API_TOKEN: "sql-read-token",
    IFA_HASH_SALT: "a-real-salt-not-a-placeholder",
    RAW_RETENTION_DAYS: "31",
    DEDUP: fakeDoNamespace((_shard, request) => dedup.fetch(request)),
    RAW: raw,
    ARCHIVE: archive,
    RECON: fakeAnalytics(),
    ANALYTICS: fakeAnalytics(),
    ...over,
  } as unknown as Env;

  return { env, dedupState, raw, archive, sqlCalls, sqlData };
}

/** Stub the Analytics SQL read API. */
function stubSql(sqlCalls: SqlCall[], sqlData: Record<string, unknown>[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sqlCalls.push({ sql: String(init.body) });
      return new Response(JSON.stringify({ meta: [], data: sqlData, rows: sqlData.length }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

const req = (path: string, init?: RequestInit) =>
  new Request(`https://tracker.example${path}`, init);

const authed = (path: string, init: RequestInit = {}) =>
  req(path, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admin auth", () => {
  it("hides the whole surface behind 404 without a token", async () => {
    const { env } = makeEnv();
    for (const path of ["/admin/health", "/admin/report/campaigns"]) {
      const res = await handleAdmin(req(path), env);
      expect(res.status).toBe(404);
    }
  });

  it("rejects a wrong token", async () => {
    const { env } = makeEnv();
    const res = await handleAdmin(
      req("/admin/health", { headers: { Authorization: "Bearer nope" } }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("rejects a missing Authorization scheme", async () => {
    const { env } = makeEnv();
    const res = await handleAdmin(req("/admin/health", { headers: { Authorization: TOKEN } }), env);
    expect(res.status).toBe(404);
  });

  it("404s an unknown admin path even when authorized", async () => {
    const { env } = makeEnv();
    const res = await handleAdmin(authed("/admin/nope"), env);
    expect(res.status).toBe(404);
  });
});

describe("admin report range clamping", () => {
  it("uses the default when the window is zero, blank, or unparseable", async () => {
    for (const [query, expected] of [
      ["days=0", "INTERVAL '7' DAY"],
      ["days=abc", "INTERVAL '7' DAY"],
      ["days=", "INTERVAL '7' DAY"],
    ] as [string, string][]) {
      const calls: SqlCall[] = [];
      const { env } = makeEnv({}, [], calls);
      stubSql(calls, []);
      const res = await handleAdmin(authed(`/admin/report/campaigns?${query}`), env);
      expect(res.status).toBe(200);
      expect(calls[0].sql).toContain(expected);
    }
  });

  it("never emits a negative interval for a negative window", async () => {
    // `Number('-5') || fallback` would have passed -5 through to
    // `INTERVAL '-5' DAY`, silently widening the result set.
    const calls: SqlCall[] = [];
    const { env } = makeEnv({}, [], calls);
    stubSql(calls, []);
    await handleAdmin(authed("/admin/report/campaigns?days=-5"), env);
    expect(calls[0].sql).not.toMatch(/INTERVAL '-/);
    expect(calls[0].sql).toContain("INTERVAL '1' DAY");
  });

  it("clamps an oversized window to the maximum", async () => {
    const calls: SqlCall[] = [];
    const { env } = makeEnv({}, [], calls);
    stubSql(calls, []);
    await handleAdmin(authed("/admin/report/campaigns?days=100000"), env);
    expect(calls[0].sql).toContain("INTERVAL '90' DAY");

    const hourCalls: SqlCall[] = [];
    const other = makeEnv({}, [], hourCalls);
    stubSql(hourCalls, []);
    await handleAdmin(authed("/admin/report/countries?hours=999999"), other.env);
    expect(hourCalls[0].sql).toContain("INTERVAL '2160' HOUR");
  });

  it("validates the campaign id before interpolating it into SQL", async () => {
    const calls: SqlCall[] = [];
    const { env } = makeEnv({}, [], calls);
    stubSql(calls, []);
    const res = await handleAdmin(
      authed("/admin/report/reach?campaign=bad%27%20OR%201%3D1"),
      env,
    );
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("admin health", () => {
  /**
   * The day the nightly run should have exported: the freshness check compares
   * the marker's `date` as well as its age, so a marker that is merely "recent"
   * is not enough.
   */
  const exportedYesterday = (): string =>
    new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  it("returns 503 with a closed ledger but a stale export", async () => {
    const calls: SqlCall[] = [];
    const { env, archive } = makeEnv({}, [], calls);
    stubSql(calls, [
      { outcome: "received", events: 100 },
      { outcome: "counted", events: 100 },
    ]);
    // No _status/last_export.json at all.
    const res = await handleAdmin(authed("/admin/health"), env);
    const body = (await res.json()) as { healthy: boolean; recon: { healthy: boolean }; export: { fresh: boolean } };
    expect(body.recon.healthy).toBe(true);
    expect(body.export.fresh).toBe(false);
    expect(body.healthy).toBe(false);
    expect(res.status).toBe(503);
    expect(archive.objects.size).toBe(0);
  });

  it("returns 200 when the ledger closes and the export is fresh", async () => {
    const calls: SqlCall[] = [];
    const { env, archive } = makeEnv({}, [], calls);
    stubSql(calls, [
      { outcome: "received", events: 100 },
      { outcome: "counted", events: 40 },
      { outcome: "duplicate", events: 60 },
    ]);
    await archive.put(
      "_status/last_export.json",
      JSON.stringify({ date: exportedYesterday(), rows: 12, ts: new Date().toISOString() }),
    );
    const res = await handleAdmin(authed("/admin/health"), env);
    const body = (await res.json()) as { healthy: boolean; export: { rows: number } };
    expect(res.status).toBe(200);
    expect(body.healthy).toBe(true);
    expect(body.export.rows).toBe(12);
  });

  it("is unhealthy when a freshly written marker describes an old export", async () => {
    // What a backfill leaves behind: `runExport` rewrites the status marker for
    // whichever day it exported, so the ts is fresh while the daily job can be
    // long dead.
    const calls: SqlCall[] = [];
    const { env, archive } = makeEnv({}, [], calls);
    stubSql(calls, [
      { outcome: "received", events: 100 },
      { outcome: "counted", events: 100 },
    ]);
    await archive.put(
      "_status/last_export.json",
      JSON.stringify({ date: "2026-01-01", rows: 1, ts: new Date().toISOString() }),
    );
    const res = await handleAdmin(authed("/admin/health"), env);
    const body = (await res.json()) as { export: { fresh: boolean; lastDate: string } };
    expect(body.export.fresh).toBe(false);
    expect(body.export.lastDate).toBe("2026-01-01");
    expect(res.status).toBe(503);
  });

  it("surfaces an unhandled ingest error as unhealthy", async () => {
    const calls: SqlCall[] = [];
    const { env, archive } = makeEnv({}, [], calls);
    stubSql(calls, [
      { outcome: "received", events: 10 },
      { outcome: "counted", events: 9 },
      { outcome: "reject_internal", events: 1 },
    ]);
    await archive.put(
      "_status/last_export.json",
      JSON.stringify({ date: exportedYesterday(), rows: 1, ts: new Date().toISOString() }),
    );
    const res = await handleAdmin(authed("/admin/health"), env);
    expect(res.status).toBe(503);
  });
});

describe("admin backfill", () => {
  it("rejects a malformed date", async () => {
    const { env } = makeEnv();
    const res = await handleAdmin(authed("/admin/backfill?date=yesterday", { method: "POST" }), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "date must be YYYY-MM-DD" });
  });

  it("refuses a future date", async () => {
    const { env } = makeEnv();
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const res = await handleAdmin(authed(`/admin/backfill?date=${future}`, { method: "POST" }), env);
    expect(res.status).toBe(400);
  });

  it("marks a re-export of the current UTC day as partial", async () => {
    const calls: SqlCall[] = [];
    const { env } = makeEnv({}, [], calls);
    stubSql(calls, []);
    const today = new Date().toISOString().slice(0, 10);
    const res = await handleAdmin(authed(`/admin/backfill?date=${today}`, { method: "POST" }), env);
    const body = (await res.json()) as { partial: boolean; date: string; rows: number };
    expect(res.status).toBe(200);
    expect(body.partial).toBe(true);
    expect(body.date).toBe(today);
    expect(body.rows).toBe(0);
  });

  it("does not mark a re-export of a closed day as partial", async () => {
    const calls: SqlCall[] = [];
    const { env } = makeEnv({}, [], calls);
    stubSql(calls, [{ hour: "2026-09-14 00:00:00", impressions: 5 }]);
    const res = await handleAdmin(authed("/admin/backfill?date=2026-09-14", { method: "POST" }), env);
    const body = (await res.json()) as { partial?: boolean; rows: number };
    expect(body.partial).toBeUndefined();
    expect(body.rows).toBe(1);
  });
});

describe("admin DSAR", () => {
  const dsar = (body: unknown) =>
    authed("/admin/dsar", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

  it("requires an identifier and at least one campaign", async () => {
    const { env } = makeEnv();
    expect((await handleAdmin(dsar({ campaigns: ["c1"] }), env)).status).toBe(400);
    expect((await handleAdmin(dsar({ ifa: "dev-1" }), env)).status).toBe(400);
    expect((await handleAdmin(dsar({ ifa: "dev-1", campaigns: [] }), env)).status).toBe(400);
  });

  it("rejects a malformed body", async () => {
    const { env } = makeEnv();
    const res = await handleAdmin(
      authed("/admin/dsar", { method: "POST", body: "{not json" }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("erases dedup keys and the raw rows for the subject", async () => {
    const { env, dedupState, raw } = makeEnv();
    // Seed: a dedup key for the subject and a raw row carrying its hash.
    const { hashIfa } = await import("../src/lib/crypto");
    const hash = await hashIfa(env.IFA_HASH_SALT as string, "dev-1");
    dedupState.sql.seen.set(hash, Math.floor(Date.now() / 1000) + 1000);
    dedupState.sql.seen.set("someone-else", Math.floor(Date.now() / 1000) + 1000);
    const day = new Date().toISOString().slice(0, 10);
    await raw.put(`dt=${day}/h=${hash.slice(0, 4)}/hh=01/camp/a.json`, "{}", {
      customMetadata: { ifaHash: hash, campaignId: "camp" },
    });

    const res = await handleAdmin(dsar({ ifa: "dev-1", campaigns: ["camp"] }), env);
    const body = (await res.json()) as {
      dedup_deleted: number;
      raw_tier: { deleted: number; truncated: boolean; daysScanned: number };
    };

    expect(res.status).toBe(200);
    expect(body.dedup_deleted).toBe(1);
    expect([...dedupState.sql.seen.keys()]).toEqual(["someone-else"]);
    expect(body.raw_tier.deleted).toBe(1);
    expect(raw.objects.size).toBe(0);
  });

  it("reports an incomplete DSAR when the raw tier cannot be verified", async () => {
    // Regression guard: eraseRawByHash fails closed when objects carry no
    // customMetadata. Reporting 200/{deleted:0} would certify an erasure that
    // never happened.
    const { env, raw } = makeEnv();
    const { hashIfa } = await import("../src/lib/crypto");
    const hash = await hashIfa(env.IFA_HASH_SALT as string, "dev-1");
    const day = new Date().toISOString().slice(0, 10);
    raw.objects.set(`dt=${day}/h=${hash.slice(0, 4)}/hh=01/camp/a.json`, { value: "{}" });

    const res = await handleAdmin(dsar({ ifa: "dev-1", campaigns: ["camp"] }), env);
    const body = (await res.json()) as { error: string; detail: string; note: string };

    expect(res.status).toBe(500);
    expect(body.error).toBe("raw_erase_failed");
    expect(body.detail).toContain("customMetadata");
    expect(body.note).toContain("NOT COMPLETE");
    // The object must not have been deleted on a failure path.
    expect(raw.objects.size).toBe(1);
  });
});

describe("admin method guards", () => {
  it("only accepts POST on the mutating routes", async () => {
    const { env } = makeEnv();
    expect((await handleAdmin(authed("/admin/backfill?date=2026-09-14"), env)).status).toBe(404);
    expect((await handleAdmin(authed("/admin/dsar"), env)).status).toBe(404);
  });
});

/** RecordedFetch is re-exported for other suites; assert the helper is wired. */
describe("fakes", () => {
  it("records DO calls", async () => {
    const calls: RecordedFetch[] = [];
    const ns = fakeDoNamespace(async () => Response.json({}), calls);
    await ns.get(ns.idFromName("s")).fetch("https://x/y");
    expect(calls).toHaveLength(1);
  });
  it("provides a KV stand-in", async () => {
    const kv = fakeKv({ a: "1" });
    expect(await kv.get("a")).toBe("1");
    expect(await kv.get("b")).toBeNull();
  });
});
