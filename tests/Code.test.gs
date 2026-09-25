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

// ?diag=1 turns on index.html's flight recorder by appending a flag script;
// without it the page must be served exactly as before.
function test_doGet_diagParam_appendsRecorderFlag_onlyWhenAsked() {
  const real = HtmlService;
  const appended = [];
  const out = {
    setTitle: function () { return out; },
    setXFrameOptionsMode: function () { return out; },
    addMetaTag: function () { return out; },
    append: function (html) { appended.push(html); return out; }
  };
  HtmlService = { createHtmlOutputFromFile: function () { return out; }, XFrameOptionsMode: real.XFrameOptionsMode };
  try {
    doGet({ parameter: {} });
    doGet();
    assertEqual(appended.length, 0, 'no diag flag unless ?diag is present');
    doGet({ parameter: { diag: '1' } });
    assertEqual(appended.length, 1);
    assert(/window\.__AT_DIAG = true/.test(appended[0]), 'must set the recorder flag: ' + appended[0]);
  } finally { HtmlService = real; }
}

// The report goes to the owner only, pretty-printed, capped, and a mail
// failure is swallowed (returns false) instead of surfacing to the page.
function test_reportUiDiagnostics_emailsOwnerOnly_prettyAndCapped() {
  const spy = installGmailSpy([]);
  try {
    assertEqual(reportUiDiagnostics(JSON.stringify({ phase: 'boot', a: 1 })), true);
    assertEqual(spy.calls.emails.length, 1);
    const m = spy.calls.emails[0];
    assertEqual(m.to, Session.getEffectiveUser().getEmail(), 'diagnostics must only ever go to the owner');
    assertEqual(m.subj, 'AutoTrash UI diagnostics (boot)');
    assert(m.body.indexOf('\n  "a": 1') > -1, 'JSON report must be pretty-printed: ' + m.body);
    reportUiDiagnostics('x'.repeat(100000));
    assertEqual(spy.calls.emails[1].body.length, 60000, 'report must be capped at 60 KB');
  } finally { spy.restore(); }
}
function test_reportUiDiagnostics_mailFailure_returnsFalseNotThrow() {
  const real = GmailApp.sendEmail;
  GmailApp.sendEmail = function () { throw new Error('quota'); };
  try { assertEqual(reportUiDiagnostics('{}'), false); }
  finally { GmailApp.sendEmail = real; }
}

const CODE_TESTS = [
  test_doGet_setsMobileViewportMetaTag,
  test_doGet_fallsBackToNestedAppIndexFilename,
  test_doGet_diagParam_appendsRecorderFlag_onlyWhenAsked,
  test_reportUiDiagnostics_emailsOwnerOnly_prettyAndCapped,
  test_reportUiDiagnostics_mailFailure_returnsFalseNotThrow
];
