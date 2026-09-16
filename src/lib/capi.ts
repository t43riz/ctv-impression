import type { Env, MatchResult, CallEvent, NumberMapping } from "../types";
import { hashPhone, areaCodeToState } from "./phone";
import { isPlaceholderSecret } from "./crypto";
import { postJson, configInt } from "./http";

/**
 * Roku Conversions API client.
 * Docs: https://help.ads.roku.com/en/articles/8880744-conversions-api
 *
 * Endpoint:
 *   live -> https://events.ads.rokuapi.net/v1/events
 *   test -> https://events.ads.rokuapi.net/v1/test_events   (validates only)
 *
 * NOTE: matching is PROBABILISTIC. The inbound call gives us only a phone
 * number — never a device ID — so any IP/RIDA we send is a best-guess
 * impression candidate, not a deterministic device match.
 *
 * Because the guess is probabilistic, device identifiers are only attached
 * when `MatchResult.deviceIds` is true (see src/lib/match.ts for the gate).
 * Below that bar the event is sent phone-only: hashed caller phone plus coarse
 * geo, which is the only certain key we hold.
 *
 * user_data carries, in order of strength:
 *   - ph                 (hashed caller phone, always)     [certain]
 *   - client_ip_address  (best-guess impression IP)        [probabilistic]
 *   - aRI                (best-guess impression RIDA)      [probabilistic, non-LMT]
 *   - st / ct            (state / city, from the impression when matched)
 *
 * Roku accepts considerably more than this (em, external_id, fn/ln, db, ge,
 * client_user_agent). Every one of those is advertiser-supplied CRM data that
 * this system never sees; adding them requires the advertiser to send the
 * fields on the /call webhook, and `client_user_agent` would additionally need
 * a DSA §14(i) cover-page amendment. See docs/ATTRIBUTION.md.
 */

const LIVE_URL = "https://events.ads.rokuapi.net/v1/events";
const TEST_URL = "https://events.ads.rokuapi.net/v1/test_events";

export interface CapiUserData {
  is_hashed?: boolean;
  client_ip_address?: string;
  aRI?: string;
  ph?: string;
  st?: string;
  ct?: string;
  // Always absent in practice: the beacon deliberately does not read
  // `cf.postalCode` (Roku's Ad Partner Data Processing Policy §5 classes
  // precise geo-location as Sensitive Data), so the stored record's `postal`
  // is always "". Kept because Roku accepts the field and the matching store
  // could carry it if the cover page is ever amended.
  zp?: string;
}

export interface CapiEvent {
  event_id: string;
  event_name: string;
  event_type: "conversion";
  event_time: number;
  event_source: "phone_call";
  user_data: CapiUserData;
  custom_data?: Record<string, unknown>;
  opt_out?: "true" | "false";
}

export interface CapiPayload {
  event_group_id: string;
  events: CapiEvent[];
}

export interface CapiResult {
  ok: boolean;
  status: number;
  body: string;
  mode: "test" | "live";
  skipped?: boolean;
  attempts?: number;
}

/**
 * Deterministic event_id for Roku's 10-minute dedup window. Tied to the call
 * and creative so retries/replays don't double-count.
 */
function eventId(call: CallEvent, creativeId: string): string {
  return `call_${call.callId}_${creativeId}`;
}

/** Attribution diagnostics attached to every event. */
function matchDiagnostics(match: MatchResult): Record<string, unknown> {
  const d: Record<string, unknown> = {
    match_candidates: match.candidateCount,
    // "probabilistic_ip" only when we actually attached device identifiers;
    // a gated match is reported as phone_only so the platform is not told the
    // attribution is device-resolved when it is not.
    match_type: match.deviceIds ? "probabilistic_ip" : "phone_only",
    match_gate: match.gate,
  };
  // The candidate-ceiling short-circuit never loads rows, so there is no score
  // to report. Omitting the field beats shipping 0, which is indistinguishable
  // from a real score.
  if (match.gate !== "too_many_candidates") {
    d.match_confidence = match.confidence;
  }
  return d;
}

/**
 * Build the CAPI payload from a call + match result. Pure (no network) so it is
 * unit-testable.
 */
export async function buildCapiPayload(
  env: Env,
  call: CallEvent,
  mapping: NumberMapping,
  match: MatchResult,
): Promise<CapiPayload> {
  const phHash = await hashPhone(call.ani);
  const user: CapiUserData = { is_hashed: true, ph: phHash };

  // LMT is a privacy signal and is honored whether or not the match gates
  // device identifiers in. It reflects a real opt-out (or a child-directed
  // campaign), never merely an unreadable identifier — reporting `opt_out` for
  // a device that opted out of nothing would misstate a user's choice.
  const lmt = match.matched && match.best?.lmt === true;
  const optOut: "true" | "false" = lmt ? "true" : "false";

  // An LMT device is never device-matched (docs/PRIVACY.md §2.1), so its IP is
  // withheld along with its RIDA: only the hashed phone and coarse geo remain.
  if (match.matched && match.best && match.deviceIds && !lmt) {
    // Each field is written only when actually present. The stored record
    // withholds ip/rida for any unusable identifier, not just an opt-out (an
    // unexpanded macro, a zeroed IFA, an unusable salt), so this branch is
    // reachable with them empty and must not emit empty identifier fields.
    if (match.best.ip) user.client_ip_address = match.best.ip;
    if (match.best.rida) {
      user.aRI = match.best.rida; // omitted under LMT (rida === "")
    }
    if (match.best.region) user.st = match.best.region;
    // City is already collected and stored with the impression; sending it
    // narrows the identity graph beyond state alone at no extra collection.
    if (match.best.city) user.ct = match.best.city;
    if (match.best.postal) user.zp = match.best.postal;
    // Fall back to the area-code state when the record carried no geo, so a
    // non-attributable match is not strictly worse than the phone-only path.
    if (!user.st) {
      const st = areaCodeToState(call.ani);
      if (st) user.st = st;
    }
  } else {
    // Phone-only path: zero match, or a match too weak to justify sending a
    // best-guess device identifier. Attribute via hashed phone + coarse geo.
    const st = areaCodeToState(call.ani);
    if (st) user.st = st;
  }

  const custom: Record<string, unknown> = {
    content_ids: [mapping.creativeId],
    content_type: "product",
    ...matchDiagnostics(match),
    call_duration_seconds: call.durationSeconds,
  };
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
 * POST the payload to Roku CAPI (test or live per CAPI_MODE).
 *
 * Bounded by HTTP_TIMEOUT_MS with one retry on transient faults; see
 * src/lib/http.ts.
 */
export async function sendToCapi(env: Env, payload: CapiPayload): Promise<CapiResult> {
  const mode = env.CAPI_MODE === "live" ? "live" : "test";
  const url = mode === "live" ? LIVE_URL : TEST_URL;

  // Guard: never attempt a live send without a key.
  if (mode === "live" && !env.CAPI_API_KEY) {
    return { ok: false, status: 0, body: "missing CAPI_API_KEY", mode, skipped: true };
  }
  // A placeholder event_group_id is rejected by the platform, so failing here
  // turns a confusing 4xx into a clear configuration error.
  if (isPlaceholderSecret(payload.event_group_id)) {
    return {
      ok: false,
      status: 0,
      body: "CAPI_EVENT_GROUP_ID is still a placeholder",
      mode,
      skipped: true,
    };
  }

  const res = await postJson(url, payload, {
    headers: { Authorization: `Bearer ${env.CAPI_API_KEY}` },
    timeoutMs: configInt(env.HTTP_TIMEOUT_MS, 5000, 100),
    attempts: configInt(env.CAPI_MAX_ATTEMPTS, 2),
  });

  return {
    ok: res.ok,
    status: res.status,
    body: res.body,
    mode,
    attempts: res.attempts,
  };
}
