'use strict';

/**
 * AutoTrash — baseline Apps Script service mocks for the Node test harness.
 *
 * These are ONLY a safety-net baseline: harmless no-ops so a test never
 * crashes on `undefined.method()` if it forgets to install a spy. Every
 * test that actually exercises GmailApp/LockService/ScriptApp behavior
 * overrides these via tests/TestFramework.gs's installGmailSpy() /
 * installLockSpy() / installScriptAppSpy() — exactly as it does in the
 * real Apps Script editor, where those spies reassign the same globals.
 *
 * PropertiesService and Session are NOT spied anywhere in the test suite
 * (getProps()/ownerEmail() are used directly), so this file gives them a
 * real, working implementation: an in-memory key/value store that behaves
 * like Apps Script's UserProperties for the lifetime of one harness run.
 *
 * createGlobals() returns a FRESH set of these on every call so tests.gs
 * behavior (e.g. corrupted-property tests) never leaks state between
 * separate `node tests/harness/run-node-tests.js` invocations — though
 * within one run all tests still share one PropertiesService store, same
 * as they'd share one real UserProperties store across one runAllTests()
 * execution in the Apps Script editor.
 */

function createPropertiesService() {
  const store = new Map();
  const userProperties = {
    getProperty(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setProperty(key, value) {
      store.set(key, String(value));
      return userProperties;
    },
    setProperties(obj) {
      Object.keys(obj).forEach(k => store.set(k, String(obj[k])));
      return userProperties;
    },
    deleteProperty(key) {
      store.delete(key);
      return userProperties;
    },
    getProperties() {
      return Object.fromEntries(store);
    }
  };
  return {
    getUserProperties() { return userProperties; },
    getScriptProperties() { return userProperties; },
    getDocumentProperties() { return userProperties; }
  };
}

function createGmailApp() {
  // No spy installed: every method is a harmless no-op returning empty
  // results, so a test that forgets installGmailSpy() fails loudly on a
  // wrong assertion rather than a confusing TypeError.
  return {
    search() { return []; },
    moveThreadsToTrash() {},
    moveThreadsToArchive() {},
    sendEmail() {}
  };
}

function createLockService() {
  return {
    getScriptLock() {
      return {
        waitLock() {},
        releaseLock() {}
      };
    }
  };
}

function createScriptApp() {
  return {
    getService() { return { getUrl() { return ''; } }; },
    getProjectTriggers() { return []; },
    deleteTrigger() {},
    newTrigger(handlerFn) {
      const config = {};
      const builder = {
        timeBased()      { return builder; },
        everyMinutes(n)  { config.everyMinutes = n; return builder; },
        everyHours(n)    { config.everyHours = n; return builder; },
        everyDays(n)     { config.everyDays = n; return builder; },
        atHour(n)        { config.atHour = n; return builder; },
        create()         { return { getHandlerFunction: () => handlerFn, getUniqueId: () => 'trig_stub' }; }
      };
      return builder;
    }
  };
}

function createSession() {
  return {
    getEffectiveUser() { return { getEmail() { return 'test-owner@example.com'; } }; },
    getActiveUser() { return { getEmail() { return 'test-owner@example.com'; } }; }
  };
}

function createHtmlService() {
  const chainable = {
    setTitle() { return chainable; },
    setXFrameOptionsMode() { return chainable; },
    getContent() { return ''; }
  };
  return {
    createHtmlOutputFromFile() { return chainable; },
    createHtmlOutput() { return chainable; },
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' }
  };
}

/**
 * Returns a fresh object of Apps Script global service bindings, ready to
 * be spread into a vm sandbox. Each key here becomes a top-level global
 * inside the vm context, exactly matching the names app/*.gs and
 * tests/*.gs reference directly (GmailApp, PropertiesService, ...).
 */
function createGlobals() {
  return {
    GmailApp: createGmailApp(),
    PropertiesService: createPropertiesService(),
    LockService: createLockService(),
    ScriptApp: createScriptApp(),
    Session: createSession(),
    HtmlService: createHtmlService(),
    console
  };
}

module.exports = { createGlobals };
