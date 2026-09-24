/**
 * AutoTrash — shared test framework: assertions, Apps Script service spies,
 * and fixtures used by every tests/*.test.gs file. No tests of its own
 * except a self-test of assertThrows.
 *
 * Split out of the former monolithic tests/Tests.gs on 2026-09-24 — see
 * CLAUDE.md for the full test-file map and why the split mirrors app/.
 */

// ════════════════════════════════════════════════════════════════════════
// ASSERTIONS
// ════════════════════════════════════════════════════════════════════════

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error((msg ? msg + ' — ' : '') + `expected ${e}, got ${a}`);
}
function assertThrows(fn, msg) {
  try { fn(); } catch (e) { return; }
  throw new Error(msg || 'expected function to throw, it did not');
}

function test_assertThrows_frameworkHelperWorks() {
  assertThrows(function () { throw new Error('x'); }, 'assertThrows must not raise when fn throws');
  let caught = false;
  try { assertThrows(function () {}, 'expected failure'); }
  catch (e) { caught = true; }
  assert(caught, 'assertThrows must itself throw when fn does NOT throw');
}

// Saves a UserProperties key, runs fn(), restores the original value (or
// deletes the key if it never existed) even if fn() throws.
function withSavedProps(keys, fn) {
  const props = getProps();
  const saved = {};
  keys.forEach(k => { saved[k] = props.getProperty(k); });
  try {
    fn(props);
  } finally {
    keys.forEach(k => {
      if (saved[k] === null || saved[k] === undefined) props.deleteProperty(k);
      else props.setProperty(k, saved[k]);
    });
  }
}

// ── FAKE GMAIL THREAD ─────────────────────────────────────────────────────
function makeFakeThread(id) {
  return {
    __id: String(id),
    __trashed: false,
    __archived: false,
    getId: function () { return this.__id; }
  };
}

// Fresh stats object matching the shape processLiveBurst()/backgroundRun()
// build for themselves — shared by every test that needs one.
function freshStats() {
  return {
    totalMoved: 0, totalTrashed: 0, totalArchived: 0,
    globalPurgeMoved: 0, globalPurgeTrashed: 0,
    inboxPurgeMoved: 0, inboxPurgeTrashed: 0,
    dryTrashed: 0, dryArchived: 0,
    labels: {}, errors: []
  };
}

// ── GMAILAPP SPY ──────────────────────────────────────────────────────────
// searchImpl(query) must return an array of fake threads for that query.
// Pass a plain array to match every query the same way regardless of text.
function installGmailSpy(searchImpl) {
  const real = (typeof GmailApp !== 'undefined') ? GmailApp : null;
  const calls = { search: [], trashBatches: [], archiveBatches: [], emails: [] };
  const resolve = Array.isArray(searchImpl) ? (() => searchImpl) : searchImpl;

  const fake = {
    search: function (q, start, max) {
      calls.search.push(q);
      const all = resolve(q) || [];
      const s = start || 0, m = max == null ? all.length : max;
      return all.slice(s, s + m);
    },
    moveThreadsToTrash: function (threads) {
      calls.trashBatches.push(threads.map(t => t.getId()));
      threads.forEach(t => { t.__trashed = true; });
    },
    moveThreadsToArchive: function (threads) {
      calls.archiveBatches.push(threads.map(t => t.getId()));
      threads.forEach(t => { t.__archived = true; });
    },
    sendEmail: function (to, subj, body, opts) {
      calls.emails.push({ to: to, subj: subj, body: body, opts: opts });
    }
  };

  GmailApp = fake; // reassign the global binding — see file header for why.

  return {
    calls: calls,
    restore: function () { GmailApp = real; }
  };
}

// ── LOCKSERVICE SPY (backgroundRun tests only) ───────────────────────────
function installLockSpy(opts) {
  opts = opts || {};
  const real = (typeof LockService !== 'undefined') ? LockService : null;
  let released = false;
  const fake = {
    getScriptLock: function () {
      return {
        waitLock: function () {
          if (opts.failToAcquire) throw new Error('Could not obtain lock.');
        },
        releaseLock: function () { released = true; }
      };
    }
  };
  LockService = fake;
  return {
    wasReleased: function () { return released; },
    restore: function () { LockService = real; }
  };
}

// ── SCRIPTAPP SPY (updateSystem trigger tests) ───────────────────────────
function installScriptAppSpy(existingTriggers) {
  const real = (typeof ScriptApp !== 'undefined') ? ScriptApp : null;
  let triggers = (existingTriggers || []).slice();
  let nextId = 1;
  const calls = { newTrigger: [], deleteTrigger: [] };

  function makeTriggerObj(handlerFn, config) {
    const id = 'trig_' + (nextId++);
    return {
      __id: id,
      config: config,
      getHandlerFunction: function () { return handlerFn; },
      getUniqueId: function () { return id; }
    };
  }

  const fake = {
    getService: (real && real.getService) || function () { return { getUrl: function () { return ''; } }; },
    getProjectTriggers: function () { return triggers.slice(); },
    deleteTrigger: function (t) {
      calls.deleteTrigger.push(t.getHandlerFunction());
      triggers = triggers.filter(function (x) { return x !== t; });
    },
    newTrigger: function (handlerFn) {
      calls.newTrigger.push(handlerFn);
      const config = {};
      const builder = {
        timeBased:     function ()  { return builder; },
        everyMinutes:  function (n) { config.everyMinutes = n; return builder; },
        everyHours:    function (n) { config.everyHours   = n; return builder; },
        everyDays:     function (n) { config.everyDays    = n; return builder; },
        atHour:        function (n) { config.atHour       = n; return builder; },
        create: function () {
          const t = makeTriggerObj(handlerFn, config);
          triggers.push(t);
          return t;
        }
      };
      return builder;
    }
  };
  ScriptApp = fake;
  return {
    calls: calls,
    triggers: function () { return triggers.slice(); },
    restore: function () { ScriptApp = real; }
  };
}

const TESTFRAMEWORK_TESTS = [
  test_assertThrows_frameworkHelperWorks
];
