'use strict';

/**
 * AutoTrash — index.html boot-safety guard (Node-only, added 2026-09-30;
 * regex-literal scanner fix 2026-10-01).
 *
 * Why this exists: the live Apps Script deployment broke on 2026-09-25
 * ("Uncaught SyntaxError: Unexpected token 'class'") because
 * renderSummary()'s innerHTML used a template literal nested inside
 * another template literal's `${...}` interpolation. The repo file
 * parsed fine in Node and Chromium, but the SERVED copy did not — see
 * commit 6d6dc5d's message for the full story. Neither `npm test` nor
 * .github/workflows/syntax-check.yml looked at app/index.html's inline
 * <script> content at all before this file existed: syntax-check.yml
 * only runs `node --check` on app/*.gs and tests/*.gs, and the Node
 * test harness (run-node-tests.js) only loads app/*.gs files into its
 * vm context, never app/index.html.
 *
 * This module is deliberately NOT a tests/*.test.gs file: it needs
 * Node's real `fs` and `vm` modules directly (to read index.html off
 * disk and compile arbitrary extracted <script> text), which the
 * sandboxed Apps-Script-mock vm context the *.test.gs suites run in
 * does not expose, and could not usefully expose in the real Apps
 * Script editor either (there is no local index.html file to read
 * there). It is wired into `npm test` at the harness level instead —
 * see tests/harness/run-node-tests.js, which runs this after
 * runAllTests() and folds its pass/fail into the same exit code.
 * tests/harness/check-index-html.selftest.js (also run from
 * run-node-tests.js) carries this module's OWN regression tests.
 *
 * Two checks, run once per inline <script> block found in index.html
 * (scripts with a `src` attribute, if any are ever added, are skipped
 * — there is nothing local to read for those):
 *
 *   1. Compiles the script's text with `vm.Script` (syntax only, never
 *      executed). Catches any real parse error, not just this one
 *      known pattern.
 *   2. Scans the script's text for a backtick that appears while
 *      already nested inside a template literal's `${...}`
 *      interpolation — the exact shape that broke live even though it
 *      is valid JS and parses fine everywhere the fix's own commit
 *      message checked (Node, Chromium).
 *
 * 2026-10-01 fix (code review claude/autotrash-review/review-20261001.md,
 * Project knowledge): the scanner originally treated EVERY backtick seen
 * while scanning top-level/interpolation code as a template-literal
 * boundary, with no concept of regex literals. A regex containing a
 * backtick in its pattern (e.g. `` /`/ ``) was therefore read as opening
 * a template literal, desyncing the nesting stack for everything after
 * it in the same <script> block and potentially masking a REAL nested
 * template-literal bug later on — while still reporting a clean pass.
 * Fixed by tracking the standard "previous significant token" heuristic
 * (same technique real tokenizers use) to tell a `/` that divides two
 * values apart from a `/` that opens a regex literal, then skipping to
 * the regex's own closing `/` — honoring `[...]` character classes and
 * escaped slashes, and never touching the template-nesting stack while
 * doing so — before resuming the normal scan. See
 * check-index-html.selftest.js for the adversarial case this closes,
 * plus coverage proving the fix doesn't make the scanner over-eager on
 * ordinary division.
 *
 * Exported separately from the runner so both `npm test` and a
 * standalone regression check (proving this fires on the pre-fix file,
 * per the Block A plan) can call it without re-reading the file twice.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const INDEX_HTML_PATH = path.join(ROOT, 'app', 'index.html');

// Matches a <script ...> ... </script> block, capturing its opening tag's
// attributes (group 1, possibly empty) and its body (group 2). Non-greedy
// body match so back-to-back <script> blocks don't get merged.
const SCRIPT_TAG_RE = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;

function extractInlineScripts(html) {
  const scripts = [];
  let m;
  SCRIPT_TAG_RE.lastIndex = 0;
  while ((m = SCRIPT_TAG_RE.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue; // nothing local to read
    scripts.push({ index: m.index, attrs: attrs.trim(), body: m[2] });
  }
  return scripts;
}

function indexToLineCol(src, idx) {
  let line = 1, col = 1;
  for (let i = 0; i < idx && i < src.length; i++) {
    if (src[i] === '\n') { line++; col = 1; } else { col++; }
  }
  return { line, col };
}

// Identifiers/keywords after which a following `/` begins a regex literal,
// not a division operator — the standard "previous significant token"
// heuristic real tokenizers use to disambiguate `/`. Not exhaustive (this
// is a safety-net scanner, not a full parser) but covers every keyword
// realistically likely to precede a regex literal in this codebase.
const REGEX_ALLOWED_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'else', 'do', 'yield', 'case', 'default', 'await'
]);

const IDENT_START_RE = /[A-Za-z_$]/;
const IDENT_PART_RE = /[A-Za-z0-9_$]/;

/**
 * Walks `src` (one inline <script>'s JS text) tracking template-literal
 * nesting depth, and returns one {line, col, snippet} entry per backtick
 * found while already inside a template literal's `${...}` interpolation.
 * See the module doc comment above for the algorithm in prose, including
 * the 2026-10-01 regex-literal fix.
 */
function findNestedTemplateBackticks(src) {
  const flags = [];
  // Stack of scanning contexts. The bottom frame is always the script's
  // own top-level code. A 'code' frame pushed by a `${` is "nested"
  // exactly when there is a 'template' frame below it on the stack.
  const stack = [{ type: 'code', braceDepth: 0, topLevel: true }];
  const n = src.length;
  let i = 0;

  // Tracks whether the next `/` should be read as a regex-literal start or
  // as division: 'value' means the previous significant token already
  // produced a value (identifier, number, string/template, a closing `)`
  // or `]`) so `/` divides; anything else (an operator, `(`, `,`, `;`,
  // `{`/`}`, a keyword, or the start of input/interpolation) means `/`
  // can only sensibly start a new expression, i.e. a regex literal.
  let prevSignificant = 'start';

  function templateDepth() {
    let d = 0;
    for (let f = 0; f < stack.length; f++) if (stack[f].type === 'template') d++;
    return d;
  }

  while (i < n) {
    const top = stack[stack.length - 1];
    const c = src[i];

    if (top.type === 'code') {
      if (c === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') i++;
        continue; // comments don't change prevSignificant
      }
      if (c === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      if (c === '"' || c === '\'') {
        const q = c; i++;
        while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; }
        i++;
        prevSignificant = 'value';
        continue;
      }
      if (c === '`') {
        if (templateDepth() > 0) {
          const pos = indexToLineCol(src, i);
          flags.push({ line: pos.line, col: pos.col, snippet: src.slice(Math.max(0, i - 20), i + 20) });
        }
        stack.push({ type: 'template' });
        i++;
        continue;
      }
      if (c === '/' && prevSignificant !== 'value') {
        // Regex literal: scan to its closing unescaped `/`, honoring
        // character classes (`[...]`, where an unescaped `/` does NOT
        // close the regex) so a stray backtick anywhere inside never
        // reaches the template-nesting tracker above.
        i++;
        let inClass = false;
        while (i < n) {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '[') { inClass = true; i++; continue; }
          if (src[i] === ']') { inClass = false; i++; continue; }
          if (src[i] === '/' && !inClass) { i++; break; }
          if (src[i] === '\n') break; // unterminated — bail out of the literal, don't eat the rest of the file
          i++;
        }
        while (i < n && /[a-z]/i.test(src[i])) i++; // flags (g, i, m, ...)
        prevSignificant = 'value';
        continue;
      }
      if (IDENT_START_RE.test(c)) {
        let j = i + 1;
        while (j < n && IDENT_PART_RE.test(src[j])) j++;
        const word = src.slice(i, j);
        i = j;
        prevSignificant = REGEX_ALLOWED_AFTER_KEYWORD.has(word) ? 'keyword' : 'value';
        continue;
      }
      if (c >= '0' && c <= '9') {
        let j = i + 1;
        while (j < n && /[0-9a-fA-FxXoObB.]/.test(src[j])) j++;
        i = j;
        prevSignificant = 'value';
        continue;
      }
      if (c === '{') { top.braceDepth++; i++; prevSignificant = 'punct'; continue; }
      if (c === '}') {
        if (!top.topLevel && top.braceDepth === 0) {
          stack.pop(); // closes this `${...}` interpolation
          i++;
          prevSignificant = 'value'; // the interpolation's result is a value
          continue;
        }
        top.braceDepth--;
        i++;
        // Closing a block statement — a regex is allowed to start the next
        // statement, so treat this like the start of a fresh context.
        prevSignificant = 'punct';
        continue;
      }
      if (c === ')' || c === ']') { i++; prevSignificant = 'value'; continue; }
      if (/\s/.test(c)) { i++; continue; } // whitespace never changes prevSignificant
      // Any other punctuation ('(' ',' ';' ':' operators, etc.) — a regex
      // may start right after it.
      i++;
      prevSignificant = 'punct';
      continue;
    }

    // top.type === 'template': scanning a template literal's raw text.
    if (c === '\\') { i += 2; continue; }
    if (c === '`') { stack.pop(); i++; prevSignificant = 'value'; continue; }
    if (c === '$' && src[i + 1] === '{') {
      stack.push({ type: 'code', braceDepth: 0, topLevel: false });
      i += 2;
      prevSignificant = 'start';
      continue;
    }
    i++;
  }

  return flags;
}

/**
 * Runs both checks against whatever index.html content is given (so the
 * regression check can pass in an old git revision's text without
 * touching disk). Returns {passed, failed, total, results} in the same
 * shape runAllTests() uses, so run-node-tests.js can merge the two.
 */
function checkIndexHtmlSource(html, label) {
  label = label || 'app/index.html';
  const results = [];
  const scripts = extractInlineScripts(html);

  results.push({
    name: 'indexHtml_hasInlineScriptsToCheck',
    status: scripts.length > 0 ? 'PASS' : 'FAIL',
    error: scripts.length > 0 ? null : `No inline <script> blocks found in ${label} — the extractor or the file itself may have changed shape.`
  });

  scripts.forEach((script, idx) => {
    const scriptLabel = `${label} <script> #${idx + 1}${script.attrs ? ' (' + script.attrs + ')' : ''}`;

    let parseError = null;
    try {
      new vm.Script(script.body, { filename: scriptLabel });
    } catch (e) {
      parseError = e;
    }
    results.push({
      name: `indexHtml_scriptParses_${idx + 1}`,
      status: parseError ? 'FAIL' : 'PASS',
      error: parseError ? `${scriptLabel} failed to parse: ${parseError.message}` : null
    });

    const nestedBackticks = findNestedTemplateBackticks(script.body);
    results.push({
      name: `indexHtml_noNestedTemplateBacktick_${idx + 1}`,
      status: nestedBackticks.length === 0 ? 'PASS' : 'FAIL',
      error: nestedBackticks.length === 0
        ? null
        : `${scriptLabel} has ${nestedBackticks.length} backtick(s) nested inside another template ` +
          `literal's \${...} interpolation — this is the exact shape that broke the live Apps Script ` +
          `deployment (commit 6d6dc5d). First occurrence at line ${nestedBackticks[0].line}, col ` +
          `${nestedBackticks[0].col}: ...${nestedBackticks[0].snippet}...`
    });
  });

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  return { passed, failed, total: results.length, results };
}

function checkIndexHtml() {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  return checkIndexHtmlSource(html, 'app/index.html');
}

module.exports = {
  checkIndexHtml,
  checkIndexHtmlSource,
  extractInlineScripts,
  findNestedTemplateBackticks
};
