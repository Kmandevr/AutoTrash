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
// The viewport has to be set HERE, via addMetaTag(). HtmlService serves
// index.html inside Google's sandbox iframe and does not honor a
// <meta name="viewport"> written in the file itself — so phones rendered
// the dashboard as a ~980px desktop page shrunk to fit, the @media
// (max-width:640px) mobile layout never applied, and the run controls at
// the bottom were tiny and easy to miss. (2026-09-24)
function doGet(e) {
  const out = HtmlService.createHtmlOutputFromFile(resolveIndexFile())
    .setTitle('AutoTrash v26')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  // UI flight recorder (2026-09-25): opening the web app URL with ?diag=1
  // switches on index.html's boot-time recorder, which emails the owner a
  // report of what the page saw on that device (see reportUiDiagnostics()).
  // Off unless asked for; nothing else about the page changes.
  if (e && e.parameter && e.parameter.diag) out.append('<script>window.__AT_DIAG = true;</script>');
  return out;
}

// Receives the ?diag=1 recorder's report from index.html and emails it to
// the account owner only (same address every AutoTrash email goes to).
// Exists to diagnose a live "page renders but nothing responds" failure on
// a real phone that no emulator reproduced. Capped at 60 KB; never throws.
function reportUiDiagnostics(report) {
  const text = String(report == null ? '' : report).slice(0, 60000);
  let body = text;
  try { body = JSON.stringify(JSON.parse(text), null, 2); } catch (err) { /* send raw */ }
  let phase = '';
  try { phase = String(JSON.parse(text).phase || ''); } catch (err) {}
  try {
    GmailApp.sendEmail(ownerEmail(), 'AutoTrash UI diagnostics' + (phase ? ' (' + phase + ')' : ''), body);
    return true;
  } catch (err) {
    console.error('reportUiDiagnostics failed:', (err && err.message) ? err.message : String(err));
    return false;
  }
}

// Apps Script names a pushed file after its path relative to clasp's
// rootDir, with folders flattened into the filename itself (there are no
// real server-side folders) — README's "Setup" (copy-paste every file
// under app/ as flat, top-level files) and "Deploying with clasp"
// (rootDir at the repo root, so tests/*.gs get pushed too, which
// prefixes every app/ file with "app/") describe two equally-supported
// deployment methods that give index.html two different Apps Script
// filenames: 'index' or 'app/index'. FIX (2026-09-24, reported live
// against a clasp-pushed deployment): "Exception: No HTML file named
// index was found" — doGet() assumed the flat name unconditionally.
// Try the flat name first (matches manual copy-paste, and clasp with
// rootDir pointed directly at app/), then the clasp-nested one, instead
// of assuming a specific deployment method.
function resolveIndexFile() {
  try {
    HtmlService.createHtmlOutputFromFile('index');
    return 'index';
  } catch (e) {
    return 'app/index';
  }
}
