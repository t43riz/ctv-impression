import { describe, it, expect } from "vitest";
import { normalizePhone, toE164, hashPhone, areaCodeToState } from "../src/lib/phone";

describe("normalizePhone", () => {
  it("strips special chars", () => {
    expect(normalizePhone("+1 (415) 555-0142")).toBe("14155550142");
    expect(normalizePhone("415.555.0142")).toBe("4155550142");
  });

  it("removes leading zeros", () => {
    expect(normalizePhone("0044 20 7946 0958")).toBe("442079460958");
  });
});

describe("toE164", () => {
  // Roku's spec: "Include the country code preceded by + ... Do not remove the
  // leading +." The + is part of the hashed string, so dropping it produces a
  // valid-looking digest that matches nobody, and the API still returns 200.
  it("keeps the leading + and the country code", () => {
    expect(toE164("+1 (415) 555-0142")).toBe("+14155550142");
    expect(toE164("0044 20 7946 0958")).toBe("+442079460958");
  });

  it("assumes +1 for a bare NANP subscriber number", () => {
    // The PBX only has to send 10+ digits (src/call.ts), so a number with no
    // country code reaches here; hashing it as-is would be a third, equally
    // unmatchable form.
    expect(toE164("415.555.0142")).toBe("+14155550142");
    expect(toE164("(415) 555-0142")).toBe("+14155550142");
  });

  it("returns empty for a number with no digits", () => {
    expect(toE164("")).toBe("");
    expect(toE164("not-a-number")).toBe("");
  });
});

describe("hashPhone", () => {
  it("produces a 64-char lowercase hex digest", async () => {
    const h = await hashPhone("+1 (415) 555-0142");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the E.164 form, + included", async () => {
    // Pinned to a precomputed SHA-256 of the exact string Roku expects
    // ("+14155550142"). An assertion that only compared two hashPhone calls
    // would pass just as happily on the digits-only form this used to emit.
    expect(await hashPhone("+1 (415) 555-0142")).toBe(
      "abbf04d6f629b136344993dfb197f1fd9296f712eaf103ebc22b1cc29fb0f135",
    );
  });

  it("is stable across equivalent formats", async () => {
    const canonical = await hashPhone("+14155550142");
    for (const variant of ["+1 (415) 555-0142", "1-415-555-0142", "415.555.0142"]) {
      expect(await hashPhone(variant)).toBe(canonical);
    }
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
