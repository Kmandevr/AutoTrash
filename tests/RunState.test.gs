/**
 * AutoTrash tests — app/RunState.gs (the shared run registry) and the
 * registry-aware paths it adds to app/Runner.gs: processLiveBurst() with a
 * runId, abortRun() with a runId, and backgroundRun()'s registration /
 * remote-abort / live-run-yield behavior. Added 2026-09-24 with the
 * cross-device run feature (Issues #82/#79) — see
 * docs/feature-reference.txt §2e.
 *
 * Every test runs inside withRunProps(), which saves/restores every
 * property the registry and runners touch and starts from "no run", so
 * tests never leak a live-looking run into each other (backgroundRun()
 * would otherwise skip in a later test, believing a manual run is active).
 */

const RUN_TEST_KEYS = [
  'RUN_STATE', 'RUN_ABORT', 'LAST_RUN_TIME', 'DAILY_STATS', 'SUMMARY_FREQ',
  'AUTOTRASH_RULES', 'CATEGORY_RULES', 'GLOBAL_PURGE_DAYS', 'INBOX_PURGE_DAYS',
  'TRIGGER_MODE', 'DIGEST_HOUR'
];

function withRunProps(fn) {
  withSavedProps(RUN_TEST_KEYS, props => {
    props.deleteProperty('RUN_STATE');
    props.deleteProperty('RUN_ABORT');
    props.setProperty('SUMMARY_FREQ', 'NEVER');
    fn(props);
  });
}

// Registers a live run for driver 'tabA' and returns a payload ready to burst.
function startTestLiveRun(queue, dryRun) {
  const res = startLiveRun({ driverId: 'tabA', dryRun: !!dryRun, left: queue.length,
    rule: queue[0].label, queue: queue.map(r => r.label), stats: freshStats() });
  assert(res.ok, 'startLiveRun must succeed when no run is active');
  return {
    runId: res.runId, driverId: 'tabA', dryRun: !!dryRun,
    activeQueue: queue.map(r => Object.assign({}, r)), seenIds: [], stats: freshStats()
  };
}

function makeRunStale(props) {
  const s = JSON.parse(props.getProperty('RUN_STATE'));
  s.updatedAt = Date.now() - 10 * 60 * 1000;
  props.setProperty('RUN_STATE', JSON.stringify(s));
}

// ── startLiveRun / coordination ────────────────────────────────────────────

function test_startLiveRun_refusesSecondRunWhileOneIsActive() {
  withRunProps(() => {
    const first = startLiveRun({ driverId: 'tabA', left: 1, queue: ['A'] });
    assert(first.ok, 'first run must register');
    const second = startLiveRun({ driverId: 'phoneB', left: 1, queue: ['A'] });
    assertEqual(second.ok, false, 'a second device must not start an overlapping run');
    assertEqual(second.run.id, first.runId, 'the refusal must hand back the run that IS active, so the UI can show it');
  });
}

function test_startLiveRun_replacesStaleRun() {
  withRunProps(props => {
    const first = startLiveRun({ driverId: 'tabA', left: 1, queue: ['A'] });
    makeRunStale(props);
    const second = startLiveRun({ driverId: 'phoneB', left: 1, queue: ['A'] });
    assert(second.ok, 'a run whose driver went silent must not block new runs forever');
    assert(second.runId !== first.runId);
  });
}

// ── processLiveBurst with a runId ──────────────────────────────────────────

function test_processLiveBurst_registered_recordsProgressForOtherDevices() {
  const spy = installGmailSpy([makeFakeThread('p1'), makeFakeThread('p2')]);
  try {
    withRunProps(() => {
      const payload = startTestLiveRun([{ label: 'PROMOS', days: 30, isTrash: true }, { label: 'OTHER', days: 30, isTrash: true }]);
      const before = getRunStatus(-1, null);
      processLiveBurst(payload);
      const st = getRunStatus(before.run.seq, payload.runId);
      assertEqual(st.run.left, 2, 'rules-left must be published after a burst');
      assertEqual(st.run.rule, 'OTHER', 'the head of the rotated queue must be published as the current rule');
      assertEqual(st.stats.totalTrashed, 2, 'full stats must be visible to viewers');
      assert(st.log.length > 0 && st.log.every(e => e.seq > before.run.seq), 'viewers asking since a seq must get only the new log lines');
    });
  } finally { spy.restore(); }
}

function test_processLiveBurst_registered_abortRequestStopsBeforeTouchingGmail() {
  const threads = [makeFakeThread('x1')];
  const spy = installGmailSpy(threads);
  try {
    withRunProps(() => {
      const payload = startTestLiveRun([{ label: 'PROMOS', days: 30, isTrash: true }]);
      assert(requestAbort(payload.runId).ok, 'requestAbort must accept an active run');
      const res = processLiveBurst(payload);
      assertEqual(res.abortRequested, true, 'the driving tab must be told an abort was requested elsewhere');
      assertEqual(threads[0].__trashed, false, 'no Gmail action may run after an abort was requested');
      assertEqual(spy.calls.search.length, 0, 'the burst must not even search');
    });
  } finally { spy.restore(); }
}

function test_processLiveBurst_registered_supersededAfterTakeOver() {
  const threads = [makeFakeThread('s1')];
  const spy = installGmailSpy(threads);
  try {
    withRunProps(() => {
      const payload = startTestLiveRun([{ label: 'PROMOS', days: 30, isTrash: true }]);
      processLiveBurst(payload);   // saves a resumable payload server-side
      const claim = claimRun(payload.runId, 'phoneB');
      assert(claim.ok, 'another device must be able to take over a live run');
      assertEqual(claim.payload.driverId, 'phoneB');
      threads[0].__trashed = false;
      const res = processLiveBurst(payload);   // old tab's next burst
      assertEqual(res.superseded, true, 'the old tab must be told to stop driving');
      assertEqual(threads[0].__trashed, false, 'the superseded tab must not act on mail');
    });
  } finally { spy.restore(); }
}

function test_claimRun_returnsLatestServerPayload() {
  const spy = installGmailSpy([makeFakeThread('c1')]);
  try {
    withRunProps(() => {
      const payload = startTestLiveRun([{ label: 'A', days: 30, isTrash: true }, { label: 'B', days: 30, isTrash: true }]);
      const res = processLiveBurst(payload);
      const claim = claimRun(payload.runId, 'phoneB');
      assertEqual(claim.payload.activeQueue.map(r => r.label), res.payload.activeQueue.map(r => r.label),
        'the resumed payload must be the post-burst one, not the launch-time one');
      assertEqual(claim.payload.stats.totalTrashed, 1);
      assertEqual(claim.queue, ['A', 'B'], 'the full rule list comes back for the progress bars');
    });
  } finally { spy.restore(); }
}

function test_claimRun_refusesBackgroundRuns() {
  withRunProps(() => {
    beginRun({ source: 'background', left: 1, queue: ['A'] });
    const s = readRunState();
    const claim = claimRun(s.id, 'phoneB');
    assertEqual(claim.ok, false, 'a background run is driven by its trigger and cannot be taken over');
  });
}

function test_processLiveBurst_registered_finalizesServerSideWhenDone() {
  const spy = installGmailSpy([]);
  try {
    withRunProps(props => {
      props.deleteProperty('LAST_RUN_TIME');
      const payload = startTestLiveRun([{ label: 'EMPTY', days: 30, isTrash: true }]);
      const res = processLiveBurst(payload);
      assertEqual(res.done, true);
      assertEqual(res.finalized, true, 'the last burst must finalize the run itself, not rely on the tab surviving');
      assert(props.getProperty('LAST_RUN_TIME'), 'finalizeAndEmail must have run server-side');
      const st = getRunStatus(-1, null);
      assertEqual(st.run.status, 'done');
      assertEqual(st.run.active, false);
      assert(/COMPLETE/.test(st.run.endMsg), 'viewers get the completion summary');
    });
  } finally { spy.restore(); }
}

function test_processLiveBurst_withoutRunId_unchangedAndUnregistered() {
  const spy = installGmailSpy([]);
  try {
    withRunProps(props => {
      processLiveBurst({ dryRun: false, activeQueue: [{ label: 'EMPTY', days: 30, isTrash: true }], seenIds: [], stats: freshStats() });
      assertEqual(props.getProperty('RUN_STATE'), null, 'an unregistered payload (older callers/tests) must not touch the registry');
    });
  } finally { spy.restore(); }
}

// ── abortRun / requestAbort ────────────────────────────────────────────────

function test_abortRun_withRunId_marksAbortedAndIsIdempotent() {
  withRunProps(props => {
    props.deleteProperty('DAILY_STATS');
    const payload = startTestLiveRun([{ label: 'A', days: 30, isTrash: true }]);
    const stats = { totalMoved: 4, totalTrashed: 4, totalArchived: 0, labels: {}, errors: [] };
    abortRun(stats, 1000, false, payload.runId);
    abortRun(stats, 1000, false, payload.runId);   // e.g. aborted from two devices at once
    const d = JSON.parse(props.getProperty('DAILY_STATS'));
    assertEqual(d.runs, 1, 'a double abort must not count the run twice in the digest');
    assertEqual(getRunStatus(-1, null).run.status, 'aborted');
    assertEqual(props.getProperty('RUN_ABORT'), null, 'the abort flag is cleared once the run is finalized');
  });
}

function test_abortRun_withRunId_usesFullerServerStats() {
  const spy = installGmailSpy([makeFakeThread('f1'), makeFakeThread('f2'), makeFakeThread('f3')]);
  try {
    withRunProps(props => {
      props.deleteProperty('DAILY_STATS');
      const payload = startTestLiveRun([{ label: 'A', days: 30, isTrash: true }]);
      processLiveBurst(payload);   // server now knows 3 trashed; the tab never saw the reply
      abortRun(freshStats(), 1000, false, payload.runId);
      const d = JSON.parse(props.getProperty('DAILY_STATS'));
      assertEqual(d.totalMoved, 3, 'real mail moved by a burst the tab never heard back from must still be accounted');
    });
  } finally { spy.restore(); }
}

// FIX 51: abortRun(..., runId) used to fall back to running finish() a
// SECOND time, completely UNLOCKED, whenever the 60s script-lock wait itself
// timed out — the opposite of what this function documents ("the abort
// waits for an in-flight burst to finish"). Simulated here the same way
// backgroundRun()'s own lock-contention test does (installLockSpy with
// failToAcquire), which makes ANY withRunLock() call in this process fail to
// acquire — proving abortRun() must not silently do the unlocked work anyway.
function test_abortRun_withRunId_lockContention_doesNotRunUnlocked() {
  withRunProps(props => {
    props.deleteProperty('DAILY_STATS');
    const payload = startTestLiveRun([{ label: 'A', days: 30, isTrash: true }]);
    const gmailSpy = installGmailSpy([]);
    const lockSpy = installLockSpy({ failToAcquire: true });
    try {
      const stats = { totalMoved: 4, totalTrashed: 4, totalArchived: 0, labels: {}, errors: [] };
      let threw = false;
      try { abortRun(stats, 1000, false, payload.runId); } catch (e) { threw = true; }
      assertEqual(threw, false, 'lock contention must not throw out of abortRun()');
      assertEqual(gmailSpy.calls.emails.length, 0,
        'abortRun() must not send the abort email unlocked when it could not acquire the script lock');
      assertEqual(getRunStatus(-1, null).run.status, 'running',
        'a run whose abort lost the lock race must be left running, not torn between two writers — it stops at its next checkpoint instead');
      assertEqual(props.getProperty('DAILY_STATS'), null,
        'DAILY_STATS must not be touched by an abort that never actually acquired the lock');
    } finally { lockSpy.restore(); gmailSpy.restore(); }
  });
}

// FIX 52: abortRun(..., runId)'s `finish()` only bailed when the SAME run
// (`mine`) had already moved off 'running' — guarding a double-abort of one
// run (two dashboards both noticing staleness at once). It did not bail when
// RUN_STATE had moved on to a DIFFERENT run entirely: this runId's own run
// already finished through its normal path, and a brand-new run has since
// started and overwritten RUN_STATE. A late stale-abort call for the OLD
// runId (requestAbort()'s staleness branch, queued behind withRunLock's
// up-to-60s wait) fell through anyway, using its own cached detail/stats to
// re-send an abort email and re-run accumulateDailyStats() for a run that
// was not this call's job to finalize a second time — silently double-
// counting that run's numbers into DAILY_STATS/the digest. Reproduced here
// by finishing run A normally, starting run B in its place, then firing a
// stale abortRun() for run A's id.
function test_abortRun_withRunId_staleForSupersededRun_doesNotDoubleAccumulate() {
  const spy = installGmailSpy([]); // no matches — the rule ejects on the first burst
  try {
    withRunProps(props => {
      props.deleteProperty('DAILY_STATS');
      const payloadA = startTestLiveRun([{ label: 'A', days: 30, isTrash: true }]);
      const res = processLiveBurst(payloadA);
      assertEqual(res.done, true, 'run A should finish in one burst (1 rule, 0 matches, ejects immediately)');
      const dAfterA = JSON.parse(props.getProperty('DAILY_STATS'));
      assertEqual(dAfterA.runs, 1, 'run A must have accumulated exactly once');
      const emailsAfterA = spy.calls.emails.length;

      const startB = startLiveRun({ driverId: 'tabB', left: 1, queue: ['B'] });
      assert(startB.ok, 'run B should be able to start now that run A finished');

      // Stale abort call for the OLD run A id, arriving late (e.g. from
      // requestAbort()'s staleness path queued behind a slow lock).
      abortRun({ totalMoved: 999, totalTrashed: 999, totalArchived: 0, labels: {}, errors: [] }, 1000, false, payloadA.runId);

      const dAfter = JSON.parse(props.getProperty('DAILY_STATS'));
      assertEqual(dAfter.runs, 1, 'a stale abort for a SUPERSEDED run must not double-accumulate into DAILY_STATS');
      assertEqual(spy.calls.emails.length, emailsAfterA, 'a stale abort for a superseded run must not send a second abort email');
      const st = getRunStatus(-1, null);
      assertEqual(st.run.id, startB.runId, 'run B must remain the tracked run');
      assertEqual(st.run.status, 'running', 'run B must be untouched by the stale abort for run A');
    });
  } finally { spy.restore(); }
}

function test_requestAbort_staleLiveRun_isFinalizedImmediately() {
  withRunProps(props => {
    const payload = startTestLiveRun([{ label: 'A', days: 30, isTrash: true }]);
    makeRunStale(props);
    requestAbort(payload.runId);
    assertEqual(getRunStatus(-1, null).run.status, 'aborted',
      'with no living driver left to notice the abort, the request itself must finish the run');
  });
}

function test_requestAbort_wrongRunId_isRejected() {
  withRunProps(() => {
    startTestLiveRun([{ label: 'A', days: 30, isTrash: true }]);
    assertEqual(requestAbort('not-this-run').ok, false);
  });
}

// ── backgroundRun ──────────────────────────────────────────────────────────

function setOneBackgroundRule(props) {
  props.setProperty('AUTOTRASH_RULES', JSON.stringify([{ label: 'BG', days: 30, isTrash: true }]));
  props.setProperty('CATEGORY_RULES', '[]');
  props.setProperty('GLOBAL_PURGE_DAYS', 'OFF');
  props.setProperty('INBOX_PURGE_DAYS', 'OFF');
}

function test_backgroundRun_registersRunVisibleToDashboards() {
  let calls = 0;
  const spy = installGmailSpy(() => (calls++ === 0 ? [makeFakeThread('b1')] : []));
  const lock = installLockSpy();
  try {
    withRunProps(props => {
      setOneBackgroundRule(props);
      props.deleteProperty('DAILY_STATS');
      backgroundRun();
      const st = getRunStatus(-1, null);
      assertEqual(st.run.source, 'background');
      assertEqual(st.run.status, 'done');
      assertEqual(st.stats.totalTrashed, 1);
      assert(st.log.some(e => e.level === 'SEARCH'), 'background runs must now publish their engine log');
    });
  } finally { spy.restore(); lock.restore(); }
}

function test_backgroundRun_stopsWhenAbortRequestedFromDashboard() {
  const threads = [];
  const spy = installGmailSpy(() => {
    // An abort lands while the first rule is being searched.
    const s = readRunState();
    if (s) getProps().setProperty('RUN_ABORT', s.id);
    const t = makeFakeThread('ab' + threads.length); threads.push(t); return [t];
  });
  const lock = installLockSpy();
  try {
    withRunProps(props => {
      setOneBackgroundRule(props);
      backgroundRun();
      assertEqual(threads.length, 1, 'no further rule iteration may start once an abort is requested');
      assertEqual(getRunStatus(-1, null).run.status, 'aborted');
      assert(/aborted/.test(props.getProperty('LAST_RUN_TIME')), 'LAST_RUN_TIME must record the abort');
    });
  } finally { spy.restore(); lock.restore(); }
}

function test_backgroundRun_yieldsToActiveManualRun() {
  const spy = installGmailSpy([makeFakeThread('y1')]);
  const lock = installLockSpy();
  try {
    withRunProps(props => {
      setOneBackgroundRule(props);
      const live = startLiveRun({ driverId: 'tabA', left: 1, queue: ['X'] });
      backgroundRun();
      assertEqual(spy.calls.search.length, 0, 'a trigger firing between two live bursts must not process mail');
      assertEqual(readRunState().id, live.runId, 'the manual run stays the registered run');
      assert(lock.wasReleased(), 'the lock must still be released on the skip path');
    });
  } finally { spy.restore(); lock.restore(); }
}

// ── pauseBackgroundTrigger ─────────────────────────────────────────────────

function test_pauseBackgroundTrigger_turnsTriggerOffKeepingOtherSettings() {
  const sa = installScriptAppSpy([]);
  try {
    withRunProps(props => {
      updateSystem({ rules: [{ label: 'KEEP', days: 9, isTrash: true }], categoryRules: [],
        triggerMode: '1MIN', summaryFreq: 'NEVER', globalPurgeDays: 'OFF', inboxPurgeDays: '90', digestHour: '8' });
      pauseBackgroundTrigger();
      assertEqual(props.getProperty('TRIGGER_MODE'), 'OFF');
      assertEqual(props.getProperty('INBOX_PURGE_DAYS'), '90', 'other settings must be untouched');
      assertEqual(JSON.parse(props.getProperty('AUTOTRASH_RULES'))[0].label, 'KEEP');
      assertEqual(sa.triggers().filter(t => t.getHandlerFunction() === 'backgroundRun').length, 0,
        'the backgroundRun trigger must be removed');
    });
  } finally { sa.restore(); }
}

// ── getRunStatus ───────────────────────────────────────────────────────────

function test_getRunStatus_noRun_returnsNullRun() {
  withRunProps(() => {
    const st = getRunStatus(-1, null);
    assertEqual(st.run, null);
    assert(typeof st.serverNow === 'number', 'serverNow lets clients correct for clock skew');
  });
}

function test_getRunStatus_corruptState_readsAsNoRun() {
  withRunProps(props => {
    props.setProperty('RUN_STATE', '{broken');
    assertEqual(getRunStatus(-1, null).run, null, 'a corrupted RUN_STATE must never break the dashboard');
  });
}

const RUNSTATE_TESTS = [
  test_startLiveRun_refusesSecondRunWhileOneIsActive,
  test_startLiveRun_replacesStaleRun,
  test_processLiveBurst_registered_recordsProgressForOtherDevices,
  test_processLiveBurst_registered_abortRequestStopsBeforeTouchingGmail,
  test_processLiveBurst_registered_supersededAfterTakeOver,
  test_claimRun_returnsLatestServerPayload,
  test_claimRun_refusesBackgroundRuns,
  test_processLiveBurst_registered_finalizesServerSideWhenDone,
  test_processLiveBurst_withoutRunId_unchangedAndUnregistered,
  test_abortRun_withRunId_marksAbortedAndIsIdempotent,
  test_abortRun_withRunId_usesFullerServerStats,
  test_abortRun_withRunId_lockContention_doesNotRunUnlocked,
  test_abortRun_withRunId_staleForSupersededRun_doesNotDoubleAccumulate,
  test_requestAbort_staleLiveRun_isFinalizedImmediately,
  test_requestAbort_wrongRunId_isRejected,
  test_backgroundRun_registersRunVisibleToDashboards,
  test_backgroundRun_stopsWhenAbortRequestedFromDashboard,
  test_backgroundRun_yieldsToActiveManualRun,
  test_pauseBackgroundTrigger_turnsTriggerOffKeepingOtherSettings,
  test_getRunStatus_noRun_returnsNullRun,
  test_getRunStatus_corruptState_readsAsNoRun
];

