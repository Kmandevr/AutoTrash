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

// ── safeRuleLabel / runSummaryMsg / fullerStats (direct unit tests) ────────
// These three small Runner.gs helpers previously had no DIRECT test
// coverage — only indirect coverage through end-to-end tests of
// processLiveBurst()/backgroundRun()/abortRun() above and in
// RunState.test.gs (same gap shape as the one RunState.test.gs's own
// isRunActive()/isRunStale()/abortRequestedFor() direct tests closed for
// app/RunState.gs). Added 2026-10-01 as a test-coverage-gap pass — no
// app/Runner.gs behavior changed.

// safeRuleLabel() wraps ruleLabel() so a broken rule object can never be
// what crashes progress reporting (see the comment on safeRuleLabel() in
// Runner.gs). Today's ruleLabel() (RuleEngine.gs) is itself already
// defensive for a category rule missing its `category` field — it falls
// back to '?' via its own `||` ternary rather than throwing — so the two
// normal-ish cases below exercise ruleLabel()'s own fallback, reached
// through safeRuleLabel() unchanged. The real try/catch in safeRuleLabel()
// is only reached when `rule` itself is missing/malformed (e.g. `null`),
// which is what the last test below actually exercises.
function test_safeRuleLabel_normalRule_returnsLabel() {
  assertEqual(safeRuleLabel({ label: 'PROMOS', days: 30, isTrash: true }), 'PROMOS');
}
function test_safeRuleLabel_categoryRuleWithCategory_returnsUppercasedCategory() {
  assertEqual(safeRuleLabel({ isCategory: true, category: 'social', days: 30 }), 'SOCIAL');
}
function test_safeRuleLabel_categoryRuleMissingCategory_returnsQuestionMark() {
  // ruleLabel()'s own fallback (`rule.isCategory && rule.category ? ... : '?'`)
  // handles this without throwing — safeRuleLabel()'s catch is not involved.
  assertEqual(safeRuleLabel({ isCategory: true, days: 30 }), '?');
}
function test_safeRuleLabel_nullRule_catchesAndReturnsQuestionMark() {
  // `null.label` inside ruleLabel() throws a TypeError — this is the one
  // case that actually reaches safeRuleLabel()'s own try/catch, proving the
  // "progress reporting must never be what breaks a run" guarantee the
  // comment on safeRuleLabel() documents.
  let threw = false;
  let result;
  try { result = safeRuleLabel(null); } catch (e) { threw = true; }
  assertEqual(threw, false, 'safeRuleLabel() must swallow a throwing ruleLabel() call, not let it escape');
  assertEqual(result, '?');
}

// runSummaryMsg() is the one-line completion summary recordRunProgress()
// sends to every dashboard watching a run (mirrors index.html's own
// finishEng() banners — see the comment on runSummaryMsg() in Runner.gs).
function test_runSummaryMsg_liveRun_formatsCompleteBanner() {
  const stats = { totalMoved: 150, totalTrashed: 100, totalArchived: 50, labels: { PROMOS: { moved: 150 } } };
  assertEqual(runSummaryMsg(stats, false, 12345),
    '✓ COMPLETE · 150 actioned · 100 trashed · 50 archived · 1 rule(s) · 12.3s');
}
function test_runSummaryMsg_dryRun_formatsDryRunBannerWithThousandsSeparator() {
  const stats = { totalMoved: 2000, dryTrashed: 1500, dryArchived: 500, labels: {} };
  assertEqual(runSummaryMsg(stats, true, 5000),
    '[DRY RUN COMPLETE] ~2,000 threads scanned · 1,500 would trash · 500 would archive · 0 rule(s) · 5.0s');
}
function test_runSummaryMsg_countsOnlyLabelsWithPositiveMoved_plusPurgeFlags() {
  const stats = {
    totalMoved: 10, totalTrashed: 10, totalArchived: 0,
    labels: { A: { moved: 5 }, B: { moved: 0 }, C: { moved: 3 } },
    globalPurgeMoved: 2, inboxPurgeMoved: 0
  };
  const msg = runSummaryMsg(stats, false, 0);
  assert(msg.indexOf('3 rule(s)') > -1,
    'rule count must include A and C (moved > 0) and globalPurgeMoved, but not B (moved: 0) or inboxPurgeMoved (0): ' + msg);
}
function test_runSummaryMsg_missingStats_doesNotThrowAndDefaultsToZero() {
  let threw = false;
  let msg;
  try { msg = runSummaryMsg(undefined, false, undefined); } catch (e) { threw = true; }
  assertEqual(threw, false, 'runSummaryMsg() must tolerate a missing stats object — it is called from catch/finalize paths');
  assertEqual(msg, '✓ COMPLETE · 0 actioned · 0 trashed · 0 archived · 0 rule(s) · 0.0s');
}

// fullerStats() picks whichever stats object has seen more of the run —
// RunState.test.gs's test_abortRun_withRunId_cachedDetailEvicted_fallsBackToCallerStats
// proves the "cache evicted" case end to end via abortRun(); these pin the
// pure function's own branches directly (null handling and the actual
// comparison), including the tie-break and "a already fuller" cases that
// test didn't need to exercise.
function test_fullerStats_aMissing_returnsB() {
  const b = { totalMoved: 5 };
  assert(fullerStats(null, b) === b, 'with no `a` at all, `b` must be returned as-is');
}
function test_fullerStats_bothMissing_returnsEmptyObject() {
  const result = fullerStats(null, null);
  assertEqual(JSON.stringify(result), '{}', 'with neither stats object, fullerStats() must return a usable empty object, not null/undefined');
}
function test_fullerStats_bMissing_returnsA() {
  const a = { totalMoved: 5 };
  assert(fullerStats(a, null) === a, 'with no `b` at all, `a` must be returned as-is');
}
function test_fullerStats_bHasStrictlyMoreMoved_returnsB() {
  const a = { totalMoved: 5 };
  const b = { totalMoved: 10 };
  assert(fullerStats(a, b) === b, 'b has seen strictly more of the run, so b must win');
}
function test_fullerStats_aHasMoreOrEqualMoved_returnsA() {
  const aGreater = { totalMoved: 10 };
  const bLesser  = { totalMoved: 5 };
  assert(fullerStats(aGreater, bLesser) === aGreater, 'a has seen more of the run, so a must win');
  const aTied = { totalMoved: 10 };
  const bTied = { totalMoved: 10 };
  assert(fullerStats(aTied, bTied) === aTied, 'a tie must favor a (the comparison requires b strictly greater to win)');
}

// ── Issue #104 end to end: a recent reply inside an old thread ─────────────
// The search (older_than:365d) matches BOTH threads on their old message;
// only the genuinely-stale one may be actioned. These fail on the pre-fix
// code, where the revived thread was trashed too. Dates mirror the
// break-test's THREAD-1455 (oldest 597d, newest reply 2.2d).
function reviveFixture() {
  const now = Date.now();
  return {
    stale:   makeRichFakeThread('stale',   { date: new Date(now - 400 * 86400000) }),
    revived: makeRichFakeThread('revived', { date: new Date(now - 2.2 * 86400000) })
  };
}
function test_processLiveBurst_liveRun_threadWithRecentReply_isNotTrashed() {
  const f = reviveFixture();
  const spy = installGmailSpy([f.stale, f.revived]);
  try {
    const payload = { dryRun: false, activeQueue: [{ label: 'OLD', days: 365, isTrash: true }], seenIds: [], stats: freshStats() };
    const res = processLiveBurst(payload);
    assertEqual(f.stale.__trashed, true, 'the thread whose newest message is old enough is trashed');
    assertEqual(f.revived.__trashed, false, 'a thread with a 2.2-day-old reply must survive an older_than:365d rule');
    assertEqual(res.payload.stats.totalTrashed, 1);
    assertEqual(res.payload.seenIds, ['stale'], 'only the actioned thread is marked seen');
    assert(res.log.some(function (e) { return e.msg.indexOf('Skipped 1 thread(s) held back') === 0; }),
      'the user is told a thread was held back');
  } finally { spy.restore(); }
}
function test_processLiveBurst_dryRun_threadWithRecentReply_isNotCounted() {
  const f = reviveFixture();
  const spy = installGmailSpy([f.stale, f.revived]);
  try {
    const payload = { dryRun: true, activeQueue: [{ label: 'OLD', days: 365, isTrash: true }], seenIds: [], stats: freshStats() };
    const res = processLiveBurst(payload);
    assertEqual(res.payload.stats.dryTrashed, 1, 'dry run must project the same count the live run will act on');
  } finally { spy.restore(); }
}
function test_processLiveBurst_inboxPurge_threadWithRecentReply_isNotTrashed() {
  const f = reviveFixture();
  const spy = installGmailSpy([f.stale, f.revived]);
  try {
    const payload = { dryRun: false, activeQueue: [{ isInboxPurge: true, isTrash: true, days: 365, label: 'INBOX PURGE' }], seenIds: [], stats: freshStats() };
    processLiveBurst(payload);
    assertEqual(f.revived.__trashed, false, 'purge rules are age rules too');
    assertEqual(f.stale.__trashed, true);
  } finally { spy.restore(); }
}
function test_backgroundRun_threadWithRecentReply_isNotTrashed() {
  const f = reviveFixture();
  withSavedProps(['AUTOTRASH_RULES', 'CATEGORY_RULES', 'GLOBAL_PURGE_DAYS', 'INBOX_PURGE_DAYS'], props => {
    props.setProperty('AUTOTRASH_RULES', JSON.stringify([{ label: 'OLD', days: 365, isTrash: true }]));
    props.setProperty('CATEGORY_RULES', '[]');
    props.setProperty('GLOBAL_PURGE_DAYS', 'OFF');
    props.setProperty('INBOX_PURGE_DAYS', 'OFF');
    const gmailSpy = installGmailSpy([f.stale, f.revived]);
    const lockSpy = installLockSpy();
    try {
      backgroundRun();
      assertEqual(f.stale.__trashed, true);
      assertEqual(f.revived.__trashed, false, 'the background runner must apply the same newest-message rule');
    } finally { lockSpy.restore(); gmailSpy.restore(); }
  });
}

// ── Issue #7: dry-run "500+" when a rule fills Gmail's 500-result search cap ──
// A dry run searches each rule once, so a capped result is a FLOOR, not the
// real match count. Pre-fix every one of these read a bare "500".
function capThreads(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(makeFakeThread('cap' + i));
  return out;
}
function test_processLiveBurst_dryRun_ruleAtSearchCap_isLabelledFiveHundredPlus() {
  const spy = installGmailSpy(capThreads(GMAIL_SEARCH));
  try {
    const payload = { dryRun: true, activeQueue: [{ label: 'BIG', days: 30, isTrash: true }], seenIds: [], stats: freshStats() };
    const res = processLiveBurst(payload);
    const msgs = res.log.map(function (e) { return e.msg; });
    assert(msgs.indexOf('[BIG] Would TRASH 500+') >= 0, 'terminal line must read "500+": ' + msgs.join(' | '));
    assert(msgs.indexOf('  → 500+ trash · 0 archive') >= 0, 'the trash/archive split must flag only the non-zero side: ' + msgs.join(' | '));
    assertEqual(res.payload.stats.dryCapped, true, 'stats must carry the capped flag for the banner/summary/email');
    assertEqual(res.payload.stats.labels['BIG'].capped, true);
    assertEqual(res.payload.stats.dryTrashed, 500, 'the numeric total stays a plain number (the "+" is display only)');
    assertEqual(res.msg, '[DRY] BIG: 500+ · 0 remain.');
  } finally { spy.restore(); }
}
function test_processLiveBurst_dryRun_ruleJustUnderSearchCap_hasNoPlus() {
  const spy = installGmailSpy(capThreads(GMAIL_SEARCH - 1));
  try {
    const payload = { dryRun: true, activeQueue: [{ label: 'BIG', days: 30, isTrash: true }], seenIds: [], stats: freshStats() };
    const res = processLiveBurst(payload);
    const msgs = res.log.map(function (e) { return e.msg; });
    assert(msgs.indexOf('[BIG] Would TRASH 499') >= 0, 'an exact count must not get a "+": ' + msgs.join(' | '));
    assert(!res.payload.stats.dryCapped, 'no capped flag below the cap');
    assert(!res.payload.stats.labels['BIG'].capped);
  } finally { spy.restore(); }
}
function test_processLiveBurst_dryRun_archiveRuleAtSearchCap_flagsArchiveSide() {
  const spy = installGmailSpy(capThreads(GMAIL_SEARCH));
  try {
    const payload = { dryRun: true, activeQueue: [{ label: 'BIG', days: 30, isTrash: false }], seenIds: [], stats: freshStats() };
    const res = processLiveBurst(payload);
    const msgs = res.log.map(function (e) { return e.msg; });
    assert(msgs.indexOf('  → 0 trash · 500+ archive') >= 0, msgs.join(' | '));
  } finally { spy.restore(); }
}
function test_processLiveBurst_dryRun_globalPurgeAtSearchCap_setsPurgeCappedFlag() {
  const spy = installGmailSpy(capThreads(GMAIL_SEARCH));
  try {
    const payload = { dryRun: true, activeQueue: [{ isGlobalPurge: true, isTrash: true, days: 365, label: 'GLOBAL PURGE' }], seenIds: [], stats: freshStats() };
    const res = processLiveBurst(payload);
    assertEqual(res.payload.stats.globalPurgeCapped, true);
    assertEqual(res.payload.stats.dryCapped, true);
    assert(!res.payload.stats.labels['GLOBAL PURGE'], 'purge rules still must not create a labels ghost row');
  } finally { spy.restore(); }
}
function test_processLiveBurst_liveRun_ruleAtSearchCap_neverShowsPlusOrCappedFlag() {
  const spy = installGmailSpy(capThreads(GMAIL_SEARCH));
  try {
    const payload = { dryRun: false, activeQueue: [{ label: 'BIG', days: 30, isTrash: true }], seenIds: [], stats: freshStats() };
    const res = processLiveBurst(payload);
    assert(res.log.every(function (e) { return !/\d\+/.test(e.msg); }), 'a live run actions the threads, so it is never a floor');
    assert(!res.payload.stats.dryCapped, 'dryCapped is dry-run only');
  } finally { spy.restore(); }
}
function test_runSummaryMsg_dryRunCapped_showsPlusOnTotals() {
  const stats = { totalMoved: 500, dryTrashed: 500, dryArchived: 0, dryCapped: true, labels: { BIG: { moved: 500 } } };
  assertEqual(runSummaryMsg(stats, true, 5000),
    '[DRY RUN COMPLETE] ~500+ threads scanned · 500+ would trash · 0 would archive · 1 rule(s) · 5.0s');
}
function test_runSummaryMsg_dryRunCapped_doesNotAffectLiveSummary() {
  const stats = { totalMoved: 500, totalTrashed: 500, totalArchived: 0, dryCapped: true, labels: { BIG: { moved: 500 } } };
  assert(runSummaryMsg(stats, false, 5000).indexOf('+') < 0, 'a live summary never shows a floor');
}

const RUNNER_TESTS = [
  test_abortRun_liveRun_accumulatesDailyStats,
  test_abortRun_dryRun_doesNotAccumulateDailyStats,

  test_safeRuleLabel_normalRule_returnsLabel,
  test_safeRuleLabel_categoryRuleWithCategory_returnsUppercasedCategory,
  test_safeRuleLabel_categoryRuleMissingCategory_returnsQuestionMark,
  test_safeRuleLabel_nullRule_catchesAndReturnsQuestionMark,

  test_runSummaryMsg_liveRun_formatsCompleteBanner,
  test_runSummaryMsg_dryRun_formatsDryRunBannerWithThousandsSeparator,
  test_runSummaryMsg_countsOnlyLabelsWithPositiveMoved_plusPurgeFlags,
  test_runSummaryMsg_missingStats_doesNotThrowAndDefaultsToZero,

  test_fullerStats_aMissing_returnsB,
  test_fullerStats_bothMissing_returnsEmptyObject,
  test_fullerStats_bMissing_returnsA,
  test_fullerStats_bHasStrictlyMoreMoved_returnsB,
  test_fullerStats_aHasMoreOrEqualMoved_returnsA,

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
  test_backgroundRun_errorOnOneRule_continuesToNextRule,
  test_processLiveBurst_liveRun_threadWithRecentReply_isNotTrashed,
  test_processLiveBurst_dryRun_threadWithRecentReply_isNotCounted,
  test_processLiveBurst_inboxPurge_threadWithRecentReply_isNotTrashed,
  test_backgroundRun_threadWithRecentReply_isNotTrashed,
  test_processLiveBurst_dryRun_ruleAtSearchCap_isLabelledFiveHundredPlus,
  test_processLiveBurst_dryRun_ruleJustUnderSearchCap_hasNoPlus,
  test_processLiveBurst_dryRun_archiveRuleAtSearchCap_flagsArchiveSide,
  test_processLiveBurst_dryRun_globalPurgeAtSearchCap_setsPurgeCappedFlag,
  test_processLiveBurst_liveRun_ruleAtSearchCap_neverShowsPlusOrCappedFlag,
  test_runSummaryMsg_dryRunCapped_showsPlusOnTotals,
  test_runSummaryMsg_dryRunCapped_doesNotAffectLiveSummary
];
