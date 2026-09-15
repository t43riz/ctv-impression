/**
 * Test stand-ins for the Worker runtime pieces the unit suite needs but Node
 * does not provide: Durable Object SQLite, DO storage, Durable Object
 * namespaces, KV, R2 and Analytics Engine.
 *
 * These are deliberately small and *loud*. `fakeSql` implements exactly the
 * statements `DedupStore`, `RecentImpressions` and `RateLimiter` issue and
 * throws on anything else, so a new query fails the test instead of quietly
 * returning no rows and producing a green-but-worthless assertion.
 */

export type Row = Record<string, unknown>;

export interface FakeCursor {
  toArray(): Row[];
}

/** Minimal SQL surface for the two DOs' tables (`seen`, `imp`). */
export function fakeSql() {
  const seen = new Map<string, number>();
  const imp: Row[] = [];
  let changes = 0;

  const norm = (q: string) => q.replace(/\s+/g, " ").trim();
  const cursor = (rows: Row[]): FakeCursor => ({ toArray: () => rows });
  /**
   * DedupStore's /erase passes `LIKE '${escapedPrefix}%' ESCAPE '\'`, i.e. an
   * escaped literal followed by exactly one wildcard. Unescape the literal part
   * and drop the wildcard.
   */
  const likePrefix = (pattern: string) =>
    pattern.slice(0, -1).replace(/\\(.)/g, "$1");

  function exec(query: string, ...params: unknown[]): FakeCursor {
    const q = norm(query);

    if (/^CREATE (TABLE|INDEX)/i.test(q) || /^ALTER TABLE/i.test(q)) {
      return cursor([]);
    }

    // --- DedupStore -------------------------------------------------------
    if (q === "DELETE FROM seen WHERE k LIKE ? ESCAPE '\\'") {
      const prefix = likePrefix(String(params[0]));
      let n = 0;
      for (const k of [...seen.keys()]) {
        if (k.startsWith(prefix)) {
          seen.delete(k);
          n++;
        }
      }
      changes = n;
      return cursor([]);
    }
    if (q === "DELETE FROM seen WHERE exp <= ?") {
      const cutoff = Number(params[0]);
      let n = 0;
      for (const [k, exp] of [...seen.entries()]) {
        if (exp <= cutoff) {
          seen.delete(k);
          n++;
        }
      }
      changes = n;
      return cursor([]);
    }
    if (q === "SELECT changes() AS c") {
      return cursor([{ c: changes }]);
    }
    if (q === "SELECT count(*) AS c FROM seen") {
      return cursor([{ c: seen.size }]);
    }
    if (q === "SELECT k, exp FROM seen WHERE k IN (?, ?)") {
      return cursor(
        [String(params[0]), String(params[1])]
          .filter((k) => seen.has(k))
          .map((k) => ({ k, exp: seen.get(k) as number })),
      );
    }
    if (q === "SELECT k, exp FROM seen WHERE k = ?") {
      const k = String(params[0]);
      return cursor(seen.has(k) ? [{ k, exp: seen.get(k) as number }] : []);
    }
    if (
      q ===
      "INSERT INTO seen (k, exp) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET exp = excluded.exp"
    ) {
      seen.set(String(params[0]), Number(params[1]));
      return cursor([]);
    }

    // --- RecentImpressions ------------------------------------------------
    if (q.startsWith("INSERT INTO imp (ts, ip, rida, hh_id, region, city, postal, lmt)")) {
      const [ts, ip, rida, hhId, region, city, postal, lmt] = params;
      imp.push({ ts, ip, rida, hh_id: hhId, region, city, postal, lmt });
      return cursor([]);
    }
    if (q === "SELECT count(*) AS c FROM imp WHERE ts >= ? AND ts <= ?") {
      const [since, until] = params.map(Number);
      return cursor([{ c: imp.filter((r) => (r.ts as number) >= since && (r.ts as number) <= until).length }]);
    }
    if (
      q ===
      "SELECT ts, ip, rida, hh_id, region, city, postal, lmt FROM imp WHERE ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?"
    ) {
      const [since, until, limit] = params.map(Number);
      return cursor(
        imp
          .filter((r) => (r.ts as number) >= since && (r.ts as number) <= until)
          .sort((a, b) => (b.ts as number) - (a.ts as number))
          .slice(0, limit),
      );
    }
    if (q === "SELECT count(*) AS c FROM imp") {
      return cursor([{ c: imp.length }]);
    }
    if (q === "DELETE FROM imp WHERE ts < ?") {
      const cutoff = Number(params[0]);
      for (let i = imp.length - 1; i >= 0; i--) {
        if ((imp[i].ts as number) < cutoff) imp.splice(i, 1);
      }
      return cursor([]);
    }

    throw new Error(`fakeSql: unsupported statement: ${q}`);
  }

  return { exec, seen, imp };
}

export interface FakeDoState {
  state: DurableObjectState;
  sql: ReturnType<typeof fakeSql>;
  kv: Map<string, unknown>;
  getAlarm: () => number | null;
}

/** `DurableObjectState` stub: fake SQL plus in-memory storage and alarm. */
export function fakeDoState(): FakeDoState {
  const sql = fakeSql();
  const kv = new Map<string, unknown>();
  let alarm: number | null = null;

  const state = {
    storage: {
      sql,
      async get<T>(key: string): Promise<T | null> {
        return (kv.get(key) as T) ?? null;
      },
      async put(key: string, value: unknown) {
        kv.set(key, value);
      },
      async delete(key: string) {
        return kv.delete(key);
      },
      async getAlarm() {
        return alarm;
      },
      async setAlarm(t: number) {
        alarm = t;
      },
      async deleteAlarm() {
        alarm = null;
      },
      async transaction<T>(fn: () => Promise<T>) {
        return fn();
      },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>) {
      return fn();
    },
  };

  return {
    state: state as unknown as DurableObjectState,
    sql,
    kv,
    getAlarm: () => alarm,
  };
}

export interface RecordedFetch {
  url: string;
  init?: RequestInit;
}

/**
 * `DurableObjectNamespace` stub. `handler` receives the shard name the caller
 * resolved via `idFromName` and the constructed `Request`, so a test can assert
 * routing as well as the DO's behaviour.
 */
export function fakeDoNamespace(
  handler: (shard: string, request: Request) => Promise<Response>,
  calls?: RecordedFetch[],
) {
  return {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: async (input: string | Request, init?: RequestInit) => {
        const request = new Request(input as string, init);
        calls?.push({ url: request.url, init });
        return handler(id, request);
      },
    }),
  } as unknown as DurableObjectNamespace;
}

export interface FakeKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<{ keys: { name: string }[]; list_complete: boolean }>;
  map: Map<string, string>;
}

export function fakeKv(initial: Record<string, string> = {}): FakeKv {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async get(key) {
      return map.get(key) ?? null;
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
    async list() {
      return { keys: [...map.keys()].map((name) => ({ name })), list_complete: true };
    },
  };
}

export interface FakeR2 {
  put(
    key: string,
    value: string | ArrayBuffer,
    opts?: { customMetadata?: Record<string, string> },
  ): Promise<void>;
  get(key: string): Promise<{ json(): Promise<unknown>; text(): Promise<string> } | null>;
  list(opts?: { prefix?: string; cursor?: string; limit?: number; include?: string[] }): Promise<{
    objects: { key: string; customMetadata?: Record<string, string> }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<void>;
  objects: Map<string, { value: string; customMetadata?: Record<string, string> }>;
}

/**
 * R2 stand-in. Faithful about one thing that matters:
 * `customMetadata` is only returned when the caller asked for it via
 * `include`. R2 does not return it by default, so a fake that always returned
 * it would hide the most likely production failure of the DSAR erase (an
 * omitted `include` means no metadata, which means the erase cannot verify
 * ownership and must fail closed).
 */
export function fakeR2(): FakeR2 {
  const objects = new Map<string, { value: string; customMetadata?: Record<string, string> }>();
  return {
    objects,
    async put(key, value, opts) {
      objects.set(key, {
        value: typeof value === "string" ? value : new TextDecoder().decode(value),
        customMetadata: opts?.customMetadata,
      });
    },
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return {
        json: async () => JSON.parse(o.value),
        text: async () => o.value,
      };
    },
    async list(opts = {}) {
      const wantsMetadata = opts.include?.includes("customMetadata") ?? false;
      const matching = [...objects.entries()]
        .filter(([key]) => !opts.prefix || key.startsWith(opts.prefix))
        .map(([key, o]) => ({
          key,
          customMetadata: wantsMetadata ? o.customMetadata : undefined,
        }));
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const limit = opts.limit ?? 1000;
      const slice = matching.slice(start, start + limit);
      const next = start + limit;
      const truncated = next < matching.length;
      return { objects: slice, truncated, cursor: truncated ? String(next) : undefined };
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  };
}

export interface FakeAnalytics {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
  points: { blobs?: string[]; doubles?: number[]; indexes?: string[] }[];
  /** Make the next (or every) write throw, to exercise the caller's guard. */
  failWith(error: Error | null): void;
}

/**
 * Analytics Engine stand-in. `failWith` exists because `writeDataPoint` is the
 * one call the ingest path must never let break a beacon, and a fake that can
 * never throw cannot prove that.
 */
export function fakeAnalytics(): FakeAnalytics {
  const points: FakeAnalytics["points"] = [];
  let failure: Error | null = null;
  return {
    points,
    writeDataPoint(p) {
      if (failure !== null) throw failure;
      points.push(p);
    },
    failWith(error) {
      failure = error;
    },
  };
}

/** Collect the `ctx.waitUntil` promises a test must await before asserting. */
export function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        pending.push(p);
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
    async settle() {
      await Promise.all(pending);
    },
  };
}
