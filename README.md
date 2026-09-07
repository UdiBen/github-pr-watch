# github.pr.watch

A Slack message whenever someone comments on a pull request you opened.

The official GitHub Slack app subscribes per channel and filters on event
type, branch, and label. It has no filter for *pull requests I authored* —
an [open feature request](https://github.com/orgs/community/discussions/178699).
Personal scheduled reminders come closest, but they are review-request
centric rather than comment centric. So the choice is a channel firehose or
nothing. This takes the third path: poll the notifications API, keep only
what is yours, post that.

Python 3, standard library only. Authenticates by shelling out to `gh`, so
it stores no credential of its own.

## What arrives

> **someone** commented on **owner/repo#123** — *the pull request title*
> > the body of the comment, as a Slack quote

A colored bar encodes the event: amber for a comment, green for an
approval, red for changes requested. The link lands on the exact comment
anchor, not the top of the pull request. Inline review comments carry a
`path/to/file.go:120` context row.

## Install

1. **Create a Slack incoming webhook.** At <https://api.slack.com/apps>:
   New App → From scratch → Incoming Webhooks → Add New Webhook, pointed at
   the channel you want. If your workspace gates app installs, you will find
   out here.

2. **Install the script** somewhere on your `PATH`:

       curl -o ~/bin/github.pr.watch https://raw.githubusercontent.com/UdiBen/github-pr-watch/main/github.pr.watch
       chmod +x ~/bin/github.pr.watch

3. **Store the webhook**, mode 600:

       mkdir -p ~/.config/github-pr-watch
       umask 077
       echo 'https://hooks.slack.com/services/...' > ~/.config/github-pr-watch/webhook

   `GITHUB_PR_WATCH_SLACK_WEBHOOK` in the environment overrides the file.

4. **Check it, then schedule it:**

       github.pr.watch --dry-run --backfill 3   # prints, changes nothing
       github.pr.watch --backfill 0             # seed state at now

   Seeding state at now stops the first real run replaying the backlog.

   On macOS, copy `dev.udiben.github-pr-watch.plist.template` to
   `~/Library/LaunchAgents/dev.udiben.github-pr-watch.plist`, replace
   `__HOME__` with your home directory, and:

       launchctl load ~/Library/LaunchAgents/dev.udiben.github-pr-watch.plist

   `StartInterval` of 180 gives roughly three-minute latency. Elsewhere, use
   cron or `--interval 180` under a supervisor.

## Scopes

| scope | covers |
|---|---|
| `mine` (default) | pull requests you opened |
| `mentions` | adds threads that name you |
| `involved` | adds review requests and assignments |

`involved` is usually a firehose: on a team where reviews are requested
from a group, it pulls in every comment on every such pull request.

Other flags: `--backfill DAYS` (look back that far, overriding saved
state), `--include-bots` (off by default), `--interval SECONDS`,
`--dry-run`.

State lives in `~/.local/state/github-pr-watch/state.json`.

## Two traps

Both of these produce a watcher that runs cleanly and silently tells you
nothing. They cost real debugging time, so they are worth stating plainly.

### A thread carries one reason, and `mention` outranks `author`

Filtering notification threads on `reason == "author"` looks correct and
silently drops comments. When somebody @-names you in a comment on your own
pull request, GitHub relabels the whole thread `mention`. A thread whose
state changes can come back as `state_change`. Both are your pull request;
neither says `author`.

So `mine` accepts `author`, plus `mention` / `comment` / `state_change` /
`subscribed` / `manual` once the thread's opener is confirmed to be you.
Opener lookups are cached in the state file.

### `subject.latest_comment_url` is not the latest comment

On real threads it is either `null` or points at the pull request itself —
whose `body` and `user` are your own description, so a self-authored check
discards everything. A pull request with eight review comments can report
`null`. The first build of this script found seven threads and sent zero
alerts.

Ignore it and fetch `issues/{n}/comments`, `pulls/{n}/comments`, and
`pulls/{n}/reviews` directly, filtered by `since`.

## Rendering

GitHub Markdown is not Slack mrkdwn, and the differences bite:

| GitHub | Slack |
|---|---|
| `**bold**` | `*bold*` |
| `### Heading` | `*Heading*` |
| `[text](url)` | `<url\|text>` |
| ```` ```lang ```` | ```` ``` ```` — a language tag renders as code content |

The converter also strips HTML comments, escapes `&` and `<` as Slack
requires, and leaves `>` alone so GitHub reply-quotes survive as real Slack
quotes. Fenced and inline code are stashed before conversion, so `**`
inside a code sample stays literal. Truncation cuts on a line boundary and
closes an unbalanced fence rather than leaving one dangling.

## Limits

- **Reactions.** A thumbs-up generates no notification at all — there is no
  reaction event in the notifications API. Catching them means polling
  `/reactions` per comment and diffing counts.
- **Sleep.** Under launchd, a sleeping machine defers the interval and
  fires once on wake, so alerts arrive late in a burst rather than going
  missing.
- **Issues you opened.** Out of scope under `mine`; they arrive under
  `mentions` if you are named.
- **Your own comments, and bots.** Both filtered; `--include-bots` brings
  the second group back.
- **Empty `COMMENTED` reviews.** Skipped — that is the wrapper GitHub puts
  around inline comments, which arrive separately.

## Alternative: no script at all

GitHub CCs `author@noreply.github.com` on every notification about a thread
you opened, and CI mail carries `ci_activity` instead, so a mail filter
alone is a clean match:

    from:notifications@github.com
    cc:author@noreply.github.com
    -cc:your_activity@noreply.github.com

Forward that to a channel address from Slack's Email app and nothing needs
to run anywhere. `gmail-filter.xml` in this repo imports the filter
directly. The catch is the Email app: Slack Standard plan and up, and
installable only if your workspace permits it. Where it is permitted,
prefer it — no cron, no machine.
