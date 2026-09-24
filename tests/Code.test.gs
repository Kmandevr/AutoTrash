/**
 * AutoTrash tests — app/Code.gs (getUISettings, updateSystem's trigger
 * management + property persistence).
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

const CODE_TESTS = [
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
