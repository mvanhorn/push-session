import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { redactDeep, redactText } from "../src/redact.js";

// The text and the total, without the per-kind breakdown.
const masked = (input) => {
  const { text, count } = redactText(input);
  return { text, count };
};

test("masks well-known credential shapes and leaves ordinary text alone", () => {
  const cases = [
    ["aws AKIAIOSFODNN7EXAMPLE here", "aws [redacted] here"],
    ["sk-proj-abcdefghijklmnopqrstuvwx", "[redacted]"],
    [`ghp_${"a".repeat(36)}`, "[redacted]"],
    ["xoxb-1234567890-abcdefghij", "[redacted]"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\nafter", "[redacted]\nafter"],
    ["export STRIPE_SECRET_KEY=whsec_1234567890", "export STRIPE_SECRET_KEY=[redacted]"],
    ['{"api_token": "abcdefgh12345678"}', '{"api_token": "[redacted]"}'],
    ['{\\"password\\":\\"hunter2hunter2\\"}', '{\\"password\\":\\"[redacted]\\"}'],
  ];
  for (const [input, expected] of cases) assert.equal(redactText(input).text, expected);
  for (const plain of ["const key = map.get(id);", "The token count is 1200.", "PASSWORD=", "sk-short", "keyboard: true", '{"password": "Password", "token": "Passwords do not match"}']) {
    assert.deepEqual(masked(plain), { text: plain, count: 0 });
  }
});

test("masks nested tool input and output and counts every secret", () => {
  const messages = [
    { role: "user", content: "use ghp_" + "b".repeat(36), createdAt: 5 },
    { role: "tool", name: "Bash", input: { command: "API_KEY=abcdefgh1234 run" }, output: [{ text: "AKIAIOSFODNN7EXAMPLE" }] },
  ];
  const { value, count } = redactDeep(messages);
  assert.equal(count, 3);
  assert.equal(value[0].content, "use [redacted]");
  assert.equal(value[0].createdAt, 5);
  assert.equal(value[1].input.command, "API_KEY=[redacted] run");
  assert.equal(value[1].output[0].text, "[redacted]");
  assert.equal(messages[1].input.command, "API_KEY=abcdefgh1234 run", "the loaded transcript is not mutated");
});

test("masks credential fields of structured input by their name", () => {
  const { value, count } = redactDeep([{ role: "tool", input: { password: "abcdefgh12345678", username: "abcdefgh12345678", max_tokens: 4096, token: "Passwords" } }]);
  assert.equal(count, 1);
  assert.deepEqual(value[0].input, { password: "[redacted]", username: "abcdefgh12345678", max_tokens: 4096, token: "Passwords" });
});

test("masks recovered source files, refreshes their size and hash, and drops an archive that held secrets", () => {
  const secret = "ghp_" + "c".repeat(36);
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
  const version = (text) => ({
    source: {
      files: [{ path: "app.js", content: Buffer.from(text), bytes: Buffer.byteLength(text), sha256: "stale" }, { path: "logo.png", content: image, bytes: 6, sha256: "image" }],
      archive: { content: gzipSync("package.json") },
    },
  });
  const { value, count } = redactDeep({ sites: [{ versions: [version("const token = \"" + secret + "\";"), version("const answer = 42;")] }] });
  assert.equal(count, 1);

  // An archive is all that was recovered: it is inspected, and dropped when it holds a secret or cannot be read.
  const only = (content) => redactDeep({ source: { files: [], archive: { content } } });
  assert.deepEqual([only(gzipSync(`TOKEN ${secret}`)).value.source.archive, only(gzipSync(`TOKEN ${secret}`)).count], [null, 1]);
  assert.equal(only(Buffer.from("not gzip")).value.source.archive, null);
  assert.notEqual(only(gzipSync("plain source")).value.source.archive, null);
  const [masked, clean] = value.sites[0].versions;
  assert.equal(masked.source.files[0].content.toString(), "const token = \"[redacted]\";");
  assert.equal(masked.source.files[0].bytes, 27);
  assert.notEqual(masked.source.files[0].sha256, "stale");
  assert.equal(masked.source.files[1].content, image);
  assert.equal(masked.source.archive, null);
  assert.equal(clean.source.files[0].sha256, "stale");
  assert.notEqual(clean.source.archive, null);
});

test("masks bare credential names and Authorization headers", () => {
  const cases = [
    ["PASSWORD=hunter2hunter2", "PASSWORD=[redacted]"],
    ["TOKEN=abcdefgh12345678 next", "TOKEN=[redacted] next"],
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", "Authorization: Bearer [redacted]"],
    ["curl -H 'Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1Ng=='", "curl -H 'Authorization: Basic [redacted]'"],
  ];
  for (const [input, expected] of cases) assert.equal(redactText(input).text, expected);
  assert.equal(redactDeep([{ input: { Authorization: "Bearer abcdefghijklmnopqrstuvwxyz012345" } }]).value[0].input.Authorization, "Bearer [redacted]");
  for (const plain of ["Bearer authentication is required", "Basic usage of the tool"]) assert.equal(redactText(plain).count, 0);

  // In a header even a short credential is one, in text and as a field.
  assert.deepEqual(masked("Authorization: Basic dTpw"), { text: "Authorization: Basic [redacted]", count: 1 });
  assert.deepEqual(masked('{"authorization": "Bearer abc"}'), { text: '{"authorization": "Bearer [redacted]"}', count: 1 });
  const fields = redactDeep([{ input: { Authorization: "Basic dTpw", "Proxy-Authorization": "dTpw", authorization: "" } }]);
  assert.deepEqual(fields.value[0].input, { Authorization: "Basic [redacted]", "Proxy-Authorization": "[redacted]", authorization: "" });
  assert.equal(fields.count, 2);
});

test("masks a quoted assignment up to its closing quote, and a whole Authorization value", () => {
  const cases = [
    ['API_TOKEN="first part second part" && deploy', 'API_TOKEN="[redacted]" && deploy'],
    ["DB_PASSWORD='p@ss word 1234' psql", "DB_PASSWORD='[redacted]' psql"],
    ['SECRET_KEY="abc \\"quoted\\" def" run', 'SECRET_KEY="[redacted]" run'],
    ['{"cmd":"API_TOKEN=\\"first part second part\\" deploy"}', '{"cmd":"API_TOKEN=\\"[redacted]\\" deploy"}'],
    ['Authorization: Digest username="u", response="6629fae49393a05397450978507c4ef1"', "Authorization: Digest [redacted]"],
    // A value that only starts with the mask still has a credential after it.
    ['Authorization: Digest [redacted], response="6629fae49393a05397450978507c4ef1"\nnext', "Authorization: Digest [redacted]\nnext"],
    // A quoted value or header ends at its quote: the fields and text after it are kept.
    ['{"Authorization":"Negotiate YIIZaAYGKwYBBQUCoIIZ","enabled":true}', '{"Authorization":"Negotiate [redacted]","enabled":true}'],
    ['{"Authorization": "Digest username=\\"u\\", response=\\"6629fae4\\"", "retries": 2}', '{"Authorization": "Digest [redacted]", "retries": 2}'],
    ["curl -H 'Authorization: Digest username=\"u\", response=\"6629fae4\"' https://example.com", "curl -H 'Authorization: Digest [redacted]' https://example.com"],
    // A value with no other end is masked up to the quote after its last backslash.
    ['{"cmd":"export API_KEY=\\"abcdefgh\\\\\\" && echo ok"}', '{"cmd":"export API_KEY=\\"[redacted]\\" && echo ok"}'],
    // Inside a JSON string a quote escaped within the value does not end it.
    ['{"cmd":"API_TOKEN=\\"long enough \\\\\\"secret suffix\\\\\\" tail\\" deploy"}', '{"cmd":"API_TOKEN=\\"[redacted]\\" deploy"}'],
  ];
  for (const [input, expected] of cases) assert.deepEqual(masked(input), { text: expected, count: 1 });

  assert.deepEqual(masked("Authorization: Digest [redacted]\nnext"), { text: "Authorization: Digest [redacted]\nnext", count: 0 });

  // An escaped quote that never closes, followed by many escapes, is left alone without a long search.
  const unclosed = 'API_KEY=\\"' + "\\\\a".repeat(5000);
  const started = performance.now();
  assert.deepEqual(masked(unclosed), { text: unclosed, count: 0 });
  assert.ok(performance.now() - started < 1000, "an unclosed value is not searched exponentially");

  const digest = 'Digest username="u", nonce="[redacted]", response="6629fae49393a05397450978507c4ef1"';
  const fields = redactDeep([{ input: { Authorization: digest, authorization: "Bearer [redacted]" } }]);
  assert.deepEqual(fields.value[0].input, { Authorization: "Digest [redacted]", authorization: "Bearer [redacted]" });
  assert.equal(fields.count, 1, "a value that is already the mask in full is not counted again");
});

test("masks GitLab, Stripe, Google and npm keys, counts each kind, and leaves near misses alone", () => {
  const rules = [
    ["anthropic", `sk-ant-api03-${"a".repeat(80)}`, "sk-ant-short"],
    ["openai", `sk-proj-${"a".repeat(48)}`, `task-${"a".repeat(48)}`],
    ["gitlab", `glpat-${"a".repeat(20)}`, `glpat-${"a".repeat(19)}`],
    ["stripe", `sk_live_${"a".repeat(24)}`, `sk_test_${"a".repeat(24)}`],
    ["stripe", `rk_live_${"a".repeat(24)}`, `rk_test_${"a".repeat(24)}`],
    ["google", `AIza${"a".repeat(35)}`, `AIza${"a".repeat(34)}`],
    ["npm", `npm_${"a".repeat(36)}`, `npm_${"a".repeat(35)}`],
    ["github", `ghp_${"a".repeat(36)}`, `ghp_${"a".repeat(35)}`],
    ["aws", "AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPL"],
  ];
  for (const [kind, token, nearMiss] of rules) {
    assert.deepEqual(redactText(`Before (${token}) after`), { text: "Before ([redacted]) after", count: 1, kinds: { [kind]: 1 } }, kind);
    assert.deepEqual(redactText(nearMiss), { text: nearMiss, count: 0, kinds: {} }, nearMiss);
  }
  // A fixed-length key inside a longer word is not one.
  for (const text of [`npm_${"a".repeat(37)}`, `prefix_glpat-${"a".repeat(20)}`]) assert.equal(redactText(text).count, 0, text);
});

test("masks only the password of a URL with credentials", () => {
  assert.deepEqual(redactText("Fetch https://alice:p%40ssword@example.test/path?q=1"), {
    text: "Fetch https://alice:[redacted]@example.test/path?q=1", count: 1, kinds: { "url-password": 1 },
  });
  assert.equal(redactText("psql postgres://app:s3cretpass99@db.example.com/app").text, "psql postgres://app:[redacted]@db.example.com/app");
  for (const text of ["https://alice@example.test/path", "https://alice:@example.test/path", "https://example.test:8080/path", "http://localhost:3000/a@b", "postgres://user:pass@host/db", "https://user:$PASSWORD@host/db"]) {
    assert.equal(redactText(text).count, 0, text);
  }
  assert.equal(redactText("redis://:s3cret123@cache.example.test:6379/0").text, "redis://:[redacted]@cache.example.test:6379/0");
  // A port is not a password, and the match stays inside the string the URL is in.
  assert.equal(redactText('{"base":"https://example.test:8080","password":"hunter2@secret"}').text, '{"base":"https://example.test:8080","password":"[redacted]"}');
  // A "#" or "?" pasted unencoded is part of the password, and so is a "$" that names no variable.
  for (const [input, expected] of [
    ["postgres://user:Pa#ss99word@db.example.com/app", "postgres://user:[redacted]@db.example.com/app"],
    ["postgres://user:Pa?ss99word@db.example.com/app", "postgres://user:[redacted]@db.example.com/app"],
    ["redis://:abc#123xyz@host:6379", "redis://:[redacted]@host:6379"],
    ["postgres://u:$ecret12@host/db", "postgres://u:[redacted]@host/db"],
    ["postgres://admin:2024#Spring!@db.internal/app", "postgres://admin:[redacted]@db.internal/app"],
    ["mysql://root:12345?x@h", "mysql://root:[redacted]@h"],
    ["postgres://user.name:12345#x@host", "postgres://user.name:[redacted]@host"],
    ["postgres://first.last:2024?Pw@db/app", "postgres://first.last:[redacted]@db/app"],
  ]) assert.equal(redactText(input).text, expected, input);
  // A port followed by a query or a fragment is not a password, whatever "@" comes later.
  for (const text of ["https://example.test:8080?email=alice@example.org/path", "https://example.test:8080#to=alice@example.org", "http://localhost:3000?to=a@b.test"]) assert.equal(redactText(text).count, 0, text);
  // A key that is the password is counted once, as the key.
  assert.deepEqual(redactText(`https://user:ghp_${"a".repeat(36)}@host.test`).kinds, { github: 1 });
});

test("masks assignments in any case and with spaces, and leaves code and placeholders alone", () => {
  const cases = [
    ['password = "hunter2hunter2"', 'password = "[redacted]"'],
    ["db_password='p4ssw0rd!'", "db_password='[redacted]'"],
    ["token = abcdefgh12345678", "token = [redacted]"],
    ["password=hunter2hunter2 next", "password=[redacted] next"],
    ["config.apiKey = \"abc123def456\";", "config.apiKey = \"[redacted]\";"],
    ["GET /cb?access_token=abc123def456&state=1", "GET /cb?access_token=[redacted]&state=1"],
    ["API_KEY = abc123def456", "API_KEY = [redacted]"],
  ];
  for (const [input, expected] of cases) assert.deepEqual(redactText(input), { text: expected, count: 1, kinds: { assignment: 1 } }, input);

  // A dotted token is not a property, and a value that only starts like a placeholder is not one.
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
  for (const [input, expected] of [
    [`ACCESS_TOKEN=${jwt}`, "ACCESS_TOKEN=[redacted]"],
    [`token = ${jwt}`, "token = [redacted]"],
    ["PASSWORD=correct.horse.battery.staple", "PASSWORD=[redacted]"],
    ["PASSWORD=%40secret123", "PASSWORD=[redacted]"],
    ["PASSWORD=$ecret-123", "PASSWORD=[redacted]"],
    // The header and NAME=value rules take whatever follows: a password may look like a variable or a call.
    ["DB_PASSWORD=$uperS3cret99", "DB_PASSWORD=[redacted]"],
    ["DB_PASSWORD=Secr3t(x)!abc", "DB_PASSWORD=[redacted]"],
    ["API_KEY=abc(def)12345", "API_KEY=[redacted]"],
    ["Authorization: Bearer $abcdefgh", "Authorization: Bearer [redacted]"],
    // A key inside a longer value takes the rest of the value with it.
    [`TOKEN=ghp_${"a".repeat(36)}!tail99`, "TOKEN=[redacted]"],
    [`password = "ghp_${"a".repeat(36)}!suffix99"`, 'password = "[redacted]"'],
    [`https://u:ghp_${"a".repeat(36)}%21suffix99@host.test/x`, "https://u:[redacted]@host.test/x"],
    ["https://user:%40secret123@host.test/db", "https://user:[redacted]@host.test/db"],
  ]) assert.equal(redactText(input).text, expected, input);
  for (const text of [
    "const apiKey = process.env.API_KEY",
    "const token = response.data.token2;",
    "const apiKey = userApiKey;",
    "token = getToken2(session)",
    "const SECRET_KEY = /secret|token/i;",
    "api_key = $API_KEY",
    "token = ${GITHUB_TOKEN_2}",
    "password=changeme",
    'tokenizer = "cl100k_base"',
    "max_tokens = 128000000",
    'password = "Enter your password"',
    "if (token == expected12345) return;",
    "private_key_path = /etc/keys/id_ed25519",
    "sha=0123456789abcdef0123456789abcdef01234567",
  ]) {
    assert.deepEqual(redactText(text), { text, count: 0, kinds: {} }, text);
  }
});

test("reports what was masked by kind across a transcript, and is quick on awkward input", () => {
  const npm = `npm_${"a".repeat(36)}`;
  const messages = [
    { role: "user", content: npm },
    { role: "tool", input: { env: { API_KEY: "abcdefgh1" }, headers: { Authorization: "Bearer fake-token" }, args: [npm, null, 42] }, output: [{ text: "db: postgres://app:s3cretpass99@db/app" }] },
  ];
  const result = redactDeep(messages);
  assert.equal(result.count, 5);
  assert.deepEqual(result.kinds, { npm: 2, assignment: 1, authorization: 1, "url-password": 1 });
  assert.deepEqual(redactDeep(result.value), { value: result.value, count: 0, kinds: {} }, "masking again finds nothing");

  const started = performance.now();
  for (const text of ["x=".repeat(40000), "a.b-".repeat(20000) + "://", "password=" + "a".repeat(60000), 'token = "' + "a".repeat(60000), "https://" + "a:".repeat(30000)]) redactText(text);
  assert.ok(performance.now() - started < 2000, "long runs without a credential are not searched slowly");
});
