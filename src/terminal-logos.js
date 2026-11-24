import { AGENT_LOGO_PNGS } from "./agent-logos.js";

// Kitty's graphics protocol with Unicode placeholders: an image is sent once, then stands in the
// text as ordinary characters, so a list that redraws itself keeps its logos. Kitty, Ghostty and
// terminals built on Ghostty draw them; everywhere else the caller falls back to text marks.
const PLACEHOLDER = "\u{10EEEE}";
const TOP_LEFT = "̅̅";
const QUERY_ID = 4211;
// A placeholder names its image by its 256-colour foreground, so the IDs are colour indexes.
const FIRST_IMAGE_ID = 201;
const CHUNK = 4096;

/** What the terminal said about itself: whether it draws images, and whether its background is light. */
export function parseTerminalAnswer(answer) {
  const background = /\]11;rgb:([0-9a-f]{2})[0-9a-f]*\/([0-9a-f]{2})[0-9a-f]*\/([0-9a-f]{2})/i.exec(answer);
  const [red, green, blue] = background ? background.slice(1).map((hex) => parseInt(hex, 16) / 255) : [0, 0, 0];
  return {
    graphics: answer.includes(`_Gi=${QUERY_ID};OK`),
    lightBackground: 0.2126 * red + 0.7152 * green + 0.0722 * blue > 0.5,
  };
}

/** The escape sequence that hands a PNG to the terminal as a two-cell image for placeholders. */
export function transmitLogo(id, base64) {
  let sequence = "";
  for (let offset = 0; offset < base64.length; offset += CHUNK) {
    const more = offset + CHUNK < base64.length ? 1 : 0;
    const control = offset === 0 ? `a=T,U=1,q=2,f=100,i=${id},c=2,r=1,m=${more}` : `m=${more}`;
    sequence += `\x1b_G${control};${base64.slice(offset, offset + CHUNK)}\x1b\\`;
  }
  return sequence;
}

/** Two cells of text that the terminal paints with image `id`. */
export function logoCells(id) {
  return `\x1b[38;5;${id}m${PLACEHOLDER}${TOP_LEFT}${PLACEHOLDER}\x1b[39m`;
}

// Asks for the background colour and for image support, then for device attributes: every terminal
// answers the last one, so its reply marks the end even when the first two go unanswered.
function askTerminal(stdin, stdout, timeoutMs) {
  return new Promise((resolve) => {
    let answer = "";
    const finish = () => {
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      resolve(answer);
    };
    const onData = (chunk) => {
      answer += chunk;
      if (/\x1b\[\?[\d;]*c/.test(answer)) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    stdout.write(`\x1b]11;?\x07\x1b_Gi=${QUERY_ID},s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[c`);
  });
}

/**
 * Sends the agents' logos to a terminal that can draw them. Returns null when it cannot, or
 * `{ mark(agentId) }`: the text to print for that agent's logo, null for an agent without one.
 * The images stay with the terminal, since the finished prompt still shows them.
 */
export async function drawAgentLogos({ agents, stdin = process.stdin, stdout = process.stdout, env = process.env, timeoutMs = 300 }) {
  if (!stdin.isTTY || !stdout.isTTY || env.TMUX) return null;
  if (!/kitty|ghostty|rex/i.test(`${env.TERM} ${env.TERM_PROGRAM}`)) return null;
  const terminal = parseTerminalAnswer(await askTerminal(stdin, stdout, timeoutMs));
  if (!terminal.graphics) return null;

  const ids = new Map();
  for (const agent of agents) {
    const pngs = AGENT_LOGO_PNGS[agent];
    if (!pngs) continue;
    const id = FIRST_IMAGE_ID + ids.size;
    stdout.write(transmitLogo(id, pngs.any || (terminal.lightBackground ? pngs.light : pngs.dark)));
    ids.set(agent, id);
  }
  return { mark: (agent) => (ids.has(agent) ? logoCells(ids.get(agent)) : null) };
}
