/* repetition.js — spots a model stuck in a loop while it streams.
 * Local vision models sometimes degenerate into one character ("////") or the
 * same line or paragraph over and over until they hit the token limit. The
 * check looks only at the end of the text and is deliberately conservative:
 * it needs a long stretch that repeats exactly (whitespace ignored), so real
 * pages with ruled lines, dot leaders or runs of identical table rows pass. */
"use strict";

const Repetition = (() => {
  const MIN_SPAN = 3000;  // repeating tail must cover at least this many characters…
  const MIN_REPEATS = 30; // …and hold at least this many copies of the repeating unit
  const MAX_UNIT = 1000;  // longest unit (in characters) that is looked for
  const WINDOW = MAX_UNIT * MIN_REPEATS + MAX_UNIT;

  /** Returns { unit, repeats } when the text ends in a loop, otherwise null. */
  function detect(text) {
    if (!text || text.length < MIN_SPAN) return null;
    // Collapse whitespace so "line\n\nline\n" loops match regardless of spacing.
    const s = text.slice(-WINDOW).replace(/\s+/g, " ").trimEnd();
    const n = s.length;
    if (n < MIN_SPAN) return null;
    for (let p = 1; p <= MAX_UNIT && p * MIN_REPEATS <= n; p++) {
      // Walk back while each character equals the one a unit earlier.
      let k = n - 1;
      while (k >= p && s.charCodeAt(k) === s.charCodeAt(k - p)) k--;
      const span = n - 1 - k + p; // the periodic tail, including its first copy
      if (span >= MIN_SPAN && span >= p * MIN_REPEATS) {
        return { unit: s.slice(n - p), repeats: Math.floor(span / p) };
      }
    }
    return null;
  }

  return { detect, MIN_SPAN, MIN_REPEATS, MAX_UNIT };
})();

if (typeof module !== "undefined") module.exports = Repetition;
