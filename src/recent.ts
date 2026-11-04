/// <reference types="@cloudflare/workers-types" />

import type { ImpressionRecord, MatchResult } from "./types";
import { scoreCandidates, DEFAULT_MAX_MATCH_CANDIDATES } from "./lib/match";

/**
 * RecentImpressions: a Durable Object holding the last N minutes of impressions
 * for ONE creative, used to match inbound phone calls back to a device/IP.
 *
 * Why a separate store (not Analytics Engine): AE is sampled and cannot return
 * individual rows, so it cannot be used for 1:1 matching. This DO keeps a small,
 * full-fidelity, short-lived set instead.
 *
 * Retention: rows are kept permanently (owner decision 2026-11-04). The match
 * window is applied as a query filter in `/match`, never as a deletion. The
 * raw device IP (and, on UA, the raw advertising ID) is also kept unhashed in
 * the R2 raw tier, which is bucket-locked against deletion. Both identifiers
 * are empty when the device opted out.
 *
 * Routing: callers use idFromName(creativeId) so all impressions and the call
 * lookup for a creative land on the same instance.
 */
export class RecentImpressions implements DurableObject {
  private state: DurableObjectState;
  private sql: SqlStorage;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS imp (
         ts INTEGER NOT NULL,
         ip TEXT NOT NULL,
         rida TEXT NOT NULL,
         region TEXT NOT NULL,
         city TEXT NOT NULL,
         postal TEXT NOT NULL,
         lmt INTEGER NOT NULL
       )`,
    );
    // Additive migration: household ID (UA). Safe on this table — contents are
    // ephemeral (purged within the attribution window).
    try {
      this.sql.exec("ALTER TABLE imp ADD COLUMN hh_id TEXT NOT NULL DEFAULT ''");
    } catch {
      // column already exists
    }
    this.sql.exec("CREATE INDEX IF NOT EXISTS imp_ts ON imp(ts)");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/record" && request.method === "POST") {
      const rec = (await request.json()) as ImpressionRecord;
      // A non-finite window would make the purge alarm's cutoff NaN, and
      // `DELETE ... WHERE ts < NaN` matches nothing — silently retaining raw
      // IP/RIDA past the attribution window. Never store anything but a
      // positive number.
      this.sql.exec(
        "INSERT INTO imp (ts, ip, rida, hh_id, region, city, postal, lmt) VALUES (?,?,?,?,?,?,?,?)",
        rec.ts,
        rec.ip,
        rec.rida,
        rec.hhId,
        rec.region,
        rec.city,
        rec.postal,
        rec.lmt ? 1 : 0,
      );
      // An alarm left armed by the purging version is cancelled so it can
      // never run a DELETE (the current alarm() is a no-op either way).
      if ((await this.state.storage.getAlarm()) !== null) {
        await this.state.storage.deleteAlarm();
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/match" && request.method === "POST") {
      const { callTs, windowMin, callerState, callerPostal, minConfidence, maxCandidates } =
        (await request.json()) as {
          callTs: number;
          windowMin: number;
          callerState: string;
          callerPostal: string;
          minConfidence?: number;
          maxCandidates?: number;
        };
      const since = callTs - windowMin * 60;
      const ceiling = maxCandidates ?? DEFAULT_MAX_MATCH_CANDIDATES;

      // Count first. Above the candidate ceiling the match is downgraded to
      // phone-only regardless of which rows we pick, so there is no reason to
      // ship thousands of candidate rows back to the Worker.
      const windowCount =
        this.sql
          .exec<{ c: number }>(
            "SELECT count(*) AS c FROM imp WHERE ts >= ? AND ts <= ?",
            since,
            callTs,
          )
          .toArray()[0]?.c ?? 0;

      if (windowCount === 0) {
        const empty: MatchResult = {
          matched: false,
          best: null,
          candidateCount: 0,
          confidence: 0,
          deviceIds: false,
          gate: "no_match",
        };
        return Response.json(empty);
      }

      if (windowCount > ceiling) {
        const gated: MatchResult = {
          matched: true,
          best: null,
          candidateCount: windowCount,
          confidence: 0, // not computed: the gate already decided
          deviceIds: false,
          gate: "too_many_candidates",
        };
        return Response.json(gated);
      }

      const rows = this.sql
        .exec<{
          ts: number;
          ip: string;
          rida: string;
          hh_id: string;
          region: string;
          city: string;
          postal: string;
          lmt: number;
        }>(
          "SELECT ts, ip, rida, hh_id, region, city, postal, lmt FROM imp " +
            "WHERE ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?",
          since,
          callTs,
          ceiling,
        )
        .toArray();

      const candidates: ImpressionRecord[] = rows.map((r) => ({
        ts: r.ts,
        ip: r.ip,
        rida: r.rida,
        hhId: r.hh_id,
        region: r.region,
        city: r.city,
        postal: r.postal,
        lmt: r.lmt === 1,
      }));

      const result: MatchResult = scoreCandidates(
        candidates,
        callTs,
        windowMin,
        callerState,
        callerPostal,
        undefined,
        minConfidence,
        maxCandidates,
      );
      return Response.json(result);
    }

    return new Response("not found", { status: 404 });
  }

  /**
   * Retention: nothing is ever deleted (owner decision 2026-11-04).
   *
   * This used to purge rows older than the match window, which destroyed the
   * raw IPs needed to re-run matching. `/match` already filters by
   * `ts >= callTs - window`, so retaining old rows changes no match result. The
   * handler is kept as a no-op so an alarm armed by an earlier version fires
   * harmlessly instead of running the old DELETE.
   */
  async alarm(): Promise<void> {
    // intentionally empty: retain all rows
  }

}

/** Helper: record an impression into the creative's matching store. */
export async function recordRecent(
  ns: DurableObjectNamespace,
  creativeId: string,
  rec: ImpressionRecord,
  windowMin: number,
): Promise<void> {
  const stub = ns.get(ns.idFromName(creativeId));
  await stub.fetch(`https://recent/record?window=${windowMin}`, {
    method: "POST",
    body: JSON.stringify(rec),
  });
}

/** Helper: match a call against a creative's recent impressions. */
export async function matchRecent(
  ns: DurableObjectNamespace,
  creativeId: string,
  callTs: number,
  windowMin: number,
  callerState: string,
  callerPostal: string,
  minConfidence?: number,
  maxCandidates?: number,
): Promise<MatchResult> {
  const stub = ns.get(ns.idFromName(creativeId));
  const res = await stub.fetch("https://recent/match", {
    method: "POST",
    body: JSON.stringify({
      callTs,
      windowMin,
      callerState,
      callerPostal,
      minConfidence,
      maxCandidates,
    }),
  });
  return (await res.json()) as MatchResult;
}
