/**
 * ████████████████████████████████████████████████████████████████
 * AUTOTRASH — TEST SUITE
 * Deploy as AutoTrash_Tests.gs, alongside Code.gs and index.html, in the
 * same Apps Script project (it calls helpers — fmtNum, safeMail, ownerEmail,
 * buildQuery, etc. — directly from Code.gs, so it cannot run standalone).
 * ████████████████████████████████████████████████████████████████
 *
 * RUN: execute runAllTests() from the Apps Script editor (Run ▶ on this
 * file), or wire it to a manual trigger. Results are written to the
 * execution log AND emailed to the script owner as an HTML report; the
 * subject line reports pass/fail/skip totals so a broken build is visible
 * without opening the log.
 *
 * Any change to Code.gs behaviour must be mirrored here in the same pass.
 */

// ════════════════════════════════════════════════════════════════════════
// TEST FRAMEWORK
// ════════════════════════════════════════════════════════════════════════

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error((msg ? msg + ' — ' : '') + `expected ${e}, got ${a}`);
}
function assertThrows(fn, msg) {
  try { fn(); } catch (e) { return; }
  throw new Error(msg || 'expected function to throw, it did not');
}

// Saves a UserProperties key, runs fn(), restores the original value (or
// deletes the key if it never existed) even if fn() throws.
function withSavedProps(keys, fn) {
  const props = getProps();
  const saved = {};
  keys.forEach(k => { saved[k] = props.getProperty(k); });
  try {
    fn(props);
  } finally {
    keys.forEach(k => {
      if (saved[k] === null || saved[k] === undefined) props.deleteProperty(k);
      else props.setProperty(k, saved[k]);
    });
  }
}

// ── FAKE GMAIL THREAD ─────────────────────────────────────────────────────
function makeFakeThread(id) {
  return {
    __id: String(id),
    __trashed: false,
    __archived: false,
    getId: function () { return this.__id; }
  };
}

// ── GMAILAPP SPY ──────────────────────────────────────────────────────────
// searchImpl(query) must return an array of fake threads for that query.
// Pass a plain array to match every query the same way regardless of text.
function installGmailSpy(searchImpl) {
  const real = (typeof GmailApp !== 'undefined') ? GmailApp : null;
  const calls = { search: [], trashBatches: [], archiveBatches: [], emails: [] };
  const resolve = Array.isArray(searchImpl) ? (() => searchImpl) : searchImpl;

  const fake = {
    search: function (q, start, max) {
      calls.search.push(q);
      const all = resolve(q) || [];
      const s = start || 0, m = max == null ? all.length : max;
      return all.slice(s, s + m);
    },
    moveThreadsToTrash: function (threads) {
      calls.trashBatches.push(threads.map(t => t.getId()));
      threads.forEach(t => { t.__trashed = true; });
    },
    moveThreadsToArchive: function (threads) {
      calls.archiveBatches.push(threads.map(t => t.getId()));
      threads.forEach(t => { t.__archived = true; });
    },
    sendEmail: function (to, subj, body, opts) {
      calls.emails.push({ to: to, subj: subj, body: body, opts: opts });
    }
  };

  GmailApp = fake; // reassign the global binding — see file header for why.

  return {
    calls: calls,
    restore: function () { GmailApp = real; }
  };
}

// ── LOCKSERVICE SPY (backgroundRun tests only) ───────────────────────────
function installLockSpy(opts) {
  opts = opts || {};
  const real = (typeof LockService !== 'undefined') ? LockService : null;
  let released = false;
  const fake = {
    getScriptLock: function () {
      return {
        waitLock: function () {
          if (opts.failToAcquire) throw new Error('Could not obtain lock.');
        },
        releaseLock: function () { released = true; }
      };
    }
  };
  LockService = fake;
  return {
    wasReleased: function () { return released; },
    restore: function () { LockService = real; }
  };
}

// ── SCRIPTAPP SPY (updateSystem trigger tests — tenth pass, 2026-09-02) ──
function installScriptAppSpy(existingTriggers) {
  const real = (typeof ScriptApp !== 'undefined') ? ScriptApp : null;
  let triggers = (existingTriggers || []).slice();
  let nextId = 1;
  const calls = { newTrigger: [], deleteTrigger: [] };

  function makeTriggerObj(handlerFn, config) {
    const id = 'trig_' + (nextId++);
    return {
      __id: id,
      config: config,
      getHandlerFunction: function () { return handlerFn; },
      getUniqueId: function () { return id; }
    };
  }

  const fake = {
    getService: (real && real.getService) || function () { return { getUrl: function () { return ''; } }; },
    getProjectTriggers: function () { return triggers.slice(); },
    deleteTrigger: function (t) {
      calls.deleteTrigger.push(t.getHandlerFunction());
      triggers = triggers.filter(function (x) { return x !== t; });
    },
    newTrigger: function (handlerFn) {
      calls.newTrigger.push(handlerFn);
      const config = {};
      const builder = {
        timeBased:     function ()  { return builder; },
        everyMinutes:  function (n) { config.everyMinutes = n; return builder; },
        everyHours:    function (n) { config.everyHours   = n; return builder; },
        everyDays:     function (n) { config.everyDays    = n; return builder; },
        atHour:        function (n) { config.atHour       = n; return builder; },
        create: function () {
          const t = makeTriggerObj(handlerFn, config);
          triggers.push(t);
          return t;
        }
      };
      return builder;
    }
  };
  ScriptApp = fake;
  return {
    calls: calls,
    triggers: function () { return triggers.slice(); },
    restore: function () { ScriptApp = real; }
  };
}

// ════════════════════════════════════════════════════════════════════════
// LAYER 1 — PURE LOGIC TESTS
// ════════════════════════════════════════════════════════════════════════

function test_assertThrows_frameworkHelperWorks() {
  assertThrows(function () { throw new Error('x'); }, 'assertThrows must not raise when fn throws');
  let caught = false;
  try { assertThrows(function () {}, 'expected failure'); }
  catch (e) { caught = true; }
  assert(caught, 'assertThrows must itself throw when fn does NOT throw');
}

function test_buildQuery_labelRule() {
  assertEqual(
    buildQuery({ label: 'Newsletters', days: 30, isTrash: true }),
    'label:"Newsletters" in:inbox older_than:30d -is:starred -in:trash'
  );
}
function test_buildQuery_labelRuleWithSpaces() {
  assertEqual(
    buildQuery({ label: 'Old Receipts', days: 10 }),
    'label:"Old Receipts" in:inbox older_than:10d -is:starred -in:trash'
  );
}
function test_buildQuery_category() {
  assertEqual(
    buildQuery({ isCategory: true, category: 'promotions', days: 30 }),
    'category:promotions in:inbox older_than:30d -is:starred -in:trash'
  );
}
function test_buildQuery_spamCategory_usesInSpamNotCategoryTab() {
  assertEqual(
    buildQuery({ isCategory: true, category: 'spam', days: 7 }),
    'in:spam older_than:7d -is:starred -in:trash'
  );
}
function test_buildQuery_inboxPurge_scopedToInbox_noRedundantTrashClause() {
  const q = buildQuery({ isInboxPurge: true, days: 90 });
  assertEqual(q, 'in:inbox older_than:90d -is:starred');
  assert(!q.includes('-in:trash'), 'inbox purge query must not carry a redundant -in:trash');
}
function test_buildQuery_globalPurge_allMailScope_excludesTrashAndSpam() {
  const q = buildQuery({ isGlobalPurge: true, days: 365 });
  assertEqual(q, 'older_than:365d -is:starred -in:trash -in:spam');
  assert(!q.includes('in:inbox'), 'global purge must reach archived mail — no in:inbox scope');
}
function test_buildQuery_allRuleTypes_spareStarredMail() {
  const rules = [
    { label: 'A', days: 1 },
    { isCategory: true, category: 'social', days: 1 },
    { isCategory: true, category: 'spam', days: 1 },
    { isInboxPurge: true, days: 1 },
    { isGlobalPurge: true, days: 1 }
  ];
  rules.forEach(r => assert(buildQuery(r).includes('-is:starred'), 'missing -is:starred in: ' + JSON.stringify(r)));
}

function test_buildQuery_labelWithEmbeddedQuote_doesNotBreakOutOfQuotedTerm() {
  const q = buildQuery({ label: 'Foo"Bar', days: 5 });
  assertEqual(q, 'label:"FooBar" in:inbox older_than:5d -is:starred -in:trash');
  assertEqual((q.match(/"/g) || []).length, 2, 'query must contain exactly one quoted phrase (2 quote chars)');
}
function test_buildQuery_labelWithoutQuotes_unaffectedByFix() {
  assertEqual(
    buildQuery({ label: 'Receipts', days: 5 }),
    'label:"Receipts" in:inbox older_than:5d -is:starred -in:trash'
  );
}

function test_buildQuery_labelAllQuoteCharacters_producesEmptyQuotedTerm() {
  const q = buildQuery({ label: '""', days: 5 });
  assertEqual(q, 'label:"" in:inbox older_than:5d -is:starred -in:trash');
}

function test_buildQuery_negativeDays_isNotValidatedOrClamped() {
  const q = buildQuery({ isCategory: true, category: 'promotions', days: -5 });
  assertEqual(q, 'category:promotions in:inbox older_than:-5d -is:starred -in:trash');
}

function test_resolveRuleAction_explicitTrash() {
  assertEqual(resolveRuleAction({ isTrash: true }), 'trash');
}
function test_resolveRuleAction_explicitArchive() {
  assertEqual(resolveRuleAction({ isTrash: false }), 'archive');
}
function test_resolveRuleAction_undefinedDefaultsToTrash() {
  assertEqual(resolveRuleAction({}), 'trash');
}
function test_resolveRuleAction_nullDefaultsToTrash() {
  assertEqual(resolveRuleAction({ isTrash: null }), 'trash');
}
function test_resolveRuleAction_globalPurgeAlwaysTrash_ignoresIsTrash() {
  assertEqual(resolveRuleAction({ isGlobalPurge: true, isTrash: false }), 'trash');
}
function test_resolveRuleAction_inboxPurgeAlwaysTrash_ignoresIsTrash() {
  assertEqual(resolveRuleAction({ isInboxPurge: true, isTrash: false }), 'trash');
}

function test_buildQueue_order_labelsThenCategoriesThenPurges() {
  const q = buildQueue(
    [{ label: 'A', days: 1 }, { label: 'B', days: 2 }],
    '365', '30',
    [{ category: 'social', enabled: true, days: 60 }, { category: 'updates', enabled: false, days: 30 }]
  );
  assertEqual(q.map(r => r.label || r.category), ['A', 'B', 'social', 'INBOX PURGE', 'GLOBAL PURGE']);
}
function test_buildQueue_disabledCategoriesExcluded() {
  const q = buildQueue([], 'OFF', 'OFF', [{ category: 'forums', enabled: false, days: 60 }]);
  assertEqual(q.length, 0);
}
function test_buildQueue_categoryRulesFlaggedIsCategory() {
  const q = buildQueue([], 'OFF', 'OFF', [{ category: 'social', enabled: true, days: 60 }]);
  assert(q[0].isCategory === true, 'buildQueue must set isCategory:true on category entries');
}
function test_buildQueue_purgeRulesUseGlobalPurgeAndInboxPurgeLabels() {
  const q = buildQueue([], '365', '90', []);
  assertEqual(q.map(r => r.label), ['INBOX PURGE', 'GLOBAL PURGE']);
}
function test_buildQueue_offMeansOff() {
  const q = buildQueue([{ label: 'A', days: 1 }], 'OFF', 'OFF', []);
  assertEqual(q.length, 1);
}

function test_ensureStat_createsZeroedEntryOnce() {
  const stats = { labels: {} };
  ensureStat(stats, 'X');
  ensureStat(stats, 'X');
  stats.labels.X.moved = 5;
  ensureStat(stats, 'X');
  assertEqual(stats.labels.X.moved, 5, 'ensureStat must not overwrite an existing entry');
}
function test_creditStat_normalRuleGoesToLabels() {
  const stats = { labels: {} };
  creditStat(stats, 'PROMOTIONS', {}, 5, 2);
  assertEqual(stats.labels.PROMOTIONS, { moved: 7, trashed: 5, archived: 2, finished: false });
}
function test_creditStat_globalPurge_bypassesLabels() {
  const stats = { labels: {}, globalPurgeMoved: 0, globalPurgeTrashed: 0 };
  creditStat(stats, 'GLOBAL PURGE', { isGlobalPurge: true }, 10, 0);
  assertEqual([stats.globalPurgeMoved, stats.globalPurgeTrashed], [10, 10]);
  assert(!stats.labels['GLOBAL PURGE'], 'global purge must not create a stats.labels entry');
}
function test_creditStat_inboxPurge_bypassesLabels() {
  const stats = { labels: {}, inboxPurgeMoved: 0, inboxPurgeTrashed: 0 };
  creditStat(stats, 'INBOX PURGE', { isInboxPurge: true }, 4, 0);
  assertEqual([stats.inboxPurgeMoved, stats.inboxPurgeTrashed], [4, 4]);
  assert(!stats.labels['INBOX PURGE'], 'inbox purge must not create a stats.labels entry');
}
function test_creditStat_accumulatesAcrossMultipleCalls() {
  const stats = { labels: {} };
  creditStat(stats, 'A', {}, 3, 0);
  creditStat(stats, 'A', {}, 2, 1);
  assertEqual(stats.labels.A, { moved: 6, trashed: 5, archived: 1, finished: false });
}

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

function test_escHtml_escapesAngleBracketsAmpersandsAndQuotes() {
  assertEqual(
    escHtml(`<img src=x onerror="alert(1)"> & "quoted"`),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;quoted&quot;'
  );
}
function test_escHtml_plainTextUnchanged() {
  assertEqual(escHtml('PROMOTIONS'), 'PROMOTIONS');
}

function test_accumulate_initializesWhenEmpty() {
  withSavedProps(['DAILY_STATS'], props => {
    props.deleteProperty('DAILY_STATS');
    accumulateDailyStats({ totalMoved: 3, totalTrashed: 3, totalArchived: 0 });
    const d = JSON.parse(props.getProperty('DAILY_STATS'));
    assertEqual(d.runs, 1);
    assertEqual(d.totalMoved, 3);
  });
}
function test_accumulate_addsAcrossMultipleRuns() {
  withSavedProps(['DAILY_STATS'], props => {
    props.deleteProperty('DAILY_STATS');
    accumulateDailyStats({ totalMoved: 2, totalTrashed: 2, totalArchived: 0 });
    accumulateDailyStats({ totalMoved: 5, totalTrashed: 0, totalArchived: 5 });
    const d = JSON.parse(props.getProperty('DAILY_STATS'));
    assertEqual(d.runs, 2);
    assertEqual(d.totalMoved, 7);
    assertEqual(d.totalTrashed, 2);
    assertEqual(d.totalArchived, 5);
  });
}
function test_accumulate_doesNotResetOnNewDay() {
  withSavedProps(['DAILY_STATS'], props => {
    const old = { date: '2026-01-01', totalMoved: 99, totalTrashed: 99, totalArchived: 0,
                   globalPurgeMoved: 0, globalPurgeTrashed: 0, inboxPurgeMoved: 0, inboxPurgeTrashed: 0,
                   labels: {}, runs: 99 };
    props.setProperty('DAILY_STATS', JSON.stringify(old));
    accumulateDailyStats({ totalMoved: 1, totalTrashed: 1, totalArchived: 0 });
    const d = JSON.parse(props.getProperty('DAILY_STATS'));
    assertEqual(d.runs, 100, 'counters must survive a calendar-day boundary — only sendDailyDigest() resets them');
    assertEqual(d.totalMoved, 100);
  });
}
function test_accumulate_purgeTrashedSubcountsAreKept() {
  withSavedProps(['DAILY_STATS'], props => {
    props.deleteProperty('DAILY_STATS');
    accumulateDailyStats({ totalMoved: 10, totalTrashed: 10, totalArchived: 0, globalPurgeMoved: 10, globalPurgeTrashed: 10 });
    const d = JSON.parse(props.getProperty('DAILY_STATS'));
    assertEqual(d.globalPurgeTrashed, 10, 'globalPurgeTrashed must accumulate alongside globalPurgeMoved');
  });
}

function test_subject_dryRun_saysWouldBeActioned_notActioned() {
  const spy = installGmailSpy([]);
  try {
    sendRunEmail({ totalMoved: 12, totalTrashed: 0, totalArchived: 0, errors: [] }, 1000, 'Dry Run Complete', '#ffbb44', true);
    assert(spy.calls.emails.length === 1, 'expected exactly one email');
    const subj = spy.calls.emails[0].subj;
    assert(subj.indexOf('would be actioned') > -1, 'dry-run subject must say "would be actioned": ' + subj);
    assert(subj.indexOf('[DRY RUN]') === 0, 'dry-run subject must be tagged up front: ' + subj);
  } finally { spy.restore(); }
}
function test_subject_liveRun_saysActioned() {
  const spy = installGmailSpy([]);
  try {
    sendRunEmail({ totalMoved: 12, totalTrashed: 8, totalArchived: 4, errors: [] }, 1000, 'Live Run Complete', '#00ff88', false);
    const subj = spy.calls.emails[0].subj;
    assert(subj.indexOf('actioned') > -1 && subj.indexOf('would') === -1, 'live subject must say actioned, not "would": ' + subj);
  } finally { spy.restore(); }
}
function test_subject_errorsWithZeroMoved_leadsWithErrorLabel() {
  const spy = installGmailSpy([]);
  try {
    sendRunEmail({ totalMoved: 0, totalTrashed: 0, totalArchived: 0, errors: [{ label: 'PROMOTIONS', error: 'quota' }] }, 500, 'Live Run', '#ff4455', false);
    const subj = spy.calls.emails[0].subj;
    assert(subj.indexOf('Error in PROMOTIONS') > -1, 'zero-moved error subject must lead with the failing rule: ' + subj);
  } finally { spy.restore(); }
}
function test_subject_errorsWithSomeMoved_appendsErrorsTag() {
  const spy = installGmailSpy([]);
  try {
    sendRunEmail({ totalMoved: 5, totalTrashed: 5, totalArchived: 0, errors: [{ label: 'X', error: 'boom' }] }, 500, 'Live Run', '#ff4455', false);
    const subj = spy.calls.emails[0].subj;
    assert(subj.indexOf('(errors)') > -1, 'partial-success error subject must flag "(errors)": ' + subj);
  } finally { spy.restore(); }
}
function test_dryRunAbortSubject_saysScannedNotActioned() {
  const spy = installGmailSpy([]);
  try {
    withSavedProps(['SUMMARY_FREQ', 'DAILY_STATS'], props => {
      props.setProperty('SUMMARY_FREQ', 'EACH_RUN');
      abortRun({ totalMoved: 20, dryTrashed: 15, dryArchived: 5 }, 3000, true);
    });
    const subj = spy.calls.emails[0].subj;
    assert(subj.indexOf('scanned') > -1, 'dry-run abort subject must say "scanned": ' + subj);
    assert(subj.indexOf('actioned') === -1, 'dry-run abort subject must not say "actioned": ' + subj);
  } finally { spy.restore(); }
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

function test_abortRun_liveRun_accumulatesDailyStats() {
  withSavedProps(['SUMMARY_FREQ', 'DAILY_STATS'], props => {
    props.setProperty('SUMMARY_FREQ', 'NEVER');
    props.deleteProperty('DAILY_STATS');
    abortRun({ totalMoved: 9, totalTrashed: 9, totalArchived: 0 }, 1000, false);
    const d = JSON.parse(props.getProperty('DAILY_STATS'));
    assertEqual(d.runs, 1, 'an aborted LIVE run must still count toward daily digest totals');
    assertEqual(d.totalMoved, 9, 'real mail actioned before an abort must not vanish from the digest');
  });
}
function test_abortRun_dryRun_doesNotAccumulateDailyStats() {
  withSavedProps(['SUMMARY_FREQ', 'DAILY_STATS'], props => {
    props.setProperty('SUMMARY_FREQ', 'NEVER');
    props.deleteProperty('DAILY_STATS');
    abortRun({ totalMoved: 9, dryTrashed: 9, dryArchived: 0 }, 1000, true);
    const raw = props.getProperty('DAILY_STATS');
    assert(!raw, 'a dry-run abort must not create/modify DAILY_STATS — nothing real happened (matches FIX 10)');
  });
}

function test_backgroundRun_corruptRulesProperty_doesNotThrow() {
  withSavedProps(['AUTOTRASH_RULES', 'CATEGORY_RULES', 'GLOBAL_PURGE_DAYS', 'INBOX_PURGE_DAYS'], props => {
    props.setProperty('AUTOTRASH_RULES', '{not valid json');
    props.setProperty('CATEGORY_RULES', '[]');
    props.setProperty('GLOBAL_PURGE_DAYS', 'OFF');
    props.setProperty('INBOX_PURGE_DAYS', 'OFF');
    let threw = false;
    try { backgroundRun(); } catch (e) { threw = true; }
    assertEqual(threw, false, 'a corrupted AUTOTRASH_RULES property must not crash backgroundRun() — it should fall back to an empty rule list');
  });
}
function test_backgroundRun_corruptCategoryRulesProperty_doesNotThrow() {
  withSavedProps(['AUTOTRASH_RULES', 'CATEGORY_RULES', 'GLOBAL_PURGE_DAYS', 'INBOX_PURGE_DAYS'], props => {
    props.setProperty('AUTOTRASH_RULES', '[]');
    props.setProperty('CATEGORY_RULES', 'definitely not json');
    props.setProperty('GLOBAL_PURGE_DAYS', 'OFF');
    props.setProperty('INBOX_PURGE_DAYS', 'OFF');
    let threw = false;
    try { backgroundRun(); } catch (e) { threw = true; }
    assertEqual(threw, false, 'a corrupted CATEGORY_RULES property must not crash backgroundRun()');
  });
}
function test_getUISettings_corruptRulesProperty_returnsEmptyArraysNotThrow() {
  withSavedProps(['AUTOTRASH_RULES', 'CATEGORY_RULES'], props => {
    props.setProperty('AUTOTRASH_RULES', 'not json at all');
    props.setProperty('CATEGORY_RULES', 'also not json');
    let result, threw = false;
    try { result = getUISettings(); } catch (e) { threw = true; }
    assertEqual(threw, false, 'getUISettings must not throw on corrupted rule properties');
    assertEqual(result.rules, [], 'corrupted AUTOTRASH_RULES must fall back to an empty array, not crash the settings load');
    assertEqual(result.categoryRules, [], 'corrupted CATEGORY_RULES must fall back to an empty array');
  });
}
function test_getUISettings_validRulesProperty_stillParsesNormally() {
  withSavedProps(['AUTOTRASH_RULES', 'CATEGORY_RULES'], props => {
    props.setProperty('AUTOTRASH_RULES', JSON.stringify([{ label: 'REAL', days: 30, isTrash: true }]));
    props.setProperty('CATEGORY_RULES', JSON.stringify([{ category: 'social', enabled: true, days: 60 }]));
    const result = getUISettings();
    assertEqual(result.rules, [{ label: 'REAL', days: 30, isTrash: true }]);
    assertEqual(result.categoryRules, [{ category: 'social', enabled: true, days: 60 }]);
  });
}

// ════════════════════════════════════════════════════════════════════════
// LAYER 2 — FAKE-THREAD INTEGRATION TESTS (processLiveBurst)
// ════════════════════════════════════════════════════════════════════════

function freshStats() {
  return {
    totalMoved: 0, totalTrashed: 0, totalArchived: 0,
    globalPurgeMoved: 0, globalPurgeTrashed: 0,
    inboxPurgeMoved: 0, inboxPurgeTrashed: 0,
    dryTrashed: 0, dryArchived: 0,
    labels: {}, errors: []
  };
}

function test_processLiveBurst_ejectsRuleWithZeroThreads() {
  const spy = installGmailSpy([]);
  try {
    const payload = { dryRun: false, activeQueue: [{ label: 'EMPTY', days: 30, isTrash: true }], seenIds: [], stats: freshStats() };
    const res = processLiveBurst(payload);
    assert(res.ejected === true, 'rule with 0 matches must be ejected');
    assertEqual(res.payload.activeQueue.length, 0);
    assertEqual(res.payload.stats.labels.EMPTY.finished, true);
  } finally { spy.restore(); }
}

function test_processLiveBurst_liveRun_trashesAndRotatesToBack() {
  const threads = [makeFakeThread('t1'), makeFakeThread('t2')];
  const spy = installGmailSpy(threads);
  try {
    const payload = {
      dryRun: false,
      activeQueue: [{ label: 'PROMOS', days: 30, isTrash: true }, { label: 'OTHER', days: 30, isTrash: true }],
      seenIds: [], stats: freshStats()
    };
    const res = processLiveBurst(payload);
    assert(threads.every(t => t.__trashed), 'matched threads must actually be trashed');
    assertEqual(res.payload.activeQueue.map(r => r.label), ['OTHER', 'PROMOS'], 'processed rule must rotate to the back of the queue');
    assertEqual(res.payload.stats.totalTrashed, 2);
    assertEqual(res.payload.stats.labels.PROMOS.trashed, 2);
  } finally { spy.restore(); }
}

function test_processLiveBurst_archiveAction_movesToArchiveNotTrash() {
  const threads = [makeFakeThread('a1')];
  const spy = installGmailSpy(threads);
  try {
    const payload = { dryRun: false, activeQueue: [{ label: 'SOCIAL', days: 60, isTrash: false }], seenIds: [], stats: freshStats() };
    processLiveBurst(payload);
    assert(threads[0].__archived === true, 'isTrash:false must archive');
    assert(threads[0].__trashed === false, 'isTrash:false must NOT trash');
  } finally { spy.restore(); }
}

function test_processLiveBurst_seenIdsDedup_skipsAlreadyProcessedThreads() {
  const shared = makeFakeThread('shared1');
  const spy = installGmailSpy([shared]);
  try {
    const payload = {
      dryRun: false,
      activeQueue: [{ label: 'RULE_B', days: 30, isTrash: true }],
      seenIds: ['shared1'],
      stats: freshStats()
    };
    const res = processLiveBurst(payload);
    assert(res.ejected === true, 'the only matching thread was already seen — rule must eject with 0 new threads');
    assertEqual(shared.__trashed, false, 'an already-seen thread must not be actioned again');
  } finally { spy.restore(); }
}

function test_processLiveBurst_dryRun_countsWithoutActingAndEjectsWithoutRotating() {
  const threads = [makeFakeThread('d1'), makeFakeThread('d2'), makeFakeThread('d3')];
  const spy = installGmailSpy(threads);
  try {
    const payload = {
      dryRun: true,
      activeQueue: [{ label: 'PROMOS', days: 30, isTrash: true }, { label: 'OTHER', days: 30, isTrash: true }],
      seenIds: [], stats: freshStats()
    };
    const res = processLiveBurst(payload);
    assert(threads.every(t => !t.__trashed && !t.__archived), 'dry run must never call Gmail move actions');
    assertEqual(res.payload.stats.dryTrashed, 3);
    assertEqual(res.payload.stats.totalTrashed, 0, 'dry run must not touch totalTrashed — only dryTrashed');
    assertEqual(res.payload.activeQueue.map(r => r.label), ['OTHER'], 'dry run ejects rather than rotating to the back');
  } finally { spy.restore(); }
}

function test_processLiveBurst_globalPurge_dryRun_routesThroughCreditStat_notLabels() {
  const threads = [makeFakeThread('g1')];
  const spy = installGmailSpy(threads);
  try {
    const payload = { dryRun: true, activeQueue: [{ isGlobalPurge: true, isTrash: true, days: 365, label: 'GLOBAL PURGE' }], seenIds: [], stats: freshStats() };
    const res = processLiveBurst(payload);
    assertEqual(res.payload.stats.globalPurgeDone, true);
    assertEqual(res.payload.stats.dryTrashed, 1);
    assert(!res.payload.stats.labels['GLOBAL PURGE'], 'dry-run global purge must not create a stats.labels ghost row');
  } finally { spy.restore(); }
}

function test_processLiveBurst_purgeRule_liveEject_setsDoneFlagNotLabels() {
  const spy = installGmailSpy([]);
  try {
    const payload = { dryRun: false, activeQueue: [{ isInboxPurge: true, isTrash: true, days: 30, label: 'INBOX PURGE' }], seenIds: [], stats: freshStats() };
    const res = processLiveBurst(payload);
    assertEqual(res.payload.stats.inboxPurgeDone, true);
    assert(!res.payload.stats.labels['INBOX PURGE'], 'purge rule ejecting clean must not create a stats.labels entry');
  } finally { spy.restore(); }
}

function test_processLiveBurst_builtNullQueueServerSide() {
  const threads = [makeFakeThread('n1')];
  const spy = installGmailSpy(threads);
  try {
    const payload = {
      dryRun: false,
      rules: [{ label: 'SOLO', days: 30, isTrash: true }],
      categoryRules: [], globalPurgeDays: 'OFF', inboxPurgeDays: 'OFF',
      activeQueue: null, seenIds: [], stats: freshStats()
    };
    const res = processLiveBurst(payload);
    assert(res.done !== true || res.moved === 1, 'a null activeQueue with real rules must actually process a rule, not report done:true immediately');
    assertEqual(res.payload.stats.totalTrashed, 1);
  } finally { spy.restore(); }
}

function test_processLiveBurst_errorDuringLiveRun_recordsErrorAndEmailsWithoutCrashing() {
  const spy = installGmailSpy(function () { throw new Error('Simulated Gmail quota error'); });
  try {
    const payload = { dryRun: false, activeQueue: [{ label: 'FLAKY', days: 30, isTrash: true }], seenIds: [], stats: freshStats() };
    const res = processLiveBurst(payload);
    assert(res.error === true, 'result must be flagged as an error');
    assertEqual(res.payload.stats.errors.length, 1);
    assertEqual(res.payload.stats.errors[0].label, 'FLAKY', 'error entry must carry the correct rule label');
    assertEqual(spy.calls.emails.length, 1, 'sendErrorEmail must actually send a mail on a live-run error');
  } finally { spy.restore(); }
}

function test_processLiveBurst_errorDuringDryRun_emailReportsProjectedCounts() {
  let firstCall = true;
  const spy = installGmailSpy(function () {
    if (firstCall) { firstCall = false; throw new Error('Simulated failure after partial scan'); }
    return [];
  });
  try {
    const payload = {
      dryRun: true,
      activeQueue: [{ label: 'FLAKY', days: 30, isTrash: true }],
      seenIds: [],
      stats: Object.assign(freshStats(), { dryTrashed: 7, dryArchived: 3, totalMoved: 10 })
    };
    processLiveBurst(payload);
    assertEqual(spy.calls.emails.length, 1);
    const body = spy.calls.emails[0].opts.htmlBody;
    assert(body.indexOf('[DRY RUN]') > -1, 'error email must be tagged as a dry run');
  } finally { spy.restore(); }
}

function test_processLiveBurst_errorEmail_categoryRuleWithoutLabelField_showsCorrectRuleName() {
  const spy = installGmailSpy(function () { throw new Error('Simulated quota error'); });
  try {
    const payload = {
      dryRun: false,
      activeQueue: [{ isCategory: true, category: 'promotions', days: 30 }],
      seenIds: [], stats: freshStats()
    };
    const res = processLiveBurst(payload);
    assertEqual(res.payload.stats.errors[0].label, 'PROMOTIONS',
      'stats.errors must use the isCategory fallback label');
    assertEqual(spy.calls.emails.length, 1);
    const body = spy.calls.emails[0].opts.htmlBody;
    assert(body.includes('PROMOTIONS'), 'error email body must name the actual failing rule, not just stats.errors');
    assert(!body.includes('Rule    : unknown'), 'error email must not fall back to "unknown" when a fallback label is available');
  } finally { spy.restore(); }
}

function test_backgroundRun_errorEmail_categoryRuleWithoutLabelField_showsCorrectRuleName() {
  withSavedProps(['AUTOTRASH_RULES', 'CATEGORY_RULES', 'GLOBAL_PURGE_DAYS', 'INBOX_PURGE_DAYS'], props => {
    props.setProperty('AUTOTRASH_RULES', '[]');
    props.setProperty('CATEGORY_RULES', JSON.stringify([{ isCategory: true, category: 'social', enabled: true, days: 60 }]));
    props.setProperty('GLOBAL_PURGE_DAYS', 'OFF');
    props.setProperty('INBOX_PURGE_DAYS', 'OFF');
    const gmailSpy = installGmailSpy(function () { throw new Error('Simulated quota error'); });
    const lockSpy = installLockSpy();
    try {
      backgroundRun();
      assert(gmailSpy.calls.emails.length >= 1, 'expected at least one email');
      const body = gmailSpy.calls.emails[0].opts.htmlBody;
      assert(body.includes('SOCIAL'), 'background error email body must name the actual failing rule');
      assert(!body.includes('Rule    : unknown'), 'background error email must not fall back to "unknown" when a fallback label is available');
    } finally { lockSpy.restore(); gmailSpy.restore(); }
  });
}

// ── NEW (eleventh pass, 2026-09-01): BUG-C24 regression ────────────────────
function test_processLiveBurst_nonErrorObjectThrown_doesNotCrashErrorReporting() {
  const spy = installGmailSpy(function () { throw 'Simulated non-Error throw (no .message field)'; });
  try {
    const payload = { dryRun: false, activeQueue: [{ label: 'ODDBALL', days: 30, isTrash: true }], seenIds: [], stats: freshStats() };
    let res, threw = false;
    try { res = processLiveBurst(payload); } catch (e) { threw = true; }
    assertEqual(threw, false, 'a non-Error thrown value must not crash processLiveBurst() or its own error-reporting path');
    assert(res && res.error === true, 'result must still be flagged as an error');
    assertEqual(spy.calls.emails.length, 1, 'an error email must still be sent even for a non-Error thrown value');
    const subj = spy.calls.emails[0].subj;
    assert(subj.indexOf('Simulated non-Error throw') > -1, 'error subject must contain the actual thrown text: ' + subj);
    assertEqual(res.payload.stats.errors[0].error, 'Simulated non-Error throw (no .message field)',
      'stats.errors[].error must hold the stringified thrown value, not undefined');
  } finally { spy.restore(); }
}

function test_backgroundRun_nonErrorObjectThrown_doesNotCrashCycle() {
  withSavedProps(['AUTOTRASH_RULES', 'CATEGORY_RULES', 'GLOBAL_PURGE_DAYS', 'INBOX_PURGE_DAYS'], props => {
    props.setProperty('AUTOTRASH_RULES', JSON.stringify([{ label: 'ODDBALL', days: 30, isTrash: true }]));
    props.setProperty('CATEGORY_RULES', '[]');
    props.setProperty('GLOBAL_PURGE_DAYS', 'OFF');
    props.setProperty('INBOX_PURGE_DAYS', 'OFF');
    const gmailSpy = installGmailSpy(function () { throw 'Simulated non-Error throw in background'; });
    const lockSpy = installLockSpy();
    try {
      let threw = false;
      try { backgroundRun(); } catch (e) { threw = true; }
      assertEqual(threw, false, 'a non-Error thrown value must not crash backgroundRun()');
      assert(lockSpy.wasReleased(), 'the lock must still be released even after a non-Error throw mid-cycle');
      assert(gmailSpy.calls.emails.length >= 1, 'an error email must still be sent for a non-Error thrown value in the background path');
    } finally { lockSpy.restore(); gmailSpy.restore(); }
  });
}

// ── NEW (thirteenth pass, 2026-09-01): BUG-C25 regression ──────────────────
// BUG-C24 normalized `err.message` at the three spots that read it directly
// (sendErrorEmail()'s errMsg, and the stats.errors[] push in both
// processLiveBurst() and backgroundRun()) — but missed three more spots that
// read a thrown value's properties just as rawly: sendErrorEmail()'s own
// `err.stack` access, and processLiveBurst()'s catch block returning
// `e.message` straight into both the `log[]` entry and the `msg` field of
// its result. `err === null` or `err === undefined` — both legal `throw`
// targets in JS — crash on ANY property read, including `.stack`, so these
// three spots reopened the exact same "an error-reporting path throws a NEW
// error and hides the original one" failure shape BUG-C15/BUG-C24 already
// established, just one property access further along. A thrown value that
// merely lacks `.message` (e.g. `throw {code:500}`) doesn't crash these
// three spots — reading `.message`/`.stack` off any non-null/undefined
// value just yields `undefined` — but it does silently print the literal
// text "undefined" in the terminal's ERROR line and the halted-run banner,
// even though the already-fixed stats.errors[] entry for the very same
// failure correctly shows the stringified thrown value. See BUG-C25 in
// AUTOTRASH_BUG_PLAN.txt for the full mechanism and reproduction.
function test_processLiveBurst_nullThrown_doesNotCrashErrorReporting() {
  const spy = installGmailSpy(function () { throw null; });
  try {
    const payload = { dryRun: false, activeQueue: [{ label: 'NULLTHROW', days: 30, isTrash: true }], seenIds: [], stats: freshStats() };
    let res, threw = false;
    try { res = processLiveBurst(payload); } catch (e) { threw = true; }
    assertEqual(threw, false, '`throw null` must not crash processLiveBurst() or sendErrorEmail()\'s own err.stack access');
    assert(res && res.error === true, 'result must still be flagged as an error');
    assertEqual(spy.calls.emails.length, 1, 'an error email must still be sent even for `throw null`');
  } finally { spy.restore(); }
}
function test_backgroundRun_nullThrown_doesNotCrashCycle() {
  withSavedProps(['AUTOTRASH_RULES', 'CATEGORY_RULES', 'GLOBAL_PURGE_DAYS', 'INBOX_PURGE_DAYS'], props => {
    props.setProperty('AUTOTRASH_RULES', JSON.stringify([{ label: 'NULLBG', days: 30, isTrash: true }]));
    props.setProperty('CATEGORY_RULES', '[]');
    props.setProperty('GLOBAL_PURGE_DAYS', 'OFF');
    props.setProperty('INBOX_PURGE_DAYS', 'OFF');
    const gmailSpy = installGmailSpy(function () { throw null; });
    const lockSpy = installLockSpy();
    try {
      let threw = false;
      try { backgroundRun(); } catch (e) { threw = true; }
      assertEqual(threw, false, '`throw null` inside the background loop must not crash backgroundRun()');
      assert(lockSpy.wasReleased(), 'the lock must still be released even after a `throw null` mid-cycle');
      assert(gmailSpy.calls.emails.length >= 1, 'an error email must still be sent for `throw null` in the background path');
    } finally { lockSpy.restore(); gmailSpy.restore(); }
  });
}
function test_processLiveBurst_nonErrorObjectThrown_logAndMsgDoNotShowLiteralUndefined() {
  const spy = installGmailSpy(function () { throw { code: 500, reason: 'quota exceeded' }; });
  try {
    const payload = { dryRun: false, activeQueue: [{ label: 'PLAINOBJ', days: 30, isTrash: true }], seenIds: [], stats: freshStats() };
    const res = processLiveBurst(payload);
    assert(res.msg !== 'Engine error: undefined',
      'msg must not degrade to the literal text "undefined" for a thrown value with no .message field: ' + res.msg);
    const errLine = res.log.find(l => l.level === 'ERROR');
    assert(errLine && errLine.msg !== undefined && errLine.msg.indexOf('undefined') === -1,
      'the log ERROR entry must not show "undefined" either: ' + JSON.stringify(errLine));
    assertEqual(res.payload.stats.errors[0].error, '[object Object]',
      'stats.errors[].error and the log/msg fields must agree on the same stringified value');
  } finally { spy.restore(); }
}

// ════════════════════════════════════════════════════════════════════════
// LAYER 2 — FAKE-THREAD INTEGRATION TESTS (backgroundRun)
// ════════════════════════════════════════════════════════════════════════

function test_backgroundRun_noRules_exitsBeforeTouchingLock() {
  withSavedProps(['AUTOTRASH_RULES', 'CATEGORY_RULES', 'GLOBAL_PURGE_DAYS', 'INBOX_PURGE_DAYS'], props => {
    props.setProperty('AUTOTRASH_RULES', '[]');
    props.setProperty('CATEGORY_RULES', '[]');
    props.setProperty('GLOBAL_PURGE_DAYS', 'OFF');
    props.setProperty('INBOX_PURGE_DAYS', 'OFF');
    const lockSpy = installLockSpy();
    try {
      backgroundRun();
      assertEqual(lockSpy.wasReleased(), false, 'lock must never be touched when the queue is empty');
    } finally { lockSpy.restore(); }
  });
}

function test_backgroundRun_lockContention_skipsGracefully() {
  withSavedProps(['AUTOTRASH_RULES', 'CATEGORY_RULES', 'GLOBAL_PURGE_DAYS', 'INBOX_PURGE_DAYS'], props => {
    props.setProperty('AUTOTRASH_RULES', JSON.stringify([{ label: 'X', days: 30, isTrash: true }]));
    props.setProperty('CATEGORY_RULES', '[]');
    props.setProperty('GLOBAL_PURGE_DAYS', 'OFF');
    props.setProperty('INBOX_PURGE_DAYS', 'OFF');
    const lockSpy = installLockSpy({ failToAcquire: true });
    const gmailSpy = installGmailSpy([]);
    try {
      let threw = false;
      try { backgroundRun(); } catch (e) { threw = true; }
      assertEqual(threw, false, 'backgroundRun must not throw when the lock is contended — it should just skip');
    } finally { lockSpy.restore(); gmailSpy.restore(); }
  });
}

function test_backgroundRun_seenIdsRegisteredBeforeExecuteActions() {
  const shared = makeFakeThread('bg1');
  withSavedProps(['AUTOTRASH_RULES', 'CATEGORY_RULES', 'GLOBAL_PURGE_DAYS', 'INBOX_PURGE_DAYS'], props => {
    props.setProperty('AUTOTRASH_RULES', JSON.stringify([
      { label: 'RULE_A', days: 30, isTrash: true },
      { label: 'RULE_B', days: 30, isTrash: true }
    ]));
    props.setProperty('CATEGORY_RULES', '[]');
    props.setProperty('GLOBAL_PURGE_DAYS', 'OFF');
    props.setProperty('INBOX_PURGE_DAYS', 'OFF');
    const gmailSpy = installGmailSpy([shared]);
    const lockSpy = installLockSpy();
    try {
      backgroundRun();
      assertEqual(gmailSpy.calls.trashBatches.length, 1, 'the shared thread must be actioned exactly once across both rules');
    } finally { lockSpy.restore(); gmailSpy.restore(); }
  });
}

function test_backgroundRun_errorOnOneRule_continuesToNextRule() {
  withSavedProps(['AUTOTRASH_RULES', 'CATEGORY_RULES', 'GLOBAL_PURGE_DAYS', 'INBOX_PURGE_DAYS'], props => {
    props.setProperty('AUTOTRASH_RULES', JSON.stringify([
      { label: 'BROKEN', days: 30, isTrash: true },
      { label: 'HEALTHY', days: 30, isTrash: true }
    ]));
    props.setProperty('CATEGORY_RULES', '[]');
    props.setProperty('GLOBAL_PURGE_DAYS', 'OFF');
    props.setProperty('INBOX_PURGE_DAYS', 'OFF');
    const healthyThread = makeFakeThread('h1');
    const gmailSpy = installGmailSpy(function (q) {
      if (q.indexOf('BROKEN') > -1) { /* no-op, handled below */ }
      return [healthyThread];
    });
    let calls = 0;
    const realSearch = GmailApp.search;
    GmailApp.search = function (q, s, m) {
      calls++;
      if (calls === 1) throw new Error('Simulated quota error on BROKEN');
      return realSearch(q, s, m);
    };
    const lockSpy = installLockSpy();
    try {
      backgroundRun();
      assertEqual(healthyThread.__trashed, true, 'a failure on one rule must not prevent later rules from running');
    } finally { lockSpy.restore(); gmailSpy.restore(); }
  });
}

// ════════════════════════════════════════════════════════════════════════
// LAYER 2 — FAKE-TRIGGER INTEGRATION TESTS (updateSystem)
// ════════════════════════════════════════════════════════════════════════
const UPDATE_SYSTEM_PROP_KEYS = [
  'AUTOTRASH_RULES', 'CATEGORY_RULES', 'TRIGGER_MODE', 'SUMMARY_FREQ',
  'GLOBAL_PURGE_DAYS', 'INBOX_PURGE_DAYS', 'DIGEST_HOUR'
];
function baseCfg(overrides) {
  return Object.assign({
    rules: [], categoryRules: [], triggerMode: 'OFF', summaryFreq: 'NEVER',
    globalPurgeDays: 'OFF', inboxPurgeDays: 'OFF', digestHour: 8
  }, overrides || {});
}

function test_updateSystem_triggerModeOff_createsNoBackgroundTrigger() {
  withSavedProps(UPDATE_SYSTEM_PROP_KEYS, function () {
    const spy = installScriptAppSpy([]);
    try {
      updateSystem(baseCfg({ triggerMode: 'OFF' }));
      const bg = spy.triggers().filter(function (t) { return t.getHandlerFunction() === 'backgroundRun'; });
      assertEqual(bg.length, 0, 'triggerMode OFF must not create a backgroundRun trigger');
    } finally { spy.restore(); }
  });
}

function test_updateSystem_triggerMode1MIN_createsEveryMinuteBackgroundTrigger() {
  withSavedProps(UPDATE_SYSTEM_PROP_KEYS, function () {
    const spy = installScriptAppSpy([]);
    try {
      updateSystem(baseCfg({ triggerMode: '1MIN' }));
      const bg = spy.triggers().filter(function (t) { return t.getHandlerFunction() === 'backgroundRun'; });
      assertEqual(bg.length, 1, 'triggerMode 1MIN must create exactly one backgroundRun trigger');
      assertEqual(bg[0].config.everyMinutes, 1, '1MIN must configure everyMinutes(1)');
    } finally { spy.restore(); }
  });
}

function test_updateSystem_triggerModeDaily_createsDailyBackgroundTriggerAtHour1() {
  withSavedProps(UPDATE_SYSTEM_PROP_KEYS, function () {
    const spy = installScriptAppSpy([]);
    try {
      updateSystem(baseCfg({ triggerMode: 'DAILY' }));
      const bg = spy.triggers().filter(function (t) { return t.getHandlerFunction() === 'backgroundRun'; });
      assertEqual(bg.length, 1, 'triggerMode DAILY must create exactly one backgroundRun trigger');
      assertEqual(bg[0].config.everyDays, 1, 'DAILY background trigger must fire once a day');
      assertEqual(bg[0].config.atHour, 1, 'DAILY background trigger must be pinned to 1am, independent of digestHour');
    } finally { spy.restore(); }
  });
}

function test_updateSystem_summaryFreqDaily_createsDigestTriggerAtConfiguredHour() {
  withSavedProps(UPDATE_SYSTEM_PROP_KEYS, function () {
    const spy = installScriptAppSpy([]);
    try {
      updateSystem(baseCfg({ summaryFreq: 'DAILY', digestHour: 14 }));
      const dg = spy.triggers().filter(function (t) { return t.getHandlerFunction() === 'sendDailyDigest'; });
      assertEqual(dg.length, 1, 'summaryFreq DAILY must create exactly one sendDailyDigest trigger');
      assertEqual(dg[0].config.everyDays, 1, 'digest trigger must fire once a day');
      assertEqual(dg[0].config.atHour, 14, 'digest trigger must be configured at the chosen hour');
    } finally { spy.restore(); }
  });
}

function test_updateSystem_summaryFreqErrorsOnlyOrEachRun_createsNoDigestTrigger() {
  withSavedProps(UPDATE_SYSTEM_PROP_KEYS, function () {
    ['ERRORS_ONLY', 'EACH_RUN', 'NEVER'].forEach(function (freq) {
      const spy = installScriptAppSpy([]);
      try {
        updateSystem(baseCfg({ summaryFreq: freq }));
        const dg = spy.triggers().filter(function (t) { return t.getHandlerFunction() === 'sendDailyDigest'; });
        assertEqual(dg.length, 0, 'summaryFreq ' + freq + ' must not create a sendDailyDigest trigger');
      } finally { spy.restore(); }
    });
  });
}

function test_updateSystem_summaryFreqAllDigestShapes_createExactlyOneDigestTrigger() {
  withSavedProps(UPDATE_SYSTEM_PROP_KEYS, function () {
    ['DAILY', 'ALT_DAYS', 'WEEKLY', 'BIWEEKLY'].forEach(function (freq) {
      const spy = installScriptAppSpy([]);
      try {
        updateSystem(baseCfg({ summaryFreq: freq }));
        const dg = spy.triggers().filter(function (t) { return t.getHandlerFunction() === 'sendDailyDigest'; });
        assertEqual(dg.length, 1, 'summaryFreq ' + freq + ' must create exactly one sendDailyDigest trigger');
      } finally { spy.restore(); }
    });
  });
}

function test_updateSystem_deletesStaleAutoTrashTriggersButPreservesUnrelatedOnes() {
  withSavedProps(UPDATE_SYSTEM_PROP_KEYS, function () {
    const preexisting = [
      { getHandlerFunction: function () { return 'backgroundRun'; }, getUniqueId: function () { return 'stale1'; } },
      { getHandlerFunction: function () { return 'someOtherProjectFunction'; }, getUniqueId: function () { return 'unrelated1'; } }
    ];
    const spy = installScriptAppSpy(preexisting);
    try {
      updateSystem(baseCfg({ triggerMode: 'OFF', summaryFreq: 'NEVER' }));
      const remaining = spy.triggers().map(function (t) { return t.getHandlerFunction(); });
      assert(!remaining.includes('backgroundRun'), 'the stale backgroundRun trigger must be deleted when triggerMode is turned OFF');
      assert(remaining.includes('someOtherProjectFunction'), 'a trigger for an unrelated function must survive updateSystem()\'s cleanup sweep');
    } finally { spy.restore(); }
  });
}

function test_updateSystem_persistsRulesAndSettingsToProperties() {
  withSavedProps(UPDATE_SYSTEM_PROP_KEYS, function (props) {
    const spy = installScriptAppSpy([]);
    try {
      updateSystem(baseCfg({
        rules: [{ label: 'Newsletters', days: 30, isTrash: true }],
        categoryRules: [{ category: 'social', enabled: true, days: 60 }],
        triggerMode: '5MIN', summaryFreq: 'WEEKLY', globalPurgeDays: '365',
        inboxPurgeDays: '90', digestHour: 9
      }));
      assertEqual(JSON.parse(props.getProperty('AUTOTRASH_RULES')), [{ label: 'Newsletters', days: 30, isTrash: true }]);
      assertEqual(JSON.parse(props.getProperty('CATEGORY_RULES')), [{ category: 'social', enabled: true, days: 60 }]);
      assertEqual(props.getProperty('TRIGGER_MODE'), '5MIN');
      assertEqual(props.getProperty('SUMMARY_FREQ'), 'WEEKLY');
      assertEqual(props.getProperty('GLOBAL_PURGE_DAYS'), '365');
      assertEqual(props.getProperty('INBOX_PURGE_DAYS'), '90');
      assertEqual(props.getProperty('DIGEST_HOUR'), '9');
    } finally { spy.restore(); }
  });
}

// ════════════════════════════════════════════════════════════════════════
// TEST RUNNER
// ════════════════════════════════════════════════════════════════════════

const TEST_FNS = [
  test_assertThrows_frameworkHelperWorks,
  test_buildQuery_labelRule,
  test_buildQuery_labelRuleWithSpaces,
  test_buildQuery_category,
  test_buildQuery_spamCategory_usesInSpamNotCategoryTab,
  test_buildQuery_inboxPurge_scopedToInbox_noRedundantTrashClause,
  test_buildQuery_globalPurge_allMailScope_excludesTrashAndSpam,
  test_buildQuery_allRuleTypes_spareStarredMail,
  test_buildQuery_labelWithEmbeddedQuote_doesNotBreakOutOfQuotedTerm,
  test_buildQuery_labelWithoutQuotes_unaffectedByFix,
  test_buildQuery_labelAllQuoteCharacters_producesEmptyQuotedTerm,
  test_buildQuery_negativeDays_isNotValidatedOrClamped,
  test_resolveRuleAction_explicitTrash,
  test_resolveRuleAction_explicitArchive,
  test_resolveRuleAction_undefinedDefaultsToTrash,
  test_resolveRuleAction_nullDefaultsToTrash,
  test_resolveRuleAction_globalPurgeAlwaysTrash_ignoresIsTrash,
  test_resolveRuleAction_inboxPurgeAlwaysTrash_ignoresIsTrash,
  test_buildQueue_order_labelsThenCategoriesThenPurges,
  test_buildQueue_disabledCategoriesExcluded,
  test_buildQueue_categoryRulesFlaggedIsCategory,
  test_buildQueue_purgeRulesUseGlobalPurgeAndInboxPurgeLabels,
  test_buildQueue_offMeansOff,
  test_ensureStat_createsZeroedEntryOnce,
  test_creditStat_normalRuleGoesToLabels,
  test_creditStat_globalPurge_bypassesLabels,
  test_creditStat_inboxPurge_bypassesLabels,
  test_creditStat_accumulatesAcrossMultipleCalls,
  test_fmtNum_addsThousandsSeparators,
  test_fmtNum_smallNumberUnchanged,
  test_fmtNum_nullOrUndefinedIsZero,
  test_fmtMs_underOneSecond,
  test_fmtMs_overOneSecond,
  test_chunkArray_splitsIntoFixedSizeGroups,
  test_chunkArray_emptyInputYieldsEmptyOutput,
  test_chunkArray_respectsGmailChunkConstant,
  test_buildAsciiChart_emptyStatsReturnsEmptyString,
  test_buildAsciiChart_tinyRuleNeverRendersAsBlankBar,
  test_buildAsciiChart_rowsNeverExceedBarWidth,
  test_buildAsciiChart_includesPurgeRows,
  test_buildAsciiChart_zeroMovedLabelsAreOmitted,
  test_plainBody_appendsChartWhenDataPresent,
  test_plainBody_noChartWhenStatsEmpty,
  test_getAppUrl_returnsEmptyStringOnFailure_neverThrows,
  test_getAppUrl_returnsUrlWhenDeployed,
  test_escHtml_escapesAngleBracketsAmpersandsAndQuotes,
  test_escHtml_plainTextUnchanged,
  test_accumulate_initializesWhenEmpty,
  test_accumulate_addsAcrossMultipleRuns,
  test_accumulate_doesNotResetOnNewDay,
  test_accumulate_purgeTrashedSubcountsAreKept,
  test_subject_dryRun_saysWouldBeActioned_notActioned,
  test_subject_liveRun_saysActioned,
  test_subject_errorsWithZeroMoved_leadsWithErrorLabel,
  test_subject_errorsWithSomeMoved_appendsErrorsTag,
  test_dryRunAbortSubject_saysScannedNotActioned,
  test_buildEmailHtml_escapesRuleNameInPerRuleTable,
  test_abortRun_liveRun_accumulatesDailyStats,
  test_abortRun_dryRun_doesNotAccumulateDailyStats,
  test_backgroundRun_corruptRulesProperty_doesNotThrow,
  test_backgroundRun_corruptCategoryRulesProperty_doesNotThrow,
  test_getUISettings_corruptRulesProperty_returnsEmptyArraysNotThrow,
  test_getUISettings_validRulesProperty_stillParsesNormally,

  test_processLiveBurst_ejectsRuleWithZeroThreads,
  test_processLiveBurst_liveRun_trashesAndRotatesToBack,
  test_processLiveBurst_archiveAction_movesToArchiveNotTrash,
  test_processLiveBurst_seenIdsDedup_skipsAlreadyProcessedThreads,
  test_processLiveBurst_dryRun_countsWithoutActingAndEjectsWithoutRotating,
  test_processLiveBurst_globalPurge_dryRun_routesThroughCreditStat_notLabels,
  test_processLiveBurst_purgeRule_liveEject_setsDoneFlagNotLabels,
  test_processLiveBurst_builtNullQueueServerSide,
  test_processLiveBurst_errorDuringLiveRun_recordsErrorAndEmailsWithoutCrashing,
  test_processLiveBurst_errorDuringDryRun_emailReportsProjectedCounts,
  test_processLiveBurst_errorEmail_categoryRuleWithoutLabelField_showsCorrectRuleName,

  test_processLiveBurst_nonErrorObjectThrown_doesNotCrashErrorReporting,
  test_backgroundRun_noRules_exitsBeforeTouchingLock,
  test_backgroundRun_lockContention_skipsGracefully,
  test_backgroundRun_seenIdsRegisteredBeforeExecuteActions,
  test_backgroundRun_errorOnOneRule_continuesToNextRule,
  test_backgroundRun_errorEmail_categoryRuleWithoutLabelField_showsCorrectRuleName,
  test_backgroundRun_nonErrorObjectThrown_doesNotCrashCycle,
  test_processLiveBurst_nullThrown_doesNotCrashErrorReporting,
  test_backgroundRun_nullThrown_doesNotCrashCycle,
  test_processLiveBurst_nonErrorObjectThrown_logAndMsgDoNotShowLiteralUndefined,

  test_updateSystem_triggerModeOff_createsNoBackgroundTrigger,
  test_updateSystem_triggerMode1MIN_createsEveryMinuteBackgroundTrigger,
  test_updateSystem_triggerModeDaily_createsDailyBackgroundTriggerAtHour1,
  test_updateSystem_summaryFreqDaily_createsDigestTriggerAtConfiguredHour,
  test_updateSystem_summaryFreqErrorsOnlyOrEachRun_createsNoDigestTrigger,
  test_updateSystem_summaryFreqAllDigestShapes_createExactlyOneDigestTrigger,
  test_updateSystem_deletesStaleAutoTrashTriggersButPreservesUnrelatedOnes,
  test_updateSystem_persistsRulesAndSettingsToProperties
];

function runAllTests() {
  const results = [];
  const t0 = Date.now();

  TEST_FNS.forEach(fn => {
    const name = fn.name || '(anonymous test)';
    const start = Date.now();
    try {
      fn();
      results.push({ name: name, status: 'PASS', ms: Date.now() - start });
    } catch (e) {
      results.push({ name: name, status: 'FAIL', ms: Date.now() - start, error: e.message, stack: e.stack });
    }
  });

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const total  = results.length;
  const elapsedMs = Date.now() - t0;

  console.log(`AutoTrash tests: ${passed}/${total} passed (${failed} failed) in ${elapsedMs}ms`);
  results.filter(r => r.status === 'FAIL').forEach(r => {
    console.log(`FAIL: ${r.name}\n  ${r.error}\n  ${r.stack || ''}`);
  });

  try {
    const subj = `${failed === 0 ? '✓' : '⚠'} AutoTrash Tests: ${passed}/${total} passed` + (failed ? `, ${failed} FAILED` : '');
    const rows = results.map(r => {
      const color = r.status === 'PASS' ? '#00ff88' : '#ff4455';
      const detail = r.status === 'FAIL' ? `<div style="color:#ff8877;font-size:10px;margin-top:2px;">${(r.error || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>` : '';
      return `<div style="padding:4px 0;font-family:'Courier New',monospace;font-size:12px;color:${color};border-bottom:1px solid #111f11;">
        [${r.status}] ${r.name} <span style="color:#447744;font-size:10px;">(${r.ms}ms)</span>
        ${detail}
      </div>`;
    }).join('');
    const html = `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#020802;font-family:'Courier New',monospace;">
      <div style="color:#00ff88;font-size:16px;font-weight:bold;">AUTOTRASH TEST REPORT</div>
      <div style="color:#447744;font-size:11px;margin:4px 0 14px;">${new Date().toLocaleString()} · ${passed}/${total} passed · ${elapsedMs}ms total</div>
      <div style="background:#030b03;border:1px solid #1a3a1a;border-radius:4px;padding:10px 14px;">${rows}</div>
    </body></html>`;
    safeMail(ownerEmail(), subj, html, `AutoTrash Tests: ${passed}/${total} passed, ${failed} failed.\n\n` +
      results.map(r => `[${r.status}] ${r.name}${r.error ? ' — ' + r.error : ''}`).join('\n'));
  } catch (e) {
    console.log('runAllTests: failed to send report email: ' + e.message);
  }

  return { passed: passed, failed: failed, total: total, results: results };
}
