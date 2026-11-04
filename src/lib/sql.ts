import type { Env } from "../types";
import { isPlaceholderSecret } from "./crypto";
import { configInt } from "./http";

/**
 * Workers Analytics Engine SQL API client.
 *
 * IMPORTANT: the `ANALYTICS` binding is WRITE-ONLY. To read data you POST SQL
 * to the account-scoped REST endpoint with an "Account Analytics Read" token.
 * This module is the only read path in the system.
 *
 * All count/sum queries MUST weight by `_sample_interval` because WAE samples
 * at both write and read time. `sum(double0)` alone undercounts.
 */

const SQL_ENDPOINT = (accountId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;

export interface SqlResponse<T> {
  meta: { name: string; type: string }[];
  data: T[];
  rows: number;
  rows_before_limit_at_least?: number;
}

export class AnalyticsSqlError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "AnalyticsSqlError";
  }
}

/**
 * Execute a read query against the SQL API.
 * Returns parsed JSON rows typed as T.
 *
 * The request is bounded by a timeout so a hung control-plane call cannot pin
 * a Worker invocation (the daily export cron and /admin/* both run on this
 * path, and neither should hang indefinitely).
 */
export async function querySql<T = Record<string, unknown>>(
  env: Env,
  sql: string,
): Promise<SqlResponse<T>> {
  if (isPlaceholderSecret(env.ACCOUNT_ID) || isPlaceholderSecret(env.CF_API_TOKEN)) {
    throw new AnalyticsSqlError(
      "Analytics SQL is not configured (ACCOUNT_ID / CF_API_TOKEN still placeholders)",
      0,
      "",
    );
  }

  const res = await fetch(SQL_ENDPOINT(env.ACCOUNT_ID), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "text/plain",
    },
    body: sql,
    signal: AbortSignal.timeout(configInt(env.HTTP_TIMEOUT_MS, 5000, 100)),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new AnalyticsSqlError(
      `Analytics SQL query failed (${res.status})`,
      res.status,
      text,
    );
  }

  // The SQL API returns JSON with a `data` array (using FORMAT JSON).
  return coerceNumericColumns(JSON.parse(text) as SqlResponse<T>);
}

/** ClickHouse numeric column types, unwrapping one `Nullable(...)` layer. */
function isNumericSqlType(type: string): boolean {
  const inner = /^Nullable\((.+)\)$/.exec(type)?.[1] ?? type;
  return /^(U?Int(8|16|32|64|128|256)|Float(32|64)|Decimal)/.test(inner);
}

/**
 * Convert numeric columns from strings to numbers, in place.
 *
 * WAE serializes 64-bit integers as JSON *strings* (`"10"`), because they can
 * exceed what an IEEE double represents exactly. Every `sum(_sample_interval)`
 * and `count(DISTINCT ...)` therefore arrives as a string while the row types
 * declare `number`, and TypeScript cannot catch it across a `JSON.parse` cast.
 *
 * Left unconverted, arithmetic silently becomes string concatenation: the
 * health reconciler's `reduce((a, r) => a + r.events, 0)` produced `"010"`
 * instead of `10`, so every ledger total was a concatenation of its parts and
 * the counted-vs-accounted equality could never hold. Coercing at the only read
 * path keeps the fix in one place instead of at each of the six call sites.
 */
function coerceNumericColumns<T>(res: SqlResponse<T>): SqlResponse<T> {
  const numericCols = (res.meta ?? [])
    .filter((c) => isNumericSqlType(c.type))
    .map((c) => c.name);
  if (numericCols.length === 0) return res;

  for (const row of res.data ?? []) {
    const r = row as Record<string, unknown>;
    for (const col of numericCols) {
      const v = r[col];
      if (typeof v !== "string") continue;
      const n = Number(v);
      // A non-finite parse means the column was not really numeric; leave the
      // original value rather than substitute NaN, which would poison sums.
      if (Number.isFinite(n)) r[col] = n;
    }
  }
  return res;
}

/**
 * Characters permitted inside a WAE string literal built by `sqlString`.
 *
 * Deliberately conservative. WAE is ClickHouse-derived, where a backslash is an
 * escape *introducer* inside a literal, so doubling quotes alone is not a
 * complete defense: a value ending in a backslash escapes the closing quote and
 * the literal runs on into the query. Rather than chase escaping rules for a
 * dialect with no parameter binding, reject anything outside the set every
 * caller already validates against.
 */
const SQL_LITERAL_SAFE = /^[A-Za-z0-9_.:@ -]*$/;

export class UnsafeSqlLiteralError extends Error {
  constructor(value: string) {
    super(
      `refusing to interpolate an unsafe SQL literal (${JSON.stringify(value)}); ` +
        "WAE has no parameter binding, so values must be validated upstream",
    );
    this.name = "UnsafeSqlLiteralError";
  }
}

/**
 * Quote a string literal for embedding in WAE SQL.
 *
 * Throws rather than escapes when the value falls outside the safe set. Every
 * call site already gates on a narrow id pattern, so a rejection here means a
 * new caller skipped that gate — which must fail loudly at the boundary instead
 * of relying on an escaper to make arbitrary input safe.
 */
export function sqlString(value: string): string {
  if (!SQL_LITERAL_SAFE.test(value)) throw new UnsafeSqlLiteralError(value);
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Interpolate a bare numeric value into SQL (row counts, INTERVAL operands).
 *
 * The reporting queries build `INTERVAL '${n}' DAY` by interpolation, which is
 * safe only while every caller clamps first. This makes that requirement
 * enforced at the point of use rather than assumed.
 */
export function sqlNumber(value: number): number {
  if (!Number.isFinite(value)) {
    throw new UnsafeSqlLiteralError(String(value));
  }
  return Math.floor(value);
}
