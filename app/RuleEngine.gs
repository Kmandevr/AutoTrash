/**
 * AutoTrash — turns a rule (custom label or Gmail category) into a Gmail
 * search query, resolves its trash/archive action, and builds the run queue.
 * This is the "rule definition + query" stage of the engine; searching,
 * message context and action execution live in Engine.gs.
 * Split out of Code.gs on 2026-09-22; see CLAUDE.md for the full file map.
 */

// ─── QUERY BUILDER ────────────────────────────────────────────────────────────
// FIX 1: ALL label and category rules use 'in:inbox' regardless of action.
// FIX 4: Spam is not a Gmail category tab → use 'in:spam' instead.
function buildQuery(rule) {
  const star     = '-is:starred';
  const notTrash = '-in:trash';

  if (rule.isGlobalPurge) {
    // FIX 7: Use All Mail scope (no inbox restriction) to reach archived mail.
    return `older_than:${rule.days}d ${star} -in:trash -in:spam`;
  }
  if (rule.isInboxPurge) {
    // FIX 13 (BUG-C4): Removed redundant -in:trash — in:inbox already excludes trash.
    return `in:inbox older_than:${rule.days}d ${star}`;
  }
  if (rule.isCategory) {
    if (rule.category === 'spam') {
      // FIX 4: spam lives in in:spam, not a Gmail category tab.
      return `in:spam older_than:${rule.days}d ${star} -in:trash`;
    }
    // FIX 1: in:inbox scope so archived threads stay archived.
    return `category:${rule.category} in:inbox older_than:${rule.days}d ${star} ${notTrash}`;
  }
  // Label rule — FIX 1: in:inbox keeps archive/trash actions permanent.
  // FIX 45 (BUG-C20): strip any literal " from the label before embedding it
  // in the quoted search term. Gmail search has no escape mechanism for a
  // quote character inside a quoted phrase — an embedded " would prematurely
  // close the phrase (e.g. label:"Foo"Bar" is parsed as label:"Foo" plus a
  // stray bareword term "Bar"), silently widening the match beyond the label
  // the user actually configured. Only the search term is affected — the
  // stored/displayed label text (index.html's rule list, the email table)
  // is completely untouched by this; escHtml() there is a separate concern.
  const safeLabel = String(rule.label).replace(/"/g, '');
  return `label:"${safeLabel}" in:inbox older_than:${rule.days}d ${star} ${notTrash}`;
}

// ─── RESOLVE ACTION ───────────────────────────────────────────────────────────
// FIX 8: only archive when isTrash is EXPLICITLY false.
// isTrash === true  → trash
// isTrash === false → archive  (user explicitly chose archive)
// isTrash undefined/null → trash (safer default; guards stale/migrated rules)
function resolveRuleAction(rule) {
  if (rule.isGlobalPurge || rule.isInboxPurge) return 'trash';
  return rule.isTrash === false ? 'archive' : 'trash';
}

// ─── RULE LABEL ──────────────────────────────────────────────────────────────
// The display/stats key for a rule. FIX 17 (BUG-C8): category rules saved
// without a label field fall back to the UPPERCASE category name, so daily
// stats keys match the digest's per-rule table. Previously computed inline,
// identically, in both processLiveBurst() and backgroundRun().
function ruleLabel(rule) {
  return rule.label || (rule.isCategory ? rule.category.toUpperCase() : '?');
}

// ─── QUEUE BUILDER ────────────────────────────────────────────────────────────
function buildQueue(rules, globalDays, inboxDays, categoryRules) {
  const q = (rules || []).map(r => ({ ...r }));
  (categoryRules || []).filter(r => r.enabled).forEach(r =>
    q.push({ ...r, isCategory: true })
  );
  if (inboxDays  !== 'OFF') q.push({ isInboxPurge: true,  isTrash: true, days: +inboxDays,  label: 'INBOX PURGE'  });
  if (globalDays !== 'OFF') q.push({ isGlobalPurge: true, isTrash: true, days: +globalDays, label: 'GLOBAL PURGE' });  // BUG-R5: matches the email
  return q;
}

// ─── ACTION EXECUTION ────────────────────────────────────────────────────────
// Moved to Engine.gs on 2026-09-24: executeAction() (any action) plus a
// backwards-compatible executeActions(toTrash, toArchive, emit) wrapper.

// ─── STAT HELPERS ────────────────────────────────────────────────────────────
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

