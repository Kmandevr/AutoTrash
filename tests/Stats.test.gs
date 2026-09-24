/**
 * AutoTrash tests — app/Stats.gs (ensureStat, creditStat,
 * accumulateDailyStats).
 * Split out on 2026-09-24: ensureStat/creditStat moved here from
 * tests/RuleEngine.test.gs, accumulateDailyStats from tests/Runner.test.gs,
 * mirroring the same move in app/RuleEngine.gs and app/Runner.gs. See
 * CLAUDE.md for the full test-file map and TestFramework.gs for the shared
 * assertions/spies these tests use.
 */

// ── ensureStat / creditStat ───────────────────────────────────────────────

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

// ── accumulateDailyStats ──────────────────────────────────────────────────

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

const STATS_TESTS = [
  test_ensureStat_createsZeroedEntryOnce,
  test_creditStat_normalRuleGoesToLabels,
  test_creditStat_globalPurge_bypassesLabels,
  test_creditStat_inboxPurge_bypassesLabels,
  test_creditStat_accumulatesAcrossMultipleCalls,

  test_accumulate_initializesWhenEmpty,
  test_accumulate_addsAcrossMultipleRuns,
  test_accumulate_doesNotResetOnNewDay,
  test_accumulate_purgeTrashedSubcountsAreKept
];
