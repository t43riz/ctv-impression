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
 * Enumerate allowlisted campaign ids from the CAMPAIGNS namespace.
 *
 * `complete` is false when the listing was cut short, so the caller can report
 * a partial erasure instead of certifying a complete one.
 */
async function listCampaigns(env: Env): Promise<{ ids: string[]; complete: boolean }> {
  const ids: string[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_DSAR_CAMPAIGN_PAGES; page++) {
    const res = await env.CAMPAIGNS.list({ prefix: "campaign:", cursor });
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

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
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
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "bad json" }, 400);
    }
    const ifa = (body.ifa ?? "").trim();
    if (!ifa) {
      return json({ error: "ifa required" }, 400);
    }

    // The dedup store is sharded by campaign, so an erasure is only complete if
    // every campaign the subject could appear in is visited. A caller-supplied
    // list cannot be verified, and silently skipping an omitted campaign while
    // answering 200 would certify an erasure that did not happen. Enumerate the
    // allowlist instead and treat the caller's list as an optional narrowing.
    const requested = (body.campaigns ?? []).filter((c) => ID_RE.test(c));
    const enumerated = await listCampaigns(env);
    const campaigns = requested.length > 0 ? requested : enumerated.ids;

    if (campaigns.length === 0) {
      return json(
        {
          error: "no_campaigns",
          note:
            "No campaigns could be enumerated from the CAMPAIGNS namespace and none " +
            "were supplied. THIS REQUEST IS NOT COMPLETE — do not record it as fulfilled.",
        },
        500,
      );
    }

    // A truncated listing means the shard set is not provably complete.
    const scopeComplete = requested.length > 0 ? false : enumerated.complete;

    // Locate by hash (PRIVACY §4): current salt, plus previous during rotation.
    const hashes = [await hashIfa(env.IFA_HASH_SALT, ifa)];
    if (env.IFA_HASH_SALT_PREV) {
      hashes.push(await hashIfa(env.IFA_HASH_SALT_PREV, ifa));
    }

    let dedupDeleted = 0;
    for (const campaign of campaigns) {
      for (const h of hashes) {
        dedupDeleted += await eraseByHash(env.DEDUP, campaign, h);
      }
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
      return json(
        {
          error: "raw_erase_failed",
          detail: err instanceof Error ? err.message : String(err),
          dedup_deleted: dedupDeleted,
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

    // Partial scope is reported as 206, never as a clean 200: the raw tier
    // already refuses to certify an unverifiable erase, and the dedup tier must
    // not answer with more confidence than it has.
    if (!scopeComplete) {
      return json(
        {
          dedup_deleted: dedupDeleted,
          raw_tier: raw,
          campaigns_scanned: campaigns.length,
          scope_complete: false,
          note:
            (requested.length > 0
              ? "Erasure covered ONLY the campaigns supplied by the caller and the system " +
                "cannot verify that list is exhaustive. Omit `campaigns` to erase across " +
                "every allowlisted campaign. "
              : "The CAMPAIGNS listing was truncated, so the campaign set is not provably " +
                "complete. ") +
            "THIS REQUEST MAY BE INCOMPLETE — verify scope before recording it as " +
            "fulfilled. " +
            baseNote,
        },
        206,
      );
    }

    return json({
      dedup_deleted: dedupDeleted,
      raw_tier: raw,
      campaigns_scanned: campaigns.length,
      scope_complete: true,
      note: baseNote,
    });
  }

  return notFound();
}
