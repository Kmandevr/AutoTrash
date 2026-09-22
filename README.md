# AutoTrash v26

A self-hosted Gmail cleanup engine built on Google Apps Script. AutoTrash
trashes or archives mail based on labels, Gmail's auto-sort categories
(Promotions, Social, Updates, Forums, Spam), and configurable age
thresholds — either on demand from an in-browser dashboard, or
continuously in the background via a time trigger.

## Features

- **Custom label rules** — target any Gmail label, trash or archive after
  N days.
- **Gmail category rules** — Promotions, Social, Updates, Forums, Spam,
  each with its own age threshold and action.
- **Inbox Purge / Global Purge** — blanket age-based cleanup, scoped to
  inbox-only or all mail (including archived).
- **Live and background runs** — run manually from the dashboard, or set
  a time trigger (1 min up to daily) for continuous, unattended cleanup.
- **Dry run mode** — preview what a run would do with no mail actually
  moved.
- **Email reporting** — per-run summaries, daily/weekly/bi-weekly
  digests, and immediate error alerts, with a dark-themed HTML report and
  a plain-text fallback.
- **Safety rails** — starred mail is never touched (no exceptions), and a
  live run with Global Purge active requires an explicit confirmation
  before it can start.

## Setup

1. Create a new [Google Apps Script](https://script.google.com) project.
2. Add `Code.gs`, `Utils.gs`, `RuleEngine.gs`, `Runner.gs`, `EmailSend.gs`,
   `EmailTemplates.gs`, `index.html`, and `Tests.gs` as files in that
   project (the test file is optional but recommended — see below). The
   `.gs` files share one global scope, so it doesn't matter what order
   Apps Script lists them in.
3. Deploy as a **Web App** (Deploy → New deployment → Web app), with
   access set to yourself. This gives `doGet()` a URL that serves the
   dashboard.
4. Open the deployed URL, configure your rules under **Custom Label
   Rules** / **Gmail Category Rules**, and hit **Save Config**.
5. Optionally enable a **Background Trigger** (System Config panel) for
   unattended cleanup, and a summary email frequency.

No external dependencies — this runs entirely on Apps Script's built-in
`GmailApp`, `PropertiesService`, `LockService`, and `ScriptApp` services.

Working on this with an AI coding agent? See [`CLAUDE.md`](CLAUDE.md) for
repo conventions and workflow.

## Repo layout

```
Code.gs             Entry point (doGet) + settings read/write
Utils.gs            Small shared helpers (formatting, mail, props)
RuleEngine.gs        Rule → Gmail query, action resolution, queue build
Runner.gs            Live/background run execution, abort, finalize
EmailSend.gs          When/whether to send a run or digest email
EmailTemplates.gs    HTML/plain-text email rendering
index.html          Web app UI (served by doGet())
Tests.gs            Test suite — run runAllTests() from the Apps
                    Script editor; emails a pass/fail report to
                    the script owner
docs/
  feature-reference.txt     Source of truth for how every feature is
                            meant to behave — read this before changing
                            any code
  suggestions.txt           Proposed features and improvements, not yet
                            built
```

Bugs, tasks, and features are tracked in this repo's
[GitHub Issues](../../issues) — closed issues (labeled `status-fixed`) are
the fixed-bug record, open ones are current work. Labels stack (type,
severity, area, time estimate) — see [`CLAUDE.md`](CLAUDE.md) for the
full breakdown.

## Running the tests

From the Apps Script editor, select `runAllTests` and run it. Results go
to the execution log and are also emailed to the script owner as an HTML
report. The suite covers query-building, stats accumulation, email
content, and both the live-burst and background-run engines against an
in-memory fake `GmailApp` — no real mail is touched by the tests.

## Known limitations

See this repo's [open Issues](../../issues?q=is%3Aissue+is%3Aopen+label%3Abug)
for the full list with root-cause detail. At a glance, the currently open
items are all reporting-accuracy
or notification-timing edge cases (e.g. a dry-run preview can undercount
a rule with a very large backlog; a digest email doesn't currently
surface error counts) — none of them cause mail to be moved incorrectly.

## Safety notes

- Starred mail is excluded from every query this project runs, with no
  per-rule override — see §9 of the feature reference.
- Gmail's own trash retention (30 days) is the practical undo window for
  anything trashed — see the feature reference for the reasoning behind
  not (yet) building a separate delay/undo mechanism.
- Global Purge reaches archived mail, not just your inbox. The dashboard
  requires an explicit confirmation before a live run with Global Purge
  enabled can start.
