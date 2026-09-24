/**
 * AutoTrash tests — app/Code.gs. As of 2026-09-24, Code.gs holds only
 * CONSTANTS and doGet(); its settings/trigger tests moved to
 * tests/Config.test.gs alongside the app/Config.gs they now test.
 * doGet() itself isn't unit-tested — it just wires an HtmlOutput, which the
 * Node harness's HtmlService mock (tests/mocks/apps-script-globals.js)
 * doesn't model meaningfully; CODE_TESTS is kept as an empty array so
 * RunAll.gs's .concat() chain doesn't need touching if that changes later.
 */
const CODE_TESTS = [];
