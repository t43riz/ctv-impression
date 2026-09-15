import { describe, it, expect, vi, afterEach } from "vitest";
import { buildQuery, runExport } from "../src/export";
import type { Env } from "../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

const env = {
  ACCOUNT_ID: "acct-123",
  CF_API_TOKEN: "sql-read-token",
  ARCHIVE: { put: async () => undefined },
} as unknown as Env;

/** Stub the Analytics SQL API with a sequence of pages. */
function stubPages(pages: { data: unknown[]; rows_before_limit_at_least?: number }[]) {
  let i = 0;
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(String(init.body));
      const page = pages[Math.min(i, pages.length - 1)];
      i++;
      return new Response(
        JSON.stringify({
          meta: [],
          data: page.data,
          rows: page.data.length,
          rows_before_limit_at_least: page.rows_before_limit_at_least,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  return calls;
}

const GROUP_KEYS = [
  "hour",
  "campaign_id",
  "creative_id",
  "country",
  "app_id",
  "advertiser_id",
  "ifa_present",
  "platform",
];

describe("buildQuery", () => {
  it("orders by every grouping key so LIMIT/OFFSET paging is deterministic", () => {
    const sql = buildQuery("2026-09-14", 0, 10_000);
    const groupBy = sql.match(/GROUP BY (.+)/)![1].trim();
    const orderBy = sql.match(/ORDER BY (.+)/)![1].trim();
    // A tie in the ORDER BY key means undefined row order, which lets a
    // paginated read skip or repeat rows.
    expect(orderBy).toBe(groupBy);
    expect(orderBy.split(/,\s*/).sort()).toEqual([...GROUP_KEYS].sort());
  });

  it("pages with LIMIT/OFFSET over the requested day", () => {
    const sql = buildQuery("2026-09-14", 20_000, 10_000);
    expect(sql).toContain("LIMIT 10000 OFFSET 20000");
    expect(sql).toContain("toDateTime('2026-09-14 00:00:00')");
    expect(sql).toContain("+ INTERVAL '1' DAY");
  });

  it("weights counts by _sample_interval, never double0", () => {
    const sql = buildQuery("2026-09-14", 0, 10);
    expect(sql).toContain("sum(_sample_interval) AS impressions");
    expect(sql).not.toContain("sum(double0)");
  });

  it("selects the append-only blob positions the ingest path writes", () => {
    const sql = buildQuery("2026-09-14", 0, 10);
    expect(sql).toContain("blob1 AS campaign_id");
    expect(sql).toContain("blob2 AS creative_id");
    expect(sql).toContain("blob4 AS country");
    expect(sql).toContain("blob7 AS ifa_present");
    expect(sql).toContain("blob9 AS platform");
  });
});

describe("runExport", () => {
  /** 2026-09-15T02:00Z -> exports 2026-09-14. */
  const SCHEDULED = Date.UTC(2026, 8, 15, 2);

  it("pages until a short page and reports the row count", async () => {
    const calls = stubPages([
      { data: Array.from({ length: 10_000 }, () => ({ impressions: 1 })) },
      { data: [{ impressions: 1 }] },
    ]);
    const r = await runExport(env, SCHEDULED);
    expect(r.date).toBe("2026-09-14");
    expect(r.rows).toBe(10_001);
    expect(r.key).toBe("dt=2026-09-14/impressions.ndjson");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("OFFSET 10000");
  });

  it("refuses to publish a truncated aggregate", async () => {
    // If the SQL API caps a page below the requested LIMIT while more rows
    // exist, the walk stops early. Publishing that file would silently truncate
    // the long-term record for the day, so it throws instead.
    stubPages([{ data: [{ impressions: 1 }], rows_before_limit_at_least: 500_000 }]);
    await expect(runExport(env, SCHEDULED)).rejects.toThrow(/truncated aggregate/);
  });

  it("is content with an empty day", async () => {
    stubPages([{ data: [], rows_before_limit_at_least: 0 }]);
    const r = await runExport(env, SCHEDULED);
    expect(r.rows).toBe(0);
  });
});
