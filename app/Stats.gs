/**
 * AutoTrash — per-run stat crediting (ensureStat/creditStat) and daily-digest
 * accumulation (accumulateDailyStats). Split out of RuleEngine.gs and
 * Runner.gs on 2026-09-24; see CLAUDE.md for the full file map.
 *
 * This is cleanup POLICY, not engine: it knows about labels, purge rules
 * and the digest period, none of which app/Engine.gs's action/context
 * pipeline needs to know about. Kept separate on purpose — see
 * docs/engine.txt §3.
 */

// ─── PER-RUN STAT HELPERS ─────────────────────────────────────────────────────
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
