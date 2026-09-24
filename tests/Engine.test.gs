/**
 * AutoTrash tests — app/Engine.gs (findMatches, makeMessageContext,
 * executeAction, runRule, refineQuery, seenTracker, getAction/registerAction,
 * executeActions compatibility wrapper).
 *
 * These tests exist to PROVE the engine is modular: that matching, context,
 * and action are separable stages, that a new action plugs in without
 * touching matching, and that the engine's safety guarantees (dry-run, seen
 * registration, chunking, narrow-only queries, lazy data) hold for every
 * action — not just trash/archive. Grouped by the guarantee they prove.
 */

const ENGINE_TEST_RULE = { label: 'PROMOS', days: 30, isTrash: true };

// A custom action that records what it saw — stands in for a future feature.
function makeRecordingAction(name) {
  const seen = [];
  return {
    def: { name: name || 'recorder', each: function (ctx) { seen.push(ctx.threadId); return 'ok:' + ctx.threadId; } },
    seen: seen
  };
}

// ── 1. Existing trash behavior still works ────────────────────────────────

function test_engine_runRule_trashRule_trashesInGmailChunks() {
  const threads = [];
  for (let i = 0; i < 250; i++) threads.push(makeFakeThread('c' + i));
  const spy = installGmailSpy(threads);
  try {
    const m = runRule(ENGINE_TEST_RULE, { seen: new Set() });
    assertEqual(m.action, 'trash');
    assertEqual(m.matched, 250);
    assertEqual(m.execution.count, 250);
    assertEqual(spy.calls.trashBatches.map(b => b.length), [100, 100, 50], 'bulk actions must be chunked to GMAIL_CHUNK');
    assert(threads.every(t => t.__trashed), 'every matched thread must be trashed');
    assertEqual(spy.calls.archiveBatches.length, 0);
  } finally { spy.restore(); }
}

function test_engine_runRule_archiveRule_archives() {
  const t = makeFakeThread('ar1');
  const spy = installGmailSpy([t]);
  try {
    const m = runRule({ label: 'SOCIAL', days: 60, isTrash: false }, {});
    assertEqual(m.action, 'archive');
    assert(t.__archived && !t.__trashed, 'isTrash:false must still archive, never trash');
  } finally { spy.restore(); }
}

function test_engine_runRule_liveLogLines_matchPreEngineFormat() {
  const spy = installGmailSpy([makeFakeThread('l1'), makeFakeThread('l2')]);
  try {
    const log = [];
    runRule(ENGINE_TEST_RULE, { seen: ['l2'], emit: (lvl, msg) => log.push(lvl + ' ' + msg) });
    assertEqual(log[0], 'SEARCH [PROMOS] label:"PROMOS" in:inbox older_than:30d -is:starred -in:trash → TRASH');
    assert(/^RESULT 2 found · /.test(log[1]), log[1]);
    assertEqual(log[2], 'INFO Skipped 1 already-processed this run.');
    assertEqual(log[3], 'ACTION TRASHING 1…');
    assert(/^BATCH Trash ×1 · /.test(log[4]), log[4]);
    assertEqual(log.length, 5);
  } finally { spy.restore(); }
}

function test_engine_executeActions_compatWrapper_keepsOldContract() {
  const a = makeFakeThread('w1'), b = makeFakeThread('w2');
  const spy = installGmailSpy([]);
  try {
    const res = executeActions([a], [b], null);
    assertEqual([res.trashed, res.archived], [1, 1]);
    assert(a.__trashed && b.__archived, 'old two-list API must still trash the first list and archive the second');
    assert(typeof res.batchMs === 'number', 'batchMs must still be returned');
  } finally { spy.restore(); }
}

// ── 2. A rule can produce matches without executing an action ─────────────

function test_engine_findMatches_neverMutatesGmailOrSeen() {
  const threads = [makeFakeThread('f1'), makeFakeThread('f2')];
  const spy = installGmailSpy(threads);
  try {
    const seenIds = [];
    const m = findMatches(ENGINE_TEST_RULE, { seen: seenIds });
    assertEqual(m.contexts.map(c => c.threadId), ['f1', 'f2']);
    assertEqual(m.found, 2);
    assertEqual(spy.calls.trashBatches.length + spy.calls.archiveBatches.length, 0, 'findMatches must never move mail');
    assert(threads.every(t => !t.__trashed && !t.__archived));
    assertEqual(seenIds.length, 0, 'findMatches must not register seen IDs — only executeAction does');
  } finally { spy.restore(); }
}

function test_engine_findMatches_contextCarriesRuleAndQuery() {
  const spy = installGmailSpy([makeFakeThread('x1')]);
  try {
    const rule = { isCategory: true, category: 'promotions', days: 30 };
    const ctx = findMatches(rule, { dryRun: true }).contexts[0];
    assert(ctx.rule === rule, 'context must reference the triggering rule');
    assertEqual(ctx.ruleLabel, 'PROMOTIONS', 'context label must use the same fallback as stats (BUG-C8)');
    assertEqual(ctx.query, buildQuery(rule));
    assertEqual(ctx.dryRun, true);
    assertEqual(ctx.threadId, 'x1');
  } finally { spy.restore(); }
}

function test_engine_findMatches_skipsSeenAndAppliesFilter() {
  const threads = [makeFakeThread('s1'), makeFakeThread('s2'), makeFakeThread('s3')];
  const spy = installGmailSpy(threads);
  try {
    const m = findMatches(ENGINE_TEST_RULE, { seen: ['s1'], filter: c => c.threadId !== 's3' });
    assertEqual(m.contexts.map(c => c.threadId), ['s2']);
    assertEqual([m.found, m.skipped, m.filtered], [3, 1, 1]);
  } finally { spy.restore(); }
}

// ── 3. A different action can consume the same match/context ──────────────

function test_engine_sameContexts_consumedByTwoDifferentActions() {
  const threads = [makeFakeThread('m1'), makeFakeThread('m2')];
  const spy = installGmailSpy(threads);
  try {
    const m = findMatches(ENGINE_TEST_RULE, {});
    const rec = makeRecordingAction();
    const r1 = executeAction(rec.def, m.contexts, {});
    const r2 = executeAction('archive', m.contexts, {});
    assertEqual(rec.seen, ['m1', 'm2'], 'custom action must receive every matched context');
    assertEqual(r1.results, ['ok:m1', 'ok:m2'], 'each() return values must be collected as results');
    assertEqual(r2.count, 2);
    assert(threads.every(t => t.__archived), 'the same contexts must be usable by a built-in action too');
    assertEqual(spy.calls.search.length, 1, 'consuming a match twice must not re-search Gmail');
  } finally { spy.restore(); }
}

// ── 4. Dry-run still works across actions ─────────────────────────────────

function test_engine_dryRun_neverInvokesAnyAction_butCountsAndRegistersSeen() {
  const threads = [makeFakeThread('d1'), makeFakeThread('d2')];
  const spy = installGmailSpy(threads);
  try {
    const rec = makeRecordingAction();
    [rec.def, 'trash', 'archive'].forEach(action => {
      const seen = new Set();
      const m = runRule(ENGINE_TEST_RULE, { dryRun: true, seen: seen }, { action: action });
      assertEqual(m.execution.count, 2, 'dry run must still report the would-be count');
      assertEqual(m.execution.dryRun, true);
      assertEqual(seen.size, 2, 'dry run must register seen IDs so later rules dedup the same way a live run does');
    });
    assertEqual(rec.seen.length, 0, 'a custom action must never be called during a dry run');
    assert(threads.every(t => !t.__trashed && !t.__archived), 'no Gmail mutation in a dry run');
    assertEqual(spy.calls.trashBatches.length + spy.calls.archiveBatches.length, 0);
  } finally { spy.restore(); }
}

function test_engine_dryRun_liveLogHasNoActionOrBatchLines() {
  const spy = installGmailSpy([makeFakeThread('dl1')]);
  try {
    const levels = [];
    runRule(ENGINE_TEST_RULE, { dryRun: true, emit: lvl => levels.push(lvl) });
    assertEqual(levels, ['SEARCH', 'RESULT'], 'dry runs must not claim an ACTION or BATCH happened');
  } finally { spy.restore(); }
}

// ── 5. Errors in an action do not corrupt the engine ──────────────────────

function test_engine_throwingAction_propagates_seenAlreadyRegistered_engineStillUsable() {
  const threads = [makeFakeThread('e1'), makeFakeThread('e2')];
  const spy = installGmailSpy(threads);
  try {
    let calls = 0;
    const broken = { name: 'broken', each: function () { calls++; if (calls === 1) throw new Error('feature bug'); } };
    const seen = new Set();
    let threw = null;
    try { runRule(ENGINE_TEST_RULE, { seen: seen }, { action: broken }); } catch (e) { threw = e; }
    assert(threw && threw.message === 'feature bug', 'the original error must reach the runner unchanged');
    assertEqual(seen.size, 2, 'seen IDs must be registered BEFORE the action runs (FIX 15), even when it throws');

    // Engine and registry intact: a normal rule still runs, built-ins untouched.
    assertEqual(getAction('trash').name, 'trash');
    const m = runRule(ENGINE_TEST_RULE, { seen: new Set() });
    assertEqual(m.execution.count, 2, 'a later run must be unaffected by an earlier action failure');
  } finally { spy.restore(); }
}

function test_engine_processLiveBurst_trashFailure_recordsErrorAndKeepsQueue() {
  const spy = installGmailSpy([makeFakeThread('q1')]);
  GmailApp.moveThreadsToTrash = function () { throw new Error('Simulated trash failure'); };
  try {
    const payload = { dryRun: false, activeQueue: [{ label: 'X', days: 1, isTrash: true }, { label: 'Y', days: 1, isTrash: true }], seenIds: [], stats: freshStats() };
    const res = processLiveBurst(payload);
    assert(res.error === true);
    assertEqual(res.payload.stats.errors[0], { label: 'X', error: 'Simulated trash failure' });
    assertEqual(res.payload.activeQueue.map(r => r.label), ['X', 'Y'], 'a failed action must not rotate or eject the rule');
    assertEqual(res.payload.stats.totalTrashed, 0, 'nothing may be credited for a failed action');
    assertEqual(spy.calls.emails.length, 1, 'error email still sent');
  } finally { spy.restore(); }
}

function test_engine_getAction_rejectsUnknownOrMalformedActions() {
  assertThrows(() => getAction('shred'), 'unknown action name must throw, not silently no-op');
  assertThrows(() => getAction({ name: 'x' }), 'action with neither bulk() nor each() must throw');
  assertThrows(() => getAction({ each: function () {} }), 'action without a name must throw');
  assertThrows(() => registerAction({ name: 'trash', each: function () {} }), 'built-in actions must not be replaceable');
}

// ── 6. A custom action plugs in without modifying matching ────────────────

function test_engine_customAction_viaRunRule_usesSameMatchingAsBuiltIns() {
  const threads = [makeFakeThread('p1'), makeFakeThread('p2'), makeFakeThread('p3')];
  const spy = installGmailSpy(threads);
  try {
    const seen = new Set(['p3']);
    const rec = makeRecordingAction('myFeature');
    const m = runRule(ENGINE_TEST_RULE, { seen: seen }, { action: rec.def });
    assertEqual(m.action, 'myFeature');
    assertEqual(rec.seen, ['p1', 'p2'], 'custom action gets exactly the deduped matches the built-ins would');
    assertEqual(m.execution.results, ['ok:p1', 'ok:p2']);
    assert(threads.every(t => !t.__trashed), 'a custom action must NOT also trigger the rule\'s own trash action');
  } finally { spy.restore(); }
}

function test_engine_registerAction_makesActionAddressableByName() {
  const spy = installGmailSpy([makeFakeThread('r1')]);
  try {
    const rec = makeRecordingAction('engineTestRegistered');
    registerAction(rec.def);
    try {
      const m = runRule(ENGINE_TEST_RULE, {}, { action: 'engineTestRegistered' });
      assertEqual(m.execution.count, 1);
      assertEqual(rec.seen, ['r1']);
    } finally { delete ENGINE_ACTIONS.engineTestRegistered; }
  } finally { spy.restore(); }
}

// ── 7. Query generation stays independent from action execution ───────────

function test_engine_queryIsIdenticalRegardlessOfAction() {
  const spy = installGmailSpy([makeFakeThread('i1')]);
  try {
    runRule(ENGINE_TEST_RULE, { dryRun: true }, { action: 'trash' });
    runRule(ENGINE_TEST_RULE, { dryRun: true }, { action: 'archive' });
    runRule(ENGINE_TEST_RULE, { dryRun: true }, { action: makeRecordingAction().def });
    findMatches(ENGINE_TEST_RULE, {});
    const expected = buildQuery(ENGINE_TEST_RULE);
    assertEqual(spy.calls.search, [expected, expected, expected, expected], 'the action must never influence the Gmail query');
  } finally { spy.restore(); }
}

function test_engine_refineQuery_onlyNarrows_keepsSafetyTerms() {
  const base = buildQuery(ENGINE_TEST_RULE);
  assertEqual(refineQuery(base, ''), base);
  assertEqual(refineQuery(base, null), base);
  const q = refineQuery(base, '-from:boss@example.com has:attachment');
  assertEqual(q, base + ' -from:boss@example.com has:attachment');
  assert(q.includes('-is:starred') && q.includes('-in:trash') && q.includes('in:inbox'), 'safety terms must survive refinement');
  ['OR in:anywhere', 'a OR b', '(x)', '{a b}', 'x | y', 'AND y'].forEach(bad =>
    assertThrows(() => refineQuery(base, bad), 'refinement that could widen the match must be rejected: ' + bad));
}

function test_engine_findMatches_refineIsAppliedToSearch() {
  const spy = installGmailSpy([]);
  try {
    findMatches(ENGINE_TEST_RULE, { refine: 'larger:5M' });
    assertEqual(spy.calls.search, [buildQuery(ENGINE_TEST_RULE) + ' larger:5M']);
  } finally { spy.restore(); }
}

// ── 8. Expensive message data is not retrieved until needed ───────────────

function test_engine_plainCleanup_neverFetchesMessagesOrMetadata() {
  const threads = [makeRichFakeThread('z1'), makeRichFakeThread('z2')];
  const spy = installGmailSpy(threads);
  try {
    runRule(ENGINE_TEST_RULE, { seen: new Set() });
    threads.forEach(t => {
      assertEqual(t.__calls, { getMessages: 0, getFirstMessageSubject: 0, getLastMessageDate: 0, getMessageCount: 0, getLabels: 0 },
        'trash must cost exactly what it did before the engine existed — no per-thread reads');
    });
  } finally { spy.restore(); }
}

function test_engine_cheapFilter_readsMetadataOnce_neverMessages() {
  const threads = [makeRichFakeThread('k1', { subject: 'Invoice 12' }), makeRichFakeThread('k2', { subject: 'Sale!' })];
  const spy = installGmailSpy(threads);
  try {
    const m = findMatches(ENGINE_TEST_RULE, {
      filter: c => c.metadata().subject.indexOf('Invoice') === -1 && c.metadata().messageCount > 0
    });
    assertEqual(m.contexts.map(c => c.threadId), ['k2']);
    threads.forEach(t => {
      assertEqual(t.__calls.getFirstMessageSubject, 1, 'metadata() must be cached — one read per thread however often it is used');
      assertEqual(t.__calls.getMessages, 0, 'a metadata-only filter must never fetch full messages');
    });
  } finally { spy.restore(); }
}

function test_engine_messages_fetchedLazilyAndCached() {
  const t = makeRichFakeThread('b1', { from: 'news@example.com', body: 'hello' });
  const ctx = makeMessageContext(t, ENGINE_TEST_RULE);
  assertEqual(t.__calls.getMessages, 0, 'creating a context must not fetch messages');
  assertEqual(ctx.message().getFrom(), 'news@example.com');
  ctx.messages(); ctx.message();
  assertEqual(t.__calls.getMessages, 1, 'messages() must be fetched once and cached');
}

// ── seenTracker (the one bit of shared run state) ─────────────────────────

function test_engine_seenTracker_arrayIsUpdatedInPlaceWithoutDuplicates() {
  const arr = ['a'];
  const s = seenTracker(arr);
  s.add('b'); s.add('a'); s.add('b');
  assertEqual(arr, ['a', 'b'], 'live payload.seenIds must grow in place, with no duplicates');
  assert(s.has('a') && s.has('b') && !s.has('c'));
  const set = new Set();
  assert(seenTracker(set) === set, 'a Set (background run) is used directly');
}

const ENGINE_TESTS = [
  test_engine_runRule_trashRule_trashesInGmailChunks,
  test_engine_runRule_archiveRule_archives,
  test_engine_runRule_liveLogLines_matchPreEngineFormat,
  test_engine_executeActions_compatWrapper_keepsOldContract,
  test_engine_findMatches_neverMutatesGmailOrSeen,
  test_engine_findMatches_contextCarriesRuleAndQuery,
  test_engine_findMatches_skipsSeenAndAppliesFilter,
  test_engine_sameContexts_consumedByTwoDifferentActions,
  test_engine_dryRun_neverInvokesAnyAction_butCountsAndRegistersSeen,
  test_engine_dryRun_liveLogHasNoActionOrBatchLines,
  test_engine_throwingAction_propagates_seenAlreadyRegistered_engineStillUsable,
  test_engine_processLiveBurst_trashFailure_recordsErrorAndKeepsQueue,
  test_engine_getAction_rejectsUnknownOrMalformedActions,
  test_engine_customAction_viaRunRule_usesSameMatchingAsBuiltIns,
  test_engine_registerAction_makesActionAddressableByName,
  test_engine_queryIsIdenticalRegardlessOfAction,
  test_engine_refineQuery_onlyNarrows_keepsSafetyTerms,
  test_engine_findMatches_refineIsAppliedToSearch,
  test_engine_plainCleanup_neverFetchesMessagesOrMetadata,
  test_engine_cheapFilter_readsMetadataOnce_neverMessages,
  test_engine_messages_fetchedLazilyAndCached,
  test_engine_seenTracker_arrayIsUpdatedInPlaceWithoutDuplicates
];
