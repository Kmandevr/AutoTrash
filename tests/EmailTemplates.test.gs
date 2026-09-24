/**
 * AutoTrash tests — app/EmailTemplates.gs (buildAsciiChart, plainBody,
 * escHtml, buildEmailHtml).
 * Split out of the former monolithic tests/Tests.gs on 2026-09-24 — see
 * CLAUDE.md for the full test-file map and TestFramework.gs for the shared
 * assertions/spies these tests use.
 */

function test_buildAsciiChart_emptyStatsReturnsEmptyString() {
  assertEqual(buildAsciiChart({ labels: {} }), '');
  assertEqual(buildAsciiChart({}), '');
}
function test_buildAsciiChart_tinyRuleNeverRendersAsBlankBar() {
  const chart = buildAsciiChart({
    labels: { BIG: { moved: 10000, trashed: 10000, archived: 0 }, TINY: { moved: 5, trashed: 5, archived: 0 } }
  });
  const tinyLine = chart.split('\n').find(l => l.startsWith('TINY'));
  assert(!!tinyLine, 'chart must include the tiny row');
  assert(tinyLine.includes('█'), 'tiny row must have at least one filled block, not a blank bar');
}
function test_buildAsciiChart_rowsNeverExceedBarWidth() {
  const chart = buildAsciiChart({
    labels: { MIXED: { moved: 300, trashed: 150, archived: 150 } }
  });
  const line = chart.split('\n').find(l => l.startsWith('MIXED'));
  const barSection = line.slice(6, 6 + 18);
  const filled = (barSection.match(/[█░]/g) || []).length;
  assert(filled <= 18, `bar exceeded BAR width: ${filled} blocks`);
}
function test_buildAsciiChart_includesPurgeRows() {
  const chart = buildAsciiChart({ labels: {}, globalPurgeMoved: 40, inboxPurgeMoved: 10 });
  assert(chart.includes('GLOBAL PURGE'), 'chart must include a Global Purge row when it moved mail');
  assert(chart.includes('INBOX PURGE'), 'chart must include an Inbox Purge row when it moved mail');
}
function test_buildAsciiChart_zeroMovedLabelsAreOmitted() {
  const chart = buildAsciiChart({ labels: { EMPTY: { moved: 0, trashed: 0, archived: 0 } } });
  assertEqual(chart, '');
}

function test_plainBody_appendsChartWhenDataPresent() {
  const body = plainBody(['line one'], { labels: { A: { moved: 5, trashed: 5, archived: 0 } } });
  assert(body.indexOf('line one') === 0, 'original lines must come first');
  assert(body.includes('█'), 'plain-text body must include the ascii chart when there is data');
}
function test_plainBody_noChartWhenStatsEmpty() {
  const body = plainBody(['only line'], { labels: {} });
  assertEqual(body, 'only line');
}

function test_escHtml_escapesAngleBracketsAmpersandsAndQuotes() {
  assertEqual(
    escHtml(`<img src=x onerror="alert(1)"> & "quoted"`),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;quoted&quot;'
  );
}
function test_escHtml_plainTextUnchanged() {
  assertEqual(escHtml('PROMOTIONS'), 'PROMOTIONS');
}

function test_buildEmailHtml_escapesRuleNameInPerRuleTable() {
  const evilName = '<img src=x onerror=alert(1)>';
  const html = buildEmailHtml('LIVE RUN COMPLETE', ['✓ done'], '#00ff88',
    { labels: { [evilName]: { moved: 3, trashed: 3, archived: 0 } } }, 1000, false);
  assert(!html.includes('<img src=x onerror=alert(1)>'),
    'raw unescaped rule name must not appear in the email HTML');
  assert(html.includes('&lt;img src=x onerror=alert(1)&gt;'),
    'rule name must appear HTML-escaped in the per-rule table');
}

const EMAILTEMPLATES_TESTS = [
  test_buildAsciiChart_emptyStatsReturnsEmptyString,
  test_buildAsciiChart_tinyRuleNeverRendersAsBlankBar,
  test_buildAsciiChart_rowsNeverExceedBarWidth,
  test_buildAsciiChart_includesPurgeRows,
  test_buildAsciiChart_zeroMovedLabelsAreOmitted,
  test_plainBody_appendsChartWhenDataPresent,
  test_plainBody_noChartWhenStatsEmpty,
  test_escHtml_escapesAngleBracketsAmpersandsAndQuotes,
  test_escHtml_plainTextUnchanged,
  test_buildEmailHtml_escapesRuleNameInPerRuleTable
];
