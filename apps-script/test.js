const fs = require('fs');
const path = require('path');

const SRC = process.env.HOME + '/code/github-pr-watch/apps-script/Code.gs';
const tmp = '/tmp/Code.test.js';
fs.writeFileSync(tmp, fs.readFileSync(SRC, 'utf8'));
const lib = require(tmp);

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));

let failures = 0;
function check(label, cond, detail) {
  if (!cond) {
    failures++;
    console.log('  FAIL: ' + label + (detail ? ' -> ' + JSON.stringify(detail) : ''));
  }
}

for (const f of fixtures) {
  console.log('\n=== ' + f.name);
  const n = lib.parseNotification(f);
  if (!n) { console.log('  FAIL: did not parse'); failures++; continue; }

  console.log('  repo/num : ' + n.repo + '#' + n.number);
  console.log('  title    : ' + n.title);
  console.log('  author   : ' + n.author + '   kind: ' + n.kind);
  console.log('  where    : ' + (n.where || '(none)'));
  console.log('  reason   : ' + n.reason);
  console.log('  url      : ' + n.url);
  if (n.hunk) console.log('  hunk     : ' + JSON.stringify(n.hunk));

  // The footer must never survive into any message.
  const payloads = lib.buildPayloads(n);
  const flat = JSON.stringify(payloads);
  console.log('  messages : ' + payloads.length + ', inline items: ' + n.items.length);
  if (f.expect) {
    check('expected message count', payloads.length === f.expect.messages, payloads.length);
    check('expected inline count', n.items.length === f.expect.items, n.items.length);
  }
  check('footer leaked', !/Reply to this email directly/.test(flat));
  check('receiving-this leaked', !/You are receiving this because/.test(flat));
  check('message-id leaked', !/Message ID:/.test(flat));
  check('placeholder leaked', !/%%C\d+%%/.test(flat), flat.match(/%%C\d+%%/g));
  check('url present', /github\.com/.test(flat));
  check('link not empty', !/<\|/.test(flat), flat.match(/<\|[^>]*>/g));
  check('some content', payloads.some(p => p.attachments[0].blocks.length >= 1));

  console.log('  --- rendered ---');
  payloads.forEach((p, idx) => {
    console.log('  [message ' + (idx + 1) + '  color ' + p.attachments[0].color + ']');
    for (const b of p.attachments[0].blocks) {
      const t = b.type === 'section' ? b.text.text : b.elements[0].text;
      console.log(t.split('\n').map(l => '  | ' + l).join('\n'));
    }
  });
}

// The CC filter must accept every reason that can land on your own thread,
// and reject the firehose ones.
for (const cc of ['author', 'mention', 'state_change', 'comment', 'manual']) {
  check('accepts ' + cc, lib.ACCEPT_CC.test(cc + '@noreply.github.com'));
}
for (const cc of ['review_requested', 'team_mention', 'assign', 'ci_activity']) {
  check('rejects ' + cc, !lib.ACCEPT_CC.test(cc + '@noreply.github.com'));
}

// A merge notice is not a comment: no "@user <verb>" opening, and the body
// starts with the state verb.
{
  const notice = fixtures.find(f => /merge notice/.test(f.name));
  const n = lib.parseNotification(notice);
  check('merge notice has no opening', n.matchedOpening === false, n);
  check('merge notice recognised', lib.STATE_NOTICE.test(n.reviewBody), n.reviewBody);
}

// A state_change-CC'd comment IS a comment and must survive.
{
  const real = fixtures.find(f => /state_change@, not author@/.test(f.name));
  const n = lib.parseNotification(real);
  check('state_change comment kept', n.matchedOpening === true, n);
  check('state_change author parsed', n.author === 'kim-t', n.author);
  check('state_change hunk found', n.items[0] && n.items[0].hunk.length > 0, n.items);
}

// A markdown blockquote inside prose is not a hunk opener.
{
  const r = lib.splitReview('body text\n\n> +code\n\ncomment one\n\n> ## not a hunk\n\nmore prose');
  check('one hunk, not two', r.items.length === 1, r.items.map(i => i.hunk));
  check('quote stays in comment text', /## not a hunk/.test(r.items[0].text), r.items[0].text);
}

// Regression: a bare number must not be swallowed by the code-span restore.
const digits = lib.toMrkdwn('ResetHard will return 500? and `code` and 409');
check('digits preserved', /500\?/.test(digits) && /409/.test(digits), digits);
check('code span restored', /`code`/.test(digits), digits);

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks passed'));
process.exit(failures ? 1 : 0);
