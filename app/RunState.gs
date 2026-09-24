/**
 * AutoTrash — the shared run registry: one server-side record of "the run
 * that is happening right now", whoever started it.
 *
 * Why this exists (Issues #82 / #79, S-N8 / S-N3): a live run used to live
 * entirely inside the browser tab that started it — its payload, its log and
 * its Abort button. Another device, another tab, or the same phone after its
 * screen locked had no way to see it, stop it, or pick it back up; and a
 * background (trigger) run was invisible to every open dashboard. This file
 * gives both kinds of run one record that every open dashboard polls:
 *
 *   RUN_STATE   (UserProperties, small JSON) — who/what/when: id, source
 *                 ('live' | 'background'), dryRun, status, driverId (the tab
 *                 currently driving a live run), current rule, rules left,
 *                 heartbeat (updatedAt), log sequence number, end message.
 *   RUN_ABORT   (UserProperties, plain run id) — the abort request. Its own
 *                 key on purpose: an abort from another device only ever
 *                 WRITES this key, and the runner only ever READS it, so an
 *                 abort can never be lost to a read-modify-write race with a
 *                 runner updating RUN_STATE at the same moment.
 *   RUN_DETAIL_<id>  (UserCache) — log tail, full stats, rule list for the
 *                 progress bars. Too big for a property; losing it to cache
 *                 eviction only blanks a viewer's log, never the run itself.
 *   RUN_PAYLOAD_<id> (UserCache) — the live run's full burst payload after
 *                 each burst, so another device can resume a run whose
 *                 driving tab went away (see claimRun()).
 *
 * Writers of RUN_STATE/RUN_DETAIL (live bursts, backgroundRun, startLiveRun,
 * claimRun, abortRun) all hold the script lock while they write, so they
 * never interleave. Readers (getRunStatus) and requestAbort() take no lock,
 * so a dashboard stays responsive while a burst is mid-flight.
 *
 * Added 2026-09-24. See docs/feature-reference.txt §2e for behavior.
 */

const RUN_STATE_KEY     = 'RUN_STATE';
const RUN_ABORT_KEY     = 'RUN_ABORT';
const RUN_DETAIL_PREFIX = 'RUN_DETAIL_';
const RUN_PAYLOAD_PREFIX = 'RUN_PAYLOAD_';
const RUN_CACHE_TTL_S   = 21600;   // 6 h — CacheService's maximum
const RUN_CACHE_MAX     = 95000;   // stay under CacheService's 100 KB/value cap
const RUN_LOG_MAX       = 150;     // log lines kept for viewers
// A run whose heartbeat is older than this is treated as gone (the driving
// tab closed / phone locked, or a background execution was killed by Apps
// Script's own time limit before it could mark itself finished). A single
// live burst can legitimately take a while (500-thread search + 5 batch
// calls), so the live window is generous.
const RUN_STALE_MS = { live: 90000, background: 150000 };

// ─── LOW-LEVEL STORAGE ────────────────────────────────────────────────────────
function newRunId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function runCache() {
  try { return CacheService.getUserCache(); } catch (e) { return null; }
}
function cacheGetJson(key) {
  const c = runCache();
  if (!c) return null;
  try { const raw = c.get(key); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
}
function cachePutJson(key, obj) {
  const c = runCache();
  if (!c) return false;
  try {
    const raw = JSON.stringify(obj);
    if (raw.length > RUN_CACHE_MAX) return false;
    c.put(key, raw, RUN_CACHE_TTL_S);
    return true;
  } catch (e) { return false; }
}

// Defensive, like parseStoredRules(): a corrupted value reads as "no run".
function readRunState() {
  try {
    const raw = getProps().getProperty(RUN_STATE_KEY);
    const s = raw ? JSON.parse(raw) : null;
    return (s && typeof s === 'object' && s.id) ? s : null;
  } catch (e) { return null; }
}
function writeRunState(s) {
  getProps().setProperty(RUN_STATE_KEY, JSON.stringify(s));
}
function abortRequestedFor(runId) {
  return !!runId && getProps().getProperty(RUN_ABORT_KEY) === runId;
}

function isRunStale(s, now) {
  if (!s) return false;
  const limit = RUN_STALE_MS[s.source] || RUN_STALE_MS.live;
  return (now || Date.now()) - (s.updatedAt || 0) > limit;
}
// "Active" = still running (or aborting) AND recently heard from.
function isRunActive(s, now) {
  return !!s && s.status === 'running' && !isRunStale(s, now);
}

// ─── LOCK HELPER ──────────────────────────────────────────────────────────────
// Runs fn() under the script lock. Returns { ok:false } instead of throwing
// if the lock can't be had in time, so callers decide what "busy" means.
function withRunLock(waitMs, fn) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(waitMs); }
  catch (e) { return { ok: false, busy: true }; }
  try { return { ok: true, value: fn() }; }
  finally { lock.releaseLock(); }
}

// ─── RECORDING (runners call these while holding the script lock) ────────────
// Creates a fresh run record and detail blob. Clears any stale abort flag.
function beginRun(opts) {
  const now = Date.now();
  const s = {
    id:        opts.id || newRunId(),
    source:    opts.source || 'live',
    dryRun:    !!opts.dryRun,
    status:    'running',
    driverId:  opts.driverId || null,
    startedAt: now,
    updatedAt: now,
    rule:      opts.rule || null,
    left:      opts.left || 0,
    seq:       0,
    endedAt:   null,
    endMsg:    null
  };
  getProps().deleteProperty(RUN_ABORT_KEY);
  const detail = { log: [], stats: opts.stats || null, queue: opts.queue || [] };
  appendRunLog(s, detail, opts.log || []);
  writeRunState(s);
  cachePutJson(RUN_DETAIL_PREFIX + s.id, detail);
  return s;
}

// Adds log lines with absolute timestamps + a monotonic seq (viewers ask for
// "everything after seq N"). Mutates s.seq and detail.log.
function appendRunLog(s, detail, entries) {
  (entries || []).forEach(e => {
    s.seq = (s.seq || 0) + 1;
    detail.log.push({ seq: s.seq, ts: e.ts || Date.now(), level: e.level, msg: e.msg });
  });
  if (detail.log.length > RUN_LOG_MAX) detail.log = detail.log.slice(-RUN_LOG_MAX);
}

// One progress update. Ignored if the record has moved on (another run
// started, or this one was already finished/aborted) so a straggling burst
// can never resurrect a finished run.
function recordRunProgress(runId, upd) {
  const s = readRunState();
  if (!s || s.id !== runId || s.status !== 'running') return null;
  const detail = cacheGetJson(RUN_DETAIL_PREFIX + runId) || { log: [], stats: null, queue: [] };
  appendRunLog(s, detail, upd.log);
  if (upd.stats)                 detail.stats = upd.stats;
  if (upd.rule !== undefined)    s.rule = upd.rule;
  if (upd.left !== undefined)    s.left = upd.left;
  s.updatedAt = Date.now();
  writeRunState(s);
  cachePutJson(RUN_DETAIL_PREFIX + runId, detail);
  if (upd.payload) saveRunPayload(runId, upd.payload);
  return s;
}

// Marks the run finished. status: 'done' | 'aborted' | 'error'.
function endRun(runId, status, msg, stats) {
  const s = readRunState();
  if (!s || s.id !== runId) return null;
  const detail = cacheGetJson(RUN_DETAIL_PREFIX + runId) || { log: [], stats: null, queue: [] };
  if (stats) detail.stats = stats;
  if (msg) appendRunLog(s, detail, [{ level: status === 'error' ? 'ERROR' : (status === 'aborted' ? 'ERROR' : 'COMPLETE'), msg: msg }]);
  s.status  = status;
  s.endMsg  = msg || null;
  s.endedAt = Date.now();
  s.updatedAt = s.endedAt;
  s.left    = status === 'done' ? 0 : s.left;
  writeRunState(s);
  cachePutJson(RUN_DETAIL_PREFIX + runId, detail);
  if (getProps().getProperty(RUN_ABORT_KEY) === runId) getProps().deleteProperty(RUN_ABORT_KEY);
  const c = runCache();
  if (c) { try { c.remove(RUN_PAYLOAD_PREFIX + runId); } catch (e) {} }
  return s;
}

// Saves the resumable burst payload. seenIds can grow large on a very long
// run (S-N10); if the whole payload won't fit in one cache value, it is
// saved without seenIds and flagged, so a resume still works — it just
// starts a fresh dedup set (Gmail moves are idempotent; see §2d).
function saveRunPayload(runId, payload) {
  if (cachePutJson(RUN_PAYLOAD_PREFIX + runId, payload)) return true;
  const slim = Object.assign({}, payload, { seenIds: [], seenIdsDropped: true });
  return cachePutJson(RUN_PAYLOAD_PREFIX + runId, slim);
}

// Public shape handed to the browser.
function runView(s, now) {
  if (!s) return null;
  now = now || Date.now();
  return {
    id: s.id, source: s.source, dryRun: s.dryRun, status: s.status,
    driverId: s.driverId, startedAt: s.startedAt, updatedAt: s.updatedAt,
    endedAt: s.endedAt, endMsg: s.endMsg, rule: s.rule, left: s.left,
    seq: s.seq || 0,
    stale: s.status === 'running' && isRunStale(s, now),
    active: isRunActive(s, now),
    abortRequested: abortRequestedFor(s.id)
  };
}

// ─── CLIENT API (called from index.html via google.script.run) ───────────────

// Polled by every open dashboard. sinceSeq lets a viewer fetch only new log
// lines; sinceSeq < 0 (or a different run than the viewer last saw) returns
// the whole retained tail.
function getRunStatus(sinceSeq, knownRunId) {
  const now = Date.now();
  const s = readRunState();
  const out = {
    serverNow: now,
    lastRun: getProps().getProperty('LAST_RUN_TIME') || 'Never',
    run: runView(s, now),
    log: [], stats: null, queue: []
  };
  if (!s) return out;
  const detail = cacheGetJson(RUN_DETAIL_PREFIX + s.id) || { log: [], stats: null, queue: [] };
  const from = (knownRunId === s.id && typeof sinceSeq === 'number') ? sinceSeq : -1;
  out.log   = (detail.log || []).filter(e => e.seq > from);
  out.stats = detail.stats || null;
  out.queue = detail.queue || [];
  return out;
}

// Registers a new live run for the tab identified by meta.driverId. Refuses
// (and returns the run that IS happening) if another run is still active —
// this is the cross-tab/cross-device coordination S-N8 asked for.
function startLiveRun(meta) {
  meta = meta || {};
  const r = withRunLock(10000, () => {
    const cur = readRunState();
    if (isRunActive(cur)) return { ok: false, reason: 'busy', run: runView(cur) };
    const s = beginRun({
      source: 'live', dryRun: !!meta.dryRun, driverId: meta.driverId,
      rule: meta.rule || null, left: meta.left || 0,
      stats: meta.stats || null, queue: meta.queue || [],
      log: [{ level: 'INFO', msg: `START · ${meta.left || 0} rule(s) · ${meta.dryRun ? 'DRY RUN' : 'LIVE'} · manual run` }]
    });
    return { ok: true, runId: s.id, run: runView(s) };
  });
  return r.ok ? r.value : { ok: false, reason: 'lock', run: runView(readRunState()) };
}

// Asks the current run to stop. Works from any device, for live and
// background runs alike. The runner notices at its next checkpoint (the next
// burst for a live run, the next rule for a background run). If the run has
// no living runner (stale), it is finalized right here instead, since nobody
// else is left to do it.
function requestAbort(runId) {
  const s = readRunState();
  if (!s || s.id !== runId || s.status !== 'running') return { ok: false, run: runView(s) };
  getProps().setProperty(RUN_ABORT_KEY, runId);
  if (isRunStale(s)) {
    const detail = cacheGetJson(RUN_DETAIL_PREFIX + runId) || {};
    abortRun(detail.stats || {}, Date.now() - (s.startedAt || Date.now()), s.dryRun, runId);
  }
  return { ok: true, run: runView(readRunState()) };
}

// Takes over driving a live run from another tab/device (or from a tab that
// went away). Waits for any in-flight burst to finish first (script lock), so
// the old driver's next burst sees it has been superseded and stops — the two
// can never both be bursting. Returns the saved payload to continue from.
function claimRun(runId, driverId) {
  const r = withRunLock(60000, () => {
    const s = readRunState();
    if (!s || s.id !== runId || s.status !== 'running')
      return { ok: false, reason: 'This run has already finished.' };
    if (s.source !== 'live')
      return { ok: false, reason: 'Background runs are driven by the trigger and can only be aborted.' };
    if (abortRequestedFor(runId))
      return { ok: false, reason: 'An abort is already pending for this run.' };
    const payload = cacheGetJson(RUN_PAYLOAD_PREFIX + runId);
    if (!payload) return { ok: false, reason: 'Run state expired — abort it and start a new run.' };
    const detail = cacheGetJson(RUN_DETAIL_PREFIX + runId) || { log: [], stats: null, queue: [] };
    s.driverId = driverId;
    s.updatedAt = Date.now();
    appendRunLog(s, detail, [{ level: 'INFO', msg: 'Run resumed on another device.' +
      (payload.seenIdsDropped ? ' (dedup list was too large to carry over — starting it fresh)' : '') }]);
    writeRunState(s);
    cachePutJson(RUN_DETAIL_PREFIX + runId, detail);
    payload.runId = runId;
    payload.driverId = driverId;
    return { ok: true, payload: payload, run: runView(s), queue: detail.queue || [] };
  });
  return r.ok ? r.value : { ok: false, reason: 'Server busy — try again in a moment.' };
}

// "Abort and stop the trigger from starting it again": switches the stored
// background trigger mode to OFF and re-syncs triggers (same path as Save
// Config), leaving every other saved setting untouched.
function pauseBackgroundTrigger() {
  const cfg = readConfig();
  cfg.triggerMode = 'OFF';
  updateSystem(cfg);
  return cfg.triggerMode;
}
