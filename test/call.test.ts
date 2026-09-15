import { describe, it, expect } from "vitest";
import { validateCallEvent, handleCall } from "../src/call";
import { DedupStore } from "../src/dedup";
import type { Env, MatchResult } from "../src/types";
import { fakeKv, fakeDoNamespace, fakeDoState, fakeAnalytics, type FakeAnalytics } from "./helpers/fakes";

const NOW = 1_700_000_000;

const base = {
  callId: "call-1",
  dnis: "18005550100",
  ani: "+1 415 555 0142",
  startTime: NOW - 120,
  durationSeconds: 120,
};

const v = (over: Record<string, unknown> = {}) =>
  validateCallEvent(JSON.stringify({ ...base, ...over }), NOW);

describe("validateCallEvent", () => {
  it("accepts a well-formed call", () => {
    const r = v();
    expect(r.ok).toBe(true);
    expect(r.call?.callId).toBe("call-1");
    expect(r.call?.durationSeconds).toBe(120);
  });

  it("rejects a missing duration rather than letting it pass qualification", () => {
    // `undefined < 60` is false, so before this check an event with no duration
    // sailed past qualification and fired a billable conversion.
    const r = validateCallEvent(
      JSON.stringify({ ...base, durationSeconds: undefined }),
      NOW,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("bad_fields");
  });

  it("rejects non-numeric, null, and negative durations", () => {
    expect(v({ durationSeconds: "120" }).reason).toBe("bad_fields");
    expect(v({ durationSeconds: null }).reason).toBe("bad_fields");
    expect(v({ durationSeconds: NaN }).reason).toBe("bad_fields");
    expect(v({ durationSeconds: Infinity }).reason).toBe("bad_fields");
    expect(v({ durationSeconds: -1 }).reason).toBe("bad_fields");
  });

  it("accepts a zero duration, leaving qualification to decide", () => {
    expect(v({ durationSeconds: 0 }).ok).toBe(true);
  });

  it("rejects malformed json and non-objects", () => {
    expect(validateCallEvent("{", NOW).reason).toBe("bad_json");
    expect(validateCallEvent("null", NOW).reason).toBe("bad_json");
    expect(validateCallEvent("42", NOW).reason).toBe("bad_json");
    expect(validateCallEvent('"a string"', NOW).reason).toBe("bad_json");
  });

  it("rejects missing required identifiers", () => {
    expect(v({ callId: "" }).reason).toBe("missing_fields");
    expect(v({ callId: undefined }).reason).toBe("missing_fields");
    expect(v({ dnis: undefined }).reason).toBe("missing_fields");
    expect(v({ ani: 123 }).reason).toBe("missing_fields");
  });

  it("accepts SIP-style call ids and rejects only controls or oversize", () => {
    // A PBX commonly forwards its SIP `Call-ID` (`localpart@host`). The callId is
    // percent-encoded into the idempotency key rather than narrow-charset
    // validated, so punctuation must not fail a qualifying call with a 400 that
    // most PBX integrations will not retry.
    expect(v({ callId: "abc123@10.0.0.1" }).ok).toBe(true);
    expect(v({ callId: "a:b|c{1}#x" }).ok).toBe(true);
    expect(v({ callId: "call_1-2.3" }).ok).toBe(true);
    expect(v({ callId: "x".repeat(129) }).reason).toBe("bad_fields");
    expect(v({ callId: "bad\u0000id" }).reason).toBe("bad_fields");
  });

  it("rejects an implausible startTime", () => {
    expect(v({ startTime: NOW + 4000 }).reason).toBe("bad_fields");
    expect(v({ startTime: NOW - 90_000 }).reason).toBe("bad_fields");
    expect(v({ startTime: "1700000000" }).reason).toBe("bad_fields");
    expect(v({ startTime: NaN }).reason).toBe("bad_fields");
  });

  it("allows a small clock skew between PBX and edge", () => {
    expect(v({ startTime: NOW + 60 }).ok).toBe(true);
    expect(v({ startTime: NOW - 86_000 }).ok).toBe(true);
  });

  it("rejects numbers that carry no usable subscriber number", () => {
    expect(v({ ani: "+1 415" }).reason).toBe("bad_fields");
    expect(v({ dnis: "1800" }).reason).toBe("bad_fields");
  });

  it("rejects a non-numeric saleValue", () => {
    expect(v({ saleValue: "49.99" }).reason).toBe("bad_fields");
    expect(v({ saleValue: NaN }).reason).toBe("bad_fields");
    expect(v({ saleValue: 49.99 }).ok).toBe(true);
    expect(v({ saleValue: undefined }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Webhook handler: auth, idempotency and failure paths.
// ---------------------------------------------------------------------------

const SECRET = "a-real-call-hmac-key-not-a-placeholder";
const DNIS = "18005550100";

async function signHmac(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const NO_MATCH: MatchResult = {
  matched: false,
  best: null,
  candidateCount: 0,
  confidence: 0,
  deviceIds: false,
  gate: "no_match",
};

/** `Response.json()` is typed `unknown`; read just the status field. */
const statusOf = async (res: Response): Promise<string> =>
  ((await res.json()) as { status: string }).status;

interface CallHarness {
  env: Env;
  seen: Map<string, number>;
  /** The conversion-path outcomes the handler recorded, in order. */
  recon: FakeAnalytics;
  request: (over?: Record<string, unknown>) => Promise<Request>;
}

const callOutcomes = (recon: FakeAnalytics): string[] =>
  recon.points.map((p) => p.blobs?.[0] ?? "");

function makeCallEnv(over: Partial<Record<string, unknown>> = {}): CallHarness {
  const { state, sql } = fakeDoState();
  const store = new DedupStore(state);
  const recon = fakeAnalytics();

  const numbers = fakeKv({
    [`number:${DNIS}`]: JSON.stringify({
      creativeId: "cre1",
      campaignId: "camp1",
      advertiserId: "adv1",
      qualifySeconds: 60,
    }),
  });

  const env = {
    CALL_HMAC_KEY: SECRET,
    NUMBERS: numbers,
    DEDUP: fakeDoNamespace((_shard, request) => store.fetch(request)),
    RECENT: fakeDoNamespace(async () => Response.json(NO_MATCH)),
    RECON: recon,
    ...over,
  } as unknown as Env;

  const request = async (over: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      callId: "call-1",
      dnis: DNIS,
      ani: "+1 415 555 0142",
      startTime: now - 120,
      durationSeconds: 120,
      ...over,
    });
    const ts = String(now);
    return new Request("https://tracker.example/call", {
      method: "POST",
      headers: { "x-timestamp": ts, "x-signature": await signHmac(SECRET, ts, body) },
      body,
    });
  };

  return { env, seen: sql.seen, recon, request };
}

describe("handleCall error boundary", () => {
  it("records an outcome when the number registry read throws", async () => {
    // The inner try can only start once the claim exists, so a KV outage used
    // to escape to the runtime as a bare 500 with no ledger row at all — and a
    // conversion path that records nothing reads as healthy.
    const h = makeCallEnv({
      NUMBERS: {
        get: async () => {
          throw new Error("kv unavailable");
        },
      },
    });
    const res = await handleCall(await h.request(), h.env);

    expect(res.status).toBe(502);
    expect(await statusOf(res)).toBe("internal_error");
    expect(callOutcomes(h.recon)).toEqual(["call_internal_error"]);
  });

  it("records an outcome when the idempotency claim throws", async () => {
    const h = makeCallEnv({
      DEDUP: fakeDoNamespace(async () => {
        throw new Error("dedup do unavailable");
      }),
    });
    const res = await handleCall(await h.request(), h.env);

    expect(res.status).toBe(502);
    expect(callOutcomes(h.recon)).toEqual(["call_internal_error"]);
  });
});

describe("handleCall registry validation", () => {
  const withMapping = (mapping: unknown) =>
    makeCallEnv({
      NUMBERS: fakeKv({ [`number:${DNIS}`]: JSON.stringify(mapping) }),
    });

  it("refuses a registry entry whose creative id is malformed", async () => {
    // creativeId selects a Durable Object instance and forms part of the
    // idempotency key, so it gets the same shape check as every other id.
    const h = withMapping({ creativeId: "bad id!", campaignId: "camp1" });
    const res = await handleCall(await h.request(), h.env);
    expect(res.status).toBe(500);
    expect(await statusOf(res)).toBe("bad_number_mapping");
    expect(callOutcomes(h.recon)).toEqual(["call_bad_number_mapping"]);
  });

  it("refuses an out-of-range qualifySeconds instead of trusting it", async () => {
    // A stray override silently redefines what counts as a billable call.
    const h = withMapping({ creativeId: "cre1", campaignId: "camp1", qualifySeconds: -5 });
    expect((await handleCall(await h.request(), h.env)).status).toBe(500);

    const h2 = withMapping({
      creativeId: "cre1",
      campaignId: "camp1",
      qualifySeconds: 999_999,
    });
    expect((await handleCall(await h2.request(), h2.env)).status).toBe(500);
  });

  it("refuses an unknown platform rather than defaulting it", async () => {
    const h = withMapping({ creativeId: "cre1", campaignId: "camp1", platform: "tiktok" });
    expect((await handleCall(await h.request(), h.env)).status).toBe(500);
  });

  it("still accepts a well-formed entry with a zero qualifySeconds", async () => {
    // 0 is meaningful ("every call qualifies") and must survive validation.
    const h = withMapping({ creativeId: "cre1", campaignId: "camp1", qualifySeconds: 0 });
    const res = await handleCall(await h.request({ durationSeconds: 1 }), h.env);
    expect(await statusOf(res)).not.toBe("bad_number_mapping");
  });
});

describe("handleCall auth", () => {
  it("refuses every request when the signing key is still a placeholder", async () => {
    const h = makeCallEnv({ CALL_HMAC_KEY: "0".repeat(64) });
    const res = await handleCall(await h.request(), h.env);
    expect(res.status).toBe(503);
    expect(await statusOf(res)).toBe("not_configured");
  });

  it("rejects a missing or wrong signature", async () => {
    const h = makeCallEnv();
    const unsigned = await h.request();
    unsigned.headers.delete("x-signature");
    expect((await handleCall(unsigned, h.env)).status).toBe(401);

    const signed = await h.request();
    const tampered = new Request(signed, { headers: { ...Object.fromEntries(signed.headers), "x-signature": "0".repeat(64) } });
    expect((await handleCall(tampered, h.env)).status).toBe(401);
  });

  it("rejects a stale timestamp so a captured payload cannot be replayed later", async () => {
    const h = makeCallEnv();
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      callId: "call-1",
      dnis: DNIS,
      ani: "+1 415 555 0142",
      startTime: now - 120,
      durationSeconds: 120,
    });
    const stale = String(now - 3600);
    const req = new Request("https://tracker.example/call", {
      method: "POST",
      headers: { "x-timestamp": stale, "x-signature": await signHmac(SECRET, stale, body) },
      body,
    });
    const res = await handleCall(req, h.env);
    expect(res.status).toBe(401);
    expect(await statusOf(res)).toBe("stale_timestamp");
  });

  it("rejects an oversized body before verifying it", async () => {
    const h = makeCallEnv();
    const res = await handleCall(
      new Request("https://tracker.example/call", {
        method: "POST",
        headers: { "x-timestamp": "1", "x-signature": "x" },
        body: "x".repeat(80_000),
      }),
      h.env,
    );
    expect(res.status).toBe(413);
  });

  it("bounds a chunked body with no content-length header", async () => {
    // `content-length` is absent on a streamed request, so the cap has to be
    // enforced while reading: otherwise an unauthenticated caller can make the
    // isolate buffer an unbounded body before the signature is checked.
    const h = makeCallEnv();
    const chunk = new TextEncoder().encode("x".repeat(8_000));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 20) {
          controller.close();
          return;
        }
        sent++;
        controller.enqueue(chunk);
      },
    });
    const res = await handleCall(
      new Request("https://tracker.example/call", {
        method: "POST",
        headers: { "x-timestamp": "1", "x-signature": "x" },
        body,
        // @ts-expect-error — required by undici for a streamed body, not in the
        // Workers `RequestInit` type.
        duplex: "half",
      }),
      h.env,
    );
    expect(res.status).toBe(413);
  });

  it("rejects an unknown dialed number", async () => {
    const h = makeCallEnv();
    const res = await handleCall(await h.request({ dnis: "18005550999" }), h.env);
    expect(res.status).toBe(404);
    expect(await statusOf(res)).toBe("unknown_number");
  });
});

describe("handleCall outcome ledger", () => {
  // The conversion path had no observability outside the PBX's own logs, so
  // every refusal has to leave a row: a path that answers 401 or 404 to every
  // call is otherwise indistinguishable from a campaign that gets no calls.
  it("records a row for every refusal", async () => {
    const placeholder = makeCallEnv({ CALL_HMAC_KEY: "0".repeat(64) });
    await handleCall(await placeholder.request(), placeholder.env);
    expect(callOutcomes(placeholder.recon)).toEqual(["call_not_configured"]);

    const unauth = makeCallEnv();
    const unsigned = await unauth.request();
    unsigned.headers.delete("x-signature");
    await handleCall(unsigned, unauth.env);
    expect(callOutcomes(unauth.recon)).toEqual(["call_unauthorized"]);

    const noNumber = makeCallEnv();
    await handleCall(await noNumber.request({ dnis: "18005550999" }), noNumber.env);
    expect(callOutcomes(noNumber.recon)).toEqual(["call_unknown_number"]);

    const short = makeCallEnv();
    await handleCall(await short.request({ durationSeconds: 10 }), short.env);
    expect(callOutcomes(short.recon)).toEqual(["call_not_qualified"]);

    const malformed = makeCallEnv();
    await handleCall(await malformed.request({ durationSeconds: undefined }), malformed.env);
    expect(callOutcomes(malformed.recon)).toEqual(["call_bad_request"]);
  });

  it("records a row when the body is refused, including an unreadable one", async () => {
    const tooLarge = makeCallEnv();
    await handleCall(
      new Request("https://tracker.example/call", {
        method: "POST",
        headers: { "x-timestamp": "1", "x-signature": "x" },
        body: "x".repeat(80_000),
      }),
      tooLarge.env,
    );
    expect(callOutcomes(tooLarge.recon)).toEqual(["call_bad_request"]);

    // A caller that opens a body and never finishes it: the size cap never
    // trips, and the HMAC cannot be verified until the body arrives, so without
    // a read deadline this pins the isolate open for free.
    const stalled = makeCallEnv({ CALL_BODY_TIMEOUT_MS: "100" });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"callId":"x"'));
      },
      cancel() {
        /* the reader is cancelled on expiry */
      },
    });
    const stalledRes = await handleCall(
      new Request("https://tracker.example/call", {
        method: "POST",
        headers: { "x-timestamp": "1", "x-signature": "x" },
        body,
        // @ts-expect-error — required by undici for a streamed body, not in the
        // Workers `RequestInit` type.
        duplex: "half",
      }),
      stalled.env,
    );
    expect(stalledRes.status).toBe(400);
    expect(await statusOf(stalledRes)).toBe("bad_request");
    expect(callOutcomes(stalled.recon)).toEqual(["call_bad_request"]);
  });

  it("records a live send as fired and a test-mode send as a dry run", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    try {
      const live = makeCallEnv({
        CAPI_MODE: "live",
        CAPI_API_KEY: "live-key",
        CAPI_EVENT_GROUP_ID: "grp_live",
      });
      await handleCall(await live.request(), live.env);
      expect(callOutcomes(live.recon)).toEqual(["call_fired"]);

      // Test mode is validated by the platform but delivers nothing, so it must
      // not be reported as a delivered conversion.
      const test = makeCallEnv({ CAPI_MODE: "test", CAPI_EVENT_GROUP_ID: "grp_test" });
      const res = await handleCall(await test.request(), test.env);
      expect(await statusOf(res)).toBe("fired");
      expect(callOutcomes(test.recon)).toEqual(["call_dry_run"]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("handleCall idempotency", () => {
  it("holds the claim across a conversion that actually landed", async () => {
    const h = makeCallEnv({
      CAPI_MODE: "live",
      CAPI_API_KEY: "live-key",
      CAPI_EVENT_GROUP_ID: "grp_live",
    });
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    try {
      const first = await handleCall(await h.request(), h.env);
      expect(first.status).toBe(200);
      expect(await statusOf(first)).toBe("fired");

      const second = await handleCall(await h.request(), h.env);
      expect(await statusOf(second)).toBe("duplicate");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("releases the claim when nothing was sent", async () => {
    // Dry-run / unconfigured client: there is no conversion to be idempotent
    // about, so a deployment that shipped with CAPI_MODE=test must not block
    // the PBX's retries for the whole CALL_DEDUP_HOURS window once the config is
    // fixed.
    const h = makeCallEnv();
    const first = await handleCall(await h.request(), h.env);
    expect(await statusOf(first)).toBe("skipped");
    expect(h.seen.size).toBe(0);

    const second = await handleCall(await h.request(), h.env);
    expect(await statusOf(second)).toBe("skipped");
  });

  it("does not consume the claim on a sub-threshold call", async () => {
    // Qualifying before claiming means a short call cannot block a later,
    // genuinely qualifying event that reuses the callId.
    const h = makeCallEnv();
    const short = await handleCall(await h.request({ durationSeconds: 10 }), h.env);
    expect(await statusOf(short)).toBe("not_qualified");
    expect(h.seen.size).toBe(0);

    const long = await handleCall(await h.request({ durationSeconds: 300 }), h.env);
    expect(await statusOf(long)).toBe("skipped");
  });

  it("releases the claim when a later step throws, so the PBX retry can succeed", async () => {
    // Regression: without an error boundary after the claim, a throw left the
    // callId marked processed and the retry was answered "duplicate" — a
    // silently lost conversion.
    const h = makeCallEnv({
      RECENT: fakeDoNamespace(async () => {
        throw new Error("do unavailable");
      }),
    });

    const first = await handleCall(await h.request(), h.env);
    expect(first.status).toBe(502);
    expect(await statusOf(first)).toBe("internal_error");
    expect(h.seen.size).toBe(0);

    const retry = await handleCall(await h.request(), h.env);
    expect(await statusOf(retry)).toBe("internal_error");
  });

  it("releases the claim when the conversion API rejects the event", async () => {
    const h = makeCallEnv({
      CAPI_MODE: "live",
      CAPI_API_KEY: "live-key",
      CAPI_EVENT_GROUP_ID: "grp_live",
    });
    // postJson retries then gives up; the claim must not survive a failed send.
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response("nope", { status: 400 });
    try {
      const res = await handleCall(await h.request(), h.env);
      expect(res.status).toBe(502);
      expect(await statusOf(res)).toBe("capi_error");
      expect(h.seen.size).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("accepts a SIP-style call id end to end and remembers it once", async () => {
    const h = makeCallEnv({
      CAPI_MODE: "live",
      CAPI_API_KEY: "live-key",
      CAPI_EVENT_GROUP_ID: "grp_live",
    });
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    try {
      const callId = "a1b2c3@10.20.30.40";
      const first = await handleCall(await h.request({ callId }), h.env);
      expect(await statusOf(first)).toBe("fired");
      const second = await handleCall(await h.request({ callId }), h.env);
      expect(await statusOf(second)).toBe("duplicate");
      // The encoded key must not collide with an unencoded one.
      expect([...h.seen.keys()].some((k) => k.includes("a1b2c3%4010.20.30.40"))).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});
