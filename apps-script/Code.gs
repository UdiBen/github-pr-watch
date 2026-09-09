/**
 * Slack alerts for comments on pull requests you opened, driven by GitHub's
 * notification email rather than its API.
 *
 * GitHub CCs a machine address encoding why you were notified: author@ for a
 * thread you opened, mention@ for one that names you. That makes the mailbox
 * a push feed, and it needs no GitHub token.
 *
 * Run setup() once to install the trigger. The Slack webhook lives in Script
 * Properties; see README.
 */

var PROP_WEBHOOK = 'SLACK_WEBHOOK';
var PROP_BOT_TOKEN = 'SLACK_BOT_TOKEN';
var PROP_DM_TO = 'SLACK_DM_TO';
var PROP_SEEN = 'SEEN_IDS';
var PROP_LOGIN = 'GITHUB_LOGIN';
var SEEN_CAP = 400;

// everyMinutes accepts 1, 5, 10, 15 or 30. Five keeps the daily trigger runtime
// to a few minutes against a six-hour Workspace allowance, and still delivers a
// comment long before anyone expects a reply.
var TRIGGER_MINUTES = 5;

/**
 * A notification carries exactly one reason, and it is rarely the most specific
 * one.  A comment on a pull request you opened arrives CC'd to state_change@ if
 * you ever reopened it, comment@ once you have replied in the thread, and
 * assign@ if you assigned the pull request to yourself.  Filtering on author@
 * alone silently drops all three.
 *
 * review_requested@, team_mention@ and ci_activity@ stay out; they are the
 * firehose.  push@ and subscribed@ do not appear in practice.
 */
// Anchored on the address boundary: an unanchored 'mention' also matches
// team_mention@, which is exactly the traffic this excludes.
var ACCEPT_CC = /(?:^|[<\s,])(author|mention|state_change|comment|manual|assign)@noreply\.github\.com/;
var MAX_AGE_DAYS = 2;

var QUERY = 'from:notifications@github.com ' +
  '{cc:author@noreply.github.com cc:mention@noreply.github.com ' +
  'cc:state_change@noreply.github.com cc:comment@noreply.github.com ' +
  'cc:manual@noreply.github.com cc:assign@noreply.github.com} ' +
  '-cc:your_activity@noreply.github.com newer_than:' + MAX_AGE_DAYS + 'd';

// "Merged #123 into main." and friends are not comments.
var STATE_NOTICE = /^(Merged|Closed|Reopened|Converted|Deleted)\b/;

var BAR = {
  'approved': '#1f6b45',
  'requested changes on': '#9c2b20'
};
var BAR_DEFAULT = '#e0aa4c';
var BODY_LIMIT = 1400;

// ------------------------------------------------------------ apps script

function seenIds_(props) {
  try {
    return JSON.parse(props.getProperty(PROP_SEEN) || '[]');
  } catch (e) {
    return [];
  }
}

/**
 * Gmail's search matches threads, not messages: a thread kept for one matching
 * message also yields its siblings, of any age and any reason.  Re-check both
 * per message.
 */
function relevant_(msg, cutoff) {
  if (!ACCEPT_CC.test(msg.getCc() || '')) return false;
  return msg.getDate().getTime() >= cutoff;
}

/**
 * Where to post: a bot DM when a token and a recipient are both set, otherwise
 * the incoming webhook.  Keeping the webhook as a fallback makes the switch
 * reversible by deleting one property.
 */
function destination_(props) {
  var token = props.getProperty(PROP_BOT_TOKEN);
  var to = props.getProperty(PROP_DM_TO);
  if (token && to) return { kind: 'DM', token: token, channel: to };
  var webhook = props.getProperty(PROP_WEBHOOK);
  if (webhook) return { kind: 'webhook', url: webhook };
  throw new Error('set ' + PROP_BOT_TOKEN + ' and ' + PROP_DM_TO + ', or ' + PROP_WEBHOOK);
}

/**
 * A bot usually cannot post to a bare user id: the direct message has to be
 * opened first, and conversations.open hands back the channel id to post into.
 * Needs the im:write scope alongside chat:write.
 */
function openIm_(token, userId) {
  var res = UrlFetchApp.fetch('https://slack.com/api/conversations.open', {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ users: userId }),
    muteHttpExceptions: true
  });
  var body;
  try {
    body = JSON.parse(res.getContentText());
  } catch (e) {
    return { error: 'conversations.open: unparsable reply' };
  }
  if (!body.ok) return { error: 'conversations.open: ' + (body.error || 'unknown error') };
  return { channel: body.channel.id };
}

/**
 * Returns an error string, or '' on success.  The two transports report failure
 * differently: a webhook uses the status code, while chat.postMessage answers
 * 200 even when it refuses and puts ok:false in the body, so the body has to be
 * read or failures pass for successes.
 */
function post_(dest, payload) {
  if (dest.kind === 'webhook') {
    var r = UrlFetchApp.fetch(dest.url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    return r.getResponseCode() === 200 ? '' : 'webhook HTTP ' + r.getResponseCode();
  }

  // Resolved once per run and remembered on dest.
  if (dest.channel.charAt(0) === 'U' && !dest.im) {
    var opened = openIm_(dest.token, dest.channel);
    if (opened.error) return opened.error;
    dest.im = opened.channel;
  }

  var res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + dest.token },
    payload: JSON.stringify({
      channel: dest.im || dest.channel,
      attachments: payload.attachments
    }),
    muteHttpExceptions: true
  });
  var body;
  try {
    body = JSON.parse(res.getContentText());
  } catch (e) {
    return 'chat.postMessage: unparsable reply';
  }
  return body.ok ? '' : ('chat.postMessage: ' + (body.error || 'unknown error'));
}

/** Run once after changing destination: delivers a single test message. */
function ping() {
  var dest = destination_(PropertiesService.getScriptProperties());
  var err = post_(dest, {
    attachments: [{
      color: BAR_DEFAULT,
      fallback: 'github.pr.watch test message',
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: '*github.pr.watch* is delivering here.' }
      }]
    }]
  });
  console.log(err ? ('FAILED: ' + err)
    : ('delivered via ' + dest.kind + ' to ' + (dest.im || dest.channel || dest.url)));
}

function run() {
  var props = PropertiesService.getScriptProperties();
  var dest = destination_(props);
  var login = props.getProperty(PROP_LOGIN) || '';

  var seen = seenIds_(props);
  var seenSet = {};
  for (var i = 0; i < seen.length; i++) seenSet[seen[i]] = true;

  var sent = 0;
  var failed = 0;
  var cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  var threads = GmailApp.search(QUERY, 0, 50);
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      var id = msg.getId();
      if (seenSet[id]) continue;
      if (!relevant_(msg, cutoff)) continue;

      var parsed = parseNotification({
        subject: msg.getSubject(),
        from: msg.getFrom(),
        plainBody: msg.getPlainBody(),
        htmlBody: msg.getBody()
      });

      seenSet[id] = true;
      seen.push(id);
      if (!parsed) continue;
      if (login && parsed.author === login) continue;
      if (/\[bot\]$/.test(parsed.author)) continue;
      if (!parsed.matchedOpening && STATE_NOTICE.test(parsed.body)) continue;

      var payloads = buildPayloads(parsed);
      for (var k = 0; k < payloads.length; k++) {
        // Slack accepts about one message a second.
        if (sent + failed > 0) Utilities.sleep(1100);
        var err = post_(dest, payloads[k]);
        if (err) {
          failed++;
          console.log('post failed for ' + parsed.repo + '#' + parsed.number + ': ' + err);
        } else {
          sent++;
        }
      }
    }
  }

  if (seen.length > SEEN_CAP) seen = seen.slice(seen.length - SEEN_CAP);
  props.setProperty(PROP_SEEN, JSON.stringify(seen));
  console.log(threads.length + ' thread(s), ' + sent + ' alert(s) via ' + dest.kind +
    (failed ? ', ' + failed + ' FAILED' : ''));
}

/** Run once, and again after changing TRIGGER_MINUTES: installs the trigger. */
function setup() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'run') ScriptApp.deleteTrigger(existing[i]);
  }
  ScriptApp.newTrigger('run').timeBased().everyMinutes(TRIGGER_MINUTES).create();
  console.log('trigger installed, every ' + TRIGGER_MINUTES + ' minute(s)');
}

/**
 * Mark everything currently matching as seen without posting, so the first
 * real run does not replay the backlog.
 */
function seedSeen() {
  var props = PropertiesService.getScriptProperties();
  var seen = seenIds_(props);
  var cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  var threads = GmailApp.search(QUERY, 0, 50);
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      if (relevant_(messages[m], cutoff)) seen.push(messages[m].getId());
    }
  }
  if (seen.length > SEEN_CAP) seen = seen.slice(seen.length - SEEN_CAP);
  props.setProperty(PROP_SEEN, JSON.stringify(seen));
  console.log('seeded ' + seen.length + ' message id(s)');
}

// ---------------------------------------------------------------- parsing

/** repo, number and title out of "Re: [owner/repo] title (PR #123)". */
function parseSubject(subject) {
  var flat = String(subject).replace(/\s+/g, ' ');
  var m = /^(?:Re: *)?\[([^\]]+)\] *([\s\S]*?) *\((?:PR|Issue) *#(\d+)\) *$/.exec(flat);
  if (!m) return null;
  return { repo: m[1], title: m[2], number: m[3] };
}

/** Everything above GitHub's "--" signature delimiter, plus what it carries. */
function splitFooter(plain) {
  var m = /\n--[ ]*\n/.exec(plain);
  if (!m) return { content: String(plain).trim(), url: '', reason: '' };
  var footer = plain.slice(m.index + m[0].length);
  var url = (/https:\/\/github\.com\/\S+/.exec(footer) || [''])[0];
  var reason = (/You are receiving this because ([^.\n]+)/.exec(footer) || ['', ''])[1];
  return { content: plain.slice(0, m.index).trim(), url: url, reason: String(reason).trim() };
}

/** "@user approved this pull request." -> actor and what they did. */
function parseOpening(content) {
  var re = /^@([A-Za-z0-9_.\[\]-]+) +(commented on|approved|requested changes on|reviewed|left a comment on)\b[^\n]*\n?/;
  var m = re.exec(content);
  if (!m) return { author: '', kind: 'commented on', rest: content };
  var kind = m[2] === 'left a comment on' ? 'commented on' : m[2];
  return { author: m[1], kind: kind, rest: content.slice(m[0].length).replace(/^\s+/, '') };
}

/**
 * A hunk opener is "> " followed by a diff marker: @@, + or -.  A space must not
 * join that class: with the separator optional, "> ## text" would match on the
 * space alone, and a markdown quote inside someone's prose would invent an
 * inline comment that does not exist.
 */
var HUNK_OPENER = /^> ?[@+\-]/;
var HUNK_MAX_LINES = 14;

/**
 * A review arrives as a single email: the review body, then one quoted hunk
 * and its comment for each inline note.  Split it back into those parts.
 */
function splitReview(content) {
  var lines = String(content).split('\n');
  var body = [];
  var items = [];
  var i = 0;

  while (i < lines.length && !HUNK_OPENER.test(lines[i])) body.push(lines[i++]);

  while (i < lines.length) {
    var hunk = [lines[i++]];
    // The hunk runs through adjacent diff lines, blanks included; it ends at
    // the first line that is neither blank nor a diff line.
    while (i < lines.length && (lines[i].trim() === '' || /^[ +\-]/.test(lines[i]))) {
      hunk.push(lines[i++]);
    }
    var text = [];
    while (i < lines.length && !HUNK_OPENER.test(lines[i])) text.push(lines[i++]);
    items.push({
      hunk: hunk.join('\n').replace(/^> ?/, '').replace(/\s+$/, ''),
      text: text.join('\n').trim(),
      where: ''
    });
  }

  return { body: body.join('\n').trim(), items: items };
}

/** Long hunks are context, not the point; keep the tail nearest the comment. */
function trimHunk(hunk) {
  var lines = hunk.split('\n');
  if (lines.length <= HUNK_MAX_LINES) return hunk;
  return '…\n' + lines.slice(lines.length - HUNK_MAX_LINES).join('\n');
}

/** Every "In <file>:" heading, in document order — one per inline comment. */
function parseFilePaths(html) {
  var re = /In *<a\b[^>]*>([^<]+)<\/a> *:/g;
  var out = [];
  var m;
  while ((m = re.exec(String(html))) !== null) out.push(m[1].trim());
  return out;
}

/** One notification email -> the fields a Slack message needs. */
function parseNotification(msg) {
  var subj = parseSubject(msg.subject);
  if (!subj) return null;
  // Mail arrives CRLF; every pattern below is written against \n.
  var plain = String(msg.plainBody || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  var html = String(msg.htmlBody || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  var foot = splitFooter(plain);
  var open = parseOpening(foot.content);
  var review = splitReview(open.rest);

  // Label each comment with its file, but only when the counts agree — a
  // mislabelled path is worse than none.
  var paths = parseFilePaths(html);
  if (paths.length === review.items.length) {
    for (var i = 0; i < review.items.length; i++) review.items[i].where = paths[i];
  }

  var fallbackAuthor = (/^ *([^<]+?) *</.exec(msg.from || '') || ['', ''])[1];
  return {
    repo: subj.repo, number: subj.number, title: subj.title,
    author: open.author || fallbackAuthor || 'someone',
    kind: open.kind,
    reviewBody: review.body,
    items: review.items,
    url: foot.url, reason: foot.reason,
    matchedOpening: !!open.author
  };
}

// -------------------------------------------------------------- rendering

/** GitHub Markdown -> Slack mrkdwn. The dialects differ; see README. */
function toMrkdwn(text) {
  var stripped = String(text).replace(/<!--[\s\S]*?-->/g, '');
  var lines = stripped.split('\n');
  var out = [];
  var inFence = false;
  for (var i = 0; i < lines.length; i++) {
    if (/^ *```/.test(lines[i])) {
      inFence = !inFence;
      out.push('```');                 // a language tag would render as content
      continue;
    }
    out.push(inFence ? lines[i] : inlineMrkdwn(lines[i]));
  }
  if (inFence) out.push('```');
  return out.join('\n').trim();
}

function inlineMrkdwn(line) {
  // Slack needs & and < escaped; > is left alone so quoted replies stay quotes.
  var s = line.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  var spans = [];
  s = s.replace(/`[^`]+`/g, function (m) {
    spans.push(m);
    return '%%C' + (spans.length - 1) + '%%';
  });
  s = s.replace(/^ *#{1,6} +(.*)$/, '*$1*');
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<$2|$1 (image)>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '*$1*');
  s = s.replace(/__([^_]+)__/g, '*$1*');
  s = s.replace(/^( *)[-*+] +/, '$1• ');
  return s.replace(/%%C(\d+)%%/g, function (_, n) { return spans[Number(n)]; });
}

/** Trim on a line boundary, never inside a code fence. */
function clip(body, url) {
  if (body.length <= BODY_LIMIT) return body;
  var cut = body.slice(0, BODY_LIMIT);
  var nl = cut.lastIndexOf('\n');
  if (nl > 0) cut = cut.slice(0, nl);
  if ((cut.match(/```/g) || []).length % 2) cut += '\n```';
  return cut + '\n<' + url + '|Read the rest on GitHub>';
}

/**
 * One Slack message per inline comment, plus one for the review body when the
 * reviewer wrote one.  A review with four notes is four separate messages, so
 * each can be read, replied to and reacted to on its own.
 */
function buildPayloads(n) {
  var ref = n.repo + '#' + n.number;
  var link = n.url ? '<' + n.url + '|' + ref + '>' : ref;
  var mentioned = n.reason && n.reason.indexOf('mentioned') !== -1;

  function section(text) {
    return { type: 'section', text: { type: 'mrkdwn', text: text } };
  }
  function header(kind) {
    return section('*' + n.author + '* ' + kind + ' ' + link + '\n_' + n.title + '_');
  }
  function shell(kind, blocks) {
    return {
      attachments: [{
        color: BAR[kind] || BAR_DEFAULT,
        blocks: blocks,
        fallback: n.author + ' ' + kind + ' ' + ref
      }]
    };
  }

  var out = [];

  var body = toMrkdwn(n.reviewBody);
  if (body) out.push(shell(n.kind, [header(n.kind), section(clip(body, n.url))]));

  for (var i = 0; i < n.items.length; i++) {
    var it = n.items[i];
    var blocks = [header('commented on')];
    if (it.hunk) blocks.push(section('```\n' + trimHunk(it.hunk) + '\n```'));
    var text = toMrkdwn(it.text);
    if (text) blocks.push(section(clip(text, n.url)));
    var context = [];
    if (it.where) context.push('`' + it.where + '`');
    if (mentioned) context.push('you were mentioned');
    if (context.length) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: context.join('  ·  ') }] });
    }
    out.push(shell('commented on', blocks));
  }

  // An approval with no body and no notes still deserves to be announced.
  if (!out.length) out.push(shell(n.kind, [header(n.kind)]));
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseSubject: parseSubject,
    splitFooter: splitFooter,
    parseOpening: parseOpening,
    splitReview: splitReview,
    trimHunk: trimHunk,
    parseFilePaths: parseFilePaths,
    parseNotification: parseNotification,
    toMrkdwn: toMrkdwn,
    clip: clip,
    buildPayloads: buildPayloads,
    ACCEPT_CC: ACCEPT_CC,
    STATE_NOTICE: STATE_NOTICE
  };
}
