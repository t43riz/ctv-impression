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
  type FakeAnalytics,
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
  // DSAR enumerates the allowlist so an erasure covers every shard the subject
  // could appear in, so the namespace has to be present for that path.
  const campaigns = fakeKv({ "campaign:camp": "active" });

  const env = {
    ADMIN_TOKEN: TOKEN,
    ACCOUNT_ID: "acct-123",
    CF_API_TOKEN: "sql-read-token",
    IFA_HASH_SALT: "a-real-salt-not-a-placeholder",
    RAW_RETENTION_DAYS: "31",
    CAMPAIGNS: campaigns,
    DEDUP: fakeDoNamespace((_shard, request) => dedup.fetch(request)),
    RAW: raw,
    ARCHIVE: archive,
    RECON: fakeAnalytics(),
    ANALYTICS: fakeAnalytics(),
    ...over,
  } as unknown as Env;

  return { env, dedupState, raw, archive, campaigns, sqlCalls, sqlData };
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

describe("admin error boundary", () => {
  it("records an outcome when a report route throws instead of a bare 500", async () => {
    // The report routes reach the Analytics SQL API over the network. Without a
    // boundary that failure escapes to the runtime as an unhandled 500 with no
    // ledger row — the same defect the /call path was fixed for.
    const { env } = makeEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("analytics sql unreachable");
      }),
    );

    const res = await handleAdmin(authed("/admin/report/campaigns"), env);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    const recorded = (env.RECON as unknown as FakeAnalytics).points.map(
      (p) => p.blobs?.[0] ?? "",
    );
    expect(recorded).toContain("alert_admin_error");
  });

  it("does not leak the upstream error detail to the caller", async () => {
    // AnalyticsSqlError quotes the upstream response, which can carry the
    // account id and the query. That belongs in the log, not the response.
    const { env } = makeEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("acct-123 token=sql-read-token rejected");
      }),
    );

    const res = await handleAdmin(authed("/admin/report/campaigns"), env);

    expect(JSON.stringify(await res.json())).not.toContain("sql-read-token");
  });

  it("keeps the surface hidden when an unauthenticated request throws", async () => {
    // The boundary must not turn a 404 into a 500 and confirm the route exists.
    const { env } = makeEnv();
    const res = await handleAdmin(req("/admin/report/campaigns"), env);
    expect(res.status).toBe(404);
  });
});

describe("admin auth", () => {
  it("hides the whole surface behind 404 without a token", async () => {
    const { env } = makeEnv();
    for (const path of ["/admin/health", "/admin/report/campaigns"]) {
      const res = await handleAdmin(req(path), env);
      expect(res.status).toBe(404);
    }
  });

  it("refuses a placeholder admin token even when it is presented correctly", async () => {
    // `.dev.vars.example` ships ADMIN_TOKEN="3333…3333". A deploy that never
    // rotated it would otherwise authenticate anyone who read the repository —
    // against reporting, backfill and destructive DSAR erasure. /pixel and
    // /call both refuse placeholder secrets; this surface must too.
    const placeholder =
      "3333333333333333333333333333333333333333333333333333333333333333";
    const { env } = makeEnv({ ADMIN_TOKEN: placeholder });
    const res = await handleAdmin(
      req("/admin/health", { headers: { Authorization: `Bearer ${placeholder}` } }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("refuses a blank admin token presented as an empty bearer", async () => {
    const { env } = makeEnv({ ADMIN_TOKEN: "   " });
    const res = await handleAdmin(
      req("/admin/health", { headers: { Authorization: "Bearer    " } }),
      env,
    );
    expect(res.status).toBe(404);
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

  it("requires an identifier", async () => {
    const { env } = makeEnv();
    expect((await handleAdmin(dsar({ campaigns: ["c1"] }), env)).status).toBe(400);
    expect((await handleAdmin(dsar({}), env)).status).toBe(400);
  });

  it("erases across every allowlisted campaign when none are supplied", async () => {
    // The dedup store is sharded by campaign, so an erasure that visits only a
    // caller-supplied subset silently leaves rows behind. Omitting `campaigns`
    // must enumerate the allowlist rather than 400.
    const { env, dedupState, campaigns } = makeEnv();
    campaigns.map.set("campaign:other", "active");
    const { hashIfa } = await import("../src/lib/crypto");
    const hash = await hashIfa(env.IFA_HASH_SALT as string, "dev-1");
    dedupState.sql.seen.set(hash, Math.floor(Date.now() / 1000) + 1000);

    const res = await handleAdmin(dsar({ ifa: "dev-1" }), env);
    const body = (await res.json()) as {
      campaigns_scanned: number;
      scope_complete: boolean;
      dedup_deleted: number;
    };

    expect(res.status).toBe(200);
    expect(body.scope_complete).toBe(true);
    expect(body.campaigns_scanned).toBe(2);
    expect(body.dedup_deleted).toBe(1);
  });

  it("reports a caller-narrowed erasure as incomplete rather than certifying it", async () => {
    // A supplied list cannot be verified exhaustive, so the response must not
    // read as a clean success the way the full-enumeration path does. The
    // signal is the body field, not the status: the erase itself succeeded.
    const { env } = makeEnv();
    const res = await handleAdmin(dsar({ ifa: "dev-1", campaigns: ["camp"] }), env);
    const body = (await res.json()) as { scope_complete: boolean; note: string };

    expect(res.status).toBe(200);
    expect(body.scope_complete).toBe(false);
    expect(body.note).toContain("MAY BE INCOMPLETE");
  });

  it("reports a truncated campaign listing as an incomplete scope", async () => {
    // A listing cut short means the shard set is not provably complete, so the
    // erasure must not be certified. The walk is bounded at
    // MAX_DSAR_CAMPAIGN_PAGES (20) x DSAR_CAMPAIGN_PAGE_SIZE (10) = 200, so 201
    // campaigns is the first count that leaves a live cursor outstanding.
    const seeded = Object.fromEntries(
      Array.from({ length: 201 }, (_, i) => [`campaign:c${String(i).padStart(3, "0")}`, "active"]),
    );
    const { env } = makeEnv({ CAMPAIGNS: fakeKv(seeded) });

    const res = await handleAdmin(dsar({ ifa: "dev-1" }), env);
    const body = (await res.json()) as {
      scope_complete: boolean;
      campaigns_scanned: number;
      note: string;
    };

    expect(res.status).toBe(200);
    expect(body.scope_complete).toBe(false);
    // Only what the walk actually reached, not the 201 that exist. This is also
    // the subrequest bound: 200 campaigns is the most one DSAR will erase.
    expect(body.campaigns_scanned).toBe(200);
    expect(body.note).toContain("MAY BE INCOMPLETE");
  });

  it("completes the scope when the listing finishes inside the page budget", async () => {
    // Control for the test above: multi-page paging that finishes must still
    // certify. Without it, a walk capped at zero pages would satisfy the
    // truncation assertion while breaking every real erasure.
    const seeded = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`campaign:c${String(i).padStart(3, "0")}`, "active"]),
    );
    const { env } = makeEnv({ CAMPAIGNS: fakeKv(seeded) });

    const res = await handleAdmin(dsar({ ifa: "dev-1" }), env);
    const body = (await res.json()) as { scope_complete: boolean; campaigns_scanned: number };

    expect(res.status).toBe(200);
    expect(body.scope_complete).toBe(true);
    // Three pages of ten, so the cursor was followed rather than one page read.
    expect(body.campaigns_scanned).toBe(25);
  });

  it("refuses when no campaign can be enumerated and none was supplied", async () => {
    const { env } = makeEnv({ CAMPAIGNS: fakeKv({}) });
    const res = await handleAdmin(dsar({ ifa: "dev-1" }), env);
    const body = (await res.json()) as { error: string; note: string };
    expect(res.status).toBe(500);
    expect(body.error).toBe("no_campaigns");
    expect(body.note).toContain("NOT COMPLETE");
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

    const res = await handleAdmin(dsar({ ifa: "dev-1" }), env);
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

    const res = await handleAdmin(dsar({ ifa: "dev-1" }), env);
    const body = (await res.json()) as { error: string; detail: string; note: string };

    expect(res.status).toBe(500);
    expect(body.error).toBe("raw_erase_failed");
    expect(body.detail).toContain("customMetadata");
    expect(body.note).toContain("NOT COMPLETE");
    // The object must not have been deleted on a failure path.
    expect(raw.objects.size).toBe(1);
  });

  it("rejects a null body and a non-array campaigns list without throwing", async () => {
    // `null` parses as valid JSON and a bare string parses too, so both reach
    // the property reads below. On the one route that erases irreversibly, a
    // malformed body must be a 400 rather than an unhandled 500.
    const { env } = makeEnv();
    expect((await handleAdmin(dsar(null), env)).status).toBe(400);
    expect((await handleAdmin(dsar({ ifa: "dev-1", campaigns: "dev-1" }), env)).status).toBe(400);
  });

  it("refuses an oversized caller campaign list before touching a Durable Object", async () => {
    // Each campaign costs a DO round trip (two during a rotation) ahead of the
    // raw-tier scan. An unbounded list exhausts the request budget mid-erase and
    // returns a 500 with no record of what was deleted.
    let doCalls = 0;
    const { env } = makeEnv({
      DEDUP: fakeDoNamespace(async () => {
        doCalls++;
        return Response.json({ deleted: 0 });
      }),
    });
    const many = Array.from({ length: 201 }, (_, i) => `camp${i}`);

    const res = await handleAdmin(dsar({ ifa: "dev-1", campaigns: many }), env);
    const body = (await res.json()) as { error: string; note: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("too_many_campaigns");
    expect(body.note).toContain("Omit `campaigns`");
    expect(doCalls).toBe(0);
  });

  it("reports a partial dedup erase instead of throwing", async () => {
    // A Durable Object that stops responding part-way through must not turn into
    // an unhandled 500: the caller has to learn that the erasure is incomplete
    // and how far it got, exactly as the raw-tier path already reports.
    const { env, dedupState } = makeEnv({
      DEDUP: fakeDoNamespace(async () => {
        throw new Error("dedup do unavailable");
      }),
    });
    const { hashIfa } = await import("../src/lib/crypto");
    const hash = await hashIfa(env.IFA_HASH_SALT as string, "dev-1");
    dedupState.sql.seen.set(hash, Math.floor(Date.now() / 1000) + 1000);

    const res = await handleAdmin(dsar({ ifa: "dev-1", campaigns: ["camp"] }), env);
    const body = (await res.json()) as {
      error: string;
      note: string;
      campaigns_planned: number;
    };

    expect(res.status).toBe(500);
    expect(body.error).toBe("dedup_erase_failed");
    expect(body.note).toContain("NOT COMPLETE");
    expect(body.campaigns_planned).toBe(1);
    // Nothing was erased, and the response says so rather than implying success.
    expect(dedupState.sql.seen.size).toBe(1);
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
