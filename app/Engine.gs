/**
 * AutoTrash — the reusable engine underneath both runners.
 *
 * AutoTrash's job is deciding WHICH Gmail threads a rule applies to, safely.
 * This file is that machinery, split into small stages that a runner — or a
 * future feature — can compose without copying any of it:
 *
 *   rule ──► buildQuery(rule)          RuleEngine.gs (unchanged)
 *        ──► refineQuery(base, extra)  optional, narrow-only
 *        ──► findMatches(rule, opts)   search → seen-dedup → filter(ctx)
 *        ──► makeMessageContext(...)   lazy per-thread context
 *        ──► executeAction(action, contexts, run)
 *                                      the ONE place a Gmail mutation happens:
 *                                      seen-registration, dry-run, chunking,
 *                                      batch logging
 *   runRule(rule, run, opts) composes all of the above for one rule.
 *
 * What stays OUTSIDE this file on purpose: queue building, round-robin
 * rotation, ejection, stats crediting, emails, locking and time budgets.
 * Those are AutoTrash's cleanup policy and live in Runner.gs / RuleEngine.gs /
 * EmailSend.gs as before. See docs/engine.txt for how to build a feature on
 * top of this file.
 *
 * Added 2026-09-24. Everything here is a plain global function, like the rest
 * of the backend — Apps Script shares one global scope across .gs files.
 */

// ─── ACTIONS ─────────────────────────────────────────────────────────────────
// An action is a plain object with a `name` and EITHER:
//   bulk(threads, contexts) — called once per chunk of ≤ GMAIL_CHUNK threads
//                             (use for Gmail's batch calls)
//   each(context)           — called once per matched thread; its return value
//                             is collected into the result's `results` array
// Optional: verb  ('TRASHING') for the live ACTION log line,
//           batchLabel ('Trash') for the BATCH summary log line.
//
// Actions are only ever invoked through executeAction(), which is what makes
// dry-run, dedup and logging uniform across every action — built-in or not.
const ENGINE_ACTIONS = {
  trash: {
    name: 'trash', verb: 'TRASHING', batchLabel: 'Trash',
    bulk: function (threads) { GmailApp.moveThreadsToTrash(threads); }
  },
  archive: {
    name: 'archive', verb: 'ARCHIVING', batchLabel: 'Archive',
    bulk: function (threads) { GmailApp.moveThreadsToArchive(threads); }
  }
};

// Resolve an action name ('trash') or an action object to a validated action
// object. Throws on anything unusable so a typo fails loudly, never silently.
function getAction(action) {
  const def = (typeof action === 'string') ? ENGINE_ACTIONS[action] : action;
  if (!def || typeof def !== 'object')
    throw new Error('Unknown AutoTrash action: ' + String(action));
  if (typeof def.bulk !== 'function' && typeof def.each !== 'function')
    throw new Error('AutoTrash action "' + (def.name || '?') + '" needs a bulk() or each() function');
  if (!def.name) throw new Error('AutoTrash action needs a name');
  return def;
}

// Optional: make an action addressable by name. Call this from inside a
// function (e.g. at the top of your feature's entry point), NOT at file top
// level — Apps Script loads .gs files in project order, so a top-level call in
// a file that loads before this one would hit ENGINE_ACTIONS before it exists.
// Passing the action object straight to runRule()/executeAction() needs no
// registration at all and is the simpler option.
function registerAction(def) {
  if (def && (def.name === 'trash' || def.name === 'archive'))
    throw new Error('Built-in action "' + def.name + '" cannot be replaced');
  const checked = getAction(def);
  ENGINE_ACTIONS[checked.name] = checked;
  return checked;
}

// ─── QUERY REFINEMENT ────────────────────────────────────────────────────────
// Appends extra Gmail search terms to a rule's base query. Refinement may only
// NARROW a match: Gmail ANDs space-separated terms, so plain extra terms can
// never undo -is:starred / -in:trash / the in:inbox scope. Grouping and OR
// could (e.g. "OR in:anywhere"), so they are rejected outright rather than
// escaped — Gmail search has no reliable escape mechanism (see BUG-C20).
function refineQuery(baseQuery, extra) {
  const x = (extra == null) ? '' : String(extra).trim();
  if (!x) return baseQuery;
  if (/[(){}]/.test(x) || /(^|\s)(OR|AND)(\s|$)/.test(x) || /(^|\s)\|(\s|$)/.test(x))
    throw new Error('refineQuery: refinement must be plain AND terms (no OR, AND, |, braces or parentheses): ' + x);
  return baseQuery + ' ' + x;
}

// ─── SEEN-ID TRACKING ────────────────────────────────────────────────────────
// Wraps either run-state shape — the live payload's seenIds ARRAY (serialized
// between bursts) or the background run's in-memory Set — behind one
// {has, add} interface, so the engine doesn't care which runner it's in.
function seenTracker(store) {
  if (store && typeof store.has === 'function' && typeof store.add === 'function') return store;
  const arr = Array.isArray(store) ? store : [];
  const set = new Set(arr);
  return {
    has: function (id) { return set.has(id); },
    add: function (id) { if (!set.has(id)) { set.add(id); arr.push(id); } }
  };
}

// ─── MESSAGE CONTEXT ─────────────────────────────────────────────────────────
// Everything a feature needs about one matched thread. Only thread.getId() is
// read up front (the search already paid for it). Everything else is LAZY and
// cached: metadata() costs a few cheap thread-level calls, messages() fetches
// full GmailMessage objects (the expensive part — bodies, attachments). Plain
// cleanup never calls either, so trash/archive cost exactly what they did
// before this file existed.
function makeMessageContext(thread, rule, info) {
  info = info || {};
  let meta = null, msgs = null;
  return {
    thread:    thread,
    threadId:  thread.getId(),
    rule:      rule || null,
    ruleLabel: info.ruleLabel || (rule ? ruleLabel(rule) : ''),
    query:     info.query || '',
    dryRun:    !!info.dryRun,

    // Cheap-ish thread-level facts (no message bodies).
    metadata: function () {
      if (!meta) {
        meta = {
          subject:         thread.getFirstMessageSubject ? thread.getFirstMessageSubject() : '',
          lastMessageDate: thread.getLastMessageDate     ? thread.getLastMessageDate()     : null,
          messageCount:    thread.getMessageCount        ? thread.getMessageCount()        : 0,
          labels: thread.getLabels ? thread.getLabels().map(function (l) { return l.getName(); }) : []
        };
      }
      return meta;
    },
    // Full messages — sender, recipients, body, attachments live on these.
    messages: function () {
      if (!msgs) msgs = thread.getMessages ? thread.getMessages() : [];
      return msgs;
    },
    // Most recent message in the thread (or null).
    message: function () {
      const m = this.messages();
      return m.length ? m[m.length - 1] : null;
    }
  };
}

// ─── CANDIDATE RETRIEVAL + EVALUATION ────────────────────────────────────────
// Finds the threads a rule applies to. NEVER mutates Gmail and never touches
// the seen set — calling it is always safe, including from a feature that only
// wants to look.
//
// opts (all optional):
//   seen     — seenTracker/Set/array: threads already handled this run are
//              skipped (reported as `skipped`)
//   refine   — extra narrow-only query terms, see refineQuery()
//   filter   — function(ctx) → truthy to keep. Runs AFTER the query and dedup,
//              so it only ever sees real candidates. Put cheap checks
//              (ctx.metadata()) before expensive ones (ctx.messages()).
//   dryRun   — copied onto every context so filters/actions can see it
//   emit     — log sink (live runs); emits RESULT and the skipped-INFO line
//   max      — search cap, defaults to GMAIL_SEARCH
function findMatches(rule, opts) {
  opts = opts || {};
  const emit  = opts.emit || null;
  const seen  = opts.seen ? seenTracker(opts.seen) : null;
  const label = ruleLabel(rule);
  const query = refineQuery(buildQuery(rule), opts.refine);

  const st  = Date.now();
  const all = GmailApp.search(query, 0, opts.max || GMAIL_SEARCH);
  if (emit) emit('RESULT', `${fmtNum(all.length)} found · ${fmtMs(Date.now() - st)}`, { count: all.length });

  const fresh = seen ? all.filter(function (t) { return !seen.has(t.getId()); }) : all;
  if (emit && all.length > 0 && fresh.length < all.length)
    emit('INFO', `Skipped ${fmtNum(all.length - fresh.length)} already-processed this run.`);

  let contexts = fresh.map(function (t) {
    return makeMessageContext(t, rule, { ruleLabel: label, query: query, dryRun: opts.dryRun });
  });
  let filtered = 0;
  if (typeof opts.filter === 'function') {
    const kept = contexts.filter(function (c) { return opts.filter(c); });
    filtered = contexts.length - kept.length;
    contexts = kept;
  }

  return {
    rule: rule, ruleLabel: label, query: query,
    found: all.length, skipped: all.length - fresh.length, filtered: filtered,
    contexts: contexts
  };
}

// ─── ACTION EXECUTION (the guarded mutation point) ───────────────────────────
// run: { dryRun, seen, emit } — all optional.
//
// Guarantees, for EVERY action:
//   1. Every context is registered in `seen` BEFORE the action runs (FIX 15 /
//      BUG-C3): if the action throws half-way, a later rule in the same run
//      can't re-action threads that were already handled.
//   2. Dry run never calls the action at all — it only counts.
//   3. bulk() actions are chunked to GMAIL_CHUNK (Gmail's hard batch limit).
//   4. Errors propagate unchanged to the runner, whose existing catch blocks
//      own error emails and stats.errors (BUG-C15/C24/C25 handling).
// Returns { action, count, dryRun, batchMs, results }.
function executeAction(action, contexts, run) {
  run = run || {};
  const def  = getAction(action);
  const emit = run.emit || null;
  const list = contexts || [];
  const out  = { action: def.name, count: 0, dryRun: !!run.dryRun, batchMs: 0, results: [] };
  if (!list.length) return out;

  if (run.seen) {
    const seen = seenTracker(run.seen);
    list.forEach(function (c) { seen.add(c.threadId); });
  }

  if (run.dryRun) { out.count = list.length; return out; }

  if (typeof def.bulk === 'function') {
    for (const chunk of chunkArray(list, GMAIL_CHUNK)) {
      const t = Date.now();
      def.bulk(chunk.map(function (c) { return c.thread; }), chunk);
      out.batchMs += Date.now() - t;
      out.count   += chunk.length;
    }
  } else {
    const t = Date.now();
    list.forEach(function (c) { out.results.push(def.each(c)); out.count++; });
    out.batchMs = Date.now() - t;
  }

  // FIX 34 (S-U1): one summary line per action, not one per chunk.
  if (emit && out.count) emit('BATCH', `${def.batchLabel || def.name} ×${fmtNum(out.count)} · ${fmtMs(out.batchMs)}`);
  return out;
}

// ─── ONE RULE, END TO END ────────────────────────────────────────────────────
// query → candidates → context → action, for a single rule.
//   run:  { dryRun, seen, emit }  — the runner's safety state for this run
//   opts: { action, filter, refine } — action defaults to the rule's own
//         resolveRuleAction(), so the built-in runners pass nothing.
// Returns the findMatches() result plus `matched` and `execution` (null when
// nothing matched — the action is never called with an empty list).
function runRule(rule, run, opts) {
  run  = run  || {};
  opts = opts || {};
  const def  = getAction(opts.action || resolveRuleAction(rule));
  const emit = run.emit || null;

  if (emit) {
    const q = refineQuery(buildQuery(rule), opts.refine);
    emit('SEARCH', `${run.dryRun ? '[DRY] ' : ''}[${ruleLabel(rule)}] ${q} → ${def.name.toUpperCase()}`);
  }

  const m = findMatches(rule, {
    seen: run.seen, emit: emit, dryRun: run.dryRun,
    filter: opts.filter, refine: opts.refine
  });
  m.action    = def.name;
  m.matched   = m.contexts.length;
  m.execution = null;
  if (!m.matched) return m;

  if (emit && !run.dryRun) emit('ACTION', `${def.verb || def.name.toUpperCase()} ${fmtNum(m.matched)}…`);
  m.execution = executeAction(def, m.contexts, run);
  return m;
}

// ─── BACKWARDS-COMPATIBLE WRAPPER ────────────────────────────────────────────
// The pre-engine two-list API (formerly in RuleEngine.gs). Nothing in the app
// calls it any more; kept so any hand-written script that did still works.
function executeActions(toTrash, toArchive, emit) {
  const run = { emit: emit || null };
  const t = executeAction('trash',   (toTrash   || []).map(function (th) { return makeMessageContext(th, null); }), run);
  const a = executeAction('archive', (toArchive || []).map(function (th) { return makeMessageContext(th, null); }), run);
  return { trashed: t.count, archived: a.count, batchMs: t.batchMs + a.batchMs };
}
