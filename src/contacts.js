// Parse a pasted block of phone numbers into clean international digit strings.

const SPLIT = /[\n\r,;\t]+/;
const MIN_DIGITS = 8;
const MAX_DIGITS = 15; // E.164

/**
 * Normalise one raw entry. Returns a digit string (no "+") or null if empty.
 * @param {string} raw
 * @param {string} countryCode digits only, may be ''
 */
export function normalizeNumber(raw, countryCode) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const international = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return trimmed; // non-numeric junk — reported as invalid

  if (international) return digits;
  if (digits.startsWith('00')) return digits.slice(2);

  digits = digits.replace(/^0+/, '');
  if (countryCode && !(digits.startsWith(countryCode) && digits.length >= 11)) {
    digits = countryCode + digits;
  }
  return digits;
}

/**
 * @param {string} raw pasted text
 * @param {string} countryCode e.g. "+91", "91" or ""
 * @returns {{ valid: string[], invalid: string[], duplicates: number, withoutCode: number }}
 *   withoutCode = valid entries that were typed without "+" or "00"
 */
export function parseContacts(raw, countryCode = '') {
  const cc = String(countryCode || '').replace(/\D/g, '');
  const valid = [];
  const invalid = [];
  const seen = new Set();
  let duplicates = 0;
  let withoutCode = 0;

  for (const entry of String(raw || '').split(SPLIT)) {
    const n = normalizeNumber(entry, cc);
    if (n === null) continue;
    if (!/^\d+$/.test(n) || n.length < MIN_DIGITS || n.length > MAX_DIGITS) {
      invalid.push(entry.trim());
      continue;
    }
    if (seen.has(n)) {
      duplicates++;
      continue;
    }
    seen.add(n);
    valid.push(n);
    const t = entry.trim();
    if (!t.startsWith('+') && !t.startsWith('00')) withoutCode++;
  }
  return { valid, invalid, duplicates, withoutCode };
}
