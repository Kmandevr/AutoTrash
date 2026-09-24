/**
 * ████████████████████████████████████████████████████████████████
 * AUTOTRASH v26 — Gmail cleanup engine (Apps Script backend)
 * ████████████████████████████████████████████████████████████████
 *
 * Entry point (doGet) and shared constants only. The engine itself lives
 * in the files below — Apps Script shares one global scope across all
 * .gs files, so split location never affects behavior, only where to
 * find something:
 *
 *   Utils.gs            Small shared helpers (formatting, mail, props).
 *   Config.gs            Settings read/write, defensive rule-property
 *                         parsing, background/digest trigger sync.
 *   RuleEngine.gs        Rule → Gmail query, action resolution, queue build.
 *   Engine.gs            Search → match → message context → guarded action
 *                         (dry-run, seen-dedup, chunking). Both runners and
 *                         any future feature go through it; docs/engine.txt.
 *   Runner.gs            processLiveBurst() / backgroundRun() / abort /
 *                         finalize.
 *   Stats.gs              Per-label/purge stat crediting + daily accumulation.
 *   EmailSend.gs          When/whether to send a run or digest email.
 *   EmailTemplates.gs    HTML/plain-text email rendering.
 *   index.html            Web app UI (served by doGet() below).
 *
 * DOCUMENTATION MAP
 * ─────────────────
 * The 35-entry fix log that used to sit here has moved, so there is exactly
 * one canonical copy of that history instead of two that drift apart:
 *
 *   feature-reference.txt  How every feature is MEANT to behave.
 *                                    Read before changing anything.
 *   GitHub Issues                    Every fix with its root cause. The
 *                                    inline "FIX n (BUG-XX)" comments below
 *                                    resolve to a BUG-XX issue there.
 *   suggestions.txt        Proposed work, plus what has shipped.
 *                                    "FIX n (S-XX)" comments resolve there.
 *
 * Inline comments are deliberately kept wherever the code is non-obvious, or
 * where an innocent-looking "simplification" would reintroduce a data-loss
 * bug. FIX 1 (inbox scoping), FIX 15 (seenIds ordering) and FIX 31 (no
 * animation-fill-mode) are the three most likely to be undone by accident.
 */

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const GMAIL_CHUNK  = 100;    // Hard Gmail API limit per batch call
const GMAIL_SEARCH = 500;    // Max results per GmailApp.search
const BG_BUDGET_MS = 55000;  // 55 s budget per background execution
// ─── ENTRY POINT ──────────────────────────────────────────────────────────────
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('AutoTrash v26')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
