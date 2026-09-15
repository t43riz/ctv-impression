import { describe, it, expect, vi, afterEach } from "vitest";
import { configInt, configFloat, postJson } from "../src/lib/http";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("configInt", () => {
  it("returns the fallback when the value is missing or unusable", () => {
    expect(configInt(undefined, 7)).toBe(7);
    expect(configInt("", 7)).toBe(7);
    expect(configInt("   ", 7)).toBe(7);
    expect(configInt("abc", 7)).toBe(7);
    expect(configInt("NaN", 7)).toBe(7);
    expect(configInt("Infinity", 7)).toBe(7);
  });

  it("parses a padded integer", () => {
    expect(configInt(" 45 ", 7)).toBe(45);
    expect(configInt("3.9", 7)).toBe(3);
  });

  it("falls back rather than honouring a value below the minimum", () => {
    // A zero/negative budget would silently disable the bound it configures.
    expect(configInt("0", 7)).toBe(7);
    expect(configInt("-3", 7)).toBe(7);
    expect(configInt("-3", 7, -10)).toBe(-3);
  });
});

describe("configFloat", () => {
  it("returns the fallback for unusable input", () => {
    expect(configFloat(undefined, 0.6)).toBe(0.6);
    expect(configFloat("", 0.6)).toBe(0.6);
    expect(configFloat("abc", 0.6)).toBe(0.6);
    expect(configFloat("NaN", 0.6)).toBe(0.6);
  });

  it("keeps fractional values instead of truncating them", () => {
    expect(configFloat("0.82", 0)).toBe(0.82);
  });

  it("clamps into the given range", () => {
    expect(configFloat("1.5", 0.6, 0, 1)).toBe(1);
    expect(configFloat("-0.2", 0.6, 0, 1)).toBe(0);
  });
});

interface FakeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

const res = (status: number, body = ""): FakeResponse => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
});

/**
 * Install a fetch stub that replies with `responses` in order, repeating the
 * last one once it runs out. An `Error` entry is thrown instead of returned.
 */
function stubFetch(...responses: (FakeResponse | Error)[]) {
  let i = 0;
  const fn = vi.fn(async (_url: string, _init: RequestInit): Promise<FakeResponse> => {
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const initOf = (fn: ReturnType<typeof stubFetch>, i = 0): RequestInit =>
  fn.mock.calls[i][1];

describe("postJson", () => {
  it("returns on the first success", async () => {
    const fetchMock = stubFetch(res(200, '{"ok":true}'));

    const r = await postJson("https://api.example/", { a: 1 }, { attempts: 3 });

    expect(r).toMatchObject({ ok: true, status: 200, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(initOf(fetchMock).body))).toEqual({ a: 1 });
  });

  it("retries a transient 503 and succeeds", async () => {
    const fetchMock = stubFetch(res(503), res(200, "fine"));

    const r = await postJson("https://api.example/", {}, { attempts: 2, backoffMs: 1 });

    expect(r).toMatchObject({ ok: true, status: 200, attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a definitive client error", async () => {
    // A 400 means the payload is wrong; resending it cannot succeed and would
    // multiply billable conversion calls.
    const fetchMock = stubFetch(res(400, "bad request"));

    const r = await postJson("https://api.example/", {}, { attempts: 3, backoffMs: 1 });

    expect(r).toMatchObject({ ok: false, status: 400, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transport failure", async () => {
    stubFetch(new Error("socket hang up"), res(200));

    const r = await postJson("https://api.example/", {}, { attempts: 2, backoffMs: 1 });

    expect(r).toMatchObject({ ok: true, attempts: 2 });
  });

  it("gives up after the configured attempt budget", async () => {
    const fetchMock = stubFetch(res(500, "boom"));

    const r = await postJson("https://api.example/", {}, { attempts: 3, backoffMs: 1 });

    expect(r).toMatchObject({ ok: false, status: 500, attempts: 3 });
    expect(r.body).toBe("boom");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("bounds every attempt with an abort signal", async () => {
    const fetchMock = stubFetch(res(200));

    await postJson("https://api.example/", {}, { timeoutMs: 1500 });

    expect(initOf(fetchMock).signal).toBeInstanceOf(AbortSignal);
  });
  it("repairs a nonsensical timeout/attempt budget rather than sending once with none", async () => {
    const fetchMock = stubFetch(res(200));

    const r = await postJson("https://api.example/", {}, { timeoutMs: -1, attempts: 0 });

    expect(r.attempts).toBe(1); // attempts 0 -> fallback 1
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the default content type and merges caller headers", async () => {
    const fetchMock = stubFetch(res(200));

    await postJson("https://api.example/", {}, { headers: { Authorization: "Bearer k" } });

    const init = initOf(fetchMock);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });
});
