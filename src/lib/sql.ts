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
 * Escape a string literal for embedding in WAE SQL. WAE has no parameter
 * binding, so we whitelist-validate IDs upstream and additionally escape here.
 */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
