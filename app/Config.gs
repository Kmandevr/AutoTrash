/**
 * AutoTrash — settings read/write, defensive rule-property parsing, and
 * background/digest trigger sync. Split out of Code.gs on 2026-09-24;
 * see CLAUDE.md for the full file map.
 *
 * CONFIG_SCHEMA (2026-09-24) is the single source of truth for every
 * setting readConfig()/writeConfig() persist. Before this, each setting's
 * name was hardcoded independently in readConfig(), writeConfig(), and
 * (for rules/categoryRules) again in snapshotConfigBackup()/
 * listConfigBackups()/restoreConfigBackup() — five places to touch, in
 * sync, to add one setting. Now adding a setting is one entry in
 * CONFIG_SCHEMA below; every function in this file walks the list instead
 * of naming fields.
 *
 * This refactor changes nothing about the external storage contract:
 * every PropertiesService key name and JSON-vs-string format is unchanged
 * from before, because app/Runner.gs (lines ~320, ~380-381) and
 * app/EmailSend.gs (lines ~22, ~67) read SUMMARY_FREQ/GLOBAL_PURGE_DAYS/
 * INBOX_PURGE_DAYS directly via props.getProperty(), bypassing
 * readConfig() entirely — changing a key name or format here would break
 * those call sites silently.
 *
 * Four small seams, mirroring the split Engine.gs made for the run
 * pipeline:
 *   parseStoredRules()  UserProperties → {rules, categoryRules}, defensive.
 *                        Previously duplicated inline in getUISettings()
 *                        (Code.gs) and backgroundRun() (Runner.gs) — same
 *                        two try/catch blocks, copy-pasted. Now a thin
 *                        wrapper over CONFIG_SCHEMA's two rule fields.
 *   readConfig()         Every stored setting, parsed generically from
 *                        CONFIG_SCHEMA. What getUISettings() used to build
 *                        inline field-by-field.
 *   writeConfig(cfg)      Persists a config object, again by walking
 *                        CONFIG_SCHEMA. What updateSystem() used to do
 *                        inline, before also touching triggers.
 *   syncTriggers(cfg)     Deletes AutoTrash's own triggers and recreates them
 *                        to match cfg. Kept separate from writeConfig() so a
 *                        future caller (e.g. a settings-only save) can update
 *                        stored config without touching triggers, or vice
 *                        versa.
 * getUISettings()/updateSystem() — the two functions index.html actually
 * calls via google.script.run — are now one-line wrappers, unchanged in
 * name, signature and behavior.
 */

// ─── CONFIG SCHEMA ──────────────────────────────────────────────────────────
// Add a future setting HERE — one entry — and readConfig(), writeConfig(),
// and parseStoredRules() all pick it up with no other change. `type: 'json'`
// fields are JSON.parse/stringify'd; anything else round-trips as a string
// (matching how every non-rule setting was already stored: TRIGGER_MODE,
// SUMMARY_FREQ etc. were always plain strings, never numbers or booleans,
// even digestHour). `backup: true` plus `countKey`/`countFn` opts a field
// into the pre-write snapshot/restore safety net below — leave those three
// off for settings that are cheap to re-pick from a dropdown and not worth
// a recovery flow (trigger mode, purge thresholds, digest hour).
const CONFIG_SCHEMA = [
  {
    key: 'rules', prop: 'AUTOTRASH_RULES', type: 'json', default: [],
    backup: true, countKey: 'ruleCount', countFn: v => (v || []).length
  },
  {
    key: 'categoryRules', prop: 'CATEGORY_RULES', type: 'json', default: [],
    backup: true, countKey: 'categoryCount',
    countFn: v => (v || []).filter(c => c.enabled).length
  },
  { key: 'triggerMode',     prop: 'TRIGGER_MODE',      type: 'string', default: 'OFF' },
  { key: 'summaryFreq',     prop: 'SUMMARY_FREQ',      type: 'string', default: 'EACH_RUN' },
  { key: 'globalPurgeDays', prop: 'GLOBAL_PURGE_DAYS', type: 'string', default: 'OFF' },
  { key: 'inboxPurgeDays',  prop: 'INBOX_PURGE_DAYS',  type: 'string', default: 'OFF' },
  { key: 'digestHour',      prop: 'DIGEST_HOUR',       type: 'string', default: '8' }
];

// FIX 42 (BUG-C18) generalized: a corrupted or missing property of ANY
// schema field must not throw — every caller falls back to that field's
// declared default. JSON.stringify(field.default) then re-parsed gives
// each caller its own fresh array/object rather than a shared reference.
function schemaReadField(props, field) {
  const raw = props.getProperty(field.prop);
  if (field.type === 'json') {
    try { return JSON.parse(raw != null ? raw : JSON.stringify(field.default)); }
    catch (e) { return field.default; }
  }
  return raw || field.default;
}

function schemaWriteField(field, cfg) {
  const value = cfg[field.key];
  if (field.type === 'json') return JSON.stringify(value != null ? value : field.default);
  return String(value != null ? value : field.default);
}

// ─── DEFENSIVE RULE PARSING ─────────────────────────────────────────────────
// Kept as its own function — backgroundRun() (Runner.gs) needs just
// {rules, categoryRules} without paying for the rest of readConfig().
function parseStoredRules() {
  const props = getProps();
  const rulesField = CONFIG_SCHEMA.find(f => f.key === 'rules');
  const catField   = CONFIG_SCHEMA.find(f => f.key === 'categoryRules');
  return {
    rules: schemaReadField(props, rulesField),
    categoryRules: schemaReadField(props, catField)
  };
}

// ─── CONFIG READ ────────────────────────────────────────────────────────────
function readConfig() {
  const props = getProps();
  const cfg = { lastRun: props.getProperty('LAST_RUN_TIME') || 'Never' };
  CONFIG_SCHEMA.forEach(field => { cfg[field.key] = schemaReadField(props, field); });
  return cfg;
}

// FIX 42 (BUG-C18) applies here too: the client's .withFailureHandler() in
// index.html's window.onload catches a thrown RPC, but a corrupted property
// must not make every saved rule silently fail to load.
function getUISettings() {
  return readConfig();
}

// ─── CONFIG WRITE ───────────────────────────────────────────────────────────
function writeConfig(cfg) {
  snapshotConfigBackup(); // pre-write safety net — see the block below.
  const props = getProps();
  const toWrite = {};
  CONFIG_SCHEMA.forEach(field => { toWrite[field.prop] = schemaWriteField(field, cfg); });
  props.setProperties(toWrite);
}

// ─── CONFIG BACKUP / RESTORE ────────────────────────────────────────────────
// FIX (2026-09-24, reported live: a Save Config wiped out every existing
// rule): index.html's window.onload failure handler only logged an error —
// it never stopped Save Config from running with whatever was in memory,
// which defaults to an empty array until a successful load overwrites it.
// A failed or slow initial load followed by any Save Config click silently
// replaced AUTOTRASH_RULES/CATEGORY_RULES with "[]", with nothing to
// recover from. Two independent layers now guard against this:
//   1. HERE — every writeConfig() call snapshots every CONFIG_SCHEMA field
//      marked backup:true, PRE-write (last CONFIG_BACKUP_MAX kept), so even
//      a genuine accidental wipe is recoverable afterward via
//      listConfigBackups()/restoreConfigBackup().
//   2. index.html itself now refuses to call updateSystem() at all until a
//      load has actually succeeded, and confirms before a save that would
//      remove every rule/category it started with — catching the mistake
//      before it's written at all, not just after. See saveConfig() there.
const CONFIG_BACKUP_MAX = 5;

function backupFields() { return CONFIG_SCHEMA.filter(f => f.backup); }

function snapshotConfigBackup() {
  try {
    const props = getProps();
    const fields = backupFields();
    const current = {};
    let anyNonEmpty = false;
    fields.forEach(f => {
      const v = schemaReadField(props, f);
      current[f.key] = v;
      if (Array.isArray(v) ? v.length : v) anyNonEmpty = true;
    });
    // Nothing worth protecting yet (fresh install, or already empty) —
    // skip rather than piling up empty snapshots.
    if (!anyNonEmpty) return;

    let backups;
    try { backups = JSON.parse(props.getProperty('AUTOTRASH_CONFIG_BACKUPS') || '[]'); }
    catch (e) { backups = []; }

    backups.unshift(Object.assign({ ts: Date.now() }, current));
    backups = backups.slice(0, CONFIG_BACKUP_MAX);

    // PropertiesService caps a single value around 9KB. A pathologically
    // large rule set could push even one snapshot over that — rather than
    // let a quota error here block the real config write, drop backups
    // oldest-first until it fits, and give up quietly (still letting the
    // real write proceed) if even one alone won't fit.
    while (backups.length > 0) {
      try { props.setProperty('AUTOTRASH_CONFIG_BACKUPS', JSON.stringify(backups)); return; }
      catch (e) { backups.pop(); }
    }
  } catch (e) {
    // A backup failing must never block the actual config save.
    console.log('snapshotConfigBackup: skipped — ' + e.message);
  }
}

// Summaries only (no rule bodies) — small enough to always round-trip to
// the client even with several backups queued up. Each backed-up field
// contributes its own summary column via its schema entry's countKey/
// countFn, so a future backed-up setting shows up here automatically.
function listConfigBackups() {
  const props = getProps();
  let backups;
  try { backups = JSON.parse(props.getProperty('AUTOTRASH_CONFIG_BACKUPS') || '[]'); }
  catch (e) { backups = []; }
  const fields = backupFields();
  return backups.map(b => {
    const summary = { ts: b.ts };
    fields.forEach(f => { summary[f.countKey] = f.countFn(b[f.key]); });
    return summary;
  });
}

// Restores every backup:true field from one snapshot; every other setting
// is left untouched. Snapshots the CURRENT state first (via writeConfig()
// below), so restoring is itself undoable the same way a normal save is.
// Returns the restored fields so the caller can update its in-memory state
// without a full page reload.
function restoreConfigBackup(ts) {
  const props = getProps();
  let backups;
  try { backups = JSON.parse(props.getProperty('AUTOTRASH_CONFIG_BACKUPS') || '[]'); }
  catch (e) { backups = []; }
  const found = backups.find(b => b.ts === ts);
  if (!found) return { ok: false, reason: 'That backup no longer exists.' };

  const restored = {};
  backupFields().forEach(f => { restored[f.key] = found[f.key] !== undefined ? found[f.key] : f.default; });

  writeConfig(Object.assign({}, readConfig(), restored));
  return Object.assign({ ok: true }, restored);
}

// ─── TRIGGER SYNC ───────────────────────────────────────────────────────────
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
