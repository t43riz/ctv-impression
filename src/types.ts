/// <reference types="@cloudflare/workers-types" />

export interface Env {
  // Analytics Engine (write-only binding)
  ANALYTICS: AnalyticsEngineDataset;
  RECON: AnalyticsEngineDataset;

  // R2
  ARCHIVE: R2Bucket;
  RAW: R2Bucket;

  // KV campaign/creative allowlist
  CAMPAIGNS: KVNamespace;

  // KV tracking-number registry: number:{e164} -> NumberMapping JSON
  NUMBERS: KVNamespace;

  // Durable Object for dedup + replay
  DEDUP: DurableObjectNamespace;

  // Durable Object holding recent impressions for call matching
  RECENT: DurableObjectNamespace;

  // Durable Object for per-IP rate limiting
  RATE: DurableObjectNamespace;

  // Secrets
  CF_API_TOKEN: string;
  ACCOUNT_ID: string;
  HMAC_SIGNING_KEY: string;
  IFA_HASH_SALT: string;
  IFA_HASH_SALT_PREV?: string; // previous salt during a rotation window
  CALL_HMAC_KEY: string; // shared key the PBX signs /call payloads with
  CAPI_API_KEY: string; // Roku CAPI bearer token
  UA_CAPI_API_KEY?: string; // Universal Ads CAPI bearer token [CONFIRM WITH UA]
  ADMIN_TOKEN: string; // bearer token protecting /admin/* routes

  // Vars
  DEDUP_WINDOW_HOURS: string;
  SIGNATURE_REQUIRED: string;
  MATCH_WINDOW_MINUTES: string; // impression->call attribution window
  QUALIFY_SECONDS: string; // default min call duration to qualify
  CAPI_MODE: string; // "test" -> /v1/test_events, "live" -> /v1/events
  CAPI_EVENT_GROUP_ID: string; // default event_group_id
  CAPI_EVENT_NAME: string; // default event_name (e.g. "LEAD")
  RATE_LIMIT_PER_MINUTE: string; // per-IP beacon budget; "0" disables
  UA_CAPI_ENDPOINT?: string; // UA CAPI base URL [CONFIRM WITH UA]
  UA_CAPI_MODE?: string; // "test" (default) or "live"

  // --- Added in the correctness pass -------------------------------------
  // Frequency cap for impressions we cannot identify (LMT / COPPA
  // child-directed / zeroed IFA). Without it that traffic is never deduped.
  // Any value other than "true" disables the coarse cap.
  DEDUP_NON_ATTRIBUTABLE?: string;
  // Global kill switch (DSA §2(b), Roku may demand Pixel removal on demand).
  // "true" => keep serving the pixel but stop counting and matching.
  INGEST_DISABLED?: string;
  // Device identifiers are sent to a conversion API only when the match is
  // strong enough. Below either bound we fall back to phone_only.
  MIN_MATCH_CONFIDENCE?: string; // default 0.6
  MAX_MATCH_CANDIDATES?: string; // default 10
  // Outbound request timeout (ms) for CAPI and Analytics Engine SQL calls.
  HTTP_TIMEOUT_MS?: string; // default 5000
  // Retry budget for Roku conversion sends (1 = no retry). Roku dedups
  // event_id for 10 minutes, so a retry inside that window is safe.
  CAPI_MAX_ATTEMPTS?: string; // default 2
  // Separate budget for UA, whose dedup window is unconfirmed: defaults to 1
  // so a retry cannot double-count a billable conversion.
  UA_CAPI_MAX_ATTEMPTS?: string; // default 1
  // /call replay protection: max accepted skew of the signed timestamp.
  CALL_MAX_SKEW_SECONDS?: string; // default 300
  // How long a processed callId is remembered to make /call idempotent.
  CALL_DEDUP_HOURS?: string; // default 48
  // Raw-tier DSAR scan window in days; must cover the bucket's lifecycle rule.
  RAW_RETENTION_DAYS?: string; // default 31
  // Deadline (ms) for reading a /call webhook body. Bounds unauthenticated
  // slow-loris reads; the HMAC cannot be checked until the body arrives.
  CALL_BODY_TIMEOUT_MS?: string; // default 10000

  // --- Alert thresholds (monitor.ts) --------------------------------------
  // Ceilings used by computeReconHealth. Each accepts 0..1; unset, blank or
  // out-of-range falls back to the default so a typo cannot disable an alert.
  HEALTH_MAX_REJECT_RATIO?: string; // default 0.5  rejects / received
  HEALTH_MAX_ALERT_RATIO?: string; // default 0.01 alerts / received
  HEALTH_MAX_CALL_ERROR_RATIO?: string; // default 0.5  failed sends / calls
  HEALTH_MAX_CALL_REJECT_RATIO?: string; // default 0.5  refused calls / calls
}

/** Ad platform a tag / tracking number belongs to. */
export type Platform = "roku" | "ua";

/** Tracking number registry entry. */
export interface NumberMapping {
  creativeId: string;
  campaignId: string;
  advertiserId: string;
  platform?: Platform; // conversion API to fire; defaults to "roku"
  qualifySeconds?: number; // per-number override of QUALIFY_SECONDS
  eventGroupId?: string; // per-number override of CAPI_EVENT_GROUP_ID
}

/**
 * Compact impression record held in the matching store for the attribution
 * window only. Holds RAW ip/rida (Roku CAPI needs them unhashed); purged after
 * the window. RIDA is empty under LMT.
 */
export interface ImpressionRecord {
  ts: number; // unix seconds
  ip: string; // CF-Connecting-IP (true device IP)
  rida: string; // raw IFA/RIDA, "" under LMT
  hhId: string; // household ID (UA), "" when absent
  region: string; // cf.region (state/province)
  city: string;
  postal: string;
  lmt: boolean;
}

/** Inbound qualified-call webhook from the PBX. */
export interface CallEvent {
  callId: string;
  dnis: string; // dialed tracking number (E.164)
  ani: string; // caller number (E.164)
  startTime: number; // unix seconds
  durationSeconds: number;
  saleValue?: number; // optional, for revenue reporting
  currency?: string;
}

/** Why device identifiers were withheld from a conversion payload. */
export type MatchGate =
  | "ok"
  | "no_match"
  | "low_confidence"
  | "too_many_candidates";

/** Result of matching a call against recent impressions. */
export interface MatchResult {
  matched: boolean; // true if >=1 candidate in window
  best: ImpressionRecord | null;
  candidateCount: number;
  confidence: number; // 0..1
  /**
   * True only when the match is strong enough to justify sending a
   * best-guess device IP / advertising ID to a conversion API. When false the
   * caller must fall back to phone-only attribution (hashed phone + coarse
   * geo). Sending device identifiers on a weak match misattributes the
   * conversion and is what DPP §4(f)(i) / §4(d)(ii) turn on.
   */
  deviceIds: boolean;
  gate: MatchGate;
}

/**
 * Normalized, validated impression extracted from a beacon request.
 * `ifaHash` is a salted hash — raw IFA is never stored.
 */
export interface Impression {
  advertiserId: string;
  campaignId: string;
  creativeId: string;
  ifaHash: string; // "anon" when LMT or missing
  ifaPresent: boolean; // false when LMT=1 / IFA zeroed / missing
  appId: string;
  country: string;
  ifaType: string; // IFA namespace (e.g. "rida", "idfa"); "" when absent
  platform: Platform; // tag platform ("roku" default, "ua")
}

export type RejectReason =
  | "method"
  | "path"
  | "missing_params"
  | "bad_signature"
  | "expired"
  | "not_allowlisted"
  | "rate_limited"
  // Secret is still the shipped placeholder, so nothing can be trusted.
  | "not_configured";
