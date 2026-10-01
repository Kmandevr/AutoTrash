#!/usr/bin/env node
'use strict';

/**
 * AutoTrash — Node-runnable test harness.
 *
 * Loads every app/*.gs file plus every tests/*.gs file (the shared
 * framework, each per-module suite, and RunAll.gs) into ONE Node `vm`
 * context seeded with Apps Script service mocks, then calls the exact
 * same runAllTests() the Apps Script editor uses — so there is only one
 * implementation of "run every test and report", exercised both ways.
 *
 * Why one concatenated vm.Script instead of one runInContext() call per
 * file: top-level `const`/`let` declarations in a script executed via
 * vm's runInContext do NOT attach to the shared context object — only
 * `var` and function declarations do. Loading each file as a separate
 * script would make every top-level `const X_TESTS = [...]` (every
 * tests/*.test.gs file) invisible to RunAll.gs, breaking on a
 * ReferenceError with no equivalent problem in the real Apps Script
 * runtime, which really does share one execution scope across files.
 * Concatenating into a single script sidesteps that mismatch and mirrors
 * Apps Script's actual behavior more faithfully than multiple scripts
 * would.
 *
 * Usage:
 *   node tests/harness/run-node-tests.js
 *   npm test          (same thing, via package.json)
 * Exit code is 0 iff every test passed.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createGlobals } = require('../mocks/apps-script-globals');
const { checkIndexHtml } = require('./check-index-html');

const ROOT = path.resolve(__dirname, '..', '..');

const APP_FILES = [
  'app/Code.gs',
  'app/Utils.gs',
  'app/RuleEngine.gs',
  'app/Config.gs',
  'app/Stats.gs',
  'app/Engine.gs',
  'app/RunState.gs',
  'app/Runner.gs',
  'app/EmailSend.gs',
  'app/EmailTemplates.gs'
];

// TestFramework.gs and every *.test.gs must load before RunAll.gs, which
// references their TEST_FNS-style arrays at its own top level. Order among
// the suites themselves doesn't matter — every test body is inside a
// function, so no suite calls another at load time.
const TEST_FILES = [
  'tests/TestFramework.gs',
  'tests/Utils.test.gs',
  'tests/RuleEngine.test.gs',
  'tests/Engine.test.gs',
  'tests/Stats.test.gs',
  'tests/EmailTemplates.test.gs',
  'tests/EmailSend.test.gs',
  'tests/Code.test.gs',
  'tests/Config.test.gs',
  'tests/Runner.test.gs',
  'tests/RunState.test.gs',
  'tests/RunAll.gs'
];

function readAll(relPaths) {
  return relPaths.map(rel => {
    const full = path.join(ROOT, rel);
    const src = fs.readFileSync(full, 'utf8');
    // A `//# sourceURL` comment gives each file's own name in stack
    // traces even though everything runs as one concatenated vm.Script.
    return `\n// ──── ${rel} ────\n` + src;
  }).join('\n');
}

function main() {
  const sandbox = createGlobals();
  const context = vm.createContext(sandbox);

  const combinedSource = readAll(APP_FILES) + '\n' + readAll(TEST_FILES);

  const script = new vm.Script(combinedSource, { filename: 'autotrash-combined.gs' });
  script.runInContext(context);

  if (typeof context.runAllTests !== 'function') {
    console.error('runAllTests() was not defined after loading all files — check tests/RunAll.gs.');
    process.exit(2);
  }

  const { passed, failed, total, results } = context.runAllTests();

  console.log('');
  console.log(`AutoTrash Node harness: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('');
    console.log('Failures:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  ✗ ${r.name}`);
      console.log(`    ${r.error}`);
    });
  }

  // Boot-safety guard: static checks on app/index.html's inline <script>
  // content (see tests/harness/check-index-html.js for why this is a
  // separate Node-level check rather than a tests/*.test.gs suite). Kept
  // as its own summary line rather than folded into the runAllTests()
  // count above, since it checks a different file with a different
  // mechanism (vm.Script parse + a static scanner, not runAllTests()'s
  // assert-based suites) — but it still gates `npm test`'s exit code.
  const htmlCheck = checkIndexHtml();
  console.log('');
  console.log(`AutoTrash index.html guard: ${htmlCheck.passed}/${htmlCheck.total} passed, ${htmlCheck.failed} failed`);
  if (htmlCheck.failed > 0) {
    console.log('');
    console.log('Failures:');
    htmlCheck.results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  ✗ ${r.name}`);
      console.log(`    ${r.error}`);
    });
  }

  // Regression coverage for the guard's own scanner (see
  // tests/harness/check-index-html.selftest.js) — required here, not at
  // module load, so its summary prints in the same order it runs.
  const htmlSelftest = require('./check-index-html.selftest');

  const anyFailed = failed > 0 || htmlCheck.failed > 0 || htmlSelftest.failed > 0;
  process.exit(anyFailed ? 1 : 0);
}

main();
