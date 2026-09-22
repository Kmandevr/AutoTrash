/**
 * AutoTrash — the two execution paths: processLiveBurst() (one rule per
 * call, driven by the open tab) and backgroundRun() (whole queue inside a
 * 55s budget, trigger-driven), plus abort/finalize/daily-stats bookkeeping.
 * Split out of Code.gs on 2026-09-22; see CLAUDE.md for the full file map.
 */

// ─── LIVE ENGINE (client-driven bursts) ──────────────────────────────────────
function processLiveBurst(payload) {
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

    lbl = rule.label
      || (rule.isCategory ? rule.category.toUpperCase() : '?');

    // FIX 1+3: action from rule only, no cross-queue override.
    const action = resolveRuleAction(rule);

    const q = buildQuery(rule);
    emit('SEARCH', `${dry ? '[DRY] ' : ''}[${lbl}] ${q} → ${action.toUpperCase()}`);

    const st         = Date.now();
    const allThreads = GmailApp.search(q, 0, GMAIL_SEARCH);
    emit('RESULT', `${fmtNum(allThreads.length)} found · ${fmtMs(Date.now() - st)}`,
      { count: allThreads.length });

    // FIX 2: seenIds dedup — skip threads processed by an earlier rule this run.
    if (!payload.seenIds) payload.seenIds = [];
    const seenSet = new Set(payload.seenIds);
    const threads  = allThreads.filter(t => !seenSet.has(t.getId()));

    if (allThreads.length > 0 && threads.length < allThreads.length) {
      emit('INFO', `Skipped ${fmtNum(allThreads.length - threads.length)} already-processed this run.`);
    }

    if (threads.length === 0) {
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
      const wouldTrash   = action === 'trash'   ? threads.length : 0;
      const wouldArchive = action === 'archive' ? threads.length : 0;
      emit('DRYRUN', `[${lbl}] Would ${action.toUpperCase()} ${fmtNum(threads.length)}`);
      emit('DRYRUN', `  → ${fmtNum(wouldTrash)} trash · ${fmtNum(wouldArchive)} archive`);

      payload.stats.totalMoved  = (payload.stats.totalMoved  || 0) + threads.length;
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
        payload.stats.labels[lbl].moved    += threads.length;
        payload.stats.labels[lbl].trashed  += wouldTrash;
        payload.stats.labels[lbl].archived += wouldArchive;
        payload.stats.labels[lbl].finished  = true;
      }

      threads.forEach(t => payload.seenIds.push(t.getId()));
      payload.activeQueue.shift();

      return {
        payload, log, ejected: true,
        done: payload.activeQueue.length === 0,
        moved: threads.length,
        msg: `[DRY] ${lbl}: ${fmtNum(threads.length)} · ${payload.activeQueue.length} remain.`
      };
    }

    // ── EXECUTE (live) ────────────────────────────────────────────────────
    const toTrash   = action === 'trash'   ? threads : [];
    const toArchive = action === 'archive' ? threads : [];

    if (toTrash.length)   emit('ACTION', `TRASHING ${fmtNum(toTrash.length)}…`);
    if (toArchive.length) emit('ACTION', `ARCHIVING ${fmtNum(toArchive.length)}…`);

    const { trashed, archived, batchMs } = executeActions(toTrash, toArchive, emit);
    const total = trashed + archived;
    const tps   = Math.round(total / ((batchMs || 1) / 1000));

    threads.forEach(t => payload.seenIds.push(t.getId()));

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
// FIX 11: accepts dryRun flag so abort email shows projected counts, not 0/0.
function abortRun(stats, elapsedMs, dryRun) {
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
    safeMail(ownerEmail(), subj,
      buildEmailHtml('RUN ABORTED', lines, '#ffbb44', emailStats, elapsedMs, dryRun),
      plainBody(lines, emailStats));
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
  // FIX 42 (BUG-C18): Parse AUTOTRASH_RULES/CATEGORY_RULES defensively.
  // accumulateDailyStats() and sendDailyDigest() already guarded their own
  // JSON.parse calls (DAILY_STATS) against corruption with a try/catch: this
  // pair never got the same treatment. A single malformed value in either
  // property (hand-edited via the Apps Script property editor, a partial
  // write cut off mid-save, etc.) would throw here, OUTSIDE every try/catch
  // that leads to sendErrorEmail() — so backgroundRun() would fail on every
  // single trigger firing with no owner-visible warning at all (Apps Script
  // only logs an internal execution failure), silently ending all background
  // automation. Falling back to an empty list is the same safe default the
  // UI already applies via `|| '[]'` when the property has never been set.
  let rules, categoryRules;
  try { rules = JSON.parse(props.getProperty('AUTOTRASH_RULES') || '[]'); }
  catch (e) { rules = []; }
  try { categoryRules = JSON.parse(props.getProperty('CATEGORY_RULES') || '[]'); }
  catch (e) { categoryRules = []; }
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
    const start = Date.now();

    const stats = {
      totalMoved: 0, totalTrashed: 0, totalArchived: 0,
      globalPurgeMoved: 0, globalPurgeTrashed: 0,
      inboxPurgeMoved: 0,  inboxPurgeTrashed: 0,
      labels: {}, errors: []
    };

    // FIX 2: per-run Set so rules don't re-process each other's threads.
    const seenIds = new Set();

    // q was built before the lock; use it directly (shallow copy to allow mutation)
    let workQueue = q.map(r => ({...r}));

    while (workQueue.length > 0 && Date.now() - start < BG_BUDGET_MS) {
      const rule = workQueue[0];
      // FIX 17 (BUG-C8): Use toUpperCase() fallback so old configs without a
      // label field don't produce lowercase keys in daily stats, which would
      // make category totals invisible in the digest per-rule table.
      const lbl  = rule.label || (rule.isCategory ? rule.category.toUpperCase() : '?');
      try {
        const allThreads = GmailApp.search(buildQuery(rule), 0, GMAIL_SEARCH);
        const threads    = allThreads.filter(t => !seenIds.has(t.getId()));

        if (threads.length === 0) { workQueue.shift(); continue; }

        const action    = resolveRuleAction(rule);
        const toTrash   = action === 'trash'   ? threads : [];
        const toArchive = action === 'archive' ? threads : [];

        // FIX 15 (BUG-C3): Register thread IDs BEFORE executing actions.
        // If executeActions() throws mid-batch (e.g. quota error), threads
        // already processed in earlier chunks are in seenIds and won't be
        // re-actioned by later rules in the same run.
        threads.forEach(t => seenIds.add(t.getId()));

        const { trashed, archived } = executeActions(toTrash, toArchive, null);

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
        workQueue.shift();
      }
    }

    accumulateDailyStats(stats);
    maybeSendRunEmail(stats, Date.now() - start, 'Background Run');
    // FIX 18 (BUG-C9): Write LAST_RUN_TIME here — maybeSendRunEmail no longer owns it.
    getProps().setProperty('LAST_RUN_TIME', new Date().toLocaleString());

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

// ─── DAILY STATS ACCUMULATION ─────────────────────────────────────────────────
function accumulateDailyStats(stats) {
  const props = getProps();
  const today = new Date().toISOString().slice(0, 10);
  let d;
  try { d = JSON.parse(props.getProperty('DAILY_STATS') || '{}'); } catch (e) { d = {}; }
  // FIX 37 (BUG-C13): Do NOT reset on a calendar-day boundary. sendDailyDigest()
  // owns the reset and performs it after a successful send, which is what makes
  // ALT_DAYS / WEEKLY / BIWEEKLY periods possible. Resetting here meant a 7-day
  // digest silently reported one day of numbers and discarded the other six.
  // Only initialise when the stored object is empty or malformed.
  if (!d.date) {
    d = { date: today, totalMoved: 0, totalTrashed: 0, totalArchived: 0,
          globalPurgeMoved: 0, globalPurgeTrashed: 0,
          inboxPurgeMoved: 0,  inboxPurgeTrashed: 0,
          labels: {}, runs: 0 };
  }
  d.date = today;  // last-updated marker; the PERIOD reset lives in sendDailyDigest
  d.runs++;
  d.totalMoved    += stats.totalMoved    || 0;
  d.totalTrashed  += stats.totalTrashed  || 0;
  d.totalArchived += stats.totalArchived || 0;
  d.globalPurgeMoved    += (stats.globalPurgeMoved    || 0);
  // FIX 19 (BUG-C10): Also accumulate the trashed sub-counts for purge rules.
  // Previously only "moved" totals were stored; the trashed split was lost.
  d.globalPurgeTrashed  += (stats.globalPurgeTrashed  || 0);
  d.inboxPurgeMoved     += (stats.inboxPurgeMoved     || 0);
  d.inboxPurgeTrashed   += (stats.inboxPurgeTrashed   || 0);
  for (const [k, v] of Object.entries(stats.labels || {})) {
    if (!d.labels[k]) d.labels[k] = { moved: 0, trashed: 0, archived: 0 };
    d.labels[k].moved    += v.moved    || 0;
    d.labels[k].trashed  += v.trashed  || 0;
    d.labels[k].archived += v.archived || 0;
  }
  props.setProperty('DAILY_STATS', JSON.stringify(d));
}

