#!/usr/bin/env node
'use strict';

/**
 * AutoTrash — index.html pure-function extractor.
 *
 * app/index.html's inline <script> block mixes DOM-dependent UI code with
 * a handful of small, pure helper functions (formatting, id-sanitizing,
 * relative-time labels, run-descriptor strings). Running the WHOLE script
 * in Node would throw immediately — most of it assumes a live `document`,
 * `google.script.run`, etc. — so this module does NOT execute the script.
 * Instead it surgically pulls out the source text of just the named pure
 * functions (by brace-matching from each `function NAME(` to its closing
 * `}`) and evaluates ONLY those snippets in an isolated vm context.
 *
 * This mirrors the project's existing pattern of reaching into index.html
 * with a Node `vm` sandbox for a specific function (see the AT-BRK-004 /
 * reload-READY-flash fixes in git history) rather than standing up a full
 * headless-DOM harness, which this project doesn't otherwise need.
 *
 * Usage:
 *   const { loadIndexHtmlFunctions } = require('./extract-index-html-functions');
 *   const fns = loadIndexHtmlFunctions(['fmt', 'esc', 'cid']);
 *   fns.fmt(1234) // '1,234'
 *
 * Throws if a requested function isn't found in app/index.html, or if its
 * source doesn't brace-balance — so a rename/refactor in index.html that
 * breaks extraction fails loudly here instead of silently testing stale
 * copy-pasted source.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX_HTML_PATH = path.resolve(__dirname, '..', '..', 'app', 'index.html');

/**
 * Brace-match from the `function NAME(` keyword at `startIdx` in `src` to
 * its closing `}`, skipping over braces inside strings/template literals/
 * regex literals/comments so an unrelated `{`/`}` inside those doesn't
 * desync the count. Returns the end index (exclusive) of the function's
 * closing `}`.
 */
// Characters/keywords after which a `/` starts a regex literal rather than
// being a division operator — a standard regex-vs-division disambiguation
// heuristic (the same shape used elsewhere in this project's index.html
// tooling). Good enough for the small, simple function bodies this
// extractor targets; not a general JS parser.
const REGEX_CONTEXT_PUNCT = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '+', '-', '*', '%', '^', '~', '<', '>']);
const REGEX_CONTEXT_KEYWORDS = /(return|typeof|instanceof|case|do|else|in|new|void|delete|throw|yield)$/;

function isRegexContext(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true; // start of scanned text
  const prevChar = src[j];
  if (REGEX_CONTEXT_PUNCT.has(prevChar)) return true;
  // Previous token is a word — regex-context only if it's a keyword, not an
  // identifier/number (which would make `/` division).
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
  const word = src.slice(k + 1, j + 1);
  return REGEX_CONTEXT_KEYWORDS.test(word);
}

function findFunctionEnd(src, startIdx) {
  const openBrace = src.indexOf('{', startIdx);
  if (openBrace === -1) throw new Error('No opening brace found after function at index ' + startIdx);

  let depth = 0;
  let i = openBrace;
  for (; i < src.length; i++) {
    const c = src[i];
    const c2 = src[i + 1];

    // Skip line comments.
    if (c === '/' && c2 === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    // Skip block comments.
    if (c === '/' && c2 === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Unterminated block comment while scanning function body');
      i = end + 1;
      continue;
    }
    // Skip regex literals (so a brace or quote char *inside* one, e.g.
    // /\d{3}/ or /"/`, doesn't desync string/brace scanning below).
    if (c === '/' && isRegexContext(src, i)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        else if (src[j] === '\n') throw new Error('Unterminated regex literal while scanning function body');
        j++;
      }
      // Skip trailing flags (g, i, m, ...).
      j++;
      while (j < src.length && /[a-z]/.test(src[j])) j++;
      i = j - 1;
      continue;
    }
    // Skip string/template literals (no nested-expression handling needed —
    // none of the target functions contain `${...}` inside their bodies).
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') j++; // skip escaped char
        j++;
      }
      i = j;
      continue;
    }

    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error('Unbalanced braces: reached end of file before function body closed');
}

/**
 * Extract the full source text (`function NAME(...) { ... }`) of each
 * named top-level function from app/index.html, in file order.
 */
function extractFunctionSources(names) {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const out = {};
  const missing = [];

  for (const name of names) {
    const re = new RegExp('function\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(');
    const match = re.exec(src);
    if (!match) { missing.push(name); continue; }
    const start = match.index;
    const end = findFunctionEnd(src, start);
    out[name] = src.slice(start, end);
  }

  if (missing.length) {
    throw new Error(
      'extract-index-html-functions: could not find function(s) in app/index.html: ' +
      missing.join(', ') + ' — renamed, removed, or no longer top-level?'
    );
  }
  return out;
}

/**
 * Evaluate the named pure functions' source in an isolated vm context and
 * return them as callables. No DOM/global stubs are provided on purpose —
 * if a "pure" function turns out to touch `document`/`window`/etc., this
 * throws a ReferenceError at call time, which is the point: it means the
 * function doesn't actually belong in this pure-function test file.
 */
function loadIndexHtmlFunctions(names) {
  const sources = extractFunctionSources(names);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(Object.values(sources).join('\n\n'), sandbox, {
    filename: 'app/index.html (extracted pure functions)'
  });
  const fns = {};
  for (const name of names) {
    if (typeof sandbox[name] !== 'function') {
      throw new Error('extract-index-html-functions: "' + name + '" did not evaluate to a function');
    }
    fns[name] = sandbox[name];
  }
  return fns;
}

module.exports = { loadIndexHtmlFunctions, extractFunctionSources, findFunctionEnd };
