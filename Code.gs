/**
 * ████████████████████████████████████████████████████████████████
 * AUTOTRASH v26 — Gmail cleanup engine (Apps Script backend)
 * ████████████████████████████████████████████████████████████████
 *
 * Served to the browser by doGet() → index.html. Two execution paths:
 *   • processLiveBurst() — one rule per call, driven by the open tab.
 *   • backgroundRun()    — whole queue inside a 55s budget, trigger-driven.
 *
 * DOCUMENTATION MAP
 * ─────────────────
 * The 35-entry fix log that used to sit here has moved, so there is exactly
 * one canonical copy of that history instead of two that drift apart:
 *
 *   AUTOTRASH_FEATURE_REFERENCE.txt  How every feature is MEANT to behave.
 *                                    Read before changing anything.
 *   AUTOTRASH_BUG_PLAN.txt           Every fix with its root cause. The
 *                                    inline "FIX n (BUG-XX)" comments below
 *                                    resolve to BUG-XX entries in that file.
 *   AUTOTRASH_SUGGESTIONS.txt        Proposed work, plus what has shipped.
 *                                    "FIX n (S-XX)" comments resolve there.
 *
 * Inline comments are deliberately kept wherever the code is non-obvious, or
 * where an innocent-looking "simplification" would reintroduce a data-loss
 * bug. FIX 1 (inbox scoping), FIX 15 (seenIds ordering) and FIX 31 (no
 * animation-fill-mode) are the three most likely to be undone by accident.
 */

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const GMAIL_CHUNK  = 100;    // Hard Gmail API limit per batch call
const GMAIL_SEARCH = 500;    // Max results per GmailApp.search
const BG_BUDGET_MS = 55000;  // 55 s budget per background execution

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function fmtNum(n) { return (n||0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function fmtMs(ms) { return ms < 1000 ? ms + 'ms' : (ms/1000).toFixed(1) + 's'; }
function safeMail(to, subj, html, plain) {
  // FIX 48 (BUG-C25): guard e.message the same way the rest of the error-
  // reporting path now does (see sendErrorEmail() below) — if GmailApp ever
  // threw something other than a real Error (in principle possible; nothing
  // in JS enforces it), reading .message off it here would be safe only if
  // e itself is non-null. This is the last line of defense for every email
  // this project sends, so it gets the same defensive treatment.
  try { GmailApp.sendEmail(to, subj, plain || subj, { htmlBody: html }); }
  catch (e) { console.error('safeMail failed:', (e && e.message) ? e.message : String(e)); }
}
function ownerEmail() { return Session.getEffectiveUser().getEmail(); }
function getProps()   { return PropertiesService.getUserProperties(); }

// FIX 26 (BUG-E7): Resolve the deployed web app URL for the email link.
// getService().getUrl() only returns a usable /exec address when the script is
// published as a web app; it can return null or throw otherwise, so callers
// receive '' and simply omit the button rather than emitting a dead link.
// No extra OAuth scope needed — ScriptApp is already used for trigger management.
function getAppUrl() {
  try { return ScriptApp.getService().getUrl() || ''; }
  catch (e) { return ''; }
}

// ─── QUERY BUILDER ────────────────────────────────────────────────────────────
// FIX 1: ALL label and category rules use 'in:inbox' regardless of action.
// FIX 4: Spam is not a Gmail category tab → use 'in:spam' instead.
function buildQuery(rule) {
  const star     = '-is:starred';
  const notTrash = '-in:trash';

  if (rule.isGlobalPurge) {
    // FIX 7: Use All Mail scope (no inbox restriction) to reach archived mail.
    return `older_than:${rule.days}d ${star} -in:trash -in:spam`;
  }
  if (rule.isInboxPurge) {
    // FIX 13 (BUG-C4): Removed redundant -in:trash — in:inbox already excludes trash.
    return `in:inbox older_than:${rule.days}d ${star}`;
  }
  if (rule.isCategory) {
    if (rule.category === 'spam') {
      // FIX 4: spam lives in in:spam, not a Gmail category tab.
      return `in:spam older_than:${rule.days}d ${star} -in:trash`;
    }
    // FIX 1: in:inbox scope so archived threads stay archived.
    return `category:${rule.category} in:inbox older_than:${rule.days}d ${star} ${notTrash}`;
  }
  // Label rule — FIX 1: in:inbox keeps archive/trash actions permanent.
  // FIX 45 (BUG-C20): strip any literal " from the label before embedding it
  // in the quoted search term. Gmail search has no escape mechanism for a
  // quote character inside a quoted phrase — an embedded " would prematurely
  // close the phrase (e.g. label:"Foo"Bar" is parsed as label:"Foo" plus a
  // stray bareword term "Bar"), silently widening the match beyond the label
  // the user actually configured. Only the search term is affected — the
  // stored/displayed label text (index.html's rule list, the email table)
  // is completely untouched by this; escHtml() there is a separate concern.
  const safeLabel = String(rule.label).replace(/"/g, '');
  return `label:"${safeLabel}" in:inbox older_than:${rule.days}d ${star} ${notTrash}`;
}

// ─── RESOLVE ACTION ───────────────────────────────────────────────────────────
// FIX 8: only archive when isTrash is EXPLICITLY false.
// isTrash === true  → trash
// isTrash === false → archive  (user explicitly chose archive)
// isTrash undefined/null → trash (safer default; guards stale/migrated rules)
function resolveRuleAction(rule) {
  if (rule.isGlobalPurge || rule.isInboxPurge) return 'trash';
  return rule.isTrash === false ? 'archive' : 'trash';
}

// ─── QUEUE BUILDER ────────────────────────────────────────────────────────────
function buildQueue(rules, globalDays, inboxDays, categoryRules) {
  const q = (rules || []).map(r => ({ ...r }));
  (categoryRules || []).filter(r => r.enabled).forEach(r =>
    q.push({ ...r, isCategory: true })
  );
  if (inboxDays  !== 'OFF') q.push({ isInboxPurge: true,  isTrash: true, days: +inboxDays,  label: 'INBOX PURGE'  });
  if (globalDays !== 'OFF') q.push({ isGlobalPurge: true, isTrash: true, days: +globalDays, label: 'GLOBAL PURGE' });  // BUG-R5: matches the email
  return q;
}

// ─── ACTION EXECUTOR ─────────────────────────────────────────────────────────
function executeActions(toTrash, toArchive, emit) {
  let trashed = 0, archived = 0, batchMs = 0;

  // FIX 34 (S-U1): Chunks are no longer logged individually. A 500-thread rule
  // used to emit 5 near-identical BATCH lines per burst; now each action type
  // emits a single summary. Per-chunk timing still accumulates into batchMs,
  // so the DONE line and the /sec figure are unchanged.
  for (const chunk of chunkArray(toTrash, GMAIL_CHUNK)) {
    const t = Date.now();
    GmailApp.moveThreadsToTrash(chunk);
    batchMs += Date.now() - t; trashed += chunk.length;
  }
  if (emit && trashed) emit('BATCH', `Trash ×${fmtNum(trashed)} · ${fmtMs(batchMs)}`);

  const archFrom = batchMs; // split point so archive timing is reported alone
  for (const chunk of chunkArray(toArchive, GMAIL_CHUNK)) {
    const t = Date.now();
    GmailApp.moveThreadsToArchive(chunk);
    batchMs += Date.now() - t; archived += chunk.length;
  }
  if (emit && archived) emit('BATCH', `Archive ×${fmtNum(archived)} · ${fmtMs(batchMs - archFrom)}`);

  return { trashed, archived, batchMs };
}

// ─── STAT HELPERS ────────────────────────────────────────────────────────────
function ensureStat(stats, lbl) {
  if (!stats.labels[lbl])
    stats.labels[lbl] = { moved: 0, trashed: 0, archived: 0, finished: false };
}

function creditStat(stats, lbl, rule, trashed, archived) {
  if (rule.isGlobalPurge) {
    stats.globalPurgeMoved   = (stats.globalPurgeMoved   || 0) + trashed + archived;
    stats.globalPurgeTrashed = (stats.globalPurgeTrashed || 0) + trashed;
    return;
  }
  if (rule.isInboxPurge) {
    stats.inboxPurgeMoved   = (stats.inboxPurgeMoved   || 0) + trashed + archived;
    stats.inboxPurgeTrashed = (stats.inboxPurgeTrashed || 0) + trashed;
    return;
  }
  ensureStat(stats, lbl);
  stats.labels[lbl].moved    += trashed + archived;
  stats.labels[lbl].trashed  += trashed;
  stats.labels[lbl].archived += archived;
}

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
  // reproduction before patching; see AUTOTRASH_BUG_PLAN.txt.
  let lbl = 'unknown';
  let dry = false;

  try {
    // FIX 40 (BUG-C16): Build the queue server-side when the caller hasn't
    // supplied one. AUTOTRASH_FEATURE_REFERENCE.txt §11 documents
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
    // AUTOTRASH_BUG_PLAN.txt for the full reproduction.
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

function maybeSendRunEmail(stats, elapsedMs, status, dryRun) {
  const props     = getProps();
  const freq      = props.getProperty('SUMMARY_FREQ') || 'EACH_RUN';
  const hasErrors = (stats.errors || []).length > 0;
  // FIX 18 (BUG-C9): LAST_RUN_TIME is now written by finalizeAndEmail() for live
  // runs and by backgroundRun() directly, so we don't write it here a second time.
  if (hasErrors && freq !== 'NEVER') {
    sendRunEmail(stats, elapsedMs, status + ' (with errors)', '#ff4455', dryRun);
    return;
  }
  if (freq === 'EACH_RUN') sendRunEmail(stats, elapsedMs, status, '#00ff88', dryRun);
}

function sendRunEmail(stats, elapsedMs, status, accent, dryRun) {
  const secs  = ((elapsedMs || 0) / 1000).toFixed(1);
  const lines = [
    `${dryRun ? '[DRY RUN] ' : ''}✓ ${status}`,
    `  Duration : ${secs}s`,
    `  Total    : ${fmtNum(stats.totalMoved)}`,
    `  Trashed  : ${fmtNum(stats.totalTrashed  || 0)}`,
    `  Archived : ${fmtNum(stats.totalArchived || 0)}`,
    ...(stats.inboxPurgeMoved  > 0 ? [`  Inbox Purge  : ${fmtNum(stats.inboxPurgeMoved)}`]  : []),
    ...(stats.globalPurgeMoved > 0 ? [`  Global Purge : ${fmtNum(stats.globalPurgeMoved)}`] : []),
    ...((stats.errors || []).length > 0
      ? ['', 'ERRORS:', ...stats.errors.map(e => `  [${e.label}] ${e.error}`)]
      : [])
  ];

  // FIX 20 (BUG-E1): Dry-run subject no longer says "actioned" — nothing was deleted.
  // FIX 24 (BUG-E6): When 0 threads moved and errors present, lead with the error.
  let subj;
  if (dryRun) {
    subj = `[DRY RUN] AutoTrash: ~${fmtNum(stats.totalMoved)} would be actioned — ${secs}s`;
  } else if ((stats.errors || []).length && !stats.totalMoved) {
    const firstErr = stats.errors[0];
    subj = `⚠ AutoTrash: Error in ${firstErr.label} — no mail processed`;
  } else if ((stats.errors || []).length) {
    subj = `⚠ AutoTrash: ${fmtNum(stats.totalMoved)} actioned (errors) — ${secs}s`;
  } else {
    subj = `✓ AutoTrash: ${fmtNum(stats.totalMoved)} actioned — ${secs}s`;
  }

  safeMail(ownerEmail(), subj,
    buildEmailHtml(status.toUpperCase(), lines, accent, stats, elapsedMs, dryRun),
    plainBody(lines, stats));
}

function sendDailyDigest() {
  const props      = getProps();
  const freq       = props.getProperty('SUMMARY_FREQ') || 'EACH_RUN';
  if (!['DAILY', 'ALT_DAYS', 'WEEKLY', 'BIWEEKLY'].includes(freq)) return;
  const lastDigest = props.getProperty('LAST_DIGEST_DATE') || '';
  const today      = new Date().toISOString().slice(0, 10);
  const daysSince  = Math.floor((new Date() - new Date(lastDigest || 0)) / 864e5);
  const should = freq === 'DAILY' ? true
    : freq === 'ALT_DAYS' ? daysSince >= 2
    : freq === 'WEEKLY'   ? daysSince >= 7
    : daysSince >= 14;
  if (!should) return;
  let d; try { d = JSON.parse(props.getProperty('DAILY_STATS') || '{}'); } catch (e) { d = {}; }
  // FIX 16 (BUG-C6): Always update LAST_DIGEST_DATE, even when d.runs===0.
  // Previously the date was only set after a successful send, so a no-run day
  // would re-check every single day and waste trigger quota.
  props.setProperty('LAST_DIGEST_DATE', today);
  if (!d.runs) return;
  const pLabel = { DAILY: 'Daily', ALT_DAYS: 'Bi-Daily', WEEKLY: 'Weekly', BIWEEKLY: 'Bi-Weekly' }[freq];
  const lines = [
    `✓ ${pLabel} Digest`, `  Period  : ${lastDigest || 'start'} → ${today}`,
    `  Runs    : ${d.runs}`, `  Total   : ${fmtNum(d.totalMoved)}`,
    `  Trashed : ${fmtNum(d.totalTrashed || 0)}`, `  Archived: ${fmtNum(d.totalArchived || 0)}`
  ];
  // FIX 22 (BUG-E3): Append per-rule breakdown to plain-text lines.
  // Previously only the HTML version had this table; plain-text readers saw only totals.
  for (const [k, v] of Object.entries(d.labels || {})) {
    if ((v.moved || 0) > 0)
      lines.push(`    ${k}: ${fmtNum(v.moved)} (▓${fmtNum(v.trashed || 0)} ░${fmtNum(v.archived || 0)})`);
  }
  safeMail(ownerEmail(),
    `✓ AutoTrash ${pLabel} Digest: ${fmtNum(d.totalMoved)} actioned`,
    buildEmailHtml(`${pLabel.toUpperCase()} DIGEST`, lines, '#00ff88', d, null),
    plainBody(lines, d));
  props.setProperty('DAILY_STATS', JSON.stringify({
    date: today, totalMoved: 0, totalTrashed: 0, totalArchived: 0,
    globalPurgeMoved: 0, globalPurgeTrashed: 0,
    inboxPurgeMoved: 0, inboxPurgeTrashed: 0,
    labels: {}, runs: 0
  }));
}

// ─── ERROR EMAIL ──────────────────────────────────────────────────────────────
// FIX 23 (BUG-E4): Accepts source ('live' | 'background') so the footer can
// give correct guidance. Background runs auto-retry; live runs need user action.
// FIX 39 (BUG-E13): Accepts dryRun so a live-run error mid-dry-scan reports
// its projected trash/archive counts instead of a hardcoded 0/0. Background
// runs never dry-run, so callers there simply omit the 4th argument.
// FIX 46 (BUG-E16): Accepts an explicit 5th `ruleLabel` argument now, used in
// preference to re-deriving one from payload.activeQueue[0].label. Both
// call sites (processLiveBurst's and backgroundRun's catch blocks) already
// compute a correct `lbl` locally BEFORE calling this — including the
// isCategory fallback (`rule.category.toUpperCase()`) for a category rule
// that has no `.label` field of its own. This function used to ignore that
// and recompute its own `lbl` from `payload.activeQueue[0].label` alone,
// with no such fallback — so a category rule missing a `.label` field (a
// hand-edited CATEGORY_RULES property, or any caller that doesn't go
// through index.html's getCatState(), which always sets one) would push the
// CORRECT label (e.g. "PROMOTIONS") into stats.errors[], while this same
// function's own "Rule:" line in the very same error email printed
// "unknown" — two different rule names in one report about one error.
// Reproduced directly before fixing: a category rule
// `{isCategory:true, category:'promotions', days:30}` (no `.label`) that
// throws during search left stats.errors[0].label === 'PROMOTIONS' but the
// error email body read "Rule    : unknown". Falls back to the old
// derivation when no explicit label is passed, so nothing else changes.
function sendErrorEmail(err, payload, source, dryRun, ruleLabel) {
  const lbl    = ruleLabel || payload?.activeQueue?.[0]?.label || 'unknown';
  const footer = (source === 'background')
    ? 'Background trigger will retry automatically on next scheduled run.'
    : 'Engine stopped. Re-run when ready.';
  const stats = payload?.stats || {};
  // Dry runs only ever populate dryTrashed/dryArchived, never
  // totalTrashed/totalArchived — without this swap the stat boxes in the
  // email always read 0/0 during a dry-run failure, the same bug BUG-E9
  // already fixed for the abort email but this path was missed.
  const emailStats = dryRun
    ? { ...stats, totalTrashed: stats.dryTrashed || 0, totalArchived: stats.dryArchived || 0 }
    : stats;
  // FIX 47 (BUG-C24): err.message can be undefined whenever something other
  // than a real Error object was thrown upstream (e.g. a bare `throw 'boom'`
  // or `throw {code:500}`). Every GmailApp/Apps-Script-service call in this
  // project is expected to throw proper Error instances, but nothing here
  // actually enforces that assumption, and nothing about the JS language
  // does either — `throw` accepts any value. Before this fix, an undefined
  // err.message hit `.substring(0, 60)` directly in the subject line below,
  // a TypeError thrown from INSIDE this very error-reporting function, with
  // no try/catch around either call site (processLiveBurst()'s and
  // backgroundRun()'s catch blocks both call sendErrorEmail() directly). That
  // crash propagated out of the function meant to report the ORIGINAL
  // failure — silently defeating error reporting in the same spirit as
  // BUG-C15 — and inside backgroundRun() specifically it would also skip the
  // accumulateDailyStats()/maybeSendRunEmail() calls that come after the
  // while loop (though the lock is still released via the outer finally{}).
  // errMsg normalizes any thrown value to a string once, used everywhere
  // err.message was read raw below. Reproduced directly (GmailApp.search
  // spy throwing a bare string) against the pre-fix code before patching;
  // see AUTOTRASH_BUG_PLAN.txt BUG-C24 and the regression test in
  // claude/Tests.
  const errMsg = (err && err.message) ? err.message : String(err);
  // FIX 49 (BUG-C25): errStack mirrors errMsg's null-safety — the line right
  // below used to read `err.stack` directly. That's safe when err is any
  // real object (a string, a plain {code:500} object, etc. all just yield
  // `.stack === undefined`, falling through to '(none)'), but `err === null`
  // or `err === undefined` — both legal `throw` targets in JS, and nothing
  // upstream guarantees GmailApp/Apps-Script services never produce one —
  // throws its own TypeError reading `.stack` off of it, from inside this
  // very error-reporting function, before the email it exists to send is
  // ever built. Same failure shape as the err.message gap FIX 47 (BUG-C24)
  // already closed a few lines up; this closes the matching gap for
  // err.stack. Reproduced directly (GmailApp.search spy doing `throw null`)
  // against the pre-fix code before patching — see BUG-C25 in
  // AUTOTRASH_BUG_PLAN.txt.
  const errStack = (err && err.stack) ? err.stack : '(none)';
  const lines = [
    `⚠ ENGINE ERROR${dryRun ? ' [DRY RUN]' : ''}`, '',
    `Message : ${errMsg}`,
    `Rule    : ${lbl}`,
    `Moved   : ${fmtNum(stats.totalMoved || 0)}`,
    '', 'Stack:',
    ...errStack.split('\n').map(l => '  ' + l),
    '', footer
  ];
  safeMail(ownerEmail(),
    `⚠ AutoTrash Error: ${errMsg.substring(0, 60)}`,
    buildEmailHtml('⚠ ENGINE ERROR', lines, '#ff4455', emailStats, null, dryRun),
    lines.join('\n'));
}

// ─── ASCII CHART ─────────────────────────────────────────────────────────────
function buildAsciiChart(stats) {
  const BAR = 18;
  const entries = [];
  for (const [k, v] of Object.entries(stats?.labels || {}))
    if ((v.moved || 0) > 0) entries.push({ name: k, t: v.trashed || 0, a: v.archived || 0 });
  if ((stats?.globalPurgeMoved || 0) > 0)
    entries.push({ name: 'GLOBAL PURGE', t: stats.globalPurgeMoved, a: 0 });
  if ((stats?.inboxPurgeMoved || 0) > 0)
    entries.push({ name: 'INBOX PURGE',  t: stats.inboxPurgeMoved,  a: 0 });
  if (!entries.length) return '';

  const maxV = Math.max(...entries.map(e => e.t + e.a), 1);
  const nw   = Math.max(...entries.map(e => e.name.length), 4);
  const sep  = '─'.repeat(nw + BAR + 20);
  const rows = entries.map(e => {
    const tot  = e.t + e.a;
    // FIX 27 (BUG-E8): Clamp non-zero values to at least one block. Anything
    // below ~1/BAR of the largest row used to round to 0 and print a blank row.
    let tb = e.t > 0 ? Math.max(1, Math.round((e.t / maxV) * BAR)) : 0;
    let ab = e.a > 0 ? Math.max(1, Math.round((e.a / maxV) * BAR)) : 0;
    // Clamping can push the pair past BAR; trim the larger side back down so
    // every row stays exactly BAR wide and the columns still line up.
    while (tb + ab > BAR) { if (tb >= ab) tb--; else ab--; }
    const bar  = ('█'.repeat(tb) + '░'.repeat(ab)).padEnd(BAR);
    return `${e.name.padEnd(nw)}  ${bar}  ${fmtNum(tot).padStart(7)}  (█${fmtNum(e.t)} ░${fmtNum(e.a)})`;  // BUG-R6: glyphs match the bar
  });
  return [sep, `${'RULE'.padEnd(nw)}  ${'█=TRASH  ░=ARCHIVE'.padEnd(BAR)}    TOTAL`, sep, ...rows, sep].join('\n');
}

// FIX 35 (S-E4): Plain-text bodies keep the ASCII chart — it is the only
// per-rule view a plain-text reader gets. The HTML body drops it because the
// colour-coded table directly above shows the same numbers.
function plainBody(lines, stats) {
  const chart = buildAsciiChart(stats);
  return (chart ? [...lines, '', chart] : lines).join('\n');
}

// ─── HTML ESCAPE ──────────────────────────────────────────────────────────────
// FIX 44 (BUG-E15): Escapes text that gets interpolated into an HTML email
// body. Needed because Gmail label names (and the rule names derived from
// them) are free-text the user types into the "Label name" field in
// index.html — nothing on the server validates or restricts that text. See
// the escHtml() call inside buildEmailHtml()'s tableRows for the one place
// this closes a gap; AUTOTRASH_BUG_PLAN.txt BUG-E15 has the full story.
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── EMAIL HTML ───────────────────────────────────────────────────────────────
// FIX 21 (BUG-E2): Accepts dryRun flag. Dry-run emails get a prominent
// simulation banner and relabelled stat boxes so they can't be mistaken
// for a real run that actually deleted mail.
function buildEmailHtml(title, lines, accent, stats, elapsedMs, dryRun) {
  const ts   = new Date().toLocaleString();
  const secs = elapsedMs != null ? (elapsedMs / 1000).toFixed(1) : null;
  accent     = accent || '#00ff88';

  // Stat box labels: live vs dry run
  const labelActioned = dryRun ? 'Would Action' : 'Actioned';
  const labelTrashed  = dryRun ? 'Would Trash'  : 'Trashed';
  const labelArchived = dryRun ? 'Would Archive' : 'Archived';

  // Dry-run banner shown above everything else
  const dryBanner = dryRun
    ? `<tr><td style="padding:10px 24px;background:#2a1e00;border-bottom:2px solid #ffbb44;">
        <div class="at-glow" style="font-family:'Courier New',monospace;font-size:13px;font-weight:bold;color:#ffbb44;text-align:center;letter-spacing:1px;">
          ⚠ SIMULATION ONLY — NO MAIL WAS MOVED OR DELETED
        </div>
       </td></tr>`
    : '';

  const allRows = [];
  for (const [k, v] of Object.entries(stats?.labels || {})) {
    if ((v.moved || 0) === 0) continue;
    allRows.push({ name: k, moved: v.moved, t: v.trashed || 0, a: v.archived || 0 });
  }
  if ((stats?.globalPurgeMoved || 0) > 0)
    allRows.push({ name: 'GLOBAL PURGE', moved: stats.globalPurgeMoved, t: stats.globalPurgeMoved, a: 0, special: true });
  if ((stats?.inboxPurgeMoved || 0) > 0)
    allRows.push({ name: 'INBOX PURGE',  moved: stats.inboxPurgeMoved,  t: stats.inboxPurgeMoved,  a: 0, special: true });
  allRows.sort((a, b) => b.moved - a.moved);

  const maxM = Math.max(...allRows.map(r => r.moved), 1);
  const BC   = 12;

  const tableRows = allRows.map(r => {
    // FIX 27 (BUG-E8): Minimum 1 column for any non-zero count. The old
    // rounding sent anything under ~1/BC of the largest row to 0 columns,
    // rendering a solid empty bar. Worst case: a purge rule sets maxM and
    // every ordinary label rule beneath it collapses to nothing.
    let tc = r.t > 0 ? Math.max(1, Math.round((r.t / maxM) * BC)) : 0;
    let ac = r.a > 0 ? Math.max(1, Math.round((r.a / maxM) * BC)) : 0;
    while (tc + ac > BC) { if (tc >= ac) tc--; else ac--; } // never exceed BC
    const ec = Math.max(BC - tc - ac, 0);
    const bar =
      (tc > 0 ? `<td colspan="${tc}" style="background:#ff4455;height:8px;"></td>` : '') +
      (ac > 0 ? `<td colspan="${ac}" style="background:#44aaff;height:8px;"></td>` : '') +
      (ec > 0 ? `<td colspan="${ec}" style="background:#0a180a;height:8px;"></td>` : '');
    const nc = r.special ? '#ffdd88' : '#aaffcc';
    // FIX 44 (BUG-E15): r.name is escHtml()'d — it originates from a Gmail
    // label name the user typed into a free-text field client-side, with no
    // HTML sanitization anywhere on that path. Every other piece of dynamic
    // text in this email (the operation-summary lines below, via logHtml)
    // was already escaped; this row was the one gap that let a label name
    // like `<img src=x onerror=...>` inject markup into the user's own
    // summary/digest email instead of rendering as plain text.
    return `<tr>
      <td style="padding:6px 10px;font-family:'Courier New',monospace;font-size:12px;color:${nc};border-bottom:1px solid #111f11;white-space:nowrap;">${escHtml(r.name)}</td>
      <td style="padding:6px 10px;font-family:'Courier New',monospace;font-size:12px;color:#fff;text-align:right;border-bottom:1px solid #111f11;white-space:nowrap;">${fmtNum(r.moved)}</td>
      <td style="padding:6px 10px;font-family:'Courier New',monospace;font-size:12px;color:#ff8877;text-align:right;border-bottom:1px solid #111f11;white-space:nowrap;">${fmtNum(r.t)}</td>
      <td style="padding:6px 10px;font-family:'Courier New',monospace;font-size:12px;color:#88aaff;text-align:right;border-bottom:1px solid #111f11;white-space:nowrap;">${fmtNum(r.a)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #111f11;min-width:70px;">
        <table cellpadding="0" cellspacing="1" width="100%"><tr>${bar}</tr></table>
      </td></tr>`;
  }).join('');

  // FIX 26 (BUG-E7): Link back to the UI so settings are one tap away.
  // Omitted entirely when the script isn't deployed as a web app.
  const appUrl  = getAppUrl();
  const openBtn = appUrl
    ? `<div class="at-fade" style="text-align:center;padding:2px 0 14px;">
         <a href="${appUrl}" style="display:inline-block;font-family:'Courier New',monospace;font-size:11px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:${accent};text-decoration:none;padding:10px 22px;border:1px solid ${accent};border-radius:4px;background:#060d06;">Open AutoTrash &rarr;</a>
       </div>`
    : '';

  // FIX 35 (S-E4): Chart no longer duplicated here. Gmail strips the
  // overflow-x rule on the wrapper, so a chart wider than the 600px shell
  // clipped rather than scrolled — worst with long rule names.
  const allLines = lines;
  const logHtml  = allLines.map(l => {
    const c = l.startsWith('⚠') || l.startsWith('ERROR') ? '#ff6677'
            : l.startsWith('✓') ? '#00ff88'
            // FIX 29 (BUG-E10): #2a5a2a (~2.5:1) failed and #5a7a5a (~4.2:1)
            // was marginal on #010601. Indented lines are the bulk of the body.
            : l.startsWith('─') || l.startsWith('▓') ? '#3f7f3f'
            : l.startsWith('  ') ? '#88bb99'
            : '#aaffcc';
    return `<div style="padding:1px 0;font-family:'Courier New',monospace;font-size:11px;color:${c};line-height:1.6;white-space:pre;">${l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  /* FIX 31: Progressive enhancement ONLY. Gmail and Outlook strip <style>
     blocks and ignore @keyframes entirely — those clients render the static
     inline styles exactly as before, with no visual change whatsoever.
     animation-fill-mode is deliberately NOT set: with 'both', a client that
     keeps the stylesheet but blocks animations would leave elements stuck at
     opacity:0 — an invisible email. Without it the worst case is no animation. */
  @keyframes atFade { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
  @keyframes atGlow { 0%,100% { opacity:1; } 50% { opacity:.7; } }
  .at-fade { animation:atFade .5s ease; }
  .at-d1   { animation:atFade .5s ease .06s; }
  .at-d2   { animation:atFade .5s ease .12s; }
  .at-d3   { animation:atFade .5s ease .18s; }
  .at-glow { animation:atGlow 2.4s ease-in-out infinite; }
</style></head>
<body style="margin:0;padding:0;background:#020802;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#020802;">
<tr><td align="center" style="padding:24px 12px;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
${dryBanner}
<tr><td style="background:#050e05;border:1px solid #1a3a1a;border-radius:6px 6px 0 0;padding:20px 24px 16px;border-bottom:3px solid ${accent};">
  <div style="font-family:'Courier New',monospace;font-size:9px;color:#336633;letter-spacing:3px;text-transform:uppercase;margin-bottom:5px;">AUTOTRASH v26 // OPS REPORT</div>
  <div style="font-family:'Courier New',monospace;font-size:19px;font-weight:bold;color:${accent};">${title}</div>
  <div style="font-family:'Courier New',monospace;font-size:10px;color:#447744;margin-top:4px;">${ts}</div>
</td></tr>
<tr><td style="background:#030b03;border:1px solid #1a3a1a;border-top:none;border-radius:0 0 6px 6px;padding:20px 24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;border-collapse:separate;border-spacing:4px;">
  <tr>
    <td style="padding:12px 8px;background:#060d06;border:1px solid #1a3a1a;border-top:3px solid ${accent};border-radius:4px;text-align:center;">
      <div class="at-d1" style="font-family:'Courier New',monospace;font-size:26px;font-weight:bold;color:${accent};">${fmtNum(stats?.totalMoved || 0)}</div>
      <div style="font-family:'Courier New',monospace;font-size:8px;color:#447744;text-transform:uppercase;letter-spacing:1.5px;margin-top:3px;">${labelActioned}</div>
    </td>
    <td style="padding:12px 8px;background:#060d06;border:1px solid #1a3a1a;border-top:3px solid #ff4455;border-radius:4px;text-align:center;">
      <div class="at-d2" style="font-family:'Courier New',monospace;font-size:26px;font-weight:bold;color:#ff8877;">${fmtNum(stats?.totalTrashed || 0)}</div>
      <div style="font-family:'Courier New',monospace;font-size:8px;color:#447744;text-transform:uppercase;letter-spacing:1.5px;margin-top:3px;">${labelTrashed}</div>
    </td>
    <td style="padding:12px 8px;background:#060d06;border:1px solid #1a3a1a;border-top:3px solid #44aaff;border-radius:4px;text-align:center;">
      <div class="at-d3" style="font-family:'Courier New',monospace;font-size:26px;font-weight:bold;color:#88aaff;">${fmtNum(stats?.totalArchived || 0)}</div>
      <div style="font-family:'Courier New',monospace;font-size:8px;color:#447744;text-transform:uppercase;letter-spacing:1.5px;margin-top:3px;">${labelArchived}</div>
    </td>
  </tr>
  </table>
  ${secs ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;">
  <tr><td style="padding:9px 12px;background:#060d06;border:1px solid #1a3a1a;border-radius:4px;">
    <span style="font-family:'Courier New',monospace;font-size:10px;color:#447744;">DURATION </span>
    <span style="font-family:'Courier New',monospace;font-size:12px;color:#aaffcc;">${secs}s</span>
    ${(stats?.totalMoved || 0) > 0 && parseFloat(secs) > 0
      ? `<span style="font-family:'Courier New',monospace;font-size:10px;color:#447744;"> · AVG </span>
         <span style="font-family:'Courier New',monospace;font-size:12px;color:#aaffcc;">${fmtNum(Math.round((stats.totalMoved||0)/parseFloat(secs)))}/sec</span>`
      : ''}
  </td></tr></table>` : ''}
  ${tableRows ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;border-collapse:collapse;background:#040c04;border:1px solid #1a3a1a;border-radius:4px;overflow:hidden;">
  <tr style="background:#091509;">
    <td style="padding:6px 10px;font-family:'Courier New',monospace;font-size:9px;color:#336633;text-transform:uppercase;letter-spacing:1.2px;">Rule</td>
    <td style="padding:6px 10px;font-family:'Courier New',monospace;font-size:9px;color:#336633;text-transform:uppercase;letter-spacing:1.2px;text-align:right;">Total</td>
    <td style="padding:6px 10px;font-family:'Courier New',monospace;font-size:9px;color:#ff6655;text-transform:uppercase;letter-spacing:1.2px;text-align:right;">Trash</td>
    <td style="padding:6px 10px;font-family:'Courier New',monospace;font-size:9px;color:#6699ff;text-transform:uppercase;letter-spacing:1.2px;text-align:right;">Archive</td>
    <td style="padding:6px 10px;font-family:'Courier New',monospace;font-size:9px;color:#336633;text-transform:uppercase;letter-spacing:1.2px;">Split (red=trash · blue=archive)</td>
  </tr>
  ${tableRows}
  </table>` : ''}
  <div style="background:#010601;border:1px solid #0f1f0f;border-radius:3px;padding:12px 14px;margin-bottom:12px;overflow-x:auto;">
    <div style="font-family:'Courier New',monospace;font-size:9px;color:#336633;letter-spacing:2px;text-transform:uppercase;margin-bottom:7px;">OPERATION SUMMARY</div>
    ${logHtml}
  </div>
  ${openBtn}
  <div style="padding-top:10px;border-top:1px solid #0d1d0d;font-family:'Courier New',monospace;font-size:9px;color:#253525;text-align:center;">
    AUTOTRASH v26 · Safety-first email automation · ${ts}
  </div>
</td></tr>
</table></td></tr></table>
</body></html>`;
}

// ─── SETTINGS ────────────────────────────────────────────────────────────────
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('AutoTrash v26')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getUISettings() {
  const props = getProps();
  // FIX 42 (BUG-C18): Same defensive parse as backgroundRun() — a corrupted
  // AUTOTRASH_RULES/CATEGORY_RULES value must not crash the settings load.
  // Previously a bad value here would throw inside this RPC, which the
  // client's .withFailureHandler() catches (see index.html window.onload) —
  // so the app wouldn't crash outright, but EVERY saved rule would silently
  // fail to load on every page visit with only a generic "Load failed"
  // terminal line and no way to recover them from the UI.
  let rules, categoryRules;
  try { rules = JSON.parse(props.getProperty('AUTOTRASH_RULES') || '[]'); }
  catch (e) { rules = []; }
  try { categoryRules = JSON.parse(props.getProperty('CATEGORY_RULES') || '[]'); }
  catch (e) { categoryRules = []; }
  return {
    lastRun:         props.getProperty('LAST_RUN_TIME')     || 'Never',
    triggerMode:     props.getProperty('TRIGGER_MODE')      || 'OFF',
    summaryFreq:     props.getProperty('SUMMARY_FREQ')      || 'EACH_RUN',
    globalPurgeDays: props.getProperty('GLOBAL_PURGE_DAYS') || 'OFF',
    inboxPurgeDays:  props.getProperty('INBOX_PURGE_DAYS')  || 'OFF',
    digestHour:      props.getProperty('DIGEST_HOUR')       || '8',
    rules:           rules,
    categoryRules:   categoryRules
  };
}

function updateSystem(cfg) {
  const props = getProps();
  props.setProperties({
    'AUTOTRASH_RULES':   JSON.stringify(cfg.rules          || []),
    'CATEGORY_RULES':    JSON.stringify(cfg.categoryRules  || []),
    'TRIGGER_MODE':      cfg.triggerMode     || 'OFF',
    'SUMMARY_FREQ':      cfg.summaryFreq     || 'EACH_RUN',
    'GLOBAL_PURGE_DAYS': cfg.globalPurgeDays || 'OFF',
    'INBOX_PURGE_DAYS':  cfg.inboxPurgeDays  || 'OFF',
    'DIGEST_HOUR':       String(cfg.digestHour || 8)
  });

  ScriptApp.getProjectTriggers()
    .filter(t => ['backgroundRun', 'sendDailyDigest'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));

  const mode = cfg.triggerMode || 'OFF';
  if (mode !== 'OFF') {
    const b = ScriptApp.newTrigger('backgroundRun').timeBased();
    if      (mode === '1MIN')   b.everyMinutes(1).create();
    else if (mode === '5MIN')   b.everyMinutes(5).create();
    else if (mode === '15MIN')  b.everyMinutes(15).create();
    else if (mode === 'HOURLY') b.everyHours(1).create();
    else if (mode === 'DAILY')  b.everyDays(1).atHour(1).create();
  }

  const freq = cfg.summaryFreq || 'EACH_RUN';
  // FIX 36 (BUG-C12): The digest trigger is created for ANY digest frequency,
  // regardless of TRIGGER_MODE. FIX 16 gated it behind background mode to stop
  // empty digests firing, but manual live runs call accumulateDailyStats() too
  // — so a manual-only user on DAILY/WEEKLY accumulated stats forever and was
  // never sent them. The empty-fire concern is already handled inside
  // sendDailyDigest(), which returns early when d.runs === 0.
  if (['DAILY', 'ALT_DAYS', 'WEEKLY', 'BIWEEKLY'].includes(freq)) {
    ScriptApp.newTrigger('sendDailyDigest').timeBased()
      .everyDays(1).atHour(parseInt(cfg.digestHour || 8)).create();
  }
}
