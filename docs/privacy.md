# AutoTrash Privacy Policy

Effective 25 September 2026

This policy applies to the AutoTrash Google Apps Script application
("AutoTrash", "the Software"), maintained by Kmandevr ("the Developer",
"we"). It explains what AutoTrash does with your data when you authorize
it to access your Google Account.

## Summary

AutoTrash runs entirely inside your own Google Account, on Google's
infrastructure. It does not have a server of its own, does not send your
data to the Developer or to any third party, and does not use your data
for advertising, analytics, or any purpose other than running the rules
you configure.

## Who operates AutoTrash

Each deployment of AutoTrash is a Google Apps Script project. Unless you
were given a link to a deployment operated by the Developer, you deployed
your own copy of AutoTrash into your own Google Cloud project when you
followed the setup instructions in the repository. In that case, that
copy is a separate application under Google's OAuth rules, and you are
its operator with respect to Google's policies, even though the
Developer wrote and published the source code. This policy describes how
the Software is designed to behave in either case.

## What AutoTrash accesses, and why

When you authorize AutoTrash, Google asks you to grant it permission to
use the following capabilities of your Google Account, solely to run the
cleanup rules you configure:

- **Read and search your Gmail messages and threads**, using the Gmail
  search queries built from the rules you set up (for example, a label
  or Gmail-category rule with an age threshold), so AutoTrash can find the messages a
  rule applies to.
- **Move matching messages to Archive or Trash**, and no other mailbox
  action. AutoTrash never permanently deletes a message itself; Gmail's
  own Trash retention (normally 30 days) still applies. AutoTrash never
  searches Trash, and only searches Spam if you turn on its Spam
  category rule.
- **Send one email from your own account back to yourself** — the
  optional run summary or daily digest report, sent only to the
  address of the account running AutoTrash, never to the Developer or to
  anyone else.
- **Create and remove time-based triggers** on your script, so scheduled
  background runs can happen automatically, and so triggers can be
  cleaned up if you turn scheduling off.
- **Store your rule and settings configuration** using Apps Script's
  built-in per-user storage, which is part of your own Google Account
  and not a database operated by the Developer.

AutoTrash never requests access to your Google Drive, Contacts,
Calendar, or any Google product other than Gmail and the Apps Script
services listed above.

Built-in safety limits, described further in the repository's
`docs/feature-reference.txt`, exclude starred messages, Trash, Drafts, and
Sent mail from every rule, and Spam from every rule except the optional
Spam category rule.

## What AutoTrash does not do

- It does not transmit your email content, metadata, or any other data
  to the Developer, to Anthropic, to any analytics or advertising
  service, or to any other third party or external server. There is no
  "phone home" request anywhere in the code.
- It does not sell, rent, or share your data with anyone, for any
  reason.
- It does not use your data to train any machine-learning or
  artificial-intelligence model.
- It does not access your Gmail data for any purpose other than running
  the rules you configured, showing you their results in the web app,
  and sending you the optional summary email described above.

## Where your data is stored

All configuration AutoTrash stores (your rules, settings, and run
statistics) is stored using Google Apps Script's `PropertiesService`,
and the progress and log of a run in progress are kept temporarily (at
most 6 hours) in Apps Script's `CacheService` — both scoped to your own
Google Account, on Google's infrastructure — the same
place Google stores the rest of your Apps Script projects. The Developer
has no access to this storage and no copy of it.

## How long your data is kept

AutoTrash retains only the configuration described above, for as long as
you keep the script deployed. Uninstalling the script, deleting the Apps
Script project, or revoking AutoTrash's access from your Google Account
security settings (myaccount.google.com/permissions) removes that access
immediately and leaves nothing running.

## Human involvement

AutoTrash runs unattended, on a schedule or when you trigger it
manually. No person, including the Developer, reviews your email content
as part of its operation.

## Changes to this policy

This policy may be updated from time to time. The version in effect is
the one in the `docs/privacy.md` file on the `main` branch of the
[AutoTrash repository](https://github.com/Kmandevr/AutoTrash). Material
changes will be noted in the repository's commit history.

## Contact

Questions about this policy, or about a specific deployment maintained
by the Developer, can be sent by opening an issue in the
[AutoTrash repository](https://github.com/Kmandevr/AutoTrash), or by
email to the address listed on the Developer's GitHub profile.
