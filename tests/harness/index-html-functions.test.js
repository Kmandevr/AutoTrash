#!/usr/bin/env node
'use strict';

/**
 * AutoTrash — direct unit tests for app/index.html's pure helper functions.
 *
 * docs/testing.txt has long said "index.html has no automated tests" —
 * true for the UI as a whole (it needs a real DOM/google.script.run to
 * exercise meaningfully), but a handful of its helpers are pure string/
 * number formatting functions with no DOM dependency at all:
 *   fmt(n)         thousands-separator formatting for on-screen counters
 *   esc(s)         HTML-escaping for text interpolated into innerHTML
 *   cid(s)         sanitizing a rule label into a safe DOM id fragment
 *   relTime(ts)    coarse relative-time label for config-backup timestamps
 *   ruleName(r)    display name for a rule (label, else category, else '?')
 *   describeRun(r) "manual run" / "background trigger run" [+ DRY RUN] text
 *
 * These are exactly the kind of logic a copy/paste slip or a refactor can
 * silently break (e.g. esc() losing a character, or fmt() mis-handling 0),
 * and a break here is directly user-visible (wrong counts, unescaped HTML,
 * a stale backup-age label) — so they get real coverage like any other
 * pure helper in this codebase, via the same vm-extraction approach this
 * project already uses for index.html fixes (see git history for the
 * AT-BRK-004 / reload-READY-flash patches).
 *
 * Not wired into tests/RunAll.gs / runAllTests() — that suite is Apps-
 * Script-flavored (TestFramework.gs's assert/assertEqual, GmailApp/
 * PropertiesService spies) and only ever loads app/*.gs, never
 * app/index.html. This is a standalone Node-only test file, run as its
 * own `npm test` step, with its own pass/fail report line — same pattern
 * as tests/harness/run-node-tests.js itself.
 *
 * Usage: node tests/harness/index-html-functions.test.js
 */

const assert = require('assert');
const { loadIndexHtmlFunctions } = require('./extract-index-html-functions');

const FN_NAMES = ['fmt', 'esc', 'cid', 'relTime', 'ruleName', 'describeRun'];
const { fmt, esc, cid, relTime, ruleName, describeRun } = loadIndexHtmlFunctions(FN_NAMES);

let pass = 0, fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    failures.push(name + ': ' + e.message);
  }
}

// ── fmt(n) — thousands-separator formatting ────────────────────────────
test('fmt(0) === "0"', () => assert.strictEqual(fmt(0), '0'));
test('fmt(undefined) === "0" (n||0 fallback)', () => assert.strictEqual(fmt(undefined), '0'));
test('fmt(null) === "0" (n||0 fallback)', () => assert.strictEqual(fmt(null), '0'));
test('fmt(999) has no separator (< 1000)', () => assert.strictEqual(fmt(999), '999'));
test('fmt(1000) === "1,000"', () => assert.strictEqual(fmt(1000), '1,000'));
test('fmt(1234567) === "1,234,567"', () => assert.strictEqual(fmt(1234567), '1,234,567'));
test('fmt(-1234) === "-1,234" (sign not treated as a digit)', () => assert.strictEqual(fmt(-1234), '-1,234'));

// ── esc(s) — HTML escaping ──────────────────────────────────────────────
test('esc() escapes & before < > " (order matters: escaping & last would double-escape)', () => {
  assert.strictEqual(esc('&<>"'), '&amp;&lt;&gt;&quot;');
});
test('esc() escapes a label that looks like a tag', () => {
  assert.strictEqual(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});
test('esc() leaves plain text untouched', () => assert.strictEqual(esc('Promotions'), 'Promotions'));
test('esc() stringifies a non-string input', () => assert.strictEqual(esc(42), '42'));
test('esc() does not touch single quotes (not in the escape set)', () => assert.strictEqual(esc("it's fine"), "it's fine"));

// ── cid(s) — DOM-id-safe sanitizing ─────────────────────────────────────
test('cid() keeps alphanumerics/underscore/hyphen as-is', () => assert.strictEqual(cid('abc-123_XYZ'), 'abc-123_XYZ'));
test('cid() replaces spaces and punctuation with underscores', () => assert.strictEqual(cid('My Label!'), 'My_Label_'));
test('cid() replaces every disallowed char, not just the first', () => assert.strictEqual(cid('a/b/c'), 'a_b_c'));
test('cid() on an empty string stays empty', () => assert.strictEqual(cid(''), ''));

// ── relTime(ts) — coarse relative-time label ────────────────────────────
test('relTime() just under a minute ago says "just now"', () => {
  assert.strictEqual(relTime(Date.now() - 5000), 'just now');
});
test('relTime() a future/zero-clock-skew timestamp still says "just now" (clamped, not negative)', () => {
  assert.strictEqual(relTime(Date.now() + 5000), 'just now');
});
test('relTime() 10 minutes ago', () => {
  assert.strictEqual(relTime(Date.now() - 10 * 60 * 1000), '10 min ago');
});
test('relTime() 1 hour ago uses singular "hour"', () => {
  assert.strictEqual(relTime(Date.now() - 60 * 60 * 1000), '1 hour ago');
});
test('relTime() 5 hours ago uses plural "hours"', () => {
  assert.strictEqual(relTime(Date.now() - 5 * 60 * 60 * 1000), '5 hours ago');
});
test('relTime() 1 day ago uses singular "day"', () => {
  assert.strictEqual(relTime(Date.now() - 24 * 60 * 60 * 1000), '1 day ago');
});
test('relTime() 3 days ago uses plural "days"', () => {
  assert.strictEqual(relTime(Date.now() - 3 * 24 * 60 * 60 * 1000), '3 days ago');
});

// ── ruleName(r) — display name for a rule ───────────────────────────────
test('ruleName(null) === "?"', () => assert.strictEqual(ruleName(null), '?'));
test('ruleName() prefers an explicit label', () => assert.strictEqual(ruleName({ label: 'Newsletters' }), 'Newsletters'));
test('ruleName() falls back to the uppercased category when label is empty', () => {
  assert.strictEqual(ruleName({ label: '', category: 'promotions' }), 'PROMOTIONS');
});
test('ruleName() falls back to "?" when neither label nor category is set', () => {
  assert.strictEqual(ruleName({}), '?');
});

// ── describeRun(r) — run-descriptor text ────────────────────────────────
test('describeRun(null) === "unknown"', () => assert.strictEqual(describeRun(null), 'unknown'));
test('describeRun() manual, live run', () => {
  assert.strictEqual(describeRun({ source: 'manual', dryRun: false }), 'manual run');
});
test('describeRun() background trigger run', () => {
  assert.strictEqual(describeRun({ source: 'background', dryRun: false }), 'background trigger run');
});
test('describeRun() appends " · DRY RUN" when dryRun is set', () => {
  assert.strictEqual(describeRun({ source: 'manual', dryRun: true }), 'manual run · DRY RUN');
  assert.strictEqual(describeRun({ source: 'background', dryRun: true }), 'background trigger run · DRY RUN');
});

console.log(`index.html function tests: ${pass}/${pass + fail} passed (${fail} failed)`);
if (failures.length) {
  for (const f of failures) console.log('  FAIL: ' + f);
  process.exitCode = 1;
}
