/// <reference types="@cloudflare/workers-types" />

/**
 * RateLimiter: a Durable Object implementing a fixed-window per-key counter
 * (SPEC §7.2 "per-IP/IFA rate limiting for low-and-slow inflation").
 *
 * Keys are sharded across DO instances by `idFromName(bucket(key))` so one hot
 * IP cannot serialize the namespace. State is in-memory only — a window is a
 * minute, so losing counts on eviction is acceptable and keeps the hot path
 * storage-free.
 *
 * Over-limit beacons still receive the pixel (we never reveal outcomes to the
 * client); they are recorded as `reject_rate_limited` in reconciliation and
 * not counted.
 */
export class RateLimiter implements DurableObject {
  private counts = new Map<string, { window: number; n: number }>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/hit") {
      return new Response("not found", { status: 404 });
    }
    const key = url.searchParams.get("key") ?? "";
    const limit = Number(url.searchParams.get("limit") ?? "0");
    if (!key || limit <= 0) return Response.json({ allowed: true });

    const window = Math.floor(Date.now() / 60_000); // 1-minute fixed window
    const entry = this.counts.get(key);
    let n: number;
    if (entry && entry.window === window) {
      n = entry.n + 1;
      entry.n = n;
    } else {
      n = 1;
      this.counts.set(key, { window, n });
    }

    // Opportunistic cleanup of stale windows to bound memory.
    if (this.counts.size > 10_000) {
      for (const [k, v] of this.counts) {
        if (v.window !== window) this.counts.delete(k);
      }
    }

    return Response.json({ allowed: n <= limit });
  }
}

/** Stable small shard for a key so load spreads across DO instances. */
function shardFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return `shard-${Math.abs(h) % 64}`;
}

/**
 * Returns true when the request is within budget. `limitPerMinute <= 0`
 * disables limiting (always allowed). Fails open on DO errors — a rate-limit
 * outage must never take down ingestion.
 */
export async function allowRequest(
  ns: DurableObjectNamespace,
  key: string,
  limitPerMinute: number,
): Promise<boolean> {
  if (limitPerMinute <= 0 || !key) return true;
  try {
    const stub = ns.get(ns.idFromName(shardFor(key)));
    const res = await stub.fetch(
      `https://rate/hit?key=${encodeURIComponent(key)}&limit=${limitPerMinute}`,
    );
    const { allowed } = (await res.json()) as { allowed: boolean };
    return allowed;
  } catch {
    return true;
  }
}
