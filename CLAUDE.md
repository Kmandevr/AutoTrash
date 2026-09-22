# CLAUDE.md

Context for AI agents working in this repo. Read this before re-deriving
anything below from the files themselves — it's already known.

## What this is

A self-hosted Gmail cleanup engine on Google Apps Script (several `.gs`
files + `index.html`, served via `doGet()`). No build step, no package
manager, no external dependencies — everything runs on Apps Script's
built-in services (`GmailApp`, `PropertiesService`, `LockService`,
`ScriptApp`).

## Layout

    Code.gs                   entry point (doGet) + settings read/write
    Utils.gs                  small shared helpers (formatting, mail, props)
    RuleEngine.gs              rule → Gmail query, action resolution, queue build
    Runner.gs                  processLiveBurst()/backgroundRun()/abort/
                               finalize/daily-stats bookkeeping
    EmailSend.gs                when/whether to send a run or digest email
    EmailTemplates.gs          HTML/plain-text email rendering
    index.html                 web UI
    Tests.gs                   test suite (runAllTests(), Apps Script editor only)
    docs/feature-reference.txt  how each feature is MEANT to behave — read
                               before changing behavior, not just style
    docs/suggestions.txt        proposed, unbuilt — don't implement without
                               being asked to

`Code.gs` used to hold the entire backend (~1060 lines); it was split by
purpose on 2026-09-22 into the six files above. Apps Script shares one
global scope across every `.gs` file regardless of name or push order, so
this is a pure reorganization — nothing about behavior, execution order,
or what's callable from `index.html` via `google.script.run` changed.
When adding backend code: put it in the file whose purpose matches (new
rule-matching logic → `RuleEngine.gs`, a new email → `EmailSend.gs` +
`EmailTemplates.gs`, etc.) rather than defaulting to `Code.gs`.

## Rules

- **Bugs, tasks, and features live in GitHub Issues, not a file.** A new
  finding is a new Issue (or a comment on one), not a straight-to-code fix,
  unless told to build it. See "Issue labels" below for how to tag one.
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

## Issue labels

Four kinds, always stackable, color signals which kind:

| Kind | Color | Labels | Meaning |
|---|---|---|---|
| Type | pink | `bug` `task` `feature` | what it is |
| Severity | red→green gradient | `critical` `high` `medium` `low` | how bad, bugs only |
| Area | light blue | `code` `logic` `email` `ui` `tests` `docs` | what it touches — apply as many as fit |
| Time estimate | purple gradient | `minutes` `hours` `days` | rough effort, open issues only |

`status-fixed` marks resolved bugs kept as closed history.

**Filing a new one:** open an Issue, plain descriptive title (no
`BUG-<letter><num>` prefix needed — labels already carry that; old
numbered titles are historical, leave them as-is). Apply one type, one
or more area labels, a severity if it's a bug, and a time estimate if
it's actionable. Example: a bug in the dry-run counter is
`bug` `code` `logic` `medium` `hours`.
