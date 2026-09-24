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

const ROOT = path.resolve(__dirname, '..', '..');

const APP_FILES = [
  'app/Code.gs',
  'app/Utils.gs',
  'app/RuleEngine.gs',
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
  'tests/EmailTemplates.test.gs',
  'tests/EmailSend.test.gs',
  'tests/Code.test.gs',
  'tests/Runner.test.gs',
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

  process.exit(failed > 0 ? 1 : 0);
}

main();
