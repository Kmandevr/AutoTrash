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

const CODE_TESTS = [
  test_doGet_setsMobileViewportMetaTag
];
