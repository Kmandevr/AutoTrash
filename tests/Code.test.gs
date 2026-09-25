/**
 * AutoTrash tests — app/Code.gs. As of 2026-09-24, Code.gs holds only
 * CONSTANTS and doGet(); its settings/trigger tests moved to
 * tests/Config.test.gs alongside the app/Config.gs they now test.
 */

// doGet() must set the viewport through HtmlOutput.addMetaTag(): HtmlService
// ignores a <meta name="viewport"> written inside index.html, which is what
// made the dashboard render as a shrunken desktop page on phones.
function test_doGet_setsMobileViewportMetaTag() {
  const real = HtmlService;
  const tags = {};
  const out = {
    setTitle: function () { return out; },
    setXFrameOptionsMode: function () { return out; },
    addMetaTag: function (name, content) { tags[name] = content; return out; }
  };
  HtmlService = {
    createHtmlOutputFromFile: function () { return out; },
    XFrameOptionsMode: real.XFrameOptionsMode
  };
  try {
    doGet();
    assert(/width=device-width/.test(tags.viewport || ''), 'doGet() must add a device-width viewport meta tag');
  } finally { HtmlService = real; }
}

// FIX (2026-09-24): doGet() must fall back to the 'app/index' filename
// Apps Script gives index.html when clasp pushes this repo with rootDir
// at the repo root (README's recommended, tests-inclusive setup) — see
// resolveIndexFile()'s comment in app/Code.gs for why the two names
// exist. Reproduces "Exception: No HTML file named index was found"
// by making the mock throw on the flat name, exactly like the real
// HtmlService does against that deployment layout.
function test_doGet_fallsBackToNestedAppIndexFilename() {
  const real = HtmlService;
  const calls = [];
  const out = {
    setTitle: function () { return out; },
    setXFrameOptionsMode: function () { return out; },
    addMetaTag: function () { return out; }
  };
  HtmlService = {
    createHtmlOutputFromFile: function (name) {
      calls.push(name);
      if (name === 'index') throw new Error('No HTML file named index was found.');
      return out;
    },
    XFrameOptionsMode: real.XFrameOptionsMode
  };
  try {
    doGet();
    assertEqual(calls[0], 'index', 'doGet() must try the flat filename first');
    assertEqual(calls[1], 'app/index', 'doGet() must fall back to app/index when the flat name is not found');
  } finally { HtmlService = real; }
}

const CODE_TESTS = [
  test_doGet_setsMobileViewportMetaTag,
  test_doGet_fallsBackToNestedAppIndexFilename
];
