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

    app/
      Code.gs                   entry point (doGet) + settings read/write
      Utils.gs                  small shared helpers (formatting, mail, props)
      RuleEngine.gs              rule → Gmail query, action resolution, queue build
      Runner.gs                  processLiveBurst()/backgroundRun()/abort/
                                 finalize/daily-stats bookkeeping
      EmailSend.gs                when/whether to send a run or digest email
      EmailTemplates.gs          HTML/plain-text email rendering
      index.html                 web UI
    tests/
      TestFramework.gs           assert/assertEqual/assertThrows, spies
                                 (installGmailSpy/installLockSpy/
                                 installScriptAppSpy), shared fixtures
      Utils.test.gs               tests for app/Utils.gs
      RuleEngine.test.gs          tests for app/RuleEngine.gs
      EmailTemplates.test.gs      tests for app/EmailTemplates.gs
      EmailSend.test.gs           tests for app/EmailSend.gs
      Code.test.gs                tests for app/Code.gs
      Runner.test.gs              tests for app/Runner.gs (largest suite)
      RunAll.gs                  combines every suite's TEST_FNS + defines
                                 runAllTests() — the one entry point used
                                 both by the Apps Script editor and by the
                                 Node harness below
      mocks/apps-script-globals.js  Node-only: baseline GmailApp/
                                 PropertiesService/LockService/ScriptApp/
                                 Session/HtmlService mocks
      harness/run-node-tests.js  Node-only: `npm test` entry point — loads
                                 every app/*.gs + tests/*.gs into one `vm`
                                 context and calls runAllTests() from Node
    docs/
      feature-reference.txt      how each feature is MEANT to behave — read
                                 before changing behavior, not just style
      testing.txt                 how tests/ is organized, how the Node
                                 harness works, and how to add a test —
                                 read before touching anything under tests/
      suggestions.txt            proposed, unbuilt — don't implement without
                                 being asked to

This GitHub layout is a pure repo-organization convenience — Apps Script
itself has no real folders and shares one global scope across every `.gs`
file regardless of name, path, or push order. Deploying (clasp or manual
copy-paste) still ends up with every `app/` and `tests/` file flat in one
Apps Script project; nothing about behavior, execution order, or what's
callable from `index.html` via `google.script.run` changes because of
where a file sits in this repo. Only `README.md`, `LICENSE`, `.gitignore`,
and `CLAUDE.md` belong at repo root — everything else goes in `app/`,
`tests/`, or `docs/`.

`Code.gs` used to hold the entire backend (~1060 lines) at repo root; it
was split by purpose on 2026-09-22 into the files under `app/` above, then
those files (plus `index.html`) were grouped into `app/` and the test
suite into `tests/` the same day. The test suite itself was originally one
file (`tests/Tests.gs`); it was split by app-file on 2026-09-24 into the
`tests/*.test.gs` + `TestFramework.gs` + `RunAll.gs` layout above, at the
same time the Node harness (`tests/mocks/`, `tests/harness/`) was added.
When adding backend code: put it in the file whose purpose matches (new
rule-matching logic → `RuleEngine.gs`, a new email → `EmailSend.gs` +
`EmailTemplates.gs`, etc.) rather than defaulting to `Code.gs`. When
adding a test for it, put it in that file's matching `tests/*.test.gs`
and add it to that file's own `..._TESTS` array — `RunAll.gs` picks it up
automatically from there.

## Testing

Two ways to run the exact same suite (`runAllTests()` in `tests/RunAll.gs`
— one implementation, no drift between them):

- **Apps Script editor**: open the project, select `runAllTests` in
  `RunAll.gs`, Run ▶. Uses the real `GmailApp`/`PropertiesService`/
  `LockService`/`ScriptApp`/`Session`. Emails an HTML report to the
  script owner in addition to the execution log.
- **Node, from this repo, no Apps Script account needed**: `npm test`
  (or `node tests/harness/run-node-tests.js`). Loads every `app/*.gs` +
  `tests/*.gs` file into one `vm` context seeded with the mocks in
  `tests/mocks/apps-script-globals.js`, then calls the same
  `runAllTests()`. This is how a change here should be verified before
  it's handed off — run it after writing or editing any `app/*.gs` or
  `tests/*.gs` code and before pushing, the same way you'd run any other
  project's test suite locally.

Any change to backend behavior (`app/`) must get a matching test in the
same pass, in the `tests/*.test.gs` file for the app file it changed.

See `docs/testing.txt` for the full file map, how to add a test, and how
the Node harness (`tests/mocks/`, `tests/harness/`) actually works
internally — including the one real gotcha in it (why it concatenates
every file into a single `vm.Script` instead of running one per file).

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
