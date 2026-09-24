/**
 * AutoTrash — settings read/write, defensive rule-property parsing, and
 * background/digest trigger sync. Split out of Code.gs on 2026-09-24;
 * see CLAUDE.md for the full file map.
 *
 * Three small seams, mirroring the split Engine.gs made for the run
 * pipeline:
 *   parseStoredRules()  UserProperties → {rules, categoryRules}, defensive.
 *                        Previously duplicated inline in getUISettings()
 *                        (Code.gs) and backgroundRun() (Runner.gs) — same
 *                        two try/catch blocks, copy-pasted.
 *   readConfig()         Every stored setting, parsed. What getUISettings()
 *                        used to build inline.
 *   writeConfig(cfg)      Persists a config object. What updateSystem() used
 *                        to do inline, before also touching triggers.
 *   syncTriggers(cfg)     Deletes AutoTrash's own triggers and recreates them
 *                        to match cfg. Kept separate from writeConfig() so a
 *                        future caller (e.g. a settings-only save) can update
 *                        stored config without touching triggers, or vice
 *                        versa.
 * getUISettings()/updateSystem() — the two functions index.html actually
 * calls via google.script.run — are now one-line wrappers, unchanged in
 * name, signature and behavior.
 */

// ─── DEFENSIVE RULE PARSING ───────────────────────────────────────────────────
// FIX 42 (BUG-C18): A corrupted AUTOTRASH_RULES/CATEGORY_RULES value (hand-
// edited via the Apps Script property editor, a partial write cut off
// mid-save, etc.) must not throw — every caller falls back to an empty list.
function parseStoredRules() {
  const props = getProps();
  let rules, categoryRules;
  try { rules = JSON.parse(props.getProperty('AUTOTRASH_RULES') || '[]'); }
  catch (e) { rules = []; }
  try { categoryRules = JSON.parse(props.getProperty('CATEGORY_RULES') || '[]'); }
  catch (e) { categoryRules = []; }
  return { rules: rules, categoryRules: categoryRules };
}

// ─── CONFIG READ ──────────────────────────────────────────────────────────────
function readConfig() {
  const props = getProps();
  const stored = parseStoredRules();
  return {
    lastRun:         props.getProperty('LAST_RUN_TIME')     || 'Never',
    triggerMode:     props.getProperty('TRIGGER_MODE')      || 'OFF',
    summaryFreq:     props.getProperty('SUMMARY_FREQ')      || 'EACH_RUN',
    globalPurgeDays: props.getProperty('GLOBAL_PURGE_DAYS') || 'OFF',
    inboxPurgeDays:  props.getProperty('INBOX_PURGE_DAYS')  || 'OFF',
    digestHour:      props.getProperty('DIGEST_HOUR')       || '8',
    rules:           stored.rules,
    categoryRules:   stored.categoryRules
  };
}

// FIX 42 (BUG-C18) applies here too: the client's .withFailureHandler() in
// index.html's window.onload catches a thrown RPC, but a corrupted property
// must not make every saved rule silently fail to load.
function getUISettings() {
  return readConfig();
}

// ─── CONFIG WRITE ─────────────────────────────────────────────────────────────
function writeConfig(cfg) {
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
}

// ─── TRIGGER SYNC ─────────────────────────────────────────────────────────────
function syncTriggers(cfg) {
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

function updateSystem(cfg) {
  writeConfig(cfg);
  syncTriggers(cfg);
}
