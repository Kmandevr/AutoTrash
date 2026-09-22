/**
 * ████████████████████████████████████████████████████████████████
 * AUTOTRASH v26 — Gmail cleanup engine (Apps Script backend)
 * ████████████████████████████████████████████████████████████████
 *
 * Entry point (doGet) and settings read/write only. The engine itself
 * lives in the files below — Apps Script shares one global scope across
 * all .gs files, so split location never affects behavior, only where
 * to find something:
 *
 *   Utils.gs            Small shared helpers (formatting, mail, props).
 *   RuleEngine.gs        Rule → Gmail query, action resolution, queue build.
 *   Runner.gs            processLiveBurst() / backgroundRun() / abort /
 *                         finalize / daily-stats bookkeeping.
 *   EmailSend.gs          When/whether to send a run or digest email.
 *   EmailTemplates.gs    HTML/plain-text email rendering.
 *   index.html            Web app UI (served by doGet() below).
 *
 * DOCUMENTATION MAP
 * ─────────────────
 * The 35-entry fix log that used to sit here has moved, so there is exactly
 * one canonical copy of that history instead of two that drift apart:
 *
 *   feature-reference.txt  How every feature is MEANT to behave.
 *                                    Read before changing anything.
 *   GitHub Issues                    Every fix with its root cause. The
 *                                    inline "FIX n (BUG-XX)" comments below
 *                                    resolve to a BUG-XX issue there.
 *   suggestions.txt        Proposed work, plus what has shipped.
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
