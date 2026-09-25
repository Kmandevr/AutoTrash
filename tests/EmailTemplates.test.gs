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

// ── buildEmailHtml: dry-run vs live wording (the one visual signal telling
// the user whether mail actually moved). Coverage only, no code change.
function test_buildEmailHtml_dryRunShowsSimulationBannerAndWouldLabels() {
  const html = buildEmailHtml('DRY RUN COMPLETE', ['✓ done'], '#00ff88',
    { totalMoved: 5, totalTrashed: 3, totalArchived: 2, labels: {} }, 1000, true);
  assert(html.includes('SIMULATION ONLY'), 'a dry-run email must show the simulation banner');
  assert(html.includes('>Would Action<'), 'dry-run stat box must relabel Actioned as Would Action');
  assert(html.includes('>Would Trash<'), 'dry-run stat box must relabel Trashed as Would Trash');
  assert(html.includes('>Would Archive<'), 'dry-run stat box must relabel Archived as Would Archive');
}
function test_buildEmailHtml_liveRunHasNoSimulationBannerOrWouldLabels() {
  const html = buildEmailHtml('LIVE RUN COMPLETE', ['✓ done'], '#00ff88',
    { totalMoved: 5, totalTrashed: 3, totalArchived: 2, labels: {} }, 1000, false);
  assert(!html.includes('SIMULATION ONLY'), 'a live run email must never show the dry-run simulation banner');
  assert(html.includes('>Actioned<'), 'a live run stat box must use the real "Actioned" label');
  assert(!html.includes('Would Action'), 'a live run must never use dry-run wording');
}

// ── buildEmailHtml: open-app button (FIX 26/BUG-E7) ────────────────────────
function test_buildEmailHtml_omitsOpenButtonWhenNotDeployedAsWebApp() {
  const html = buildEmailHtml('LIVE RUN COMPLETE', ['✓ done'], '#00ff88', { labels: {} }, 1000, false);
  assert(!html.includes('Open AutoTrash'), 'must omit the open-app button when getAppUrl() has no URL to link to');
}
function test_buildEmailHtml_includesOpenButtonLinkingToDeployedAppUrl() {
  const real = ScriptApp.getService;
  ScriptApp.getService = function () { return { getUrl: function () { return 'https://script.google.com/x/exec'; } }; };
  try {
    const html = buildEmailHtml('LIVE RUN COMPLETE', ['✓ done'], '#00ff88', { labels: {} }, 1000, false);
    assert(html.includes('Open AutoTrash'), 'must show the open-app button when a deployed web app URL is available');
    assert(html.includes('href="https://script.google.com/x/exec"'), 'button must link to the actual deployed app URL, not a placeholder');
  } finally {
    ScriptApp.getService = real;
  }
}

// ── buildEmailHtml: Global/Inbox Purge rows in the per-rule table ──────────
function test_buildEmailHtml_includesPurgeRowsInTable() {
  const html = buildEmailHtml('LIVE RUN COMPLETE', ['✓ done'], '#00ff88',
    { labels: {}, globalPurgeMoved: 40, inboxPurgeMoved: 10 }, 1000, false);
  assert(html.includes('GLOBAL PURGE'), 'table must include a Global Purge row when it moved mail');
  assert(html.includes('INBOX PURGE'), 'table must include an Inbox Purge row when it moved mail');
}

// ── buildEmailHtml: per-line log color coding ───────────────────────────────
function test_buildEmailHtml_colorCodesLogLinesByPrefix() {
  const html = buildEmailHtml('LIVE RUN COMPLETE',
    ['⚠ warning line', '✓ success line', '  indented detail', 'plain line'],
    '#00ff88', { labels: {} }, 1000, false);
  assert(html.includes('color:#ff6677;line-height:1.6;white-space:pre;">⚠ warning line'),
    'a line starting with ⚠ must render in the warning color');
  assert(html.includes('color:#00ff88;line-height:1.6;white-space:pre;">✓ success line'),
    'a line starting with ✓ must render in the success color');
  assert(html.includes('color:#88bb99;line-height:1.6;white-space:pre;">  indented detail'),
    'an indented detail line must render in the muted color');
  assert(html.includes('color:#aaffcc;line-height:1.6;white-space:pre;">plain line'),
    'an unprefixed line must render in the default color');
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
  test_buildEmailHtml_escapesRuleNameInPerRuleTable,
  test_buildEmailHtml_dryRunShowsSimulationBannerAndWouldLabels,
  test_buildEmailHtml_liveRunHasNoSimulationBannerOrWouldLabels,
  test_buildEmailHtml_omitsOpenButtonWhenNotDeployedAsWebApp,
  test_buildEmailHtml_includesOpenButtonLinkingToDeployedAppUrl,
  test_buildEmailHtml_includesPurgeRowsInTable,
  test_buildEmailHtml_colorCodesLogLinesByPrefix
];
