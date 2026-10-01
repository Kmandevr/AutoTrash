'use strict';

/**
 * AutoTrash — regression tests for tests/harness/check-index-html.js's own
 * scanner (Node-only; self-contained assert-based checks, not a
 * tests/*.test.gs suite — see check-index-html.js's doc comment for why
 * this whole area lives outside the Apps-Script-mock vm harness). Wired
 * into `npm test` from run-node-tests.js, reported as its own summary
 * line, same as check-index-html.js itself.
 *
 * Added 2026-10-01 after a code review
 * (claude/autotrash-review/review-20261001.md, Project knowledge) found
 * that findNestedTemplateBackticks() had no concept of regex literals:
 * any backtick inside a regex (e.g. `/`/`) was read as a template-literal
 * boundary, which could desync the scanner's nesting tracker for
 * everything after it and make it silently miss a REAL nested
 * template-literal bug later in the same <script> block. Reproduced
 * against the shipped function before the fix:
 *
 *   const html = '<script>const re = /`/; const z = `outer ${ `inner` }`;</script>';
 *   checkIndexHtmlSource(html, 'adversarial-test');
 *   // pre-fix: { passed: 3, failed: 0, total: 3, ... } — reports ALL CLEAR
 *   //          even though this is a textbook nested-template-literal bug.
 *
 * These tests prove that regression is now caught AND that fixing it
 * didn't make the scanner over-eager (misreading an ordinary division as
 * the start of a regex and losing its place).
 */

const assert = require('assert');
const { checkIndexHtmlSource, findNestedTemplateBackticks } = require('./check-index-html');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
  }
}

// ── The reviewer's exact adversarial case ──────────────────────────────────
test('regex literal containing a backtick does not mask a later real nested-template-literal bug', () => {
  const html = '<script>const re = /`/; const z = `outer ${ `inner` }`;</script>';
  const result = checkIndexHtmlSource(html, 'adversarial-test');
  assert.strictEqual(result.failed > 0, true,
    'the genuine nested `inner` template literal must still be flagged even though an earlier regex contains a backtick');
});

test('findNestedTemplateBackticks() does not flag the backtick inside the regex literal itself', () => {
  const flags = findNestedTemplateBackticks('const re = /`/; const z = 1;');
  assert.strictEqual(flags.length, 0,
    'a backtick that is part of a regex literal\'s pattern is not a template literal at all and must never be flagged');
});

// ── Must not regress: ordinary code the fix could plausibly break ─────────
test('ordinary division is not mistaken for the start of a regex literal', () => {
  // Without correct regex-vs-division disambiguation, this `/` would be
  // read as opening a regex that only closes at the LATER `/` inside the
  // string below — desyncing everything after it, including the
  // deliberately-placed nested backtick two statements down.
  const flags = findNestedTemplateBackticks(
    "const q = a / b; const s = 'x/y'; const z = `outer ${ `inner` }`;"
  );
  assert.strictEqual(flags.length, 1, 'the real nested backtick after the division must still be found');
});

test('a regex literal after a value-producing keyword argument still scans past it correctly', () => {
  const flags = findNestedTemplateBackticks(
    "return /abc\\/def/.test(x); const z = `outer ${ `inner` }`;"
  );
  assert.strictEqual(flags.length, 1,
    'an escaped slash inside the regex must not end it early, and the real nested backtick after it must still be found');
});

test('a regex literal containing a character class with an unescaped slash is not ended early', () => {
  // `[/]` is a character class matching the `/` character — an unescaped
  // `/` inside it must NOT be read as the regex's closing delimiter.
  const flags = findNestedTemplateBackticks('const re = /[/]/; const z = `outer ${ `inner` }`;');
  assert.strictEqual(flags.length, 1,
    'the real nested backtick after the character-class regex must still be found');
});

test('a clean inline script with no nested template literal reports zero flags', () => {
  const flags = findNestedTemplateBackticks('const s = `a ${b} c`; const t = `d ${e()} f`;');
  assert.strictEqual(flags.length, 0);
});

test('the actual 2026-09-25 live boot bug pattern is still caught after the regex-literal fix', () => {
  // A minimal reproduction of the real shipped bug: a template literal's
  // ${...} interpolation builds an attribute string containing ANOTHER
  // template literal.
  const flags = findNestedTemplateBackticks(
    'el.innerHTML = `<a data-to="${ `mailto:${addr}` }">x</a>`;'
  );
  assert.strictEqual(flags.length >= 1, true,
    'the original 2026-09-25 bug pattern must still be caught after the regex-literal fix');
});

console.log('');
console.log(`AutoTrash index.html guard self-test: ${passed}/${passed + failed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('');
  console.log('Failures:');
  failures.forEach(f => {
    console.log(`  ✗ ${f.name}`);
    console.log(`    ${f.error}`);
  });
}

module.exports = { passed, failed, total: passed + failed };
