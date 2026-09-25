/**
 * AutoTrash tests — app/Config.gs (getUISettings/readConfig, updateSystem's
 * trigger management + property persistence via writeConfig/syncTriggers).
 * Split out of tests/Code.test.gs on 2026-09-24, mirroring the same move
 * in app/Code.gs -> app/Config.gs.
 * Split out of the former monolithic tests/Tests.gs on 2026-09-24 — see
 * CLAUDE.md for the full test-file map and TestFramework.gs for the shared
 * assertions/spies these tests use.
 */

function test_getUISettings_corruptRulesProperty_returnsEmptyArraysNotThrow() {
  withSavedProps(['AUTOTRASH_RULES', 'CATEGORY_RULES'], props => {
    props.setProperty('AUTOTRASH_RULES', 'not json at all');
    props.setProperty('CATEGORY_RULES', 'also not json');
    let result, threw = false;
    try { result = getUISettings(); } catch (e) { threw = true; }
    assertEqual(threw, false, 'getUISettings must not throw on corrupted rule properties');
    assertEqual(result.rules, [], 'corrupted AUTOTRASH_RULES must fall back to an empty array, not crash the settings load');
    assertEqual(result.categoryRules, [], 'corrupted CATEGORY_RULES must fall back to an empty array');
  });
}
function test_getUISettings_validRulesProperty_stillParsesNormally() {
  withSavedProps(['AUTOTRASH_RULES', 'CATEGORY_RULES'], props => {
    props.setProperty('AUTOTRASH_RULES', JSON.stringify([{ label: 'REAL', days: 30, isTrash: true }]));
    props.setProperty('CATEGORY_RULES', JSON.stringify([{ category: 'social', enabled: true, days: 60 }]));
    const result = getUISettings();
    assertEqual(result.rules, [{ label: 'REAL', days: 30, isTrash: true }]);
    assertEqual(result.categoryRules, [{ category: 'social', enabled: true, days: 60 }]);
  });
}

// ── FAKE-TRIGGER INTEGRATION TESTS (updateSystem) ────────────────────────
const UPDATE_SYSTEM_PROP_KEYS = [
  'AUTOTRASH_RULES', 'CATEGORY_RULES', 'TRIGGER_MODE', 'SUMMARY_FREQ',
  'GLOBAL_PURGE_DAYS', 'INBOX_PURGE_DAYS', 'DIGEST_HOUR'
];
function baseCfg(overrides) {
  return Object.assign({
    rules: [], categoryRules: [], triggerMode: 'OFF', summaryFreq: 'NEVER',
    globalPurgeDays: 'OFF', inboxPurgeDays: 'OFF', digestHour: 8
  }, overrides || {});
}

function test_updateSystem_triggerModeOff_createsNoBackgroundTrigger() {
  withSavedProps(UPDATE_SYSTEM_PROP_KEYS, function () {
    const spy = installScriptAppSpy([]);
    try {
      updateSystem(baseCfg({ triggerMode: 'OFF' }));
      const bg = spy.triggers().filter(function (t) { return t.getHandlerFunction() === 'backgroundRun'; });
      assertEqual(bg.length, 0, 'triggerMode OFF must not create a backgroundRun trigger');
    } finally { spy.restore(); }
  });
}

function test_updateSystem_triggerMode1MIN_createsEveryMinuteBackgroundTrigger() {
  withSavedProps(UPDATE_SYSTEM_PROP_KEYS, function () {
    const spy = installScriptAppSpy([]);
    try {
      updateSystem(baseCfg({ triggerMode: '1MIN' }));
      const bg = spy.triggers().filter(function (t) { return t.getHandlerFunction() === 'backgroundRun'; });
      assertEqual(bg.length, 1, 'triggerMode 1MIN must create exactly one backgroundRun trigger');
      assertEqual(bg[0].config.everyMinutes, 1, '1MIN must configure everyMinutes(1)');
    } finally { spy.restore(); }
  });
}

function test_updateSystem_triggerModeDaily_createsDailyBackgroundTriggerAtHour1() {
  withSavedProps(UPDATE_SYSTEM_PROP_KEYS, function () {
    const spy = installScriptAppSpy([]);
    try {
      updateSystem(baseCfg({ triggerMode: 'DAILY' }));
      const bg = spy.triggers().filter(function (t) { return t.getHandlerFunction() === 'backgroundRun'; });
      assertEqual(bg.length, 1, 'triggerMode DAILY must create exactly one backgroundRun trigger');
      assertEqual(bg[0].config.everyDays, 1, 'DAILY background trigger must fire once a day');
      assertEqual(bg[0].config.atHour, 1, 'DAILY background trigger must be pinned to 1am, independent of digestHour');
    } finally { spy.restore(); }
  });
}

function test_updateSystem_summaryFreqDaily_createsDigestTriggerAtConfiguredHour() {
  withSavedProps(UPDATE_SYSTEM_PROP_KEYS, function () {
    const spy = installScriptAppSpy([]);
    try {
      updateSystem(baseCfg({ summaryFreq: 'DAILY', digestHour: 14 }));
      const dg = spy.triggers().filter(function (t) { return t.getHandlerFunction() === 'sendDailyDigest'; });
      assertEqual(dg.length, 1, 'summaryFreq DAILY must create exactly one sendDailyDigest trigger');
      assertEqual(dg[0].config.everyDays, 1, 'digest trigger must fire once a day');
      assertEqual(dg[0].config.atHour, 14, 'digest trigger must be configured at the chosen hour');
    } finally { spy.restore(); }
  });
}

function test_updateSystem_summaryFreqErrorsOnlyOrEachRun_createsNoDigestTrigger() {
  withSavedProps(UPDATE_SYSTEM_PROP_KEYS, function () {
    ['ERRORS_ONLY', 'EACH_RUN', 'NEVER'].forEach(function (freq) {
      const spy = installScriptAppSpy([]);
      try {
        updateSystem(baseCfg({ summaryFreq: freq }));
        const dg = spy.triggers().filter(function (t) { return t.getHandlerFunction() === 'sendDailyDigest'; });
        assertEqual(dg.length, 0, 'summaryFreq ' + freq + ' must not create a sendDailyDigest trigger');
      } finally { spy.restore(); }
    });
  });
}

function test_updateSystem_summaryFreqAllDigestShapes_createExactlyOneDigestTrigger() {
  withSavedProps(UPDATE_SYSTEM_PROP_KEYS, function () {
    ['DAILY', 'ALT_DAYS', 'WEEKLY', 'BIWEEKLY'].forEach(function (freq) {
      const spy = installScriptAppSpy([]);
      try {
        updateSystem(baseCfg({ summaryFreq: freq }));
        const dg = spy.triggers().filter(function (t) { return t.getHandlerFunction() === 'sendDailyDigest'; });
        assertEqual(dg.length, 1, 'summaryFreq ' + freq + ' must create exactly one sendDailyDigest trigger');
      } finally { spy.restore(); }
    });
  });
}

function test_updateSystem_deletesStaleAutoTrashTriggersButPreservesUnrelatedOnes() {
  withSavedProps(UPDATE_SYSTEM_PROP_KEYS, function () {
    const preexisting = [
      { getHandlerFunction: function () { return 'backgroundRun'; }, getUniqueId: function () { return 'stale1'; } },
      { getHandlerFunction: function () { return 'someOtherProjectFunction'; }, getUniqueId: function () { return 'unrelated1'; } }
    ];
    const spy = installScriptAppSpy(preexisting);
    try {
      updateSystem(baseCfg({ triggerMode: 'OFF', summaryFreq: 'NEVER' }));
      const remaining = spy.triggers().map(function (t) { return t.getHandlerFunction(); });
      assert(!remaining.includes('backgroundRun'), 'the stale backgroundRun trigger must be deleted when triggerMode is turned OFF');
      assert(remaining.includes('someOtherProjectFunction'), 'a trigger for an unrelated function must survive updateSystem()\'s cleanup sweep');
    } finally { spy.restore(); }
  });
}

function test_updateSystem_persistsRulesAndSettingsToProperties() {
  withSavedProps(UPDATE_SYSTEM_PROP_KEYS, function (props) {
    const spy = installScriptAppSpy([]);
    try {
      updateSystem(baseCfg({
        rules: [{ label: 'Newsletters', days: 30, isTrash: true }],
        categoryRules: [{ category: 'social', enabled: true, days: 60 }],
        triggerMode: '5MIN', summaryFreq: 'WEEKLY', globalPurgeDays: '365',
        inboxPurgeDays: '90', digestHour: 9
      }));
      assertEqual(JSON.parse(props.getProperty('AUTOTRASH_RULES')), [{ label: 'Newsletters', days: 30, isTrash: true }]);
      assertEqual(JSON.parse(props.getProperty('CATEGORY_RULES')), [{ category: 'social', enabled: true, days: 60 }]);
      assertEqual(props.getProperty('TRIGGER_MODE'), '5MIN');
      assertEqual(props.getProperty('SUMMARY_FREQ'), 'WEEKLY');
      assertEqual(props.getProperty('GLOBAL_PURGE_DAYS'), '365');
      assertEqual(props.getProperty('INBOX_PURGE_DAYS'), '90');
      assertEqual(props.getProperty('DIGEST_HOUR'), '9');
    } finally { spy.restore(); }
  });
}

const CONFIG_TESTS = [
  test_getUISettings_corruptRulesProperty_returnsEmptyArraysNotThrow,
  test_getUISettings_validRulesProperty_stillParsesNormally,
  test_updateSystem_triggerModeOff_createsNoBackgroundTrigger,
  test_updateSystem_triggerMode1MIN_createsEveryMinuteBackgroundTrigger,
  test_updateSystem_triggerModeDaily_createsDailyBackgroundTriggerAtHour1,
  test_updateSystem_summaryFreqDaily_createsDigestTriggerAtConfiguredHour,
  test_updateSystem_summaryFreqErrorsOnlyOrEachRun_createsNoDigestTrigger,
  test_updateSystem_summaryFreqAllDigestShapes_createExactlyOneDigestTrigger,
  test_updateSystem_deletesStaleAutoTrashTriggersButPreservesUnrelatedOnes,
  test_updateSystem_persistsRulesAndSettingsToProperties
];

// ── parseStoredRules (shared by getUISettings/readConfig and backgroundRun) ──

function test_parseStoredRules_corruptEitherProperty_fallsBackToEmptyArray() {
  withSavedProps(['AUTOTRASH_RULES', 'CATEGORY_RULES'], props => {
    props.setProperty('AUTOTRASH_RULES', 'not json');
    props.setProperty('CATEGORY_RULES', JSON.stringify([{ category: 'social' }]));
    const r1 = parseStoredRules();
    assertEqual(r1.rules, [], 'corrupted AUTOTRASH_RULES must fall back to []');
    assertEqual(r1.categoryRules, [{ category: 'social' }], 'a valid CATEGORY_RULES must still parse normally');

    props.setProperty('AUTOTRASH_RULES', '[]');
    props.setProperty('CATEGORY_RULES', 'not json either');
    const r2 = parseStoredRules();
    assertEqual(r2.categoryRules, [], 'corrupted CATEGORY_RULES must fall back to [] independently of AUTOTRASH_RULES');
  });
}
function test_parseStoredRules_missingProperties_defaultToEmptyArrays() {
  withSavedProps(['AUTOTRASH_RULES', 'CATEGORY_RULES'], props => {
    props.deleteProperty('AUTOTRASH_RULES');
    props.deleteProperty('CATEGORY_RULES');
    assertEqual(parseStoredRules(), { rules: [], categoryRules: [] });
  });
}
function test_readConfig_usesParseStoredRules_matchesGetUISettings() {
  withSavedProps(['AUTOTRASH_RULES', 'CATEGORY_RULES'], props => {
    props.setProperty('AUTOTRASH_RULES', JSON.stringify([{ label: 'X', days: 1 }]));
    props.setProperty('CATEGORY_RULES', '[]');
    assertEqual(readConfig().rules, getUISettings().rules, 'getUISettings() must be a thin wrapper over readConfig()');
  });
}

CONFIG_TESTS.push(
  test_parseStoredRules_corruptEitherProperty_fallsBackToEmptyArray,
  test_parseStoredRules_missingProperties_defaultToEmptyArrays,
  test_readConfig_usesParseStoredRules_matchesGetUISettings
);

// ── CONFIG BACKUP / RESTORE (2026-09-24) ──────────────────────────────────
// Guards against the exact failure reported live: a Save Config click that
// silently replaced a non-empty rule set with an empty one, with nothing to
// recover from. See app/Config.gs's "CONFIG BACKUP / RESTORE" comment.
const CONFIG_BACKUP_PROP_KEYS = ['AUTOTRASH_RULES', 'CATEGORY_RULES', 'AUTOTRASH_CONFIG_BACKUPS', 'TRIGGER_MODE'];

function test_writeConfig_snapshotsPreviousNonEmptyStateBeforeOverwriting() {
  withSavedProps(CONFIG_BACKUP_PROP_KEYS, function () {
    writeConfig(baseCfg({ rules: [{ label: 'Old', days: 30, isTrash: true }] }));
    writeConfig(baseCfg({ rules: [{ label: 'New', days: 10, isTrash: false }] }));
    const backups = listConfigBackups();
    assertEqual(backups.length, 1, 'a save over a non-empty config must create exactly one backup');
    assertEqual(backups[0].ruleCount, 1, 'the backup must summarize the PREVIOUS rule count, not the new one');
  });
}

function test_writeConfig_firstEverSave_createsNoBackup() {
  withSavedProps(CONFIG_BACKUP_PROP_KEYS, function (props) {
    props.deleteProperty('AUTOTRASH_RULES');
    props.deleteProperty('CATEGORY_RULES');
    props.deleteProperty('AUTOTRASH_CONFIG_BACKUPS');
    writeConfig(baseCfg({ rules: [{ label: 'First', days: 5, isTrash: true }] }));
    assertEqual(listConfigBackups(), [], 'the very first save (nothing to protect yet) must not create a backup entry');
  });
}

function test_snapshotConfigBackup_capsHistoryAtMaxNewestFirst() {
  withSavedProps(CONFIG_BACKUP_PROP_KEYS, function () {
    for (let i = 0; i < CONFIG_BACKUP_MAX + 2; i++) {
      writeConfig(baseCfg({ rules: [{ label: 'R' + i, days: 1, isTrash: true }] }));
    }
    assertEqual(listConfigBackups().length, CONFIG_BACKUP_MAX, 'backup history must be capped at CONFIG_BACKUP_MAX entries');
  });
}

function test_restoreConfigBackup_restoresRulesButLeavesOtherSettingsAlone() {
  withSavedProps(CONFIG_BACKUP_PROP_KEYS, function () {
    writeConfig(baseCfg({ rules: [{ label: 'Old', days: 30, isTrash: true }], triggerMode: 'OFF' }));
    writeConfig(baseCfg({ rules: [{ label: 'New', days: 10, isTrash: false }, { label: 'New2', days: 20, isTrash: false }], triggerMode: '5MIN' }));
    const backupTs = listConfigBackups()[0].ts;
    const result = restoreConfigBackup(backupTs);
    assertEqual(result.ok, true, 'restoring a known backup must report success');
    assertEqual(result.rules, [{ label: 'Old', days: 30, isTrash: true }], 'restore must return the backed-up rules');
    const after = readConfig();
    assertEqual(after.rules, [{ label: 'Old', days: 30, isTrash: true }], 'restore must bring back the backed-up rules as the current config');
    assertEqual(after.triggerMode, '5MIN', 'restore must not touch unrelated settings like triggerMode');
  });
}

function test_restoreConfigBackup_itselfCreatesARecoverableBackupOfPriorState() {
  withSavedProps(CONFIG_BACKUP_PROP_KEYS, function () {
    writeConfig(baseCfg({ rules: [{ label: 'Old', days: 30, isTrash: true }] }));
    writeConfig(baseCfg({ rules: [{ label: 'New', days: 10, isTrash: false }, { label: 'New2', days: 20, isTrash: false }] }));
    const beforeRestoreTs = listConfigBackups()[0].ts;
    restoreConfigBackup(beforeRestoreTs);
    const backups = listConfigBackups();
    assertEqual(backups[0].ruleCount, 2, 'restoring must itself snapshot the pre-restore state first, so restoring is undoable too');
    assertEqual(backups[1].ruleCount, 1, 'the original backup being restored from must still be there afterward');
  });
}

function test_restoreConfigBackup_unknownTimestamp_returnsNotOkAndChangesNothing() {
  withSavedProps(CONFIG_BACKUP_PROP_KEYS, function () {
    writeConfig(baseCfg({ rules: [{ label: 'Keep', days: 30, isTrash: true }] }));
    const result = restoreConfigBackup(123456789);
    assertEqual(result.ok, false, 'restoring an unknown timestamp must report failure');
    assertEqual(readConfig().rules, [{ label: 'Keep', days: 30, isTrash: true }], 'a failed restore must leave the current config untouched');
  });
}

function test_writeConfig_backupWriteFailure_neverBlocksTheRealSave() {
  withSavedProps(CONFIG_BACKUP_PROP_KEYS, function (props) {
    writeConfig(baseCfg({ rules: [{ label: 'Old', days: 30, isTrash: true }] }));
    const realSetProperty = props.setProperty;
    props.setProperty = function (key, value) {
      if (key === 'AUTOTRASH_CONFIG_BACKUPS') throw new Error('simulated quota exceeded');
      return realSetProperty.call(props, key, value);
    };
    try {
      let threw = false;
      try { writeConfig(baseCfg({ rules: [{ label: 'New', days: 10, isTrash: false }] })); }
      catch (e) { threw = true; }
      assertEqual(threw, false, 'a backup write failure must never throw out of writeConfig()');
      assertEqual(readConfig().rules, [{ label: 'New', days: 10, isTrash: false }],
        'the real config write must still succeed even when the backup itself could not be saved');
    } finally { props.setProperty = realSetProperty; }
  });
}

CONFIG_TESTS.push(
  test_writeConfig_snapshotsPreviousNonEmptyStateBeforeOverwriting,
  test_writeConfig_firstEverSave_createsNoBackup,
  test_snapshotConfigBackup_capsHistoryAtMaxNewestFirst,
  test_restoreConfigBackup_restoresRulesButLeavesOtherSettingsAlone,
  test_restoreConfigBackup_itselfCreatesARecoverableBackupOfPriorState,
  test_restoreConfigBackup_unknownTimestamp_returnsNotOkAndChangesNothing,
  test_writeConfig_backupWriteFailure_neverBlocksTheRealSave
);

// ── CONFIG_SCHEMA (2026-09-24) — read/write/backup are schema-driven ──────
// These guard the actual point of the refactor: readConfig()/writeConfig()
// must not hardcode field names anywhere else in this file, so a new
// setting added to CONFIG_SCHEMA in app/Config.gs is automatically read,
// written, and (if backup:true) included in backups/restore — without
// touching readConfig(), writeConfig(), snapshotConfigBackup(),
// listConfigBackups() or restoreConfigBackup() at all.

function test_configSchema_everyFieldRoundTripsThroughReadAndWriteConfig() {
  const keys = CONFIG_SCHEMA.map(f => f.prop);
  withSavedProps(keys.concat(['AUTOTRASH_CONFIG_BACKUPS']), function () {
    writeConfig(baseCfg({
      rules: [{ label: 'RoundTrip', days: 7, isTrash: true }],
      categoryRules: [{ category: 'promos', enabled: true, days: 14 }],
      triggerMode: 'HOURLY', summaryFreq: 'ALT_DAYS',
      globalPurgeDays: '180', inboxPurgeDays: '45', digestHour: 6
    }));
    const cfg = readConfig();
    CONFIG_SCHEMA.forEach(function (field) {
      assert(cfg[field.key] !== undefined, 'readConfig() must return every CONFIG_SCHEMA field: ' + field.key);
    });
    assertEqual(cfg.triggerMode, 'HOURLY');
    assertEqual(cfg.summaryFreq, 'ALT_DAYS');
    assertEqual(cfg.globalPurgeDays, '180');
    assertEqual(cfg.inboxPurgeDays, '45');
    assertEqual(cfg.digestHour, '6');
  });
}

function test_configSchema_addingAFieldAtRuntime_isPickedUpByReadWriteWithNoOtherCodeChange() {
  // Simulates "add a future setting": push one schema entry, not marked for
  // backup, and confirm readConfig()/writeConfig() honor it purely by
  // walking CONFIG_SCHEMA — the whole point of the refactor.
  withSavedProps(['AUTOTRASH_TEST_FUTURE_SETTING'], function () {
    const fakeField = { key: 'futureSetting', prop: 'AUTOTRASH_TEST_FUTURE_SETTING', type: 'string', default: 'DEFAULT_VAL' };
    CONFIG_SCHEMA.push(fakeField);
    try {
      assertEqual(readConfig().futureSetting, 'DEFAULT_VAL', 'a brand-new schema field must read its default with nothing stored yet');
      writeConfig(baseCfg({ futureSetting: 'CUSTOM_VAL' }));
      assertEqual(readConfig().futureSetting, 'CUSTOM_VAL', 'writeConfig() must persist a field it only knows about via CONFIG_SCHEMA');
      assertEqual(getProps().getProperty('AUTOTRASH_TEST_FUTURE_SETTING'), 'CUSTOM_VAL');
    } finally {
      CONFIG_SCHEMA.pop();
    }
  });
}

function test_configSchema_backupEligibleFieldIsGenericallyIncludedInBackupsAndRestore() {
  // A future backup:true field (not just today's rules/categoryRules) must
  // flow through snapshotConfigBackup()/listConfigBackups()/
  // restoreConfigBackup() with zero changes to those functions.
  withSavedProps(['AUTOTRASH_TEST_FUTURE_LIST', 'AUTOTRASH_CONFIG_BACKUPS', 'AUTOTRASH_RULES', 'CATEGORY_RULES'], function () {
    const fakeField = {
      key: 'futureList', prop: 'AUTOTRASH_TEST_FUTURE_LIST', type: 'json', default: [],
      backup: true, countKey: 'futureListCount', countFn: v => (v || []).length
    };
    CONFIG_SCHEMA.push(fakeField);
    try {
      writeConfig(baseCfg({ futureList: [{ x: 1 }] }));
      writeConfig(baseCfg({ futureList: [{ x: 1 }, { x: 2 }] }));
      const backups = listConfigBackups();
      assertEqual(backups[0].futureListCount, 1, 'a new backup:true field must show up in listConfigBackups() automatically');

      const result = restoreConfigBackup(backups[0].ts);
      assertEqual(result.futureList, [{ x: 1 }], 'restoreConfigBackup() must restore a new backup:true field automatically');
      assertEqual(readConfig().futureList, [{ x: 1 }]);
    } finally {
      CONFIG_SCHEMA.pop();
    }
  });
}

CONFIG_TESTS.push(
  test_configSchema_everyFieldRoundTripsThroughReadAndWriteConfig,
  test_configSchema_addingAFieldAtRuntime_isPickedUpByReadWriteWithNoOtherCodeChange,
  test_configSchema_backupEligibleFieldIsGenericallyIncludedInBackupsAndRestore
);
