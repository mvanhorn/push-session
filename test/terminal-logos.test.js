import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { drawAgentLogos, logoCells, parseTerminalAnswer, transmitLogo } from "../src/terminal-logos.js";

function fakeTerminal(reply) {
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {}, pause() {} });
  const written = [];
  const stdout = { isTTY: true, write: (text) => { written.push(text); if (text.includes("\x1b[c")) queueMicrotask(() => stdin.emit("data", reply)); } };
  return { stdin, stdout, written };
}

test("reads image support and the background from the terminal's answers", () => {
  assert.deepEqual(parseTerminalAnswer("\x1b]11;rgb:ffff/ffff/f0f0\x07\x1b_Gi=4211;OK\x1b\\\x1b[?62;c"), { graphics: true, lightBackground: true });
  assert.deepEqual(parseTerminalAnswer("\x1b]11;rgb:1a1a/1b1b/2626\x1b\\\x1b[?62;c"), { graphics: false, lightBackground: false });
  assert.deepEqual(parseTerminalAnswer(""), { graphics: false, lightBackground: false });
});

test("sends a logo in chunks and stands it in the text as two placeholder cells", () => {
  const sequence = transmitLogo(201, "A".repeat(5_000));
  assert.match(sequence, /^\x1b_Ga=T,U=1,q=2,f=100,i=201,c=2,r=1,m=1;A{4096}\x1b\\\x1b_Gm=0;A{904}\x1b\\$/);
  assert.equal(logoCells(201), "\x1b[38;5;201m\u{10EEEE}̅̅\u{10EEEE}\x1b[39m");
});

test("draws logos only in a terminal that says it can, in the colour that suits its background", async () => {
  const ghostty = { TERM: "xterm-ghostty" };
  const capable = fakeTerminal("\x1b]11;rgb:ffff/ffff/ffff\x07\x1b_Gi=4211;OK\x1b\\\x1b[?62;c");
  const logos = await drawAgentLogos({ agents: ["claude", "codex", "gemini", "pi"], env: ghostty, ...capable });
  assert.equal(logos.mark("claude"), logoCells(201));
  assert.equal(logos.mark("codex"), logoCells(202));
  assert.equal(logos.mark("gemini"), null, "an agent without a logo keeps its text mark");
  assert.equal(logos.mark("pi"), logoCells(203));
  const { AGENT_LOGO_PNGS } = await import("../src/agent-logos.js");
  assert.ok(capable.written.join("").includes(AGENT_LOGO_PNGS.codex.light.slice(0, 200)), "a light background gets the dark logo");

  assert.equal(await drawAgentLogos({ agents: ["claude"], env: ghostty, ...fakeTerminal("\x1b[?62;c") }), null, "no image support");
  assert.equal(await drawAgentLogos({ agents: ["claude"], env: { TERM: "xterm-256color" }, ...capable }), null, "an unknown terminal is not asked");
  assert.equal(await drawAgentLogos({ agents: ["claude"], env: { ...ghostty, TMUX: "1" }, ...capable }), null);
  const piped = fakeTerminal("");
  piped.stdout.isTTY = false;
  assert.equal(await drawAgentLogos({ agents: ["claude"], env: ghostty, ...piped }), null);
});
