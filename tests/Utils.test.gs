/**
 * AutoTrash tests — app/Utils.gs (fmtNum, fmtMs, chunkArray, getAppUrl).
 * Split out of the former monolithic tests/Tests.gs on 2026-09-24 — see
 * CLAUDE.md for the full test-file map and TestFramework.gs for the shared
 * assertions/spies these tests use.
 */

function test_fmtNum_addsThousandsSeparators() { assertEqual(fmtNum(1234567), '1,234,567'); }
function test_fmtNum_smallNumberUnchanged() { assertEqual(fmtNum(42), '42'); }
function test_fmtNum_nullOrUndefinedIsZero() {
  assertEqual(fmtNum(null), '0');
  assertEqual(fmtNum(undefined), '0');
}
function test_fmtMs_underOneSecond() { assertEqual(fmtMs(500), '500ms'); }
function test_fmtMs_overOneSecond() { assertEqual(fmtMs(1500), '1.5s'); }
function test_chunkArray_splitsIntoFixedSizeGroups() {
  assertEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
}
function test_chunkArray_emptyInputYieldsEmptyOutput() {
  assertEqual(chunkArray([], 100), []);
}
function test_chunkArray_respectsGmailChunkConstant() {
  assertEqual(GMAIL_CHUNK, 100);
}

function test_getAppUrl_returnsEmptyStringOnFailure_neverThrows() {
  const real = ScriptApp.getService;
  ScriptApp.getService = function () { throw new Error('not deployed'); };
  try {
    assertEqual(getAppUrl(), '');
  } finally {
    ScriptApp.getService = real;
  }
}
function test_getAppUrl_returnsUrlWhenDeployed() {
  const real = ScriptApp.getService;
  ScriptApp.getService = function () { return { getUrl: function () { return 'https://script.google.com/x/exec'; } }; };
  try {
    assertEqual(getAppUrl(), 'https://script.google.com/x/exec');
  } finally {
    ScriptApp.getService = real;
  }
}

// safeMail() had no dedicated tests despite its own FIX 48 (BUG-C25) comment
// calling it out as "the last line of defense for every email this project
// sends" — every other e.message-guarding call site (sendErrorEmail's errMsg/
// errStack) is covered, but safeMail's own try/catch, and its plain-body
// fallback to subj, were not. Added 2026-09-29.
function test_safeMail_sendsHtmlBodyAndFallsBackToSubjectAsPlainText() {
  const spy = installGmailSpy([]);
  try {
    safeMail('user@example.com', 'Hello', '<p>Hi</p>');
    assertEqual(spy.calls.emails.length, 1);
    const m = spy.calls.emails[0];
    assertEqual(m.to, 'user@example.com');
    assertEqual(m.subj, 'Hello');
    assertEqual(m.body, 'Hello', 'plain body must fall back to subj when plain is omitted');
    assertEqual(m.opts.htmlBody, '<p>Hi</p>');
  } finally { spy.restore(); }
}
function test_safeMail_usesExplicitPlainBodyWhenProvided() {
  const spy = installGmailSpy([]);
  try {
    safeMail('user@example.com', 'Hello', '<p>Hi</p>', 'Hi there (plain)');
    assertEqual(spy.calls.emails[0].body, 'Hi there (plain)');
  } finally { spy.restore(); }
}
function test_safeMail_catchesErrorFromSendEmail_doesNotThrow() {
  const real = GmailApp.sendEmail;
  GmailApp.sendEmail = function () { throw new Error('quota exceeded'); };
  try {
    safeMail('user@example.com', 'Hello', '<p>Hi</p>');
    assert(true, 'safeMail must swallow a real Error thrown by GmailApp.sendEmail');
  } finally { GmailApp.sendEmail = real; }
}
// The actual point of FIX 48: e.message is read as `(e && e.message)`, so a
// thrown null/undefined (legal `throw` targets in JS) must not itself crash
// the catch block with a TypeError while safeMail is busy reporting some
// OTHER failure.
function test_safeMail_catchesNullThrow_doesNotThrow() {
  const real = GmailApp.sendEmail;
  GmailApp.sendEmail = function () { throw null; };
  try {
    safeMail('user@example.com', 'Hello', '<p>Hi</p>');
    assert(true, 'safeMail must not throw when GmailApp.sendEmail throws null');
  } finally { GmailApp.sendEmail = real; }
}
function test_safeMail_catchesBareStringThrow_doesNotThrow() {
  const real = GmailApp.sendEmail;
  GmailApp.sendEmail = function () { throw 'boom'; };
  try {
    safeMail('user@example.com', 'Hello', '<p>Hi</p>');
    assert(true, 'safeMail must not throw when GmailApp.sendEmail throws a bare string');
  } finally { GmailApp.sendEmail = real; }
}

const UTILS_TESTS = [
  test_fmtNum_addsThousandsSeparators,
  test_fmtNum_smallNumberUnchanged,
  test_fmtNum_nullOrUndefinedIsZero,
  test_fmtMs_underOneSecond,
  test_fmtMs_overOneSecond,
  test_chunkArray_splitsIntoFixedSizeGroups,
  test_chunkArray_emptyInputYieldsEmptyOutput,
  test_chunkArray_respectsGmailChunkConstant,
  test_getAppUrl_returnsEmptyStringOnFailure_neverThrows,
  test_getAppUrl_returnsUrlWhenDeployed,
  test_safeMail_sendsHtmlBodyAndFallsBackToSubjectAsPlainText,
  test_safeMail_usesExplicitPlainBodyWhenProvided,
  test_safeMail_catchesErrorFromSendEmail_doesNotThrow,
  test_safeMail_catchesNullThrow_doesNotThrow,
  test_safeMail_catchesBareStringThrow_doesNotThrow
];
