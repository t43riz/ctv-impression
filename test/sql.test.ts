import { describe, it, expect, vi, afterEach } from "vitest";
import { sqlString, sqlNumber, querySql, UnsafeSqlLiteralError } from "../src/lib/sql";
import type { Env } from "../src/types";

const env = {
  ACCOUNT_ID: "acct123",
  CF_API_TOKEN: "token123",
  HTTP_TIMEOUT_MS: "5000",
} as unknown as Env;

function mockSqlResponse(body: unknown) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
}

describe("sqlString", () => {
  it("quotes a well-formed identifier", () => {
    expect(sqlString("camp_spring24")).toBe("'camp_spring24'");
    expect(sqlString("cre-30s.hero")).toBe("'cre-30s.hero'");
  });

  it("refuses a value carrying a backslash rather than escaping it", () => {
    // Workers Analytics Engine is ClickHouse-derived, where a backslash is an
    // escape introducer inside a string literal. Doubling quotes alone is not a
    // complete defense: a trailing backslash escapes the closing quote and the
    // literal runs on into the query. There is no parameter binding to fall
    // back on, so an out-of-shape value has to fail loudly at the boundary.
    expect(() => sqlString("camp\\")).toThrow(UnsafeSqlLiteralError);
    expect(() => sqlString("a\\' OR 1=1 --")).toThrow(UnsafeSqlLiteralError);
  });

  it("refuses quotes, semicolons, comment openers and newlines", () => {
    for (const bad of ["a'b", "a;b", "a/*b", "a\nb", "a\tb"]) {
      expect(() => sqlString(bad), bad).toThrow(UnsafeSqlLiteralError);
    }
  });

  it("allows a hyphen, which real creative ids use", () => {
    // `--` only opens a comment outside a string literal, and the quote and
    // backslash rejections above are what keep a value inside one.
    expect(sqlString("cre-30s-hero")).toBe("'cre-30s-hero'");
  });

  it("names the offending value so the failure is diagnosable", () => {
    expect(() => sqlString("bad\\")).toThrow(/refusing to interpolate/);
  });
});

describe("sqlNumber", () => {
  it("floors a finite value for interpolation", () => {
    expect(sqlNumber(7)).toBe(7);
    expect(sqlNumber(7.9)).toBe(7);
  });

  it("refuses a non-finite value", () => {
    // The reporting queries build `INTERVAL '${n}' DAY` by interpolation, which
    // is safe only while every caller clamps first. NaN would otherwise reach
    // the query as a bare token.
    expect(() => sqlNumber(Number.NaN)).toThrow(UnsafeSqlLiteralError);
    expect(() => sqlNumber(Number.POSITIVE_INFINITY)).toThrow(UnsafeSqlLiteralError);
  });
});

describe("querySql numeric coercion", () => {
  afterEach(() => vi.restoreAllMocks());

  it("converts 64-bit integer columns from strings to numbers", async () => {
    // WAE serializes UInt64 as a JSON *string* because the range exceeds what an
    // IEEE double holds exactly. The row types declare `number`, and the cast
    // through JSON.parse hides the mismatch from the compiler, so `a + r.events`
    // in the health reconciler silently concatenated: 0 + "10" -> "010".
    mockSqlResponse({
      meta: [
        { name: "outcome", type: "String" },
        { name: "events", type: "UInt64" },
      ],
      data: [
        { outcome: "received", events: "10" },
        { outcome: "counted", events: "4" },
      ],
      rows: 2,
    });

    const { data } = await querySql<{ outcome: string; events: number }>(
      env,
      "SELECT 1 FORMAT JSON",
    );

    expect(data.map((r) => r.events)).toEqual([10, 4]);
    expect(data.reduce((a, r) => a + r.events, 0)).toBe(14);
  });

  it("coerces Nullable and Float columns but leaves strings alone", async () => {
    mockSqlResponse({
      meta: [
        { name: "campaign_id", type: "String" },
        { name: "ratio", type: "Float64" },
        { name: "maybe", type: "Nullable(UInt64)" },
      ],
      data: [{ campaign_id: "camp_1", ratio: "0.25", maybe: "7" }],
      rows: 1,
    });

    const { data } = await querySql<Record<string, unknown>>(env, "SELECT 1 FORMAT JSON");

    expect(data[0]).toEqual({ campaign_id: "camp_1", ratio: 0.25, maybe: 7 });
  });

  it("leaves a null numeric value untouched rather than coercing it to 0", async () => {
    // Number(null) is 0, which would turn "no data" into a real zero reading.
    mockSqlResponse({
      meta: [{ name: "events", type: "Nullable(UInt64)" }],
      data: [{ events: null }],
      rows: 1,
    });

    const { data } = await querySql<{ events: number | null }>(env, "SELECT 1 FORMAT JSON");

    expect(data[0].events).toBeNull();
  });
});
