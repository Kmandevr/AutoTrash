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
  test_getAppUrl_returnsUrlWhenDeployed
];
