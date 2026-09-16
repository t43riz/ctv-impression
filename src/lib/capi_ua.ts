import type { Env, MatchResult, CallEvent, NumberMapping } from "../types";
import { hashPhone, areaCodeToState } from "./phone";
import { postJson, configInt } from "./http";
import type { CapiResult } from "./capi";

/**
 * Universal Ads (Comcast / FreeWheel) Conversions API client.
 *
 * [CONFIRM WITH UA] — the endpoint, auth scheme, event schema, identifier
 * fields, opt-out token, and dedup key are provisioned during UA onboarding
 * (see docs/UA_ATTRIBUTION.md §5 / UA_SPEC.md §14). This client implements the
 * proposed default mapping and is HARD-GATED to test mode until
 * `UA_CAPI_ENDPOINT` is configured: without it, sends are skipped and the
 * payload is only validated locally/by unit tests.
 *
 * Differences from Roku:
 *   - `ifa` (generic device advertising ID) instead of `aRI`
 *   - `household_id` when the impression carried one
 */

export interface UaCapiUserData {
  is_hashed?: boolean;
  client_ip_address?: string;
  ifa?: string;
  household_id?: string;
  ph?: string;
  st?: string;
  zp?: string;
}

export interface UaCapiEvent {
  event_id: string;
  event_name: string;
  event_type: "conversion";
  event_time: number;
  event_source: "phone_call";
  user_data: UaCapiUserData;
  custom_data?: Record<string, unknown>;
  opt_out?: "true" | "false"; // [CONFIRM WITH UA] exact LDU token
}

export interface UaCapiPayload {
  event_group_id: string;
  events: UaCapiEvent[];
}

function eventId(call: CallEvent, creativeId: string): string {
  return `call_${call.callId}_${creativeId}`;
}

/** Build the UA CAPI payload. Pure (no network) so it is unit-testable. */
export async function buildUaCapiPayload(
  env: Env,
  call: CallEvent,
  mapping: NumberMapping,
  match: MatchResult,
): Promise<UaCapiPayload> {
  const phHash = await hashPhone(call.ani);
  const user: UaCapiUserData = { is_hashed: true, ph: phHash };

  // LMT is honored whether or not the match gates device identifiers in.
  const lmt = match.matched && match.best?.lmt === true;
  const optOut: "true" | "false" = lmt ? "true" : "false";

  // An LMT device is never device-matched (docs/PRIVACY.md §2.1), so its IP and
  // advertising ID are withheld together: only the hashed phone and coarse geo
  // remain.
  if (match.matched && match.best && match.deviceIds && !lmt) {
    // Written only when present: the record withholds ip/rida for any unusable
    // identifier, not only for an opt-out, so this branch is reachable with
    // them empty.
    if (match.best.ip) user.client_ip_address = match.best.ip;
    if (match.best.rida) user.ifa = match.best.rida; // "" under LMT
    if (match.best.hhId) user.household_id = match.best.hhId;
    if (match.best.region) user.st = match.best.region;
    if (match.best.postal) user.zp = match.best.postal;
  } else {
    // Zero match, or a match too weak to justify best-guess device
    // identifiers: fall back to hashed phone + coarse geo.
    const st = areaCodeToState(call.ani);
    if (st) user.st = st;
  }

  const custom: Record<string, unknown> = {
    content_ids: [mapping.creativeId],
    content_type: "product",
    match_candidates: match.candidateCount,
    // Only claims device resolution when identifiers were actually attached.
    match_type: match.deviceIds ? "probabilistic_ip" : "phone_only",
    match_gate: match.gate,
    call_duration_seconds: call.durationSeconds,
  };
  // The candidate-ceiling short-circuit has no score to report; omit rather
  // than ship a 0 that is indistinguishable from a real one.
  if (match.gate !== "too_many_candidates") {
    custom.match_confidence = match.confidence;
  }
  if (typeof call.saleValue === "number") {
    custom.value = call.saleValue;
    custom.currency = call.currency ?? "USD";
  }

  return {
    event_group_id: mapping.eventGroupId ?? env.CAPI_EVENT_GROUP_ID,
    events: [
      {
        event_id: eventId(call, mapping.creativeId),
        event_name: env.CAPI_EVENT_NAME || "LEAD",
        event_type: "conversion",
        event_time: call.startTime,
        event_source: "phone_call",
        user_data: user,
        custom_data: custom,
        opt_out: optOut,
      },
    ],
  };
}

/**
 * POST the payload to the UA CAPI.
 * Skips (never errors) until UA_CAPI_ENDPOINT is provisioned, and refuses a
 * live send without a key — mirrors the Roku client's guard.
 */
export async function sendToUaCapi(
  env: Env,
  payload: UaCapiPayload,
): Promise<CapiResult> {
  const mode = env.UA_CAPI_MODE === "live" ? "live" : "test";

  if (!env.UA_CAPI_ENDPOINT) {
    return {
      ok: false,
      status: 0,
      body: "UA_CAPI_ENDPOINT not configured [CONFIRM WITH UA]",
      mode,
      skipped: true,
    };
  }
  if (mode === "live" && !env.UA_CAPI_API_KEY) {
    return { ok: false, status: 0, body: "missing UA_CAPI_API_KEY", mode, skipped: true };
  }

  const base = env.UA_CAPI_ENDPOINT.replace(/\/$/, "");
  const url = mode === "live" ? `${base}/v1/events` : `${base}/v1/test_events`;

  // UA's dedup key and window are still unconfirmed ([CONFIRM WITH UA]), so a
  // retry cannot be assumed to be absorbed. Roku documents a 10-minute
  // event_id dedup window and is safe to retry; UA defaults to a single attempt
  // until its window is confirmed, so a retry cannot double-count a billable
  // conversion. Raise UA_CAPI_MAX_ATTEMPTS once documented.
  const res = await postJson(url, payload, {
    headers: { Authorization: `Bearer ${env.UA_CAPI_API_KEY ?? ""}` },
    timeoutMs: configInt(env.HTTP_TIMEOUT_MS, 5000, 100),
    attempts: configInt(env.UA_CAPI_MAX_ATTEMPTS, 1),
  });

  return {
    ok: res.ok,
    status: res.status,
    body: res.body,
    mode,
    attempts: res.attempts,
  };
}
