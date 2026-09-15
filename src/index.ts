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
import { configInt } from "./lib/http";
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
      // window only. IDs are "" under LMT so opted-out devices are never
      // device-matched.
      const rawIfa = url.searchParams.get("ifa") ?? "";
      const rawHhId = url.searchParams.get("hh_id") ?? "";
      const rec: ImpressionRecord = {
        ts: nowSeconds,
        ip: trueIp,
        rida: imp.ifaPresent ? rawIfa : "",
        hhId: imp.ifaPresent ? rawHhId : "",
        region: cfFull?.region ?? "",
        city: cfFull?.city ?? "",
        postal: "",
        lmt: !imp.ifaPresent,
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

    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname === "/pixel") {
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      return handlePixel(request, env, ctx);
    }

    if (url.pathname === "/call") {
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
    if (event.cron === "30 3 * * *") {
      ctx.waitUntil(runHealthCheck(env));
      return;
    }
    ctx.waitUntil(runExport(env, event.scheduledTime));
  },
} satisfies ExportedHandler<Env>;

async function runHealthCheck(env: Env): Promise<void> {
  const [recon, exportFreshness] = await Promise.all([
    checkReconHealth(env),
    checkExportFreshness(env),
  ]);
  await env.ARCHIVE.put(
    "_status/health.json",
    JSON.stringify({
      ts: new Date().toISOString(),
      healthy: recon.healthy && exportFreshness.fresh,
      recon,
      export: exportFreshness,
    }),
    { httpMetadata: { contentType: "application/json" } },
  );
}
