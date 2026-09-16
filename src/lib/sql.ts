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
  return JSON.parse(text) as SqlResponse<T>;
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
