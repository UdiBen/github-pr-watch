# Apps Script variant

Same Slack messages, no machine of your own. Google runs it on a timer, so it
does not care whether your laptop is asleep.

It reads GitHub's notification **email** rather than the API. GitHub CCs a
machine address that encodes why you were notified — `author@noreply.github.com`
for a thread you opened, `mention@noreply.github.com` for one that names you —
which makes the mailbox most of the filter. Consequences:

- **No GitHub token.** Nothing to create, nothing to authorize for SSO, no
  fine-grained-PAT question.
- **No webhook on a shared repo**, so no personal endpoint receiving an entire
  organisation's comment traffic.
- **No Slack Email app**, so no workspace-admin approval. Just an incoming
  webhook, which any member can create.
- Company review content stays inside company Google Workspace and company
  Slack.

The cost is that it parses an email template instead of consuming JSON. That
template has been stable for years, but it is a maintenance surface the API
version does not have.

## Two traps, both the same shape as the API's

**The CC address carries one reason, and it is not always the most specific
one.** A genuine inline comment on a pull request *you opened* arrives CC'd to
`state_change@` if you ever reopened that pull request, and to `comment@` once
you have replied in the thread. Filtering on `author@` alone silently drops
them — the same precedence problem the notifications API has with `mention`
outranking `author`. So `ACCEPT_CC` admits `author`, `mention`, `state_change`,
`comment` and `manual`, and deliberately excludes `review_requested`,
`team_mention`, `assign` and `ci_activity`.

Anchor that pattern on the address boundary. Unanchored, `mention` also matches
`team_mention@`, which readmits the exact firehose you excluded.

**Gmail search matches threads, not messages.** A thread kept for one matching
message hands you all its siblings — any age, any reason. Without a per-message
re-check, a live thread replays old comments and posts merge notices. `run()`
re-tests every message against the CC set and the age window, and `seedSeen()`
uses the same test so the two cannot disagree.

A merge or close notice has no `@user <verb>` opening line and its body starts
with the state verb, which is how it is told apart from a top-level comment
(which also has no opening line).

## Setup

1. **<https://script.google.com>** → New project. Paste `Code.gs` over the
   default file. Rename the project to something you will recognise.

2. **Project Settings → Script Properties**, add:

   | property | value |
   |---|---|
   | `SLACK_WEBHOOK` | your `https://hooks.slack.com/services/...` URL |
   | `GITHUB_LOGIN` | your GitHub username, so your own comments are skipped |

   To receive a direct message instead of a channel post, set both of these as
   well and the webhook is ignored:

   | property | value |
   |---|---|
   | `SLACK_BOT_TOKEN` | a bot token (`xoxb-…`) with the `chat:write` scope |
   | `SLACK_DM_TO` | your Slack member id, e.g. `U01234567` |

   Add `chat:write` under *OAuth & Permissions → Bot Token Scopes* at
   <https://api.slack.com/apps>, reinstall the app, and copy the bot token from
   the top of that page. If a post fails with `channel_not_found`, add
   `im:write` as well. `ping` sends one test message and reports which
   transport carried it.

3. **Run `run` once, as the live test.** Google will ask you to authorize Gmail
   and external requests; the "unverified app" warning is expected for a script
   you wrote yourself — continue via *Advanced*. It posts whatever real
   notifications fall inside the two-day window, which is the fastest honest
   proof that the whole chain works.

   If you would rather not see that backlog, run `seedSeen` instead: it marks
   the same messages as handled without posting.

4. **Run `setup` once.** It installs a one-minute trigger. Anything `run`
   already posted is recorded, so nothing repeats.

5. **Check the Executions tab.** You should see `run` firing with
   `N thread(s), 0 alert(s)` once it is caught up.

6. **Retire the poller**, or every comment arrives twice — the two keep
   separate state and neither knows about the other:

       launchctl unload ~/Library/LaunchAgents/dev.udiben.github-pr-watch.plist

## Deploying with clasp

Pasting into the editor works, but it leaves no way to tell whether the running
project matches this repo. [clasp](https://github.com/google/clasp) removes the
doubt.

    # once
    # enable the Apps Script API at script.google.com/home/usersettings
    npx @google/clasp login

    # thereafter, from this directory
    npx @google/clasp pull    # what is actually running
    npx @google/clasp push    # deploy this repo

`.clasp.json` holds the script id and is deliberately untracked, since it points
at one person's project. `appsscript.json` is the project manifest and is
tracked; `pull` it before changing it so an existing timezone or scope grant is
not overwritten. `.claspignore` keeps `test.js` and `fixtures.json` out of the
deploy — they are for Node, and Apps Script would reject `require`.

Changing the code does not disturb the trigger or the Script Properties. Both
live server-side, independent of the files.

## Tuning

`QUERY` is an ordinary Gmail search. To follow only threads you opened, drop
the `cc:mention@noreply.github.com` clause. To widen it, add another reason
address — `review_requested@`, `assign@`, `team_mention@`.

`everyMinutes()` accepts 1, 5, 10, 15 or 30. One minute costs roughly an hour
a day against the Apps Script trigger-runtime quota, which is 6 hours a day on
Workspace and 90 minutes on a personal account. On a personal account use 5.

## Quotas

At one-minute intervals this makes about 1,440 Gmail searches and at most a few
hundred `UrlFetchApp` calls a day, against a 20,000-call limit. Not close.

## Failure reporting

An incoming webhook signals failure with its status code. `chat.postMessage`
answers **200 even when it refuses**, putting `ok:false` and a reason in the
body, so the body is parsed and the reason logged. Without that, a revoked
token or a bad member id would look exactly like a quiet day.

Failures are counted separately in the execution log — `12 thread(s), 3
alert(s) via DM, 1 FAILED` — because the failure mode that matters here is
silence, and a silent notifier is indistinguishable from a working one.

## Known differences from the API version

- **Single-asterisk emphasis flips meaning.** `*text*` is italic in GitHub
  Markdown and bold in Slack, so GitHub italics arrive bold. Converting it
  properly means disambiguating from bold, which is not worth the risk of
  mangling both.
- **The diff hunk is included**, which the API version does not do — GitHub
  puts the quoted code in the email and it is genuinely useful context.
- **`reviewed` vs `commented on`** is inferred from the email's opening line
  rather than a review `state` field, so an unusual phrasing falls back to
  `commented on` and the amber bar.

## Testing the parser

`Code.gs` exports its pure functions under `module.exports` when `module`
exists, which Apps Script ignores and Node does not. So the parsing and
rendering can be exercised off-platform against saved real emails, without a
Google project or a Slack post.
