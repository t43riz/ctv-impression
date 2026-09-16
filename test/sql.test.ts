import { describe, it, expect } from "vitest";
import { sqlString, sqlNumber, UnsafeSqlLiteralError } from "../src/lib/sql";

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
