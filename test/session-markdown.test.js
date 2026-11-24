import assert from "node:assert/strict";
import test from "node:test";

import { continuationPrompt, sessionMarkdown } from "../vendor/t3code-viewer/sessionMarkdown.js";

const session = { title: "Fix the pager", providerLabel: "Claude Code", project: "/work/site", createdAt: "2026-11-23T09:00:00.000Z" };
const items = [
  { itemType: "user_message", itemId: "u1", detail: "Fix the pager" },
  { itemType: "command_execution", itemId: "t1", status: "failed", data: { label: "npm test" }, detail: "Input\nnpm test\n\nOutput\n```\n1 failing" },
  { itemType: "file_change", itemId: "t2", status: "completed", title: "apply_patch" },
  { itemType: "assistant_message", itemId: "a1:fragment:1", detail: "Part one, ", data: { wireFragment: { sourceItemId: "a1", index: 1, total: 2 } } },
  { itemType: "assistant_message", itemId: "a1:fragment:2", detail: "part two.", data: { wireFragment: { sourceItemId: "a1", index: 2, total: 2 } } },
];

test("writes the whole session as Markdown: messages, tool input and output, rejoined long messages", () => {
  assert.equal(sessionMarkdown(session, items), [
    "# Fix the pager",
    "Claude Code · /work/site · 2026-11-23",
    "## User\n\nFix the pager",
    "### Tool: npm test (failed)\n\n````\nInput\nnpm test\n\nOutput\n```\n1 failing\n````",
    "### Tool: apply_patch",
    "## Assistant\n\nPart one, part two.",
  ].join("\n\n") + "\n");
});

test("the prompt an agent opens with names the page and keeps the end of a long session", () => {
  const short = continuationPrompt(session, items, "https://sessions.example/sessions/one/");
  assert.match(short, /^Continue from this shared session\.\nFull transcript: https:\/\/sessions\.example\/sessions\/one\/\n\n# Fix the pager/);
  const long = continuationPrompt(session, [...items, { itemType: "user_message", itemId: "u2", detail: `${"x".repeat(9_000)} the end` }], "https://sessions.example/");
  assert.ok(long.length < 4_300);
  assert.match(long, /the end\n$/);
  assert.match(long, /whole transcript is on the clipboard/);
  assert.doesNotMatch(short, /clipboard/, "a session that fits is quoted in full");
});

test("a prompt cut inside an emoji still fits in a link", () => {
  const emoji = [{ itemType: "user_message", itemId: "u1", detail: "😀".repeat(5_000) }];
  for (const budget of [4_000, 3_999]) {
    assert.doesNotThrow(() => encodeURIComponent(continuationPrompt(session, emoji, "https://sessions.example/", budget)));
  }
});
