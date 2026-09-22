# CLAUDE.md

Context for AI agents working in this repo. Read this before re-deriving
anything below from the files themselves — it's already known.

## What this is

A self-hosted Gmail cleanup engine on Google Apps Script (`Code.gs` +
`index.html`, served via `doGet()`). No build step, no package manager,
no external dependencies — everything runs on Apps Script's built-in
services (`GmailApp`, `PropertiesService`, `LockService`, `ScriptApp`).

## Layout

    Code.gs                  backend
    index.html                web UI
    Tests.gs                  test suite (runAllTests(), Apps Script editor only)
    docs/feature-reference.txt  how each feature is MEANT to behave — read
                               before changing behavior, not just style
    docs/suggestions.txt        proposed, unbuilt — don't implement without
                               being asked to

## Rules

- **Bugs live in GitHub Issues, not a file.** Labels: `bug`,
  `category-<animation|readability|email|code-logic|html-js>`,
  `severity-<level>`, `status-fixed` on resolved ones. A new finding is
  a new Issue (or a comment on one), not a straight-to-code fix, unless
  told to build it.
- **Never push to `main`.** Branch as `claude/<topic>-<YYYYMMDD>`, one
  branch per logical change, commit, push the branch, stop — the human
  merges via GitHub's own PR banner.
- **Patch what's targeted.** No drive-by rewrites of working files.
- **A GitHub push is not a deploy.** This code only goes live via
  `clasp push` or a manual copy-paste into the Apps Script editor —
  don't imply otherwise.
- Write access needs a repo-scoped token (Contents + Issues, no PR /
  Workflow / Actions scope) — kept outside this repo, never commit it.
- Say what changed and why, every time.
