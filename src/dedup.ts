/// <reference types="@cloudflare/workers-types" />

/**
 * DedupStore: a Durable Object backing the "seen-key" set used for
 * deduplication and short-window replay protection.
 *
 * A key is `hash(ifaHash|campaignId|creativeId)` for a given dedup window.
 * Requests route to a DO instance via `idFromName(shardKey)` so load spreads
 * across many instances while a given identity is consistently hashed.
 *
 * Storage is SQLite-backed; we set an alarm to purge expired rows so the DO
 * does not grow unbounded.
 */
export class DedupStore implements DurableObject {
  private state: DurableObjectState;
  private sql: SqlStorage;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS seen (k TEXT PRIMARY KEY, exp INTEGER NOT NULL)",
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // DSAR erasure: delete all keys for a hashed identifier prefix.
    if (url.pathname === "/erase" && request.method === "POST") {
      const prefix = url.searchParams.get("prefix") ?? "";
      if (!prefix) return Response.json({ deleted: 0 });
      // Escape LIKE wildcards in the prefix, then match `${prefix}%`.
      const escaped = prefix.replace(/([%_\\])/g, "\\$1");
      this.sql.exec("DELETE FROM seen WHERE k LIKE ? ESCAPE '\\'", `${escaped}%`);
      const deleted = this.sql
        .exec<{ c: number }>("SELECT changes() AS c")
        .toArray()[0]?.c ?? 0;
      return Response.json({ deleted });
    }

    if (url.pathname !== "/check") {
      return new Response("not found", { status: 404 });
    }
    const key = url.searchParams.get("key") ?? "";
    // Optional alternate key (previous-salt hash) consulted during rotation.
    const altKey = url.searchParams.get("alt");
    const ttlSeconds = Number(url.searchParams.get("ttl") ?? "86400");
    const now = Math.floor(Date.now() / 1000);
    const exp = now + ttlSeconds;

    // Atomic: the SELECT and the INSERT below run in one synchronous block
    // (SqlStorage.exec does not yield), so no concurrent request can interleave
    // between the check and the write.
    const existing = altKey
      ? this.sql
          .exec<{ k: string; exp: number }>(
            "SELECT k, exp FROM seen WHERE k IN (?, ?)",
            key,
            altKey,
          )
          .toArray()
      : this.sql
          .exec<{ k: string; exp: number }>("SELECT k, exp FROM seen WHERE k = ?", key)
          .toArray();

    const primary = existing.find((r) => r.k === key);
    const alias = altKey ? existing.find((r) => r.k === altKey) : undefined;
    const primaryLive = primary !== undefined && primary.exp > now;
    const aliasLive = alias !== undefined && alias.exp > now;
    const isDuplicate = primaryLive || aliasLive;

    // Seed the current-salt key whenever it is not already live. That covers
    // the first sighting and, importantly, the rotation case where the match
    // came from the previous-salt alias only: without seeding, the
    // current-salt key would be absent when the rotation window closes and the
    // device would be counted a second time. A live primary key is deliberately
    // left untouched so the window stays fixed instead of sliding on repeats.
    if (!primaryLive) {
      this.sql.exec(
        "INSERT INTO seen (k, exp) VALUES (?, ?) " +
          "ON CONFLICT(k) DO UPDATE SET exp = excluded.exp",
        key,
        exp,
      );
      // Schedule periodic purge if not already scheduled.
      const current = await this.state.storage.getAlarm();
      if (current === null) {
        await this.state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
      }
    }

    return Response.json({ duplicate: isDuplicate });
  }

  /** Purge expired keys; reschedule while rows remain. */
  async alarm(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    this.sql.exec("DELETE FROM seen WHERE exp <= ?", now);
    const remaining = this.sql
      .exec<{ c: number }>("SELECT count(*) AS c FROM seen")
      .toArray()[0]?.c ?? 0;
    if (remaining > 0) {
      await this.state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    }
  }
}

/**
 * Helper used by the ingest Worker: returns true if this is the first time we
 * have seen `key` within the window (i.e. it should be counted).
 */
export async function isFirstSeen(
  ns: DurableObjectNamespace,
  shardKey: string,
  key: string,
  ttlSeconds: number,
  altKey?: string | null,
): Promise<boolean> {
  const id = ns.idFromName(shardKey);
  const stub = ns.get(id);
  const alt = altKey ? `&alt=${encodeURIComponent(altKey)}` : "";
  const res = await stub.fetch(
    `https://dedup/check?key=${encodeURIComponent(key)}&ttl=${ttlSeconds}${alt}`,
  );
  const { duplicate } = (await res.json()) as { duplicate: boolean };
  return !duplicate;
}

/**
 * DSAR helper: erase every dedup key beginning with `ifaHash` on the campaign
 * shard. Returns the number of rows deleted.
 */
export async function eraseByHash(
  ns: DurableObjectNamespace,
  shardKey: string,
  ifaHash: string,
): Promise<number> {
  const stub = ns.get(ns.idFromName(shardKey));
  const res = await stub.fetch(
    `https://dedup/erase?prefix=${encodeURIComponent(ifaHash)}`,
    { method: "POST" },
  );
  const { deleted } = (await res.json()) as { deleted: number };
  return deleted;
}
