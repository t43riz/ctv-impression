import type { Env, CallEvent, NumberMapping } from "./types";
import { verifyTimestampedSignature, isPlaceholderSecret } from "./lib/crypto";
import { configInt, configFloat } from "./lib/http";
import { isFirstSeen, eraseByHash } from "./dedup";
import { matchRecent } from "./recent";
import { areaCodeToState } from "./lib/phone";
import { buildCapiPayload, sendToCapi } from "./lib/capi";
import { buildUaCapiPayload, sendToUaCapi } from "./lib/capi_ua";
import { recordCallOutcome } from "./lib/recon";

/**
 * /call ingest: the PBX POSTs a qualified-call webhook here on call end.
 *
 * Flow:
 *   1. Authenticate: HMAC of `<timestamp>.<raw body>` (headers `x-timestamp`,
 *      `x-signature`). Binding the timestamp is what stops a captured payload
 *      from being replayed into a second conversion.
 *   2. Validate fields (a missing duration must not slip past qualification).
 *   3. Resolve dialed number (DNIS) -> creative via NUMBERS registry.
 *   4. Qualify by duration (before claiming, so a sub-threshold call does not
 *      consume the callId's claim).
 *   5. Claim the callId so a replay cannot fire twice. From here every exit
 *      path releases the claim unless the conversion actually landed.
 *   6. Match against the creative's recent impressions (time + geo).
 *   7. Build + send the conversion, attaching device identifiers only when the
 *      match gate allows it.
 *
 * Returns a JSON summary (useful for PBX-side logging / our debugging).
 */

interface CallResponse {
  status: string;
  matched?: boolean;
  confidence?: number;
  /** Set instead of `confidence` when no score was computed. */
  confidenceOmitted?: string;
  candidates?: number;
  gate?: string;
  capi?: { mode: string; status: number; ok: boolean; skipped?: boolean; attempts?: number };
}

function json(body: CallResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A call this old cannot match any impression in the attribution window. */
const MAX_CALL_AGE_SECONDS = 86_400;

/**
 * Upper bound on the webhook body. The handler reads the whole body to verify
 * the HMAC, so an unbounded body is unbounded CPU and memory inside a 128 MB
 * isolate. A qualified-call payload is a few hundred bytes.
 */
const MAX_CALL_BODY_BYTES = 64 * 1024;

/**
 * Deadline for reading the body. `content-length` bounds nothing about *time*:
 * a caller can hold the connection open and stream one byte at a time, keeping
 * the isolate (and the HMAC verification that cannot start until the body
 * arrives) alive for the whole request lifetime. The read is abandoned on
 * expiry and the call is refused unauthenticated.
 */
const CALL_BODY_READ_TIMEOUT_MS = 10_000;

/**
 * Charset bound on `callId`. Deliberately permissive: a PBX may legitimately
 * forward its SIP `Call-ID` (`localpart@host`) or use punctuation. Only control
 * characters and an implausible length are rejected, and the value is
 * percent-encoded before it becomes part of an idempotency key.
 */
const CALL_ID_MAX_LEN = 128;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Same id shape the beacon path enforces. */
const MAPPING_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Upper bound on a per-number qualification override. A registry entry is
 * operator-entered and reaches this code unvalidated otherwise, so a stray
 * `qualifySeconds` would silently redefine what counts as a billable call.
 */
const MAX_QUALIFY_SECONDS = 86_400;

/**
 * Validate a tracking-number registry entry before any of it is trusted.
 *
 * These fields select a Durable Object instance (`creativeId`), form part of an
 * idempotency key, choose the conversion platform, and set the billing
 * threshold. Every other identifier in the system is shape-checked; this one
 * arrives from an operational KV write, which is exactly where a typo lands.
 */
export function isValidNumberMapping(m: unknown): m is NumberMapping {
  if (m === null || typeof m !== "object") return false;
  const v = m as Partial<NumberMapping>;

  if (!MAPPING_ID_RE.test(v.creativeId ?? "")) return false;
  if (v.campaignId !== undefined && !MAPPING_ID_RE.test(v.campaignId)) return false;
  if (v.advertiserId !== undefined && !MAPPING_ID_RE.test(v.advertiserId)) return false;
  if (v.platform !== undefined && v.platform !== "roku" && v.platform !== "ua") return false;
  if (v.eventGroupId !== undefined && !MAPPING_ID_RE.test(v.eventGroupId)) return false;

  if (v.qualifySeconds !== undefined) {
    // A 0 is meaningful ("every call qualifies") and is kept, but it has to be
    // a deliberate, in-range number rather than whatever JSON supplied.
    if (
      typeof v.qualifySeconds !== "number" ||
      !Number.isFinite(v.qualifySeconds) ||
      v.qualifySeconds < 0 ||
      v.qualifySeconds > MAX_QUALIFY_SECONDS
    ) {
      return false;
    }
  }

  return true;
}

export interface CallValidation {
  ok: boolean;
  reason?: "bad_json" | "missing_fields" | "bad_fields";
  call?: CallEvent;
}

/**
 * Parse and validate a call webhook body. Pure, so the field rules (especially
 * the duration rule) are unit-testable.
 */
export function validateCallEvent(raw: string, nowSeconds: number): CallValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "bad_json" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, reason: "bad_json" };
  }

  const c = parsed as Partial<CallEvent>;

  if (
    typeof c.callId !== "string" ||
    c.callId.length === 0 ||
    typeof c.dnis !== "string" ||
    c.dnis.length === 0 ||
    typeof c.ani !== "string" ||
    c.ani.length === 0
  ) {
    return { ok: false, reason: "missing_fields" };
  }

  // The callId is percent-encoded into an idempotency key, so only control
  // characters and an implausible length are rejected. A narrower charset would
  // break PBX integrations that forward a SIP `Call-ID`.
  if (c.callId.length > CALL_ID_MAX_LEN || CONTROL_CHARS.test(c.callId)) {
    return { ok: false, reason: "bad_fields" };
  }

  // `durationSeconds` must be a real number. `undefined < threshold` evaluates
  // to false, so a payload with no duration would otherwise pass qualification
  // and fire a billable conversion.
  if (
    typeof c.durationSeconds !== "number" ||
    !Number.isFinite(c.durationSeconds) ||
    c.durationSeconds < 0
  ) {
    return { ok: false, reason: "bad_fields" };
  }

  if (typeof c.startTime !== "number" || !Number.isFinite(c.startTime)) {
    return { ok: false, reason: "bad_fields" };
  }
  if (c.startTime > nowSeconds + 300 || nowSeconds - c.startTime > MAX_CALL_AGE_SECONDS) {
    return { ok: false, reason: "bad_fields" };
  }

  if (c.saleValue !== undefined && (typeof c.saleValue !== "number" || !Number.isFinite(c.saleValue))) {
    return { ok: false, reason: "bad_fields" };
  }

  // Both numbers must carry a usable subscriber number.
  if (c.dnis.replace(/\D/g, "").length < 10 || c.ani.replace(/\D/g, "").length < 10) {
    return { ok: false, reason: "bad_fields" };
  }

  return { ok: true, call: c as CallEvent };
}

/**
 * Outer error boundary for the whole conversion path.
 *
 * The inner handler's `try` can only start after the idempotency claim exists,
 * so the I/O before it (the NUMBERS registry read and the claim itself) used to
 * throw straight past it: the runtime answered a bare 500 and *no* `call_*`
 * ledger row was written. A KV or Durable Object outage — exactly what the
 * ledger exists to surface — therefore left `callAttempts` flat and
 * `callHealthy` green. Every exit from `/call` must leave an outcome behind.
 */
export async function handleCall(request: Request, env: Env): Promise<Response> {
  try {
    return await handleCallInner(request, env);
  } catch (err) {
    console.log(
      "call_internal_error stage=pre_claim",
      err instanceof Error ? err.stack ?? err.message : String(err),
    );
    recordCallOutcome(env, "internal_error", "unknown");
    return json({ status: "internal_error" }, 502);
  }
}

async function handleCallInner(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ status: "method_not_allowed" }, 405);

  // A placeholder signing key means anyone can forge a webhook.
  if (isPlaceholderSecret(env.CALL_HMAC_KEY)) {
    recordCallOutcome(env, "not_configured", "unknown");
    return json({ status: "not_configured" }, 503);
  }

  // Bound the read itself, both in size and in time. A `content-length` header
  // is advisory: it can be absent (chunked) or understated, and reading
  // `request.text()` unbounded would let an unauthenticated caller force a
  // full-body buffer inside a 128 MB isolate before the signature is ever
  // checked — or hold the isolate open indefinitely by trickling bytes.
  const read = await readBoundedText(
    request,
    MAX_CALL_BODY_BYTES,
    configInt(env.CALL_BODY_TIMEOUT_MS, CALL_BODY_READ_TIMEOUT_MS, 100),
  );
  if (!read.ok) {
    // A refused read is an outcome like any other: without a row here the
    // conversion path loses a whole class of rejection (and a caller probing
    // the endpoint is invisible).
    recordCallOutcome(env, "bad_request", "unknown");
    if (read.reason === "too_large") {
      return json({ status: "payload_too_large" }, 413);
    }
    return json({ status: "bad_request" }, 400);
  }
  const raw = read.text;

  const timestamp = request.headers.get("x-timestamp") ?? "";
  const sig = (request.headers.get("x-signature") ?? "").toLowerCase();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const maxSkew = configInt(env.CALL_MAX_SKEW_SECONDS, 300);

  const auth = await verifyTimestampedSignature(
    env.CALL_HMAC_KEY,
    timestamp,
    read.bytes,
    sig,
    nowSeconds,
    maxSkew,
  );
  if (!auth.ok) {
    recordCallOutcome(env, "unauthorized", "unknown");
    return json({ status: auth.reason === "expired" ? "stale_timestamp" : "unauthorized" }, 401);
  }

  const validated = validateCallEvent(raw, nowSeconds);
  if (!validated.ok || !validated.call) {
    recordCallOutcome(env, "bad_request", "unknown");
    return json({ status: validated.reason ?? "bad_fields" }, 400);
  }
  const call = validated.call;

  // Resolve dialed number -> creative.
  const mappingRaw = await env.NUMBERS.get(`number:${call.dnis}`);
  if (mappingRaw === null) {
    recordCallOutcome(env, "unknown_number", "unknown");
    return json({ status: "unknown_number" }, 404);
  }
  let mapping: NumberMapping;
  try {
    mapping = JSON.parse(mappingRaw) as NumberMapping;
  } catch {
    recordCallOutcome(env, "bad_number_mapping", "unknown");
    return json({ status: "bad_number_mapping" }, 500);
  }
  if (!isValidNumberMapping(mapping)) {
    recordCallOutcome(env, "bad_number_mapping", "unknown");
    return json({ status: "bad_number_mapping" }, 500);
  }
  const campaign = mapping.campaignId ?? "unknown";

  // Qualify by duration *before* claiming idempotency, so a sub-threshold call
  // does not consume the callId's claim (a later, genuinely qualifying event
  // for the same callId would then be answered "duplicate" and lost).
  //
  // A per-number `qualifySeconds` of 0 means "every call qualifies" and is kept;
  // the global default goes through `configInt` so an unset or blank var means
  // 60, not NaN (which would reject every call) or 0 (which would accept every
  // call).
  const threshold = mapping.qualifySeconds ?? configInt(env.QUALIFY_SECONDS, 60);
  if (!Number.isFinite(threshold) || call.durationSeconds < threshold) {
    recordCallOutcome(env, "not_qualified", campaign);
    return json({ status: "not_qualified" });
  }

  // Idempotency: claim the call so a replay cannot fire a second conversion.
  //
  // The callId is percent-encoded into the key rather than being constrained to
  // a narrow charset: a PBX may legitimately forward its SIP `Call-ID`
  // (`localpart@host`) or other punctuation, and rejecting those would fail
  // every qualifying call with a 400 that most PBX integrations do not retry.
  // The trailing "|" terminators the key so releasing the claim by prefix (see
  // eraseByHash below) cannot also release a sibling creative whose id happens
  // to start with the same characters.
  const claimKey = `call:${encodeURIComponent(call.callId)}:${mapping.creativeId}|`;
  const claimTtl = configInt(env.CALL_DEDUP_HOURS, 48) * 3600;
  const first = await isFirstSeen(env.DEDUP, "calls", claimKey, claimTtl);
  if (!first) {
    recordCallOutcome(env, "duplicate", campaign);
    return json({ status: "duplicate" });
  }

  // From here on the claim is held. Every exit path must release it unless the
  // conversion actually landed, otherwise the PBX's retry is answered
  // "duplicate" and the conversion is silently lost.
  try {
    // Match against recent impressions for the creative.
    const windowMin = configInt(env.MATCH_WINDOW_MINUTES, 60);
    const callerState = areaCodeToState(call.ani);
    const match = await matchRecent(
      env.RECENT,
      mapping.creativeId,
      call.startTime,
      windowMin,
      callerState,
      "", // caller postal not derivable from ANI alone
      configFloat(env.MIN_MATCH_CONFIDENCE, 0.6, 0, 1),
      configInt(env.MAX_MATCH_CANDIDATES, 10, 1),
    );

    // Build + fire the platform's conversion API. Platform comes from the number
    // registry entry; device identifiers are attached only when the gate allows.
    const platform = mapping.platform ?? "roku";
    const capi =
      platform === "ua"
        ? await sendToUaCapi(env, await buildUaCapiPayload(env, call, mapping, match))
        : await sendToCapi(env, await buildCapiPayload(env, call, mapping, match));

    // `candidates` is the count of impressions this creative served inside the
    // match window. Returned to the caller it is an inventory oracle — anyone
    // able to replay a still-valid signed webhook could poll a competitor's
    // delivery rate — so it is reported in the recon ledger and logs, and only
    // echoed back when CALL_DEBUG_RESPONSE is explicitly enabled.
    const debug = env.CALL_DEBUG_RESPONSE === "true";
    const summary = {
      matched: match.matched,
      // Only report a score when one was computed: the candidate-ceiling
      // short-circuit returns 0 without evaluating anything, and a bare 0 in a
      // log or dashboard is indistinguishable from a real (and impossible)
      // zero score on a matched candidate.
      ...(debug
        ? {
            ...(match.gate === "too_many_candidates"
              ? { confidenceOmitted: "candidate_ceiling" }
              : { confidence: match.confidence }),
            candidates: match.candidateCount,
            gate: match.gate,
          }
        : {}),
    };

    if (capi.skipped) {
      // Nothing was sent: dry-run mode, or the platform client is not
      // configured. There is no conversion to be idempotent about, so release
      // the claim — otherwise a deployment that shipped with `CAPI_MODE=test`
      // or a placeholder event group would acknowledge every qualified call as
      // "skipped" and block the PBX's retries for the whole
      // CALL_DEDUP_HOURS window after the config is fixed.
      await releaseClaim(env, claimKey);
      recordCallOutcome(env, "skipped", campaign);
      return json({
        status: "skipped",
        ...summary,
        capi: {
          mode: capi.mode,
          status: capi.status,
          ok: capi.ok,
          skipped: capi.skipped,
          attempts: capi.attempts,
        },
      });
    }

    if (!capi.ok) {
      // Release the claim so the PBX's retry can succeed; a conversion that did
      // not land must not be remembered as processed.
      await releaseClaim(env, claimKey);
      recordCallOutcome(env, "capi_error", campaign);
      return json(
        {
          status: "capi_error",
          ...summary,
          capi: {
            mode: capi.mode,
            status: capi.status,
            ok: capi.ok,
            skipped: capi.skipped,
            attempts: capi.attempts,
          },
        },
        502,
      );
    }

    // A test-mode send is validated by the platform but is NOT a delivered
    // conversion, so it must not be counted as one: a deployment left on
    // CAPI_MODE=test otherwise reports a healthy, fully-delivered conversion
    // path. `dry_run` is reported separately (and, like `skipped`, is not a
    // health failure — test mode is intentional outside production).
    recordCallOutcome(env, capi.mode === "live" ? "fired" : "dry_run", campaign);
    return json({
      status: "fired",
      ...summary,
      capi: {
        mode: capi.mode,
        status: capi.status,
        ok: capi.ok,
        skipped: capi.skipped,
        attempts: capi.attempts,
      },
    });
  } catch (err) {
    // Without this, a throw anywhere above (matching store, buildPayload,
    // network) would leave the claim set and return a 500 that the PBX may
    // treat as final, permanently losing a real conversion.
    await releaseClaim(env, claimKey);
    console.log(
      `call_internal_error callId=${call.callId}`,
      err instanceof Error ? err.stack ?? err.message : String(err),
    );
    recordCallOutcome(env, "internal_error", campaign);
    return json({ status: "internal_error" }, 502);
  }
}

/**
 * Result of a bounded body read. `too_large`, `timeout` and `read_error` are
 * distinct so the caller can answer 413 vs 400 and record the right outcome.
 */
export type BodyRead =
  | { ok: true; text: string; bytes: Uint8Array }
  | { ok: false; reason: "too_large" | "timeout" | "read_error" };

/** Sentinel rejected by the deadline, so a timeout is distinguishable. */
const READ_TIMEOUT = Symbol("call-body-timeout");

/**
 * Read at most `maxBytes` of a request body as UTF-8 text, within `timeoutMs`.
 *
 * `content-length` cannot be trusted for the size bound: it is absent on
 * chunked requests and can be understated, so the bound has to be enforced
 * while reading. The time bound is separate and just as necessary — a caller
 * that trickles bytes never trips a size cap, and the HMAC cannot be checked
 * until the body has arrived, so an unbounded read is an unauthenticated way to
 * hold the isolate open.
 *
 * `request.signal` aborts the underlying stream when the client disconnects,
 * which surfaces here as `read_error`.
 */
async function readBoundedText(
  request: Request,
  maxBytes: number,
  timeoutMs: number,
): Promise<BodyRead> {
  const body = request.body;
  if (body === null) return { ok: true, text: "", bytes: new Uint8Array(0) };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(READ_TIMEOUT), timeoutMs);
  });

  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: err === READ_TIMEOUT ? "timeout" : "read_error" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    reader.releaseLock?.();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Both forms are returned: the bytes are what the HMAC covers, the text is
  // what JSON parsing consumes.
  return { ok: true, text: new TextDecoder().decode(merged), bytes: merged };
}

/**
 * Release an idempotency claim so a retry can succeed. Erasure failure is
 * logged but not fatal: the caller is already on an error path.
 */
async function releaseClaim(env: Env, claimKey: string): Promise<void> {
  try {
    await eraseByHash(env.DEDUP, "calls", claimKey);
  } catch (err) {
    console.log(
      `claim_release_failed key=${claimKey}`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
