import type { Env, ImpressionRecord } from "./types";
import {
  extractImpression,
  dedupKey,
  prevSaltDedupKey,
  nonAttributableDedupKey,
} from "./lib/beacon";
import { isFirstSeen } from "./dedup";
import { recordRecent } from "./recent";
import { pixelResponse } from "./lib/pixel";
import { configInt, postJson } from "./lib/http";
import { runExport } from "./export";
import { handleCall } from "./call";
import { handleAdmin } from "./admin";
import { allowRequest } from "./ratelimit";
import { writeRawEvent } from "./raw";
import { recordRecon, terminalOutcomeRecorder } from "./lib/recon";
import { checkReconHealth, checkExportFreshness } from "./monitor";

export { DedupStore } from "./dedup";
export { RecentImpressions } from "./recent";
export { RateLimiter } from "./ratelimit";

/**
 * `campaign_id` arrives unvalidated on the recon path, and it is used as an
 * Analytics Engine blob/index. Clamp it to the same shape the ingest validator
 * accepts so a malformed or oversized value cannot fail the write itself.
 */
const RECON_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function reconCampaignId(raw: string | null): string {
  const v = (raw ?? "").trim();
  return RECON_ID_RE.test(v) ? v : "unknown";
}

async function handlePixel(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const campaign = reconCampaignId(url.searchParams.get("campaign_id"));

  // postalCode is deliberately not read: Roku's Ad Partner Data Processing
  // Policy §5 classes precise geo-location as Sensitive Data we may not
  // Process, and it is absent from the licensed Campaign Data list.
  const cfFull = request.cf as
    | { country?: string; region?: string; city?: string }
    | undefined;
  const trueIp = request.headers.get("CF-Connecting-IP") ?? "";

  // All counting work happens after we commit to returning the pixel, so a
  // slow dedup/allowlist lookup never delays the beacon response.
  const work = (async () => {
    // Exactly one terminal outcome per beacon keeps the ledger closed. Without
    // a guard a failure after counting (e.g. recordRecent rejecting) would emit
    // both `counted` and `reject_internal`, over-crediting an outcome and
    // hiding the imbalance from the health check. The guard itself is unit
    // tested in test/recon.test.ts.
    const end = terminalOutcomeRecorder(env);

    try {
      recordRecon(env, "received", campaign);

      // Global kill switch (DSA §2(b): Roku may demand removal of the pixel and
      // we must comply promptly). Serving the pixel keeps the tag owner's page
      // working; counting and matching stop.
      if (env.INGEST_DISABLED === "true") {
        end("disabled", campaign);
        return;
      }

      // Per-IP rate limit (SPEC §7.2). Over-limit beacons still get the pixel
      // (never reveal outcome); they are recorded and not counted. Fails open.
      // `configInt` so a typo cannot turn into "reject everything": a raw
      // `Number()` parse would yield NaN, and `1 <= NaN` is false in the DO.
      const limitPerMinute = configInt(env.RATE_LIMIT_PER_MINUTE, 120, 0);
      if (!(await allowRequest(env.RATE, trueIp, limitPerMinute))) {
        end("reject_rate_limited", campaign);
        return;
      }

      const result = await extractImpression(url, cfFull, env, nowSeconds);
      if (!result.ok) {
        end(`reject_${result.reason}`, campaign);
        // Rejections are the signal that a tag is misconfigured; log the reason
        // rather than every accepted beacon.
        console.log(`reject ${result.reason} campaign=${campaign}`);
        return;
      }

      const imp = result.impression;

      // Deduplication / replay guard. Attributable impressions key on the
      // salted IFA hash; the rest (LMT, child-directed, zeroed or unexpanded
      // IFA) fall back to a coarse salted IP + hour key so they are still
      // frequency-capped rather than counting without bound. During a salt
      // rotation the previous-salt key is checked as an alias.
      const ttl = configInt(env.DEDUP_WINDOW_HOURS, 24) * 3600;
      const dedupNonAttributable = env.DEDUP_NON_ATTRIBUTABLE !== "false";
      const dedupK =
        dedupKey(imp) ??
        (await nonAttributableDedupKey(env, imp, trueIp, nowSeconds, dedupNonAttributable));

      if (dedupK !== null) {
        const altKey = await prevSaltDedupKey(env, url, imp);
        const first = await isFirstSeen(env.DEDUP, imp.campaignId, dedupK, ttl, altKey);
        if (!first) {
          end("duplicate", imp.campaignId);
          return;
        }
      }

      // Count it. blobs ordered per schema; index = campaign_id for equitable
      // per-campaign sampling. doubles[0] = 1 (sum via sum(_sample_interval)).
      // Blobs 8-9 (ifa_type, platform) are append-only additions; older rows
      // read back as '' and queries must tolerate that.
      env.ANALYTICS.writeDataPoint({
        blobs: [
          imp.campaignId,
          imp.creativeId,
          imp.ifaHash,
          imp.country,
          imp.appId,
          imp.advertiserId,
          imp.ifaPresent ? "1" : "0",
          imp.ifaType,
          imp.platform,
        ],
        doubles: [1],
        indexes: [imp.campaignId],
      });
      end("counted", imp.campaignId);

      // Raw 30-day tier: unsampled, hashed-IFA rows for accurate
      // reach/frequency and DSAR erasure (SPEC §7.3).
      const rawWrite = writeRawEvent(env, imp, nowSeconds).catch((err) => {
        // Raw-tier failure must never affect counting, but it must be visible:
        // this tier is the DSAR erasure target and the reach/frequency source,
        // so a silent failure leaves a compliance gap. Recorded as an alert_*
        // side-channel outcome rather than a terminal one.
        console.log(
          `alert_raw_write_error campaign=${imp.campaignId}`,
          err instanceof Error ? err.message : String(err),
        );
        recordRecon(env, "alert_raw_write_error", imp.campaignId);
      });

      // Record into the matching store for call attribution. This holds the RAW
      // ip/ifa (the conversion APIs need them unhashed) for the attribution
      // window only. Every device identifier is "" under LMT so opted-out
      // devices are never device-matched.
      //
      // The IP follows the RIDA rather than being stored unconditionally: it is
      // a device identifier for this purpose, the conversion clients withhold it
      // under LMT anyway (src/lib/capi.ts, src/lib/capi_ua.ts), and a
      // child-directed campaign forces LMT — so storing it would retain a
      // child's device identifier for a send that provably never happens.
      const rawIfa = url.searchParams.get("ifa") ?? "";
      const rawHhId = url.searchParams.get("hh_id") ?? "";
      const rec: ImpressionRecord = {
        ts: nowSeconds,
        ip: imp.ifaPresent ? trueIp : "",
        rida: imp.ifaPresent ? rawIfa : "",
        hhId: imp.ifaPresent ? rawHhId : "",
        region: cfFull?.region ?? "",
        city: cfFull?.city ?? "",
        postal: "",
        // The device's actual opt-out signal, not the availability of its
        // identifier. These differ: an unexpanded `[[[RIDA]]]` macro leaves
        // `ifaPresent` false on a device that opted out of nothing, and this
        // field becomes `opt_out` on the conversion payload (src/lib/capi.ts).
        // Deriving it from `ifaPresent` reported a fabricated opt-out to the
        // platform and suppressed attribution the user never declined.
        lmt: imp.lmt,
      };
      // A non-finite window would make the DO's purge cutoff NaN and retain raw
      // IP/RIDA indefinitely, so fall back rather than propagate NaN.
      const windowMin = configInt(env.MATCH_WINDOW_MINUTES, 60);
      const recentWrite = recordRecent(env.RECENT, imp.creativeId, rec, windowMin).catch(
        (err) => {
          // This tier is the source of call attribution, so a silent failure
          // means conversions stop matching with no signal. It does not affect
          // counting, so it is an alert_* side-channel rather than a terminal
          // outcome: the ledger already closed with `counted`.
          console.log(
            `alert_recent_write_error campaign=${imp.campaignId}`,
            err instanceof Error ? err.message : String(err),
          );
          recordRecon(env, "alert_recent_write_error", imp.campaignId);
        },
      );
      await Promise.all([rawWrite, recentWrite]);
    } catch (err) {
      // Without this, a throwing dependency (KV, a Durable Object, R2) would be
      // swallowed by waitUntil: the impression would vanish with no outcome row
      // and no way to tell why. `end` makes this a no-op when a terminal
      // outcome was already recorded, so the ledger stays exact.
      console.log(
        `reject_internal campaign=${campaign}`,
        err instanceof Error ? err.stack ?? err.message : String(err),
      );
      end("reject_internal", campaign);
    }
  })();

  ctx.waitUntil(work);
  return pixelResponse();
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Liveness only: this answers "is the isolate serving?", which is what the
    // beacon path needs to stay up regardless of dependency state. Dependency
    // health is a separate, authenticated question — see /admin/health, which
    // returns 503 when reconciliation or export freshness fails. Keeping the
    // two apart stops a degraded backend from pulling the pixel out of DNS.
    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    // "/v1/pixel" is canonical; "/pixel" is a permanent alias. DSA §2(b)(3)
    // freezes the beacon URL once Roku certifies it, so a breaking change to
    // the query contract has to ship as "/v2/pixel" rather than a re-
    // certification of this one. The unversioned path stays served forever:
    // a CTV beacon is baked into ad creatives and served by devices that may
    // never be updated, so it can never be retired once handed out.
    if (url.pathname === "/v1/pixel" || url.pathname === "/pixel") {
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      return handlePixel(request, env, ctx);
    }

    if (url.pathname === "/call") {
      // The webhook is unauthenticated until its body has been read and the
      // HMAC checked, so the read itself (64 KiB, up to CALL_BODY_TIMEOUT_MS)
      // is work an anonymous caller can force. Budget it per IP the same way
      // the beacon is, before any of that work starts. Fails open.
      const callIp = request.headers.get("CF-Connecting-IP") ?? "";
      const callBudget = configInt(env.CALL_RATE_LIMIT_PER_MINUTE, 60, 0);
      if (!(await allowRequest(env.RATE, `call:${callIp}`, callBudget))) {
        recordRecon(env, "call_rate_limited", "unknown");
        // The limiter is a fixed one-minute window, so the exact wait is the
        // remainder of the current minute. Sent for the same reason 502/503
        // carry it: a PBX that has not read the docs should still learn when to
        // retry, and a retry aimed at the window boundary succeeds instead of
        // hitting a counter that has not reset yet.
        const retryAfter = 60 - (Math.floor(Date.now() / 1000) % 60);
        return new Response(JSON.stringify({ status: "rate_limited" }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(retryAfter),
          },
        });
      }
      return handleCall(request, env);
    }

    if (url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // "0 2 * * *"  -> daily export of yesterday's aggregates.
    // "30 3 * * *" -> health check written to _status/health.json for
    //                 external monitors (SPEC §7.1 alerts).
    // Both branches are guarded: an unhandled rejection inside `waitUntil` is
    // invisible, and `runExport` throws by design on a truncated read.
    if (event.cron === "30 3 * * *") {
      ctx.waitUntil(runHealthCheck(env));
      return;
    }
    ctx.waitUntil(
      runExport(env, event.scheduledTime).catch((err) => {
        console.log(
          "alert_export_failed",
          err instanceof Error ? err.stack ?? err.message : String(err),
        );
        recordRecon(env, "alert_export_failed", "unknown");
      }),
    );
  },
} satisfies ExportedHandler<Env>;

/**
 * Write the health artifact external monitors read.
 *
 * A failure here must publish a *red* artifact rather than propagate. The
 * previous version let the Analytics SQL call throw straight into `waitUntil`,
 * which skipped the `put` entirely and left the previous run's
 * `healthy: true` in place — so a broken health check and a healthy system were
 * indistinguishable to anything reading this file.
 */
async function runHealthCheck(env: Env): Promise<void> {
  let body: Record<string, unknown>;
  try {
    const [recon, exportFreshness] = await Promise.all([
      checkReconHealth(env),
      checkExportFreshness(env),
    ]);
    body = {
      ts: new Date().toISOString(),
      healthy: recon.healthy && exportFreshness.fresh,
      recon,
      export: exportFreshness,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log("alert_health_check_failed", detail);
    recordRecon(env, "alert_health_check_failed", "unknown");
    body = {
      ts: new Date().toISOString(),
      healthy: false,
      error: "health_check_failed",
      detail,
    };
  }

  try {
    await env.ARCHIVE.put("_status/health.json", JSON.stringify(body), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (err) {
    // R2 itself is down. Nothing left to write the signal to; log so the
    // failure is at least in Workers Logs rather than an unhandled rejection.
    console.log(
      "alert_health_write_failed",
      err instanceof Error ? err.message : String(err),
    );
    // Recorded in the ledger as well, unlike the two alerts above: this one
    // cannot appear in the artifact it failed to write, so the ledger is the
    // only remaining place a downstream monitor can see it.
    recordRecon(env, "alert_health_write_failed", "unknown");
  }

  await notifyIfUnhealthy(env, body);
}

/**
 * Deliver a red health result to `ALERT_WEBHOOK_URL`.
 *
 * The artifact in R2 is a record, not a notification: nothing reads it on a
 * schedule, so every health signal the ledger produces stops at a file. This is
 * the one push in the system. It is best-effort and deliberately narrow — a
 * failure to alert must not fail the cron or mask the health result itself.
 *
 * Unset by default: with no endpoint configured the behaviour is exactly as
 * before, so this cannot break a deployment that has not opted in.
 */
async function notifyIfUnhealthy(env: Env, body: Record<string, unknown>): Promise<void> {
  const url = env.ALERT_WEBHOOK_URL?.trim();
  if (!url || body.healthy === true) return;

  try {
    const res = await postJson(
      url,
      {
        text:
          `CTV impression worker: health check FAILED at ${String(body.ts)}` +
          (body.error ? ` (${String(body.error)})` : ""),
        health: body,
      },
      { timeoutMs: configInt(env.HTTP_TIMEOUT_MS, 5000), attempts: 2 },
    );
    if (!res.ok) {
      // Status only, deliberately. For most incident tools this URL *is* the
      // credential, and on a transport failure `postJson` puts the caught
      // error's message into `res.body` — workerd quotes the full request URL
      // there. Logging the body to diagnose a delivery failure is the obvious
      // next change and would publish a post-to-the-incident-channel secret
      // into Workers Logs, which more people can read than can read secrets.
      console.log(`alert_notify_failed status=${res.status}`);
      recordRecon(env, "alert_notify_failed", "unknown");
    }
  } catch (err) {
    // `postJson` converts transport failures into `ok: false`, so this is
    // reachable only if it is changed to rethrow. Kept as a boundary because a
    // throw here would escape into the cron, and redacted for the same reason
    // the branch above logs no body.
    console.log(
      `alert_notify_failed host=${safeHost(url)}`,
      err instanceof Error ? err.name : "error",
    );
    recordRecon(env, "alert_notify_failed", "unknown");
  }
}

/** Host only, for logging a URL that is itself a credential. */
function safeHost(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return "invalid-url";
  }
}
