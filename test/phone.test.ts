import { describe, it, expect } from "vitest";
import { normalizePhone, hashPhone, areaCodeToState } from "../src/lib/phone";

describe("normalizePhone", () => {
  it("strips special chars per Roku rules", () => {
    expect(normalizePhone("+1 (415) 555-0142")).toBe("14155550142");
    expect(normalizePhone("415.555.0142")).toBe("4155550142");
  });

  it("removes leading zeros", () => {
    expect(normalizePhone("0044 20 7946 0958")).toBe("442079460958");
  });
});

describe("hashPhone", () => {
  it("produces a 64-char lowercase hex digest", async () => {
    const h = await hashPhone("+1 (415) 555-0142");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across equivalent formats", async () => {
    const a = await hashPhone("+1 (415) 555-0142");
    const b = await hashPhone("14155550142");
    expect(a).toBe(b);
  });
});

describe("areaCodeToState", () => {
  it("maps US area codes to full state names (matches cf.region)", () => {
    expect(areaCodeToState("+1 415 555 0142")).toBe("California");
    expect(areaCodeToState("2125550001")).toBe("New York");
    expect(areaCodeToState("13125550001")).toBe("Illinois");
  });

  it("returns empty string for unknown/short numbers", () => {
    expect(areaCodeToState("12")).toBe("");
    expect(areaCodeToState("1999")).toBe("");
  });
});
