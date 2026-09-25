/**
 * AutoTrash tests — app/Runner.gs (abortRun, processLiveBurst,
 * backgroundRun). accumulateDailyStats tests moved to tests/Stats.test.gs.
 * The largest suite, since this file
 * carries almost all of the engine's fake-thread integration tests.
 * Split out of the former monolithic tests/Tests.gs on 2026-09-24 — see
 * CLAUDE.md for the full test-file map and TestFramework.gs for the shared
 * assertions/spies (freshStats, makeFakeThread, installGmailSpy,
 * installLockSpy, withSavedProps) these tests use.
 */

// ── abortRun ───────────────────────────────────────────────────────────────

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

// ── processLiveBurst ───────────────────────────────────────────────────────

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
// GitHub Issues for the full mechanism and reproduction.
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

// ── backgroundRun ────────────────────────────────────────────────────────

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

// ── Issues #96/#97 regression: ruleLabel() must never kill backgroundRun() ──

// #96's concrete repro: a category rule that reaches backgroundRun() with
// isCategory:true but no `category` field (CATEGORY_RULES is only validated
// as parseable JSON — see parseStoredRules() — not per-field). Before the
// fix, ruleLabel() threw TypeError computing `lbl` for this rule, and that
// line sat OUTSIDE backgroundRun()'s per-rule try — so the exception escaped
// the whole function uncaught: no error email, no partial stats saved, the
// trigger just silently died. Now it must process like any other unlabeled
// rule (label '?'), with no error at all.
function test_backgroundRun_categoryRuleMissingCategoryField_processesWithoutError() {
  withSavedProps(['AUTOTRASH_RULES', 'CATEGORY_RULES', 'GLOBAL_PURGE_DAYS', 'INBOX_PURGE_DAYS'], props => {
    props.setProperty('AUTOTRASH_RULES', '[]');
    props.setProperty('CATEGORY_RULES', JSON.stringify([{ enabled: true, days: 30 }])); // no `category`
    props.setProperty('GLOBAL_PURGE_DAYS', 'OFF');
    props.setProperty('INBOX_PURGE_DAYS', 'OFF');
    const thread = makeFakeThread('t1');
    const gmailSpy = installGmailSpy([thread]);
    const lockSpy = installLockSpy();
    try {
      let threw = false;
      try { backgroundRun(); } catch (e) { threw = true; }
      assertEqual(threw, false, 'a category rule missing its category field must not crash backgroundRun()');
      assertEqual(gmailSpy.calls.emails.length, 0, 'a rule that ran cleanly must not trigger an error email');
      assert(thread.__trashed, 'the rule must still actually run (fallback label only affects reporting, not the query/action)');
    } finally { lockSpy.restore(); gmailSpy.restore(); }
  });
}

// #97's structural claim: even after #96 removes today's only known trigger,
// the try/catch STRUCTURE around `lbl` must independently guard against any
// future exception computing it. Simulated here by monkeypatching the global
// ruleLabel() itself (same save/restore-in-finally pattern already used for
// GmailApp/props methods elsewhere in this suite) so the rule's real shape
// is irrelevant — only the structural guarantee is under test.
function test_backgroundRun_ruleLabelThrows_stillEmailsAndDoesNotCrashCycle() {
  withSavedProps(['AUTOTRASH_RULES', 'CATEGORY_RULES', 'GLOBAL_PURGE_DAYS', 'INBOX_PURGE_DAYS'], props => {
    props.setProperty('AUTOTRASH_RULES', JSON.stringify([{ label: 'ANYRULE', days: 30, isTrash: true }]));
    props.setProperty('CATEGORY_RULES', '[]');
    props.setProperty('GLOBAL_PURGE_DAYS', 'OFF');
    props.setProperty('INBOX_PURGE_DAYS', 'OFF');
    const gmailSpy = installGmailSpy([makeFakeThread('t1')]);
    const lockSpy = installLockSpy();
    const realRuleLabel = ruleLabel;
    ruleLabel = function () { throw new Error('Simulated future exception computing lbl'); };
    try {
      let threw = false;
      try { backgroundRun(); } catch (e) { threw = true; }
      assertEqual(threw, false, 'an exception computing lbl must not escape backgroundRun() uncaught');
      assert(lockSpy.wasReleased(), 'the lock must still be released');
      assertEqual(gmailSpy.calls.emails.length, 1, 'an error email must still be sent when lbl itself cannot be computed');
      const body = gmailSpy.calls.emails[0].opts.htmlBody;
      assert(body.includes('Simulated future exception computing lbl'),
        'the error email must carry the real failure, not a secondary error about lbl being undefined');
    } finally { lockSpy.restore(); gmailSpy.restore(); ruleLabel = realRuleLabel; }
  });
}

const RUNNER_TESTS = [
  test_abortRun_liveRun_accumulatesDailyStats,
  test_abortRun_dryRun_doesNotAccumulateDailyStats,

  test_backgroundRun_corruptRulesProperty_doesNotThrow,
  test_backgroundRun_corruptCategoryRulesProperty_doesNotThrow,
  test_backgroundRun_categoryRuleMissingCategoryField_processesWithoutError,
  test_backgroundRun_ruleLabelThrows_stillEmailsAndDoesNotCrashCycle,

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
  test_backgroundRun_errorEmail_categoryRuleWithoutLabelField_showsCorrectRuleName,

  test_processLiveBurst_nonErrorObjectThrown_doesNotCrashErrorReporting,
  test_backgroundRun_nonErrorObjectThrown_doesNotCrashCycle,
  test_processLiveBurst_nullThrown_doesNotCrashErrorReporting,
  test_backgroundRun_nullThrown_doesNotCrashCycle,
  test_processLiveBurst_nonErrorObjectThrown_logAndMsgDoNotShowLiteralUndefined,

  test_backgroundRun_noRules_exitsBeforeTouchingLock,
  test_backgroundRun_lockContention_skipsGracefully,
  test_backgroundRun_seenIdsRegisteredBeforeExecuteActions,
  test_backgroundRun_errorOnOneRule_continuesToNextRule
];
