// Checks the loop detector in ui/repetition.js. Run: node scripts/test-repetition.js
"use strict";
const assert = require("assert");
const Repetition = require("../ui/repetition.js");

const prose = (n) => Array.from({ length: n }, (_, k) =>
  `Paragraph ${k + 1}. The committee reviewed item ${k * 7 % 13} and noted ${k % 5} objections.\n\n`).join("");
const cases = [
  // [name, text, should detect]
  ["one character", "# Page 1\n\nSome text.\n\n" + "/".repeat(3500), true],
  ["one line repeated", prose(3) + "| Total | 0 | 0 |\n".repeat(200), true],
  ["paragraph repeated, ends mid-copy", prose(3) + "The quick brown fox jumps over the lazy dog near the old barn. ".repeat(60) + "The quick bro", true],
  ["blank lines vary between copies", prose(2) + Array.from({ length: 400 }, (_, k) => "same line" + "\n".repeat(1 + k % 3)).join(""), true],
  ["long real page", prose(200), false],
  ["ruled lines on a form", prose(5) + ("_".repeat(60) + "\n\n").repeat(40) + prose(3), false],
  ["ruled lines at the end", prose(5) + ("_".repeat(60) + "\n\n").repeat(40), false],
  ["dot leaders", Array.from({ length: 60 }, (_, k) => `Chapter ${k + 1} ${".".repeat(70)} ${k * 9 + 1}\n`).join(""), false],
  ["empty table rows", "| A | B | C |\n|---|---|---|\n" + "|   |   |   |\n".repeat(150), false],
  ["short text", "////", false],
  ["empty", "", false],
];
let failed = 0;
for (const [name, text, expected] of cases) {
  const got = !!Repetition.detect(text);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name} (expected ${expected ? "loop" : "no loop"})`);
}
// Timing: the check runs every few hundred streamed characters, so it must stay cheap.
const big = prose(2000);
const t0 = Date.now();
for (let k = 0; k < 50; k++) Repetition.detect(big);
const ms = (Date.now() - t0) / 50;
console.log(`${ms < 20 ? "ok  " : "FAIL"} one check on ${big.length} characters takes ${ms.toFixed(2)} ms`);
if (ms >= 20) failed++;
assert.strictEqual(failed, 0, `${failed} check(s) failed`);
