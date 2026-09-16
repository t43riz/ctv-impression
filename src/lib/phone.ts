import { AREA_CODE_STATE } from "./areacodes";

const encoder = new TextEncoder();

/**
 * Digits-only form of a phone number: strips every non-digit and any leading
 * zeros (an international trunk prefix, e.g. "0044 20..." -> "44 20...").
 *
 * This is the internal/geo form. It is NOT what Roku hashes — see
 * `toE164` — so use `hashPhone` for anything sent to a conversion API.
 */
export function normalizePhone(raw: string): string {
  let digits = (raw ?? "").replace(/[^0-9]/g, "");
  digits = digits.replace(/^0+/, "");
  return digits;
}

/** NANP subscriber numbers are 10 digits; with the country code, 11. */
const NANP_LOCAL_DIGITS = 10;

/**
 * E.164 form for hashing, per Roku's CAPI spec: country code preceded by "+",
 * no formatting characters, leading zeros of the local number removed, and the
 * "+" retained.
 *
 * Keeping the "+" matters: it is part of the hashed string, so dropping it
 * yields a well-formed 64-char digest that matches nothing on Roku's side. The
 * failure is silent — the API still answers 200 and reports the event as
 * processed — so it surfaces as unexplained zero attribution rather than an
 * error.
 *
 * A bare 10-digit number is assumed to be NANP (+1). The tracking numbers this
 * system serves are US/CA, and hashing a number with no country code would
 * produce a third, equally unmatchable digest; assuming the only country code
 * that can apply is strictly better than that.
 */
export function toE164(raw: string): string {
  const digits = normalizePhone(raw);
  if (digits === "") return "";
  return digits.length === NANP_LOCAL_DIGITS ? `+1${digits}` : `+${digits}`;
}

/** SHA-256 of the E.164 number, lowercase hex (never base64), per Roku's spec. */
export async function hashPhone(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(toE164(raw)));
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Best-effort caller geo from a North American number's area code (NANP).
 * SOFT signal only — mobile portability means this is approximate; it nudges
 * the match score, never gates it. Returns "" when not derivable.
 */
export function areaCodeToState(ani: string): string {
  const d = normalizePhone(ani);
  // Strip leading US country code if present (11 digits starting with 1).
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (ten.length < 3) return "";
  const npa = ten.slice(0, 3);
  return AREA_CODE_STATE[npa] ?? "";
}
