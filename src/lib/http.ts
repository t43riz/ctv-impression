/**
 * Minimal bounded JSON POST with a single retry, shared by the conversion API
 * clients.
 *
 * Every outbound call in this Worker needs the same two properties: a hard
 * timeout (so a hung upstream cannot pin the invocation) and a bounded retry
 * on transient faults (so a blip does not permanently drop a conversion).
 * A durable retry belongs in a Queue; this covers the common case without
 * infrastructure that would have to be provisioned before the Worker deploys.
 */

/** Statuses worth a second attempt: transient backend or rate-limit faults. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface PostResult {
  ok: boolean;
  status: number;
  body: string;
  /** How many attempts were made (1 when the first succeeded). */
  attempts: number;
}

export interface PostOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  attempts?: number;
  /** Base backoff between attempts, multiplied by the attempt number. */
  backoffMs?: number;
}

/** Resolve a positive integer config value, falling back when unset/invalid. */
export function configInt(
  raw: string | undefined,
  fallback: number,
  min = 1,
): number {
  // A blank value must fall back, not parse as 0: `Number("")` is 0, which is
  // finite and would silently configure the bound to zero.
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i < min ? fallback : i;
}

/** Positive-integer guard for values that arrive already parsed. */
function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

/** Resolve a finite float config value within [min, max], else the fallback. */
export function configFloat(
  raw: string | undefined,
  fallback: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  // `Number("")` is 0, so a blank value would read as "use the floor of the
  // range" — for MIN_MATCH_CONFIDENCE that means sending device identifiers on
  // every match. Treat blank as unset.
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export async function postJson(
  url: string,
  payload: unknown,
  opts: PostOptions = {},
): Promise<PostResult> {
  const timeoutMs = positiveInt(opts.timeoutMs, 5000);
  const attempts = positiveInt(opts.attempts, 1);
  const backoffMs = positiveInt(opts.backoffMs, 250);

  let status = 0;
  let body = "";
  let attempt = 0;

  while (attempt < attempts) {
    attempt++;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...opts.headers,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = await res.text();
      status = res.status;
      if (res.ok) return { ok: true, status, body, attempts: attempt };
      if (!RETRYABLE_STATUS.has(status)) break;
    } catch (err) {
      // Timeout or transport failure: retryable.
      status = 0;
      body = err instanceof Error ? err.message : "network error";
    }
    if (attempt < attempts) {
      await new Promise((r) => setTimeout(r, backoffMs * attempt));
    }
  }

  return { ok: false, status, body, attempts: attempt };
}
