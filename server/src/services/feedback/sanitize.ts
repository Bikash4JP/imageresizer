import { randomBytes } from 'node:crypto';

// Control characters, zero-width characters and bidirectional overrides can
// hide or visually reorder text (e.g. "Trojan Source" style spoofing).
// Written as numeric code-point ranges rather than escape literals, so no
// invisible character can ever end up in this source file itself.
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08], // C0 controls (tab, newline and CR are handled as whitespace)
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f], // DEL and C1 controls
  [0x200b, 0x200f], // zero-width space/joiners, LRM/RLM marks
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2060, 0x2069], // word joiner, invisible operators, bidi isolates
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
];

const hex = (n: number) => '\\u' + n.toString(16).padStart(4, '0');
const INVISIBLE = new RegExp(
  '[' + INVISIBLE_RANGES.map(([a, b]) => (a === b ? hex(a) : hex(a) + '-' + hex(b))).join('') + ']',
  'g',
);

/** NFC-normalises, strips invisible/control characters and collapses whitespace to single spaces. */
export function cleanText(input: string): string {
  return input.normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|info|biz|io|co|xyz|top|site|online|shop|store|app|dev|me|ly|gl|link|click|ru|cn|tk|in|uk|au)\b/i;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const PHONE_LIKE = /(?:\+?\d[\s().-]*){8,}/;

/**
 * Links, email addresses and phone numbers are how spam and scams get onto
 * review walls. Under "auto" moderation such comments are held for approval
 * instead of being published immediately.
 */
export function needsReview(text: string): boolean {
  return URL_LIKE.test(text) || EMAIL_LIKE.test(text) || PHONE_LIKE.test(text);
}

/** Lexicographically time-sortable id: 9 base-36 timestamp chars + 12 random hex chars. */
export function newFeedbackId(now = Date.now()): string {
  return now.toString(36).padStart(9, '0') + randomBytes(6).toString('hex');
}

export const FEEDBACK_ID = /^[0-9a-z]{9}[0-9a-f]{12}$/;
