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
 * Privacy: this is the ONLY place we hold the RAW device IP and RAW RIDA, and
 * only for the attribution window — Roku's CAPI requires them unhashed. An alarm
 * purges anything older than the window. RIDA is empty for LMT impressions.
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
      const requested = Number(url.searchParams.get("window"));
      const windowMin = Number.isFinite(requested) && requested > 0 ? requested : 60;
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
      await this.ensureAlarm(windowMin);
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

  /** Purge records older than the window; reschedule while rows remain. */
  async alarm(): Promise<void> {
    const stored = await this.state.storage.get<number>("windowMin");
    const windowMin = Number.isFinite(stored) && (stored as number) > 0 ? (stored as number) : 60;
    const cutoff = Math.floor(Date.now() / 1000) - windowMin * 60;
    this.sql.exec("DELETE FROM imp WHERE ts < ?", cutoff);
    const remaining =
      this.sql.exec<{ c: number }>("SELECT count(*) AS c FROM imp").toArray()[0]
        ?.c ?? 0;
    if (remaining > 0) {
      await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
    }
  }

  /**
   * Persist the window this instance retains on, and keep the purge alarm armed.
   *
   * The stored window is what `alarm()` purges against, so it has to track the
   * configured value. Lowering `MATCH_WINDOW_MINUTES` previously left the
   * instance purging on the *first* window it ever saw while `/match` queried
   * the new, shorter one: raw IP/RIDA then outlived the attribution window the
   * operator had asked for, with no signal. When the window shrinks the alarm is
   * re-armed immediately so the longer-retained rows are dropped on the next
   * tick rather than at the old cadence.
   */
  private async ensureAlarm(windowMin: number): Promise<void> {
    if (!Number.isFinite(windowMin) || windowMin <= 0) return;
    const stored = await this.state.storage.get<number>("windowMin");
    const shrank = typeof stored === "number" && windowMin < stored;
    if (stored !== windowMin) {
      await this.state.storage.put("windowMin", windowMin);
    }
    const current = await this.state.storage.getAlarm();
    if (current === null || shrank) {
      await this.state.storage.setAlarm(Date.now() + (shrank ? 0 : 5 * 60 * 1000));
    }
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
