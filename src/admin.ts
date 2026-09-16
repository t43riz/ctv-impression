import type { Env } from "./types";
import { checkReconHealth, checkExportFreshness } from "./monitor";
import {
  impressionsByCampaign,
  impressionsByCountry,
  hourlyTrend,
  reachEstimate,
} from "./query";
import { backfill } from "./export";
import { hashIfa, isPlaceholderSecret } from "./lib/crypto";
import { configInt } from "./lib/http";
import { eraseByHash } from "./dedup";
import { eraseRawByHash } from "./raw";
import { recordRecon } from "./lib/recon";

/**
 * /admin/* — token-protected operational surface (SPEC §7.1, PRIVACY §4).
 *
 *   GET  /admin/health                          recon + export freshness
 *   GET  /admin/report/campaigns?days=7         impressions by campaign
 *   GET  /admin/report/countries?hours=24       impressions by country
 *   GET  /admin/report/hourly?hours=24          hourly trend
 *   GET  /admin/report/reach?campaign=X&days=30 reach ESTIMATE
 *   POST /admin/backfill?date=YYYY-MM-DD        re-run the daily export
 *   POST /admin/dsar   {ifa, campaigns[]}       DSAR erasure (dedup + raw tier)
 *
 * Auth: `Authorization: Bearer <ADMIN_TOKEN>`. Failures return 404 (not 401)
 * so the surface is not advertised to probes.
 */

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A DSAR failure response, always carrying `scope_complete: false`.
 *
 * PRIVACY §4 states the field is on *every* response from the route, because a
 * client that tests `scope_complete === false` rather than falsiness must reach
 * the same conclusion as one that reads the status code. Only the fully
 * enumerated success path returns `true`, so every other exit — a validation
 * rejection, an empty enumeration, an erase that stopped part-way, or a throw
 * caught by the admin boundary — goes through here. Enforced by a table test
 * over the whole failure surface, since a new `return json(...)` added to this
 * route would silently reintroduce the gap.
 */
function dsarError(body: Record<string, unknown>, status: number): Response {
  return json({ ...body, scope_complete: false }, status);
}

/** Constant-time comparison; both sides hashed to fixed length first. */
async function tokenOk(env: Env, header: string | null): Promise<boolean> {
  // A deploy still carrying the documented `.dev.vars.example` token has no
  // secret at all: this surface exposes reporting, backfill and *destructive*
  // DSAR erasure, so it must refuse a placeholder exactly as `/pixel` and
  // `/call` do rather than authenticate a value published in the repository.
  if (isPlaceholderSecret(env.ADMIN_TOKEN) || !header?.startsWith("Bearer ")) return false;
  const provided = header.slice(7);
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(env.ADMIN_TOKEN)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Safety bound on the campaign enumeration a single DSAR will walk. */
const MAX_DSAR_CAMPAIGN_PAGES = 20;

/**
 * Safety bound on the campaigns a single DSAR will erase across, whether the
 * list came from the caller or from enumeration. Each campaign costs one
 * Durable Object round trip (two during a salt rotation) before the raw-tier
 * scan even starts, and a Worker request is capped at 1000 subrequests; an
 * unbounded list runs out mid-erase.
 *
 * Applied to the merged list rather than only to the caller's: the enumerated
 * path is the default (omit `campaigns`), so bounding only the narrowing left
 * the common case unprotected.
 */
const MAX_DSAR_CAMPAIGNS = 200;

/** Keys per enumeration page. `MAX_DSAR_CAMPAIGNS / MAX_DSAR_CAMPAIGN_PAGES`. */
const DSAR_CAMPAIGN_PAGE_SIZE = 10;

/**
 * Enumerate allowlisted campaign ids from the CAMPAIGNS namespace.
 *
 * `complete` is false when the listing was cut short, so the caller can report
 * a partial erasure instead of certifying a complete one.
 */
async function listCampaigns(env: Env): Promise<{ ids: string[]; complete: boolean }> {
  const ids: string[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_DSAR_CAMPAIGN_PAGES; page++) {
    const res = await env.CAMPAIGNS.list({
      prefix: "campaign:",
      cursor,
      // Bound the page explicitly: KV defaults to 1000 keys, so the 20-page
      // walk could otherwise yield 20k campaigns and the erase loop below
      // would exceed the Worker's subrequest ceiling mid-erase.
      limit: DSAR_CAMPAIGN_PAGE_SIZE,
    });
    for (const k of res.keys) {
      const id = k.name.slice("campaign:".length);
      if (ID_RE.test(id)) ids.push(id);
    }
    if (res.list_complete) return { ids, complete: true };
    cursor = res.cursor;
    // A non-complete listing with no cursor cannot be advanced; stop rather
    // than re-reading the same page forever.
    if (!cursor) break;
  }

  return { ids, complete: false };
}

/**
 * Clamp a numeric query param into [min, max]. `Number(...) || fallback`
 * alone lets a negative value through, which reaches the query as
 * `INTERVAL '-5' DAY` and silently widens the result set.
 */
function clampParam(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

/**
 * Admin surface. Wrapped by an error boundary so a throwing dependency becomes
 * a recorded outcome rather than a bare runtime 500 (see `handleAdminInner`).
 */
export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    return await handleAdminInner(request, env);
  } catch (err) {
    // The report routes reach the Analytics SQL API, whose failures carry the
    // upstream response body. That detail belongs in the log, never in the
    // response: `AnalyticsSqlError` can quote a request that contains the
    // account id, and the caller only needs to know the route failed.
    console.log(
      `admin_internal_error path=${path}`,
      err instanceof Error ? err.stack ?? err.message : String(err),
    );
    // Split by route because the two have different frequency bounds, and
    // `INFRA_ALERTS` membership is a claim that a row can never be proportional
    // to traffic. A DSAR throw is operator-initiated but rare and carries a
    // legal obligation, so any occurrence should be fatal to health. The report
    // routes are also operator-initiated but unbounded — a dashboard refreshed
    // during an upstream blip would otherwise red-light health for 24h and page
    // someone for a transient failure on a read-only route.
    recordRecon(
      env,
      path === "/admin/dsar" ? "alert_admin_dsar_error" : "alert_admin_error",
      "unknown",
    );
    // A DSAR throw is still a DSAR response. The erasure's progress is unknown,
    // which is "not provably complete" rather than the absence of an answer.
    return path === "/admin/dsar"
      ? dsarError({ error: "internal_error" }, 500)
      : json({ error: "internal_error" }, 500);
  }
}

async function handleAdminInner(request: Request, env: Env): Promise<Response> {
  if (!(await tokenOk(env, request.headers.get("Authorization")))) {
    return notFound();
  }

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/admin/health" && request.method === "GET") {
    const [recon, exportFreshness] = await Promise.all([
      checkReconHealth(env),
      checkExportFreshness(env),
    ]);
    const healthy = recon.healthy && exportFreshness.fresh;
    return json({ healthy, recon, export: exportFreshness }, healthy ? 200 : 503);
  }

  if (path === "/admin/report/campaigns" && request.method === "GET") {
    const days = clampParam(url.searchParams.get("days"), 7, 1, 90);
    return json(await impressionsByCampaign(env, days));
  }

  if (path === "/admin/report/countries" && request.method === "GET") {
    const hours = clampParam(url.searchParams.get("hours"), 24, 1, 2160);
    return json(await impressionsByCountry(env, hours));
  }

  if (path === "/admin/report/hourly" && request.method === "GET") {
    const hours = clampParam(url.searchParams.get("hours"), 24, 1, 2160);
    return json(await hourlyTrend(env, hours));
  }

  if (path === "/admin/report/reach" && request.method === "GET") {
    const campaign = url.searchParams.get("campaign") ?? "";
    if (!ID_RE.test(campaign)) return json({ error: "invalid campaign" }, 400);
    const days = clampParam(url.searchParams.get("days"), 30, 1, 90);
    return json({
      note: "ESTIMATE ONLY — count(DISTINCT) on a sampled field; use raw R2 tier for accuracy",
      ...(await reachEstimate(env, campaign, days)),
    });
  }

  if (path === "/admin/backfill" && request.method === "POST") {
    const date = url.searchParams.get("date") ?? "";
    if (!DATE_RE.test(date)) return json({ error: "date must be YYYY-MM-DD" }, 400);
    const today = new Date().toISOString().slice(0, 10);
    if (date > today) {
      return json({ error: "cannot backfill a future date" }, 400);
    }
    const result = await backfill(env, date);
    // Re-exporting the current UTC day captures only the rows written so far and
    // overwrites the day's object, so the caller must be told the file is
    // partial rather than treating it as the finished export.
    return json(
      date === today
        ? {
            ...result,
            partial: true,
            note:
              "the current UTC day is still open — this object holds only the rows written so far; " +
              "re-run backfill after 00:00Z (or let the 02:00 cron run) for the complete export",
          }
        : result,
    );
  }

  if (path === "/admin/dsar" && request.method === "POST") {
    let body: { ifa?: string; campaigns?: string[] };
    try {
      const parsed: unknown = await request.json();
      // `null` (and a bare scalar) parses successfully, and the first property
      // read would then throw: a malformed body must not become an unhandled 500
      // on the one route that performs an irreversible erasure.
      if (parsed === null || typeof parsed !== "object") {
        return dsarError({ error: "bad json" }, 400);
      }
      body = parsed as typeof body;
    } catch {
      return dsarError({ error: "bad json" }, 400);
    }
    const ifa = (body.ifa ?? "").trim();
    if (!ifa) {
      return dsarError({ error: "ifa required" }, 400);
    }
    // A string here would reach `.filter` and throw, again as a 500.
    if (body.campaigns !== undefined && !Array.isArray(body.campaigns)) {
      return dsarError({ error: "campaigns must be an array of campaign ids" }, 400);
    }
    if ((body.campaigns ?? []).length > MAX_DSAR_CAMPAIGNS) {
      return dsarError(
        {
          error: "too_many_campaigns",
          note:
            `At most ${MAX_DSAR_CAMPAIGNS} campaigns may be supplied. ` +
            "Omit `campaigns` to erase across every allowlisted campaign.",
        },
        400,
      );
    }

    // The dedup store is sharded by campaign, so an erasure is only complete if
    // every campaign the subject could appear in is visited. A caller-supplied
    // list cannot be verified, and silently skipping an omitted campaign while
    // answering 200 would certify an erasure that did not happen. Enumerate the
    // allowlist instead and treat the caller's list as an optional narrowing.
    const requested = (body.campaigns ?? []).filter(
      (c) => typeof c === "string" && ID_RE.test(c),
    );
    const enumerated = await listCampaigns(env);
    const campaigns = requested.length > 0 ? requested : enumerated.ids;
    // The enumerated path cannot exceed the cap (the page walk is bounded to
    // exactly it), so this only ever trims a pathological listing. Applied
    // anyway: the bound that protects the subrequest budget should not depend
    // on two constants staying in sync elsewhere in the file.
    const capped = campaigns.slice(0, MAX_DSAR_CAMPAIGNS);

    if (capped.length === 0) {
      // A hard failure that erased nothing, so it reports partiality like every
      // other exit from the route: absent a field, a caller testing
      // `scope_complete === false` would read this as a completed erasure.
      return dsarError(
        {
          error: "no_campaigns",
          note:
            "No campaigns could be enumerated from the CAMPAIGNS namespace and none " +
            "were supplied. THIS REQUEST IS NOT COMPLETE — do not record it as fulfilled.",
        },
        500,
      );
    }

    // Scope is only provable when the listing finished, the caller did not
    // narrow it, and nothing was trimmed by the cap.
    const scopeComplete =
      requested.length === 0 && enumerated.complete && capped.length === campaigns.length;

    // Locate by hash (PRIVACY §4): current salt, plus previous during rotation.
    const hashes = [await hashIfa(env.IFA_HASH_SALT, ifa)];
    if (env.IFA_HASH_SALT_PREV) {
      hashes.push(await hashIfa(env.IFA_HASH_SALT_PREV, ifa));
    }

    let dedupDeleted = 0;
    let dedupCampaigns = 0;
    try {
      for (const campaign of capped) {
        for (const h of hashes) {
          dedupDeleted += await eraseByHash(env.DEDUP, campaign, h);
        }
        dedupCampaigns++;
      }
    } catch (err) {
      // Same rule as the raw tier below: an erase that did not finish is not a
      // success, and the caller needs to know how far it got so a re-run is
      // informed rather than blind.
      return dsarError(
        {
          error: "dedup_erase_failed",
          detail: err instanceof Error ? err.message : String(err),
          dedup_deleted: dedupDeleted,
          campaigns_scanned: dedupCampaigns,
          campaigns_planned: capped.length,
          note:
            "Dedup erasure stopped part-way. THIS REQUEST IS NOT COMPLETE — do not " +
            "record it as fulfilled; re-run once the Durable Object responds.",
        },
        500,
      );
    }

    const rawDays = configInt(env.RAW_RETENTION_DAYS, 31);
    const raw = { scanned: 0, deleted: 0, truncated: false, daysScanned: 0 };
    try {
      for (const h of hashes) {
        const r = await eraseRawByHash(env, h, { days: rawDays });
        raw.scanned += r.scanned;
        raw.deleted += r.deleted;
        raw.truncated = raw.truncated || r.truncated;
        raw.daysScanned = Math.max(raw.daysScanned, r.daysScanned);
      }
    } catch (err) {
      // eraseRawByHash fails closed when it cannot verify whether an object
      // belongs to the subject. Reporting a partial erasure as a success would
      // be a compliance failure, so surface it as an explicit 500.
      return dsarError(
        {
          error: "raw_erase_failed",
          detail: err instanceof Error ? err.message : String(err),
          dedup_deleted: dedupDeleted,
          // `raw_tier`/`campaigns_scanned` are reported so a re-run can be
          // scoped to what is left rather than starting blind.
          raw_tier: raw,
          campaigns_scanned: capped.length,
          note:
            "Dedup keys for the supplied campaigns were erased, but the raw R2 tier " +
            "could not be verified. THIS REQUEST IS NOT COMPLETE — do not record it " +
            "as fulfilled; investigate the raw-tier writer first.",
        },
        500,
      );
    }

    const baseNote =
      "RecentImpressions self-purges within the attribution window; " +
      "AE rows expire in 3 months and hold only the hash; " +
      "aggregates contain no identifiers. " +
      `Raw tier scanned over ${raw.daysScanned} days (RAW_RETENTION_DAYS); ` +
      "re-run if raw_tier.truncated. Coarse IP-derived frequency-cap keys in " +
      "the dedup store are not IFA-addressable and expire with their TTL.";

    // Partial scope is carried by `scope_complete`, not by the status code.
    // 206 is defined for range responses and is expected to carry
    // `Content-Range` (RFC 9110 §15.3.7); intermediaries and generated clients
    // are entitled to treat a 206 without it as a truncated body. The erasure
    // succeeded either way, so the status stays 200 and the caller reads the
    // field — which it must do regardless, since a complete-scope response can
    // still report `raw_tier.truncated`.
    if (!scopeComplete) {
      return json({
        dedup_deleted: dedupDeleted,
        raw_tier: raw,
        campaigns_scanned: capped.length,
        scope_complete: false,
        note:
          (requested.length > 0
            ? "Erasure covered ONLY the campaigns supplied by the caller and the system " +
              "cannot verify that list is exhaustive. Omit `campaigns` to erase across " +
              "every allowlisted campaign. "
            : capped.length < campaigns.length
              ? `The campaign set was trimmed to the first ${MAX_DSAR_CAMPAIGNS}. `
              : "The CAMPAIGNS listing was truncated, so the campaign set is not provably " +
                "complete. ") +
          "THIS REQUEST MAY BE INCOMPLETE — verify scope before recording it as " +
          "fulfilled. " +
          baseNote,
      });
    }

    return json({
      dedup_deleted: dedupDeleted,
      raw_tier: raw,
      campaigns_scanned: capped.length,
      scope_complete: true,
      note: baseNote,
    });
  }

  return notFound();
}
