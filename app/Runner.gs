/**
 * AutoTrash — the two execution paths: processLiveBurst() (one rule per
 * call, driven by the open tab) and backgroundRun() (whole queue inside a
 * 55s budget, trigger-driven), plus abort/finalize. Stat crediting and daily
 * accumulation live in Stats.gs; config reads go through Config.gs.
 * Split out of Code.gs on 2026-09-22; see CLAUDE.md for the full file map.
 */

// ─── LIVE ENGINE (client-driven bursts) ──────────────────────────────────────
// Entry point the browser calls once per burst. A payload WITHOUT a runId
// (tests, any older caller) goes straight to processLiveBurstCore() exactly
// as before. A payload WITH a runId is part of a registered run (RunState.gs,
// started by startLiveRun()): the burst then runs under the script lock and
//   - refuses to run if the run was finished/aborted elsewhere or another
//     device has taken it over (superseded:true — the tab stops driving),
//   - stops if an abort was requested from any device (abortRequested:true —
//     the tab then calls abortRun() to finalize and email),
//   - records progress/log/stats/payload after the burst so every other open
//     dashboard can watch it, and another device can resume it,
//   - finalizes the run server-side when the queue empties (finalized:true),
//     so the summary email and LAST_RUN_TIME no longer depend on the driving
//     tab still being open when the last burst returns (e.g. a phone whose
//     screen locked).
// Added 2026-09-24 (Issues #82/#79).
function processLiveBurst(payload) {
  if (!payload || !payload.runId) return processLiveBurstCore(payload);
  const runId = payload.runId;
  const r = withRunLock(30000, () => {
    const s = readRunState();
    if (!s || s.id !== runId || s.status !== 'running')
      return { payload, log: [], superseded: true, msg: 'This run is no longer active.' };
    if (s.driverId && payload.driverId && s.driverId !== payload.driverId)
      return { payload, log: [], superseded: true, msg: 'This run was taken over by another device.' };
    if (abortRequestedFor(runId))
      return { payload, log: [], abortRequested: true, msg: 'Abort requested from another device.' };

    const t0  = Date.now();
    const res = processLiveBurstCore(payload);
    const p   = res.payload || payload;
    const q   = p.activeQueue || [];
    recordRunProgress(runId, {
      log:   (res.log || []).map(e => ({ ts: t0 + (e.t || 0), level: e.level, msg: e.msg })),
      stats: p.stats,
      rule:  q.length ? safeRuleLabel(q[0]) : null,
      left:  q.length,
      payload: p
    });

    if (res.error) {
      endRun(runId, 'error', 'Engine halted: ' + res.msg, p.stats);
    } else if (res.done) {
      const elapsed = Date.now() - (s.startedAt || t0);
      let ts = null;
      try {
        ts = finalizeAndEmail(p.stats, elapsed, s.dryRun ? 'Dry Run Complete' : 'Live Run Complete', s.dryRun);
      } catch (e) {
        res.log = (res.log || []).concat([{ t: Date.now() - t0, level: 'ERROR',
          msg: 'Summary email failed: ' + ((e && e.message) ? e.message : String(e)) }]);
      }
      endRun(runId, 'done', runSummaryMsg(p.stats, s.dryRun, elapsed), p.stats);
      res.finalized = true;
      res.lastRun = ts;
    }
    return res;
  });
  if (!r.ok) return { payload, log: [], busy: true, msg: 'Server busy — retrying.' };
  return r.value;
}

// ruleLabel() throws on a category rule missing its category field (Issue
// #96); progress reporting must never be what breaks a run.
function safeRuleLabel(rule) {
  try { return ruleLabel(rule); } catch (e) { return '?'; }
}

// The one-line completion summary shown to every dashboard watching a run.
// Mirrors the client's completion banners (index.html finishEng()).
function runSummaryMsg(stats, dryRun, elapsedMs) {
  stats = stats || {};
  const secs = ((elapsedMs || 0) / 1000).toFixed(1);
  const rules = Object.keys(stats.labels || {}).filter(k => (stats.labels[k].moved || 0) > 0).length
    + ((stats.globalPurgeMoved || 0) > 0 ? 1 : 0) + ((stats.inboxPurgeMoved || 0) > 0 ? 1 : 0);
  return dryRun
    ? `[DRY RUN COMPLETE] ~${fmtNum(stats.totalMoved)} threads scanned · ${fmtNum(stats.dryTrashed || 0)} would trash · ${fmtNum(stats.dryArchived || 0)} would archive · ${rules} rule(s) · ${secs}s`
    : `✓ COMPLETE · ${fmtNum(stats.totalMoved)} actioned · ${fmtNum(stats.totalTrashed || 0)} trashed · ${fmtNum(stats.totalArchived || 0)} archived · ${rules} rule(s) · ${secs}s`;
}

// The original, registry-unaware burst body — behavior unchanged.
function processLiveBurstCore(payload) {
  const t0  = Date.now();
  const log = [];
  const emit = (lvl, msg, meta) =>
    log.push({ t: Date.now() - t0, level: lvl, msg, meta: meta || null });

  // FIX 38 (BUG-C15): lbl and dry are declared HERE, outside the try block,
  // and only assigned once the rule is known. A const/let declared inside a
  // try{} is scoped to that block and is NOT visible from the matching
  // catch{} — plain JS block scoping, nothing Apps-Script-specific. The old
  // code declared `lbl` inside try and read `lbl || 'unknown'` in catch; that
  // read itself threw a fresh ReferenceError on literally every exception,
  // before the stats.errors push or sendErrorEmail() it was guarding could
  // ever run. Net effect: no error email was ever sent for a live-run
  // failure, and the client only ever saw a confusing RPC failure
  // ("lbl is not defined") instead of the real cause — silently defeating
  // the BUG-H12 fix it sits right next to. Verified with a plain Node
  // reproduction before patching; see GitHub Issues.
  let lbl = 'unknown';
  let dry = false;

  try {
    // FIX 40 (BUG-C16): Build the queue server-side when the caller hasn't
    // supplied one. feature-reference.txt §11 documents
    // activeQueue as "null on first burst, server builds it" — in practice
    // the client (burst() in index.html) has always pre-built it before the
    // first call, so this path was normally dead code, but any caller that
    // takes the documented contract at face value (a test, an alternate
    // client) would get an immediate "done: true" with nothing processed
    // instead of a working queue. Mirrors buildQueue() exactly, so behaviour
    // for the existing UI flow (which never sends null) is unchanged.
    if (!payload.activeQueue) {
      payload.activeQueue = buildQueue(
        payload.rules, payload.globalPurgeDays, payload.inboxPurgeDays, payload.categoryRules
      );
    }
    if (payload.activeQueue.length === 0)
      return { payload, log, done: true, msg: 'All rules complete.' };

    dry = !!payload.dryRun;
    const rule = payload.activeQueue[0];

    lbl = ruleLabel(rule);

    // FIX 1+3: action from rule only, no cross-queue override.
    const action = resolveRuleAction(rule);

    // FIX 2: seenIds dedup — skip threads processed by an earlier rule this
    // run. The engine reads AND appends to payload.seenIds through this
    // tracker, so the array that round-trips to the client stays the record.
    if (!payload.seenIds) payload.seenIds = [];
    const seen = seenTracker(payload.seenIds);

    // Engine (Engine.gs): SEARCH/RESULT/INFO logs → search → dedup → and, on
    // a live run with matches, ACTION/BATCH logs + the actual Gmail move. On a
    // dry run the engine registers seenIds and counts, but never calls Gmail.
    const m = runRule(rule, { dryRun: dry, seen: seen, emit: emit });
    const matched = m.matched;

    if (matched === 0) {
      emit('COMPLETE', `[${lbl}] clean — ejected from queue.`);
      // FIX 14 (BUG-C2): Only write to stats.labels for non-purge rules.
      // Purge rules use globalPurgeMoved/inboxPurgeMoved — writing a zero entry
      // to stats.labels would pollute the per-rule email table with "INBOX PURGE — 0".
      if (!rule.isGlobalPurge && !rule.isInboxPurge) {
        ensureStat(payload.stats, lbl);
        payload.stats.labels[lbl].finished = true;
      } else if (rule.isGlobalPurge) {
        // FIX 32 (BUG-H6): Purge rules have no stats.labels entry, so the client
        // had no way to tell they had ejected — the bar only turned green at the
        // very end via markBarsDone(). Dedicated flags let updateBars() do it now.
        payload.stats.globalPurgeDone = true;
      } else {
        payload.stats.inboxPurgeDone = true;
      }
      payload.activeQueue.shift();
      return {
        payload, log, ejected: true,
        done: payload.activeQueue.length === 0,
        msg: `"${lbl}" clean · ${payload.activeQueue.length} remain.`
      };
    }

    // ── DRY RUN ───────────────────────────────────────────────────────────
    if (dry) {
      const wouldTrash   = action === 'trash'   ? matched : 0;
      const wouldArchive = action === 'archive' ? matched : 0;
      emit('DRYRUN', `[${lbl}] Would ${action.toUpperCase()} ${fmtNum(matched)}`);
      emit('DRYRUN', `  → ${fmtNum(wouldTrash)} trash · ${fmtNum(wouldArchive)} archive`);

      payload.stats.totalMoved  = (payload.stats.totalMoved  || 0) + matched;
      payload.stats.dryTrashed  = (payload.stats.dryTrashed  || 0) + wouldTrash;
      payload.stats.dryArchived = (payload.stats.dryArchived || 0) + wouldArchive;
      // FIX 33 (BUG-C11): Purge rules must route to globalPurge*/inboxPurge*
      // here exactly as they do on the live path via creditStat(). Writing them
      // into stats.labels left the purge progress bar reading 0 (updateBars
      // reads the purge counters, not labels) and put a ghost "GLOBAL PURGE"
      // row into the dry-run email table that BUG-C2 removed from live runs.
      if (rule.isGlobalPurge || rule.isInboxPurge) {
        creditStat(payload.stats, lbl, rule, wouldTrash, wouldArchive);
        if (rule.isGlobalPurge) payload.stats.globalPurgeDone = true;
        else                    payload.stats.inboxPurgeDone  = true;
      } else {
        ensureStat(payload.stats, lbl);
        payload.stats.labels[lbl].moved    += matched;
        payload.stats.labels[lbl].trashed  += wouldTrash;
        payload.stats.labels[lbl].archived += wouldArchive;
        payload.stats.labels[lbl].finished  = true;
      }

      payload.activeQueue.shift();

      return {
        payload, log, ejected: true,
        done: payload.activeQueue.length === 0,
        moved: matched,
        msg: `[DRY] ${lbl}: ${fmtNum(matched)} · ${payload.activeQueue.length} remain.`
      };
    }

    // ── EXECUTE (live) ────────────────────────────────────────────────────
    // Already done by runRule() above — seenIds were registered BEFORE the
    // Gmail call (FIX 15, now shared with the background path).
    const exec     = m.execution;
    const trashed  = action === 'trash'   ? exec.count : 0;
    const archived = action === 'archive' ? exec.count : 0;
    const batchMs  = exec.batchMs;
    const total = trashed + archived;
    const tps   = Math.round(total / ((batchMs || 1) / 1000));

    emit('DONE', `${fmtNum(total)} done · ${fmtMs(batchMs)} · ~${fmtNum(tps)}/sec`,
      { moved: total, batchMs, tps });

    payload.stats.totalMoved    = (payload.stats.totalMoved    || 0) + total;
    payload.stats.totalTrashed  = (payload.stats.totalTrashed  || 0) + trashed;
    payload.stats.totalArchived = (payload.stats.totalArchived || 0) + archived;
    creditStat(payload.stats, lbl, rule, trashed, archived);

    payload.activeQueue.push(payload.activeQueue.shift());

    emit('INFO', `Burst ${fmtMs(Date.now() - t0)} · running total: ${fmtNum(payload.stats.totalMoved)}`);

    return {
      payload, log, done: false,
      moved: total,
      msg: `+${fmtNum(total)} [${lbl}] · ${fmtNum(payload.stats.totalMoved)} total`
    };

  } catch (e) {
    // FIX 25 (BUG-H12): Push error into stats so maybeSendRunEmail sees it
    // for ERRORS_ONLY mode, and so the email error table is populated.
    // Without this, live-run errors never appeared in stats.errors and a
    // clean "success" summary email could fire after a broken run.
    // FIX 38 (BUG-C15): lbl is safe to read here now — see the declaration
    // above the try block for why the old inline `const lbl` was not.
    payload.stats = payload.stats || {};
    payload.stats.errors = payload.stats.errors || [];
    // FIX 47 (BUG-C24): normalize a non-Error thrown value the same way
    // sendErrorEmail() now does below, so stats.errors[] never stores a
    // literal `undefined` for the error text (which would otherwise print
    // as the string "undefined" in every downstream email/digest that lists
    // stats.errors — misleading but not itself a crash, unlike the
    // sendErrorEmail() call just below this line before FIX 47).
    // FIX 49 (BUG-C25): compute errMsg ONCE here and reuse it below. FIX 47
    // only normalized the copy pushed into stats.errors[] — the `log` entry
    // and the `msg` field returned to the client two lines below still read
    // `e.message` raw. For a non-Error throw with no `.message` property
    // (e.g. `throw {code:500}`) that silently rendered the literal text
    // "undefined" in the terminal's ERROR line and the halted-run banner
    // (index.html: `banner('err', 'Engine halted: ' + res.msg)`), instead of
    // whatever was actually thrown — the exact "prints as the string
    // undefined" failure BUG-C24's own writeup already called out, just in
    // two spots that fix didn't reach. Worse, for `throw null` or `throw
    // undefined` specifically, `e.message` throws its own TypeError —
    // uncaught, escaping this catch block entirely — the same crash shape
    // as BUG-C15/BUG-C24, just one line further down. See BUG-C25 in
    // GitHub Issues for the full reproduction.
    const errMsg = (e && e.message) ? e.message : String(e);
    payload.stats.errors.push({ label: lbl, error: errMsg });
    // FIX 39 (BUG-E13): Pass dry through so sendErrorEmail can report
    // projected dry-run counts instead of a misleading 0/0 — the same swap
    // BUG-E9 already applied to the abort email, missed here until now.
    // FIX 46 (BUG-E16): Pass the already-computed `lbl` through explicitly —
    // see the comment on sendErrorEmail()'s signature below for why.
    sendErrorEmail(e, payload, 'live', dry, lbl);
    return {
      payload,
      log: [...log, { t: Date.now() - t0, level: 'ERROR', msg: errMsg }],
      error: true,
      msg: 'Engine error: ' + errMsg
    };
  }
}

// ─── ABORT ────────────────────────────────────────────────────────────────────
// runId (optional, 2026-09-24): the registered run being aborted. With it,
// the abort waits for any in-flight burst (script lock), uses whichever stats
// are more complete — the caller's, or the server's own record, which
// includes a burst that finished after the caller stopped listening — then
// marks the run aborted for every watching dashboard. A run that was already
// finalized (e.g. aborted from two devices at once) is not emailed or
// accumulated twice. Without runId: unchanged original behavior.
function abortRun(stats, elapsedMs, dryRun, runId) {
  if (!runId) return abortRunCore(stats, elapsedMs, dryRun);
  const finish = () => {
    const s = readRunState();
    const mine = !!s && s.id === runId;
    if (mine && s.status !== 'running') return getProps().getProperty('LAST_RUN_TIME');
    const detail  = cacheGetJson(RUN_DETAIL_PREFIX + runId);
    const best    = fullerStats(stats, detail && detail.stats);
    const elapsed = mine ? Date.now() - (s.startedAt || Date.now()) : elapsedMs;
    const dry     = mine ? !!s.dryRun : !!dryRun;
    const ts = abortRunCore(best, elapsed, dry);
    endRun(runId, 'aborted', `⚠ Aborted after ${((elapsed || 0) / 1000).toFixed(1)}s · ${fmtNum(best.totalMoved || 0)} ${dry ? 'scanned (dry run)' : 'actioned'}`, best);
    return ts;
  };
  const r = withRunLock(60000, finish);
  return r.ok ? r.value : finish();
}

// Picks the stats object that has seen more of the run.
function fullerStats(a, b) {
  if (!a) return b || {};
  if (!b) return a;
  return (b.totalMoved || 0) > (a.totalMoved || 0) ? b : a;
}

// FIX 11: accepts dryRun flag so abort email shows projected counts, not 0/0.
function abortRunCore(stats, elapsedMs, dryRun) {
  const props = getProps();
  const ts    = new Date().toLocaleString();
  const freq  = props.getProperty('SUMMARY_FREQ') || 'EACH_RUN';
  props.setProperty('LAST_RUN_TIME', ts + ' (aborted)');

  // FIX 41 (BUG-C17): A live run that gets aborted mid-way has already taken
  // real Gmail actions — whatever completed in the bursts before the user
  // clicked Abort. Those actions were never rolled into DAILY_STATS, because
  // only finalizeAndEmail() (the normal-completion path) ever called
  // accumulateDailyStats() — abortRun() is a separate path and was simply
  // missing the same call. Net effect: mail that was genuinely trashed or
  // archived before an abort would vanish from the mailbox but never appear
  // in any DAILY/WEEKLY/etc. digest total, silently under-reporting real
  // activity. Dry-run aborts correctly skip this — nothing real happened,
  // same rule FIX 10 already established for the normal dry-run path.
  if (!dryRun) accumulateDailyStats(stats || {});

  if (freq !== 'NEVER') {
    const secs    = ((elapsedMs || 0) / 1000).toFixed(1);
    const trashed  = dryRun ? (stats?.dryTrashed  || 0) : (stats?.totalTrashed  || 0);
    const archived = dryRun ? (stats?.dryArchived || 0) : (stats?.totalArchived || 0);
    const lines = [
      `⚠ RUN ABORTED BY USER${dryRun ? ' [DRY RUN]' : ''}`, '',
      `Duration  : ${secs}s`,
      `Actioned  : ${fmtNum(stats?.totalMoved  || 0)}`,
      `  Trashed : ${fmtNum(trashed)}`,
      `  Archived: ${fmtNum(archived)}`
    ];
    // FIX 20 (BUG-E5): Dry-run aborts no longer say "actioned" — nothing was deleted.
    const subj = dryRun
      ? `⚠ AutoTrash: Dry run aborted after ${secs}s — ~${fmtNum(stats?.totalMoved || 0)} scanned (no mail deleted)`
      : `⚠ AutoTrash: Aborted after ${secs}s (${fmtNum(stats?.totalMoved || 0)} actioned)`;
    // FIX 28 (BUG-E9): Feed the swapped counts to the HTML builder too.
    // Previously only lines[] used the dry counts, so the stat boxes labelled
    // "Would Trash"/"Would Archive" read 0 while the text directly below them
    // showed the real projected numbers — the email contradicted itself.
    const emailStats = dryRun
      ? { ...(stats || {}), totalTrashed: trashed, totalArchived: archived }
      : (stats || {});
    sendReportEmail(subj, 'RUN ABORTED', lines, '#ffbb44', emailStats, elapsedMs, dryRun);
  }
  return ts;
}

// ─── BACKGROUND RUN ───────────────────────────────────────────────────────────
// FIX 5: ScriptLock prevents two concurrent 1-min trigger executions from
// racing to process the same emails at the same time.
// FIX 9: queue emptiness check is now BEFORE lock acquisition. The old code
// checked inside the try block and returned without reaching finally{}, leaking
// the lock for the full 10-min Apps Script timeout and blocking all later triggers.
function backgroundRun() {
  // Check for work before acquiring the lock — avoids holding it needlessly.
  const props = getProps();
  // FIX 42 (BUG-C18): parseStoredRules() (Config.gs) parses
  // AUTOTRASH_RULES/CATEGORY_RULES defensively — a corrupted value falls back
  // to an empty list rather than throwing OUTSIDE every try/catch that leads
  // to sendErrorEmail(), which would otherwise fail every single trigger
  // firing with no owner-visible warning at all. Previously this was its own
  // inline try/catch pair, duplicated from getUISettings()'s identical one
  // (now also Config.gs's readConfig()); both now share one implementation.
  const stored = parseStoredRules();
  const rules = stored.rules, categoryRules = stored.categoryRules;
  const globalDays    = props.getProperty('GLOBAL_PURGE_DAYS') || 'OFF';
  const inboxDays     = props.getProperty('INBOX_PURGE_DAYS')  || 'OFF';

  const q = buildQueue(rules, globalDays, inboxDays, categoryRules);
  if (!q.length) return; // FIX 9: nothing to do — exit before touching the lock

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
  } catch (e) {
    console.log('backgroundRun: skipped — another instance is running.');
    return;
  }

  try {
    // Cross-device coordination (2026-09-24, Issue #82): a manual run that
    // is actively bursting from some tab/device owns the mailbox for now.
    // Live bursts hold this same script lock only WHILE a burst executes, so
    // a trigger can land between two bursts — without this check it would
    // then process the same rules interleaved with the live run.
    const cur = readRunState();
    if (isRunActive(cur) && cur.source === 'live') {
      console.log('backgroundRun: skipped — a manual run is in progress.');
      return;
    }

    const start = Date.now();

    const stats = {
      totalMoved: 0, totalTrashed: 0, totalArchived: 0,
      globalPurgeMoved: 0, globalPurgeTrashed: 0,
      inboxPurgeMoved: 0,  inboxPurgeTrashed: 0,
      labels: {}, errors: []
    };

    // Register this execution in the shared run registry (RunState.gs) so
    // every open dashboard shows it live and can abort it (Issue #79). The
    // engine's log lines, previously discarded on this path, are collected
    // for those dashboards; nothing else about the run changes.
    const run = beginRun({
      source: 'background', dryRun: false,
      rule: safeRuleLabel(q[0]), left: q.length, stats: stats,
      queue: q.map(safeRuleLabel),
      log: [{ level: 'INFO', msg: `START · ${q.length} rule(s) · BACKGROUND (trigger)` }]
    });
    const pending = [];
    const emit = (lvl, msg) => pending.push({ ts: Date.now(), level: lvl, msg: msg });
    let aborted = false;

    // FIX 2: per-run Set so rules don't re-process each other's threads.
    const seenIds = new Set();

    // q was built before the lock; use it directly (shallow copy to allow mutation)
    let workQueue = q.map(r => ({...r}));

    while (workQueue.length > 0 && Date.now() - start < BG_BUDGET_MS) {
      // Abort requested from a dashboard (any device) — stop before the
      // next rule. The in-flight rule, if any, already completed.
      if (abortRequestedFor(run.id)) { aborted = true; break; }
      const rule = workQueue[0];
      // FIX 17 (BUG-C8): Use toUpperCase() fallback so old configs without a
      // label field don't produce lowercase keys in daily stats, which would
      // make category totals invisible in the digest per-rule table.
      const lbl  = ruleLabel(rule);
      try {
        // Engine (Engine.gs): search → dedup → act. FIX 15 (BUG-C3): the
        // engine registers thread IDs in seenIds BEFORE the Gmail call, so if
        // it throws mid-batch (e.g. quota error), threads already processed in
        // earlier chunks won't be re-actioned by later rules in the same run.
        const m = runRule(rule, { seen: seenIds, emit: emit });

        if (m.matched === 0) {
          emit('COMPLETE', `[${lbl}] clean — ejected from queue.`);
          workQueue.shift();
          continue;
        }

        const trashed  = m.action === 'trash'   ? m.execution.count : 0;
        const archived = m.action === 'archive' ? m.execution.count : 0;

        stats.totalMoved    += trashed + archived;
        stats.totalTrashed  += trashed;
        stats.totalArchived += archived;
        creditStat(stats, lbl, rule, trashed, archived);

        workQueue.push(workQueue.shift());
      } catch (e) {
        // FIX 47 (BUG-C24): same normalization as processLiveBurst's catch
        // block above — see that comment for the full story.
        stats.errors.push({ label: lbl, error: (e && e.message) ? e.message : String(e) });
        // FIX 23 (BUG-E4): Pass 'background' so the error email footer says
        // "trigger will retry" instead of "re-run when ready".
        // FIX 46 (BUG-E16): Pass the already-computed `lbl` through explicitly
        // (background never dry-runs, so the 4th arg stays undefined/falsy —
        // unchanged from before this fix).
        sendErrorEmail(e, { activeQueue: workQueue, stats }, 'background', undefined, lbl);
        emit('ERROR', `[${lbl}] ${(e && e.message) ? e.message : String(e)}`);
        workQueue.shift();
      } finally {
        // Runs on every path out of the iteration, including `continue`.
        recordRunProgress(run.id, {
          log: pending.splice(0), stats: stats,
          rule: workQueue.length ? safeRuleLabel(workQueue[0]) : null,
          left: workQueue.length
        });
      }
    }

    const elapsed = Date.now() - start;
    accumulateDailyStats(stats);
    maybeSendRunEmail(stats, elapsed, aborted ? 'Background Run (aborted)' : 'Background Run');
    // FIX 18 (BUG-C9): Write LAST_RUN_TIME here — maybeSendRunEmail no longer owns it.
    getProps().setProperty('LAST_RUN_TIME', new Date().toLocaleString() + (aborted ? ' (aborted)' : ''));
    const secs = (elapsed / 1000).toFixed(1);
    endRun(run.id, aborted ? 'aborted' : 'done',
      aborted
        ? `⚠ Background run aborted after ${secs}s · ${fmtNum(stats.totalMoved)} actioned`
        : `✓ Background run finished · ${fmtNum(stats.totalMoved)} actioned · ${fmtNum(stats.totalTrashed)} trashed · ${fmtNum(stats.totalArchived)} archived · ${secs}s` +
          (workQueue.length ? ` · ${workQueue.length} rule(s) continue next trigger` : ''),
      stats);

  } finally {
    lock.releaseLock();
  }
}

// ─── FINALIZE (called by frontend after live run ends) ────────────────────────
// FIX 6:  dryRun flag swaps in dryTrashed/dryArchived for the summary email.
// FIX 10: accumulateDailyStats always receives the REAL stats object. Dry runs
//         never actually moved anything, so they must not inflate daily totals.
function finalizeAndEmail(stats, elapsedMs, status, dryRun) {
  // Always accumulate the real (unswapped) stats so daily totals stay accurate.
  if (!dryRun) accumulateDailyStats(stats);

  // For the email, swap in projected trash/archive counts when dry running.
  const emailStats = dryRun
    ? { ...stats, totalTrashed: stats.dryTrashed || 0, totalArchived: stats.dryArchived || 0 }
    : stats;
  maybeSendRunEmail(emailStats, elapsedMs, status, dryRun);

  // FIX 18 (BUG-C9): LAST_RUN_TIME written here only (not also in maybeSendRunEmail).
  const ts = new Date().toLocaleString();
  getProps().setProperty('LAST_RUN_TIME', ts);
  return ts;
}

