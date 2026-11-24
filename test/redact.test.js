import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { redactDeep, redactText } from "../src/redact.js";

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
    assert.deepEqual(redactText(plain), { text: plain, count: 0 });
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
  assert.deepEqual(redactText("Authorization: Basic dTpw"), { text: "Authorization: Basic [redacted]", count: 1 });
  assert.deepEqual(redactText('{"authorization": "Bearer abc"}'), { text: '{"authorization": "Bearer [redacted]"}', count: 1 });
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
    // Inside a JSON string a quote escaped within the value does not end it.
    ['{"cmd":"API_TOKEN=\\"long enough \\\\\\"secret suffix\\\\\\" tail\\" deploy"}', '{"cmd":"API_TOKEN=\\"[redacted]\\" deploy"}'],
  ];
  for (const [input, expected] of cases) assert.deepEqual(redactText(input), { text: expected, count: 1 });

  assert.deepEqual(redactText("Authorization: Digest [redacted]\nnext"), { text: "Authorization: Digest [redacted]\nnext", count: 0 });

  const digest = 'Digest username="u", nonce="[redacted]", response="6629fae49393a05397450978507c4ef1"';
  const fields = redactDeep([{ input: { Authorization: digest, authorization: "Bearer [redacted]" } }]);
  assert.deepEqual(fields.value[0].input, { Authorization: "Digest [redacted]", authorization: "Bearer [redacted]" });
  assert.equal(fields.count, 1, "a value that is already the mask in full is not counted again");
});
