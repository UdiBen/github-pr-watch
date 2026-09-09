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

**The CC address carries one reason, and it is rarely the most specific one.**
A genuine inline comment on a pull request *you opened* arrives CC'd to
`state_change@` if you ever reopened it, `comment@` once you have replied in the
thread, and `assign@` if you assigned the pull request to yourself. Filtering on
`author@` alone silently drops all three — the same precedence problem the
notifications API has with `mention` outranking `author`.

`assign@` is the one that bites hardest, because assigning your own pull request
to yourself is a common convention, and every comment on such a pull request
then routes around an `author@` filter. Nothing errors; the alerts simply stop.

So `ACCEPT_CC` admits `author`, `mention`, `state_change`, `comment`, `manual`
and `assign`, and excludes `review_requested`, `team_mention` and `ci_activity`,
which are the firehose. `push@` and `subscribed@` do not appear in practice.

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

1. **Create the project.** Either paste `Code.gs` into a new project at
   <https://script.google.com>, or, better, use clasp so the running project
   and this repo cannot drift apart:

       npx @google/clasp create --title "PR comments to Slack" --type standalone
       npx @google/clasp push

2. **Project Settings → Script Properties**, add:

   | property | value |
   |---|---|
   | `SLACK_WEBHOOK` | your `https://hooks.slack.com/services/...` URL |
   | `GITHUB_LOGIN` | your GitHub username, so your own comments are skipped |

   To receive a direct message instead of a channel post, set both of these as
   well and the webhook is ignored:

   | property | value |
   |---|---|
   | `SLACK_BOT_TOKEN` | a bot token (`xoxb-…`) with `chat:write` and `im:write` |
   | `SLACK_DM_TO` | your Slack member id, e.g. `U01234567` |

   Add **both** scopes under *OAuth & Permissions → Bot Token Scopes* at
   <https://api.slack.com/apps>, then reinstall the app and copy the bot token
   from the top of that page. `im:write` is not optional: a bot cannot post to
   a bare user id, so `conversations.open` is called first to open the direct
   message, and that needs the scope. Reinstalling can issue a new token —
   check the value still matches afterwards.

3. **Run `ping`.** It sends one message and names the transport that carried
   it: `delivered via DM to D01…`, or `delivered via webhook to https://…` if
   either DM property is missing. Failures name their cause —
   `conversations.open: missing_scope` means step 2's scopes did not take.

   Google will ask you to authorize Gmail and external requests here; the
   "unverified app" warning is expected for a script you wrote yourself —
   continue via *Advanced*.

4. **Run `run` once, as the live test.** Google will ask you to authorize Gmail
   and external requests; the "unverified app" warning is expected for a script
   you wrote yourself — continue via *Advanced*. It posts whatever real
   notifications fall inside the two-day window, which is the fastest honest
   proof that the whole chain works.

   If you would rather not see that backlog, run `seedSeen` instead: it marks
   the same messages as handled without posting.

5. **Run `setup` once.** It installs the trigger at `TRIGGER_MINUTES`. Anything
   `run` already posted is recorded, so nothing repeats. Run it again after
   changing the cadence — the trigger lives server-side and a code change alone
   does not move it.

6. **Check the Executions page**, in the left rail. Trigger runs appear there,
   not in the editor's execution log, and each names its destination:
   `1 thread(s), 0 alert(s) via DM`.

7. **Retire the poller** if you were running it, or every comment arrives twice
   — the two keep separate state and neither knows about the other:

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

**`clasp push` does not refresh an editor tab you already have open.** The tab
keeps serving a cached copy, so the function picker will still list functions
you deleted and will not list new ones. Hard-reload it. Worse, saving from a
stale tab overwrites the deployed version with the old buffer — so reload
rather than save if in doubt. Triggers always run the deployed code, never
whatever a browser is showing.

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

`TRIGGER_MINUTES` sets the cadence; `everyMinutes()` accepts 1, 5, 10, 15 or 30.
Changing it takes effect only when `setup` is run again, because the trigger
lives server-side and is not part of the code.

Apps Script is not billed, but trigger runtime is capped per day: 6 hours on
Google Workspace, 90 minutes on a personal account. At one minute this runs
1,440 times a day, costing roughly 25-50 minutes; at five it costs a fifth of
that. Exhausting the quota stops the triggers silently for the rest of the day,
so the Executions page is where that would show.

Note that the pause between posts counts toward runtime: a review producing
eight messages spends about nine seconds sleeping.

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
