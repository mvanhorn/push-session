import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { OPEN_WEB, pickSession } from "../src/session-picker.js";

function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 30 });
  let screen = "";
  output.on("data", (chunk) => { screen += chunk; });
  const plain = () => screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  // The last full frame drawn, without colours or cursor movement.
  const frame = () => plain().split("Which session?").at(-1);
  // What was drawn since the last call: the prompt redraws only the lines that changed.
  let seen = 0;
  const drawn = () => { const all = plain(); const fresh = all.slice(seen); seen = all.length; return fresh; };
  const press = async (keys) => { input.write(keys); await new Promise((resolve) => setTimeout(resolve, 20)); };
  return { input, output, frame, drawn, press };
}

const options = [
  { value: 1, agent: "claude", label: "✻  Draft the post", search: "draft the post claude" },
  { value: 2, agent: "codex", label: "❋  Fix the router", search: "fix the router codex" },
  { value: 3, agent: "codex", label: "❋  Add retries", search: "add retries codex" },
];
const agents = [{ id: "claude", label: "Claude Code", mark: "✻ " }, { id: "codex", label: "Codex", mark: "❋ " }];
const filter = (search, option) => search.toLowerCase().split(/\s+/).filter(Boolean).every((term) => option.search.includes(term));
const message = (count) => `Which session? (${count} sessions)`;

test("Tab switches which agent's sessions are listed and the footer says which", async () => {
  const { input, output, frame, drawn, press } = terminal();
  const picked = pickSession({ message, options, agents, filter, maxItems: 10, input, output });
  await press("");
  assert.match(frame(), /\(3 sessions\)[\s\S]*Draft the post[\s\S]*Fix the router[\s\S]*Agent: all • Tab: change/);
  assert.doesNotMatch(frame(), /○ Agent/, "the agent is not a row in the list");

  await press("\t");
  assert.match(frame(), /\(1 sessions\)[\s\S]*Agent: ✻  Claude Code • Tab: change/);
  assert.doesNotMatch(frame(), /Fix the router/);
  await press("\t");
  assert.match(frame(), /\(2 sessions\)[\s\S]*Fix the router[\s\S]*Add retries[\s\S]*Agent: ❋  Codex/);

  drawn();
  await press("retries");
  const typed = drawn();
  assert.match(typed, /Search: retries█ \(1 match\)/);
  assert.match(typed, /● ❋  Add retries/);
  await press("\t");
  const switched = drawn();
  assert.match(switched, /Agent: all • Tab: change/);
  assert.doesNotMatch(switched, /Search: Type to search/, "Tab keeps what was typed");
  await press("\r");
  assert.equal(await picked, 3);
});

test("one agent has no agent line, and Escape cancels", async () => {
  const { input, output, frame, press } = terminal();
  const picked = pickSession({ message, options: options.slice(1), agents: [], filter, maxItems: 10, input, output });
  await press("");
  assert.doesNotMatch(frame(), /Agent:/);
  await press("\x1b");
  await press("");
  assert.equal(await picked, null);
});

test("Ctrl+X leaves the list for the picker in the browser", async () => {
  const { input, output, frame, drawn, press } = terminal();
  const picked = pickSession({ message, options, agents, filter, maxItems: 10, web: true, input, output });
  await press("");
  assert.match(frame(), /Ctrl\+X: pick in browser/);
  drawn();
  await press("\x18");
  assert.equal(await picked, OPEN_WEB);
  assert.match(drawn(), /Opening the picker in your browser/);
});
