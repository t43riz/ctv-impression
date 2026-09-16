import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";
import { DedupStore } from "../src/dedup";
import { RecentImpressions } from "../src/recent";
import { RateLimiter } from "../src/ratelimit";
import type { Env } from "../src/types";
import {
  fakeDoState,
  fakeDoNamespace,
  fakeKv,
  fakeR2,
  fakeAnalytics,
  fakeCtx,
  type FakeAnalytics,
  type FakeR2,
  type FakeSql,
  type RecordedFetch,
} from "./helpers/fakes";

const SALT = "a-real-salt-not-a-placeholder";
const IP = "198.51.100.9";

interface Harness {
  env: Env;
  recon: FakeAnalytics;
  analytics: FakeAnalytics;
  raw: FakeR2;
  archive: FakeR2;
  /** Matching-store DOs by creative, with their storage so tests can read it. */
  recent: Map<string, { store: RecentImpressions; kv: Map<string, unknown>; sql: FakeSql }>;
  /** Rows the matching store actually persisted for a creative. */
  recentRows(creativeId: string): Record<string, unknown>[];
  dedupShards: Map<string, DedupStore>;
  campaigns: ReturnType<typeof fakeKv>;
  /** Requests the Worker sent to the matching store, in order. */
  recentCalls: RecordedFetch[];
  /** Requests the Worker sent to the rate limiter, in order. */
  rateCalls: RecordedFetch[];
}

function makeHarness(over: Partial<Record<string, unknown>> = {}): Harness {
  const dedupShards = new Map<string, DedupStore>();
  const recent = new Map<
    string,
    { store: RecentImpressions; kv: Map<string, unknown>; sql: FakeSql }
  >();
  const rateLimits = new Map<string, RateLimiter>();
  const recentCalls: RecordedFetch[] = [];
  const rateCalls: RecordedFetch[] = [];

  const DEDUP = fakeDoNamespace(async (shard, request) => {
    let s = dedupShards.get(shard);
    if (!s) {
      s = new DedupStore(fakeDoState().state);
      dedupShards.set(shard, s);
    }
    return s.fetch(request);
  });

  const RECENT = fakeDoNamespace(async (shard, request) => {
    let entry = recent.get(shard);
    if (!entry) {
      const state = fakeDoState();
      entry = { store: new RecentImpressions(state.state), kv: state.kv, sql: state.sql };
      recent.set(shard, entry);
    }
    return entry.store.fetch(request);
  }, recentCalls);

  const RATE = fakeDoNamespace(async (shard, request) => {
    let s = rateLimits.get(shard);
    if (!s) {
      s = new RateLimiter();
      rateLimits.set(shard, s);
    }
    return s.fetch(request);
  }, rateCalls);

  const campaigns = fakeKv({ "campaign:camp1": "active" });
  const recon = fakeAnalytics();
  const analytics = fakeAnalytics();
  const raw = fakeR2();
  const archive = fakeR2();

  const env = {
    CAMPAIGNS: campaigns,
    DEDUP,
    RECENT,
    RATE,
    RAW: raw,
    ARCHIVE: archive,
    RECON: recon,
    ANALYTICS: analytics,
    // Tag signature verification is covered in beacon.test.ts; the ingest path
    // is what is under test here.
    SIGNATURE_REQUIRED: "false",
    IFA_HASH_SALT: SALT,
    ...over,
  } as unknown as Env;

  return {
    env,
    recon,
    analytics,
    raw,
    archive,
    recent,
    dedupShards,
    campaigns,
    recentCalls,
    rateCalls,
    recentRows: (creativeId: string) => recent.get(creativeId)?.sql.imp ?? [],
  };
}

function pixel(
  params: Record<string, string>,
  cf: object = { country: "US", region: "California", city: "SF" },
): Request {
  const url = new URL("https://tracker.example/pixel");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const req = new Request(url.toString(), { headers: { "CF-Connecting-IP": IP } });
  // `cf` is injected by the edge; attach it to the instance for the test.
  Object.defineProperty(req, "cf", { value: cf, configurable: true });
  return req;
}

const baseParams = {
  advertiser_id: "adv1",
  campaign_id: "camp1",
  creative_id: "cre1",
  ifa: "device-identifier-1",
  lmt: "0",
  app_id: "com.example.channel",
  ifa_type: "rida",
};

/** Beacons are processed in `ctx.waitUntil`, so settle before asserting. */
async function beacon(env: Env, params: Record<string, string>, cf?: object) {
  const { ctx, pending, settle } = fakeCtx();
  const res = await worker.fetch(pixel(params, cf), env, ctx);
  await settle();
  return { res, pending };
}

const outcomes = (recon: FakeAnalytics): string[] =>
  recon.points.map((p) => p.blobs?.[0] ?? "");

/** The terminal outcomes of the ledger, excluding `received` and `alert_*`. */
const terminal = (recon: FakeAnalytics): string[] =>
  outcomes(recon).filter((o) => o !== "received" && !o.startsWith("alert_"));

describe("pixel ingest", () => {
  it("serves the pixel and counts a valid beacon exactly once", async () => {
    const h = makeHarness();
    const { res } = await beacon(h.env, baseParams);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/gif");
    expect(outcomes(h.recon)).toEqual(["received", "counted"]);
    expect(h.analytics.points).toHaveLength(1);
    expect(h.analytics.points[0].blobs?.[0]).toBe("camp1");
    expect(h.analytics.points[0].blobs?.[2]).not.toBe("device-identifier-1");
  });

  it("closes the ledger exactly for every ingest outcome", async () => {
    // The ledger invariant the health check gates on: every received beacon
    // resolves to exactly one terminal outcome, with `alert_*` (which may
    // repeat) excluded. Each case asserts the exact outcome sequence, so a
    // terminal row that is missing or doubled fails here rather than showing up
    // as a permanently green health check. (The one-shot guard that stops a
    // *second* terminal row from being written is unit-tested directly in
    // test/recon.test.ts — no ingest path can reach it, by construction.)
    const cases: {
      name: string;
      params: Record<string, string>;
      over?: Record<string, unknown>;
      breakIt?: boolean;
      /** Beacons to send; the store persists across them. */
      beacons: number;
      terminal: string[];
    }[] = [
      { name: "counted", params: baseParams, beacons: 1, terminal: ["counted"] },
      { name: "duplicate", params: baseParams, beacons: 2, terminal: ["counted", "duplicate"] },
      {
        name: "reject_not_allowlisted",
        params: { ...baseParams, campaign_id: "nope" },
        beacons: 1,
        terminal: ["reject_not_allowlisted"],
      },
      {
        name: "reject_missing_params",
        params: { advertiser_id: "adv1" },
        beacons: 1,
        terminal: ["reject_missing_params"],
      },
      {
        name: "disabled",
        params: baseParams,
        over: { INGEST_DISABLED: "true" },
        beacons: 1,
        terminal: ["disabled"],
      },
      {
        name: "reject_rate_limited",
        params: baseParams,
        over: { RATE_LIMIT_PER_MINUTE: "1" },
        beacons: 2,
        terminal: ["counted", "reject_rate_limited"],
      },
      {
        name: "reject_internal",
        params: baseParams,
        breakIt: true,
        beacons: 1,
        terminal: ["reject_internal"],
      },
    ];

    for (const c of cases) {
      const h = makeHarness(c.over ?? {});
      if (c.breakIt) {
        h.campaigns.get = async () => {
          throw new Error("kv unavailable");
        };
      }
      // Different creatives keep the rate-limit case honest: the budget is
      // per-IP, so the second beacon is over budget regardless of creative.
      for (let i = 0; i < c.beacons; i++) {
        await beacon(h.env, c.params);
      }

      const received = outcomes(h.recon).filter((o) => o === "received").length;
      expect(received, `${c.name}: received`).toBe(c.beacons);
      expect(terminal(h.recon), `${c.name}: terminal outcomes`).toEqual(c.terminal);
    }
  });

  it("writes one raw row and one matching-store row", async () => {
    const h = makeHarness();
    await beacon(h.env, baseParams);

    expect(h.raw.objects.size).toBe(1);
    const row = JSON.parse([...h.raw.objects.values()][0].value) as Record<string, unknown>;
    expect(row.campaign_id).toBe("camp1");
    expect(row.ifa_present).toBe("1");
    expect(row.ifa_hash).not.toBe("device-identifier-1");

    expect(h.recent.size).toBe(1);
    expect(h.recent.get("cre1")).toBeDefined();
  });

  it("treats a replayed beacon as a duplicate and does not double-count", async () => {
    const h = makeHarness();
    await beacon(h.env, baseParams);
    await beacon(h.env, baseParams);

    expect(outcomes(h.recon)).toEqual(["received", "counted", "received", "duplicate"]);
    expect(h.analytics.points).toHaveLength(1);
    expect(h.raw.objects.size).toBe(1);
  });

  it("frequency-caps non-attributable beacons by coarse IP + hour", async () => {
    // LMT/zeroed/unexpanded IFAs have no dedup key of their own; without the
    // fallback they would count without bound.
    const h = makeHarness();
    await beacon(h.env, { ...baseParams, ifa: "00000000-0000-0000-0000-000000000000", lmt: "1" });
    await beacon(h.env, { ...baseParams, ifa: "00000000-0000-0000-0000-000000000000", lmt: "1" });

    expect(terminal(h.recon)).toEqual(["counted", "duplicate"]);
    expect(h.analytics.points).toHaveLength(1);
  });

  it("never writes a raw identifier for an opted-out device", async () => {
    const h = makeHarness();
    await beacon(h.env, { ...baseParams, ifa: "0", lmt: "1" });

    const row = JSON.parse([...h.raw.objects.values()][0].value) as Record<string, unknown>;
    expect(row.ifa_present).toBe("0");
    expect(row.ifa_hash).toBe("anon");
    expect(h.analytics.points[0].blobs?.[2]).toBe("anon");
  });

  it("withholds the device IP from the matching store under LMT", async () => {
    // An IP is a device identifier, and the conversion clients withhold it
    // under LMT anyway — so storing it retains an opted-out device's identifier
    // for a send that provably never happens.
    const h = makeHarness();
    await beacon(h.env, { ...baseParams, lmt: "1" });

    const recorded = h.recentRows("cre1");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].ip).toBe("");
    expect(recorded[0].rida).toBe("");
    expect(recorded[0].lmt).toBe(1);
  });

  it("withholds the device IP for a child-directed campaign", async () => {
    // COPPA: the allowlist value forces LMT treatment, so the same suppression
    // must apply to the highest-sensitivity population in the system.
    const h = makeHarness();
    h.campaigns.map.set("campaign:kids", "child_directed");
    await beacon(h.env, { ...baseParams, campaign_id: "kids", lmt: "0" });

    const recorded = h.recentRows("cre1");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].ip).toBe("");
    expect(recorded[0].rida).toBe("");
  });

  it("still records the IP for a consenting device", async () => {
    // The suppression must be scoped to opted-out traffic: attribution depends
    // on this IP for every other impression.
    const h = makeHarness();
    await beacon(h.env, baseParams);

    const recorded = h.recentRows("cre1");
    expect(recorded[0].ip).toBe(IP);
    expect(recorded[0].lmt).toBe(0);
  });

  it("does not mark a consenting device as opted out when its IFA is unusable", async () => {
    // An unexpanded macro leaves the identifier unusable, but the device opted
    // out of nothing. `lmt` becomes `opt_out` on the conversion payload, so
    // deriving it from identifier availability reports a fabricated opt-out to
    // the platform — a false statement about a user's choice under a signed
    // data agreement — and needlessly suppresses attribution.
    const h = makeHarness();
    await beacon(h.env, { ...baseParams, ifa: "[[[RIDA]]]", lmt: "0" });

    const recorded = h.recentRows("cre1");
    expect(recorded).toHaveLength(1);
    // Identifiers are still withheld: the IFA is genuinely unusable.
    expect(recorded[0].ip).toBe("");
    expect(recorded[0].rida).toBe("");
    // But the device is not reported as having opted out.
    expect(recorded[0].lmt).toBe(0);
  });

  it("marks a child-directed impression as opted out", async () => {
    // COPPA treatment is a real opt-out signal, unlike an unreadable IFA.
    const h = makeHarness();
    h.campaigns.map.set("campaign:kids", "child_directed");
    await beacon(h.env, { ...baseParams, campaign_id: "kids", lmt: "0" });

    expect(h.recentRows("cre1")[0].lmt).toBe(1);
  });

  it("rejects a beacon for a campaign that is not allowlisted", async () => {
    const h = makeHarness();
    await beacon(h.env, { ...baseParams, campaign_id: "unknown-camp" });

    expect(terminal(h.recon)).toEqual(["reject_not_allowlisted"]);
    expect(h.analytics.points).toHaveLength(0);
  });

  it("rejects a beacon with missing required parameters", async () => {
    const h = makeHarness();
    await beacon(h.env, { advertiser_id: "adv1" });
    expect(terminal(h.recon)).toEqual(["reject_missing_params"]);
  });

  it("honours the kill switch without counting", async () => {
    const h = makeHarness({ INGEST_DISABLED: "true" });
    const { res } = await beacon(h.env, baseParams);

    expect(res.status).toBe(200); // the tag owner's page keeps working
    expect(outcomes(h.recon)).toEqual(["received", "disabled"]);
    expect(h.analytics.points).toHaveLength(0);
    expect(h.raw.objects.size).toBe(0);
  });

  it("rate-limits an over-limit beacon instead of counting it", async () => {
    const h = makeHarness({ RATE_LIMIT_PER_MINUTE: "1" });
    await beacon(h.env, baseParams);
    await beacon(h.env, { ...baseParams, creative_id: "cre2" });

    expect(terminal(h.recon)).toEqual(["counted", "reject_rate_limited"]);
    expect(h.analytics.points).toHaveLength(1);
  });
});

describe("pixel ingest failure handling", () => {
  it("records exactly one terminal outcome when the ingest path throws", async () => {
    // Regression: an exception (here, a KV read failure) must produce
    // reject_internal and nothing else, so received === accounted holds and the
    // health check can see it.
    const h = makeHarness();
    h.campaigns.get = async () => {
      throw new Error("kv unavailable");
    };

    const { res } = await beacon(h.env, baseParams);

    expect(res.status).toBe(200); // still serves the pixel
    expect(outcomes(h.recon)).toEqual(["received", "reject_internal"]);
    expect(terminal(h.recon)).toHaveLength(1);
    expect(h.analytics.points).toHaveLength(0);
  });

  it("reports a raw-tier failure as a side-channel alert, not a second outcome", async () => {
    const h = makeHarness();
    h.raw.put = async () => {
      throw new Error("r2 down");
    };

    await beacon(h.env, baseParams);

    expect(outcomes(h.recon)).toEqual(["received", "counted", "alert_raw_write_error"]);
    // The conversion still counted, so the ledger closed before the alert.
    expect(terminal(h.recon)).toEqual(["counted"]);
    expect(h.analytics.points).toHaveLength(1);
  });

  it("reports a matching-store failure as a side-channel alert too", async () => {
    const h = makeHarness();
    const broken = fakeDoNamespace(async () => {
      throw new Error("do unavailable");
    });
    const env = {
      ...(h.env as unknown as Record<string, unknown>),
      RECENT: broken,
    } as unknown as Env;

    await beacon(env, baseParams);

    expect(outcomes(h.recon)).toEqual(["received", "counted", "alert_recent_write_error"]);
    expect(terminal(h.recon)).toEqual(["counted"]);
  });

  it("sends a usable match window, falling back when the configured one is not", async () => {
    // Asserted on the window the Worker *sends*, not on the value the matching
    // store ends up holding: the DO normalizes a non-positive/non-finite window
    // back to 60 on its own, so asserting the stored value passed even when the
    // Worker forwarded "-5" — which would have retained raw IP/RIDA under a NaN
    // purge cutoff only if the DO had not also guarded it.
    const cases: [string, number][] = [
      ["not-a-number", 60],
      ["-5", 60],
      ["0", 60],
      ["", 60],
      ["90", 90],
    ];

    for (const [configured, expected] of cases) {
      const h = makeHarness({ MATCH_WINDOW_MINUTES: configured });
      await beacon(h.env, baseParams);

      const record = h.recentCalls.find((c) => c.url.includes("/record"));
      expect(record, `MATCH_WINDOW_MINUTES=${configured}: recorded`).toBeDefined();
      const sent = new URL(record!.url).searchParams.get("window");
      expect(sent, `MATCH_WINDOW_MINUTES=${configured}: outgoing window`).toBe(String(expected));
      expect(h.recent.get("cre1")?.kv.get("windowMin")).toBe(expected);
    }
  });

  it("sends the configured per-IP budget, defaulting when it is not usable", async () => {
    // The budget reaches the limiter DO as a query param. A raw `Number()` parse
    // of a typo yields NaN, and the DO's `n <= NaN` is false — so an unguarded
    // value would reject *every* beacon rather than falling back.
    const cases: [string | undefined, string][] = [
      [undefined, "120"],
      ["", "120"],
      ["not-a-number", "120"],
      ["-1", "120"],
      ["5", "5"],
    ];

    for (const [configured, expected] of cases) {
      const h = makeHarness(configured === undefined ? {} : { RATE_LIMIT_PER_MINUTE: configured });
      await beacon(h.env, baseParams);

      const hit = h.rateCalls.find((c) => c.url.includes("/hit"));
      expect(hit, `RATE_LIMIT_PER_MINUTE=${configured}: limiter called`).toBeDefined();
      expect(new URL(hit!.url).searchParams.get("limit")).toBe(expected);
      expect(terminal(h.recon)).toEqual(["counted"]);
    }
  });

  it("stops consulting the limiter when the budget is zero", async () => {
    // "0" is the documented way to disable per-IP limiting, and it must not be
    // read as "allow zero": that would reject all traffic.
    const h = makeHarness({ RATE_LIMIT_PER_MINUTE: "0" });
    await beacon(h.env, baseParams);

    expect(h.rateCalls).toHaveLength(0);
    expect(terminal(h.recon)).toEqual(["counted"]);
  });

  it("keeps counting when the reconciliation write itself fails", async () => {
    // `recordRecon` is called from the ingest path and from its error handler,
    // so it must never throw: a throwing recon write would turn a handled
    // failure into an unhandled rejection inside waitUntil.
    const h = makeHarness();
    h.recon.failWith(new Error("analytics engine down"));

    await expect(beacon(h.env, baseParams)).resolves.toBeDefined();
    expect(h.analytics.points).toHaveLength(1);
    expect(h.raw.objects.size).toBe(1);
  });

  it("clamps an unvalidated campaign id before using it as a recon index", async () => {
    // campaign_id arrives unvalidated on this path and is written straight into
    // an Analytics Engine blob/index. A malformed or oversized value must become
    // "unknown" rather than being passed through.
    const h = makeHarness();
    await beacon(h.env, { ...baseParams, campaign_id: "x".repeat(500) });

    expect(h.recon.points.length).toBeGreaterThan(0);
    for (const p of h.recon.points) {
      expect(p.indexes?.[0]).toBe("unknown");
      expect((p.blobs?.[1] ?? "").length).toBeLessThanOrEqual(64);
    }
  });
});

describe("worker routing", () => {
  it("answers /healthz", async () => {
    const h = makeHarness();
    const res = await worker.fetch(new Request("https://tracker.example/healthz"), h.env, fakeCtx().ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("only serves the pixel on GET", async () => {
    const h = makeHarness();
    const res = await worker.fetch(
      new Request("https://tracker.example/pixel", { method: "POST" }),
      h.env,
      fakeCtx().ctx,
    );
    expect(res.status).toBe(405);
  });

  // DSA §2(b)(3) freezes the beacon URL at certification, so "/v1/pixel" is
  // the canonical path and "/pixel" is a permanent alias. The alias can never
  // be retired: it is baked into creatives served by devices that may never
  // update. These assert the two paths are the same handler, not merely that
  // both return 200 — an alias that silently skipped dedup or recon would
  // double-count while looking healthy.
  const pixelAt = (path: string) => {
    const url = new URL(`https://tracker.example${path}`);
    for (const [k, v] of Object.entries(baseParams)) url.searchParams.set(k, v);
    const req = new Request(url.toString(), { headers: { "CF-Connecting-IP": IP } });
    Object.defineProperty(req, "cf", {
      value: { country: "US", region: "California", city: "SF" },
      configurable: true,
    });
    return req;
  };

  const ingestVia = async (path: string) => {
    const h = makeHarness();
    const { ctx, settle } = fakeCtx();
    const res = await worker.fetch(pixelAt(path), h.env, ctx);
    await settle();
    return { h, res };
  };

  it("serves the versioned pixel path identically to the unversioned alias", async () => {
    const versioned = await ingestVia("/v1/pixel");
    const alias = await ingestVia("/pixel");

    for (const { res } of [versioned, alias]) {
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/gif");
    }

    // Same ledger, same counted impression, same hashed identifier: the alias
    // reaches the full ingest path rather than a stub that just returns a GIF.
    expect(outcomes(versioned.h.recon)).toEqual(["received", "counted"]);
    expect(outcomes(alias.h.recon)).toEqual(outcomes(versioned.h.recon));
    expect(versioned.h.analytics.points).toHaveLength(1);
    expect(alias.h.analytics.points).toHaveLength(1);
    expect(alias.h.analytics.points[0].blobs).toEqual(
      versioned.h.analytics.points[0].blobs,
    );
  });

  it("rejects a non-GET on the versioned pixel path", async () => {
    const h = makeHarness();
    const res = await worker.fetch(
      new Request("https://tracker.example/v1/pixel", { method: "POST" }),
      h.env,
      fakeCtx().ctx,
    );
    expect(res.status).toBe(405);
  });

  it("does not serve an unreleased pixel version", async () => {
    // Guards against matching on a prefix: only versions this Worker actually
    // implements may answer, so a future "/v2/pixel" cannot be silently served
    // by the v1 contract.
    const h = makeHarness();
    const res = await worker.fetch(pixelAt("/v2/pixel"), h.env, fakeCtx().ctx);
    expect(res.status).toBe(404);
  });

  it("404s an unknown path", async () => {
    const h = makeHarness();
    const res = await worker.fetch(new Request("https://tracker.example/nope"), h.env, fakeCtx().ctx);
    expect(res.status).toBe(404);
  });

  it("budgets /call per IP before reading the body", async () => {
    // The body read (64 KiB, up to CALL_BODY_TIMEOUT_MS) happens before the
    // HMAC can be verified, so it is work an anonymous caller can force.
    const h = makeHarness({ CALL_RATE_LIMIT_PER_MINUTE: "1", CALL_HMAC_KEY: "a-real-key" });
    const call = () =>
      worker.fetch(
        new Request("https://tracker.example/call", {
          method: "POST",
          headers: { "CF-Connecting-IP": IP },
          body: "{}",
        }),
        h.env,
        fakeCtx().ctx,
      );

    const first = await call();
    const second = await call();

    expect(second.status).toBe(429);
    expect(first.status).not.toBe(429);
    expect(outcomes(h.recon)).toContain("call_rate_limited");

    // The retry contract travels in the response, not only in the docs: the
    // limiter is a fixed one-minute window, so the remainder of the current
    // minute is the correct wait and a retry aimed at it succeeds.
    const retryAfter = Number(second.headers.get("Retry-After"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });
});

describe("scheduled jobs", () => {
  const run = async (env: Env, cron: string) => {
    const { ctx, settle } = fakeCtx();
    await worker.scheduled(
      { cron, scheduledTime: Date.now() } as ScheduledController,
      env,
      ctx,
    );
    await settle();
  };

  it("writes a red health artifact when the health check itself fails", async () => {
    // The check reads Analytics Engine over the network. Letting that throw
    // into waitUntil skipped the put entirely and left the *previous* run's
    // `healthy: true` in place, so a broken check and a healthy system looked
    // identical to anything reading this file.
    const h = makeHarness();
    await h.archive.put("_status/health.json", JSON.stringify({ healthy: true, ts: "old" }));

    await run(h.env, "30 3 * * *");

    const written = JSON.parse(
      (await (await h.archive.get("_status/health.json"))!.text()),
    ) as { healthy: boolean; error?: string };
    expect(written.healthy).toBe(false);
    expect(written.error).toBe("health_check_failed");
    expect(outcomes(h.recon)).toContain("alert_health_check_failed");
  });

  it("records an alert when the export fails instead of rejecting unhandled", async () => {
    // runExport throws by design on a truncated read; an unguarded waitUntil
    // turns that into an invisible unhandled rejection.
    const h = makeHarness();
    await run(h.env, "0 2 * * *");
    expect(outcomes(h.recon)).toContain("alert_export_failed");
  });

  it("records an alert when the health artifact cannot be written", async () => {
    // R2 refusing the artifact is the one failure that cannot be reported inside
    // the artifact itself, so the ledger is the only place a monitor can see it.
    const h = makeHarness({ ACCOUNT_ID: "acct-123", CF_API_TOKEN: "sql-read-token" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ meta: [], data: [], rows: 0 }), { status: 200 }),
      ),
    );
    h.archive.put = async () => {
      throw new Error("r2 down");
    };

    await run(h.env, "30 3 * * *");

    const recorded = outcomes(h.recon);
    // The check itself succeeded, so this row is attributable to the write.
    expect(recorded).not.toContain("alert_health_check_failed");
    expect(recorded).toContain("alert_health_write_failed");
  });

  it("pushes a red health result to the alert webhook", async () => {
    // The R2 artifact is a record, not a notification: nothing reads it on a
    // schedule. This is the only path that reaches a human.
    const posted: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        posted.push({ url, body: JSON.parse(String(init?.body)) });
        return new Response("ok", { status: 200 });
      }),
    );
    // No ACCOUNT_ID, so the health check fails and the artifact goes red.
    const h = makeHarness({ ALERT_WEBHOOK_URL: "https://hooks.example.com/abc" });

    await run(h.env, "30 3 * * *");

    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe("https://hooks.example.com/abc");
    const body = posted[0].body as { text: string; health: { healthy: boolean } };
    expect(body.text).toContain("health check FAILED");
    expect(body.health.healthy).toBe(false);
  });

  it("does not call the webhook when the health check is green", async () => {
    // An alert on every run is an alert on none of them.
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        // The Analytics SQL read the health check performs, and the export
        // freshness marker: both healthy.
        return new Response(JSON.stringify({ meta: [], data: [], rows: 0 }), { status: 200 });
      }),
    );
    const h = makeHarness({
      ACCOUNT_ID: "acct-123",
      CF_API_TOKEN: "sql-read-token",
      ALERT_WEBHOOK_URL: "https://hooks.example.com/abc",
    });
    // Export freshness reads a marker from R2; seed today's so it is fresh.
    await h.archive.put(
      "_status/last_export.json",
      JSON.stringify({ date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), ts: new Date().toISOString() }),
    );

    await run(h.env, "30 3 * * *");

    expect(calls).not.toContain("https://hooks.example.com/abc");
  });

  it("records an alert when the webhook itself fails", async () => {
    // A notifier that fails silently is worse than none: it implies delivery.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).startsWith("https://hooks.")
          ? new Response("nope", { status: 500 })
          : new Response(JSON.stringify({ meta: [], data: [], rows: 0 }), { status: 200 }),
      ),
    );
    const h = makeHarness({ ALERT_WEBHOOK_URL: "https://hooks.example.com/abc" });

    await run(h.env, "30 3 * * *");

    expect(outcomes(h.recon)).toContain("alert_notify_failed");
  });

  it("never logs the webhook URL when delivery fails at the transport", async () => {
    // The URL is the credential for most incident tools, and a transport
    // failure is exactly where it leaks: workerd quotes the full request URL in
    // the error, and `postJson` surfaces that message as `res.body`. Logging
    // that body to diagnose delivery is a one-line change away, so pin it.
    const logged: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).startsWith("https://hooks.")) {
          // Shaped like a real workerd transport failure, which quotes the URL.
          throw new TypeError(`Fetch API cannot load: ${String(url)}`);
        }
        return new Response(JSON.stringify({ meta: [], data: [], rows: 0 }), { status: 200 });
      }),
    );
    const h = makeHarness({ ALERT_WEBHOOK_URL: "https://hooks.example.com/s3cr3t-path" });

    await run(h.env, "30 3 * * *");

    expect(outcomes(h.recon)).toContain("alert_notify_failed");
    const notifyLogs = logged.filter((l) => l.includes("alert_notify_failed"));
    expect(notifyLogs.length).toBeGreaterThan(0);
    expect(notifyLogs.join("\n")).not.toContain("s3cr3t-path");
    logSpy.mockRestore();
  });

  it("does not attempt delivery when no webhook is configured", async () => {
    // The feature's promise is that an unconfigured deployment behaves exactly
    // as before. Without this, dropping the `!url` guard leaves the suite green
    // while production POSTs to "" on every red run — which throws, records
    // alert_notify_failed, and that outcome is gated, so every deployment that
    // never opted in goes red.
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ meta: [], data: [], rows: 0 }), { status: 200 });
      }),
    );
    // Configured enough to reach the Analytics SQL read (so there are real
    // outbound calls to compare against), but with no ALERT_WEBHOOK_URL. The
    // stale export marker makes the check red, which is the only state in which
    // delivery is attempted at all.
    const h = makeHarness({ ACCOUNT_ID: "acct-123", CF_API_TOKEN: "sql-read-token" });
    await h.archive.put(
      "_status/last_export.json",
      JSON.stringify({ date: "2020-01-01", ts: "2020-01-01T00:00:00.000Z" }),
    );

    await run(h.env, "30 3 * * *");

    // Asserting "no hooks.* call" would be vacuous: with the guard dropped the
    // Worker posts to the empty string, which is not a hooks URL either. Assert
    // instead that every outbound request had a real absolute URL, which the
    // unset case violates the moment delivery is attempted at all.
    expect(calls.length).toBeGreaterThan(0);
    for (const u of calls) expect(u).toMatch(/^https:\/\/.+/);
    expect(outcomes(h.recon)).not.toContain("alert_notify_failed");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
