/**
 * AutoTrash — decides whether/when to send a run summary or daily digest
 * email, and builds the error-report email. Templates (HTML/plain body,
 * ASCII chart) live in EmailTemplates.gs.
 * Split out of Code.gs on 2026-09-22; see CLAUDE.md for the full file map.
 */

// ─── SHARED SEND ──────────────────────────────────────────────────────────────
// Every kind of AutoTrash email (run summary, daily digest, error report, and
// abortRun()'s abort notice in Runner.gs) ends the same way: render the HTML
// body, render the plain-text body from the same lines/stats, mail both to
// the owner. Added 2026-09-24 to replace four copies of that same three-call
// sequence with one.
function sendReportEmail(subject, title, lines, accent, stats, elapsedMs, dryRun) {
  safeMail(ownerEmail(), subject,
    buildEmailHtml(title, lines, accent, stats, elapsedMs, dryRun),
    plainBody(lines, stats));
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

  sendReportEmail(subj, status.toUpperCase(), lines, accent, stats, elapsedMs, dryRun);
}

function sendDailyDigest() {
  const props      = getProps();
  const freq       = props.getProperty('SUMMARY_FREQ') || 'EACH_RUN';
  if (!['DAILY', 'ALT_DAYS', 'WEEKLY', 'BIWEEKLY'].includes(freq)) return;
  const lastDigest = props.getProperty('LAST_DIGEST_DATE') || '';
  const today      = new Date().toISOString().slice(0, 10);
  // FIX 50 (Issue #98): new Date(...) never throws — an unparseable
  // LAST_DIGEST_DATE (hand-edited in the Properties editor, corrupted, or
  // left over from a future format change) silently becomes Invalid Date,
  // making daysSince NaN. NaN >= 2/7/14 is always false, so `should` used to
  // latch at false forever for every freq except DAILY — and since the
  // `if (!should) return;` below fires BEFORE the LAST_DIGEST_DATE rewrite
  // further down, the corrupted value was never self-corrected: the digest
  // stopped going out permanently, with no error and no trace. An unparseable
  // date is treated as "never sent" (daysSince = Infinity) instead, so this
  // heals itself on the very next check — `should` becomes true, the digest
  // sends (or is skipped only because there's nothing to report, same as
  // any other day), and LAST_DIGEST_DATE gets overwritten with a valid value.
  const lastDigestMs = new Date(lastDigest || 0).getTime();
  const daysSince  = isNaN(lastDigestMs) ? Infinity : Math.floor((new Date() - lastDigestMs) / 864e5);
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
  sendReportEmail(`✓ AutoTrash ${pLabel} Digest: ${fmtNum(d.totalMoved)} actioned`,
    `${pLabel.toUpperCase()} DIGEST`, lines, '#00ff88', d, null);
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
  // see BUG-C24 in GitHub Issues and the regression test in
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
  // GitHub Issues.
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
  // sendErrorEmail's plain-text body is `lines` verbatim, not plainBody()'s
  // lines+ASCII-chart — an error report has no per-rule breakdown to chart —
  // so it stays a direct safeMail() call rather than sendReportEmail().
  safeMail(ownerEmail(),
    `⚠ AutoTrash Error: ${errMsg.substring(0, 60)}`,
    buildEmailHtml('⚠ ENGINE ERROR', lines, '#ff4455', emailStats, null, dryRun),
    lines.join('\n'));
}

