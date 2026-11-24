import path from "node:path";

import { PROVIDER_LOGOS } from "../vendor/t3code-viewer/t3/providerLogos.js";
import { escapeHtml } from "./render.js";
import { listSpaceAccess, readSpaceFiles } from "./spacefast.js";

export const INDEX_PATH = "sessions/index.json";
export const PUBLIC_INDEX_PATH = "sessions/public.json";
const TEAM_PATH = "sessions/team.html";
const ROOT_PATH = "index.html";
// Marks a page as written by push-session, so a Space's own home page is never taken for ours.
const GENERATOR = '<meta name="generator" content="push-session">';
const MAX_BACKFILL = 50;

/**
 * The sessions a Space already lists, and whether its home page belongs to something else.
 * Sessions published before the index existed are recovered from their own pages, at most 50 at
 * a time. Throws when the Space cannot be read, so a failed read never becomes an index that
 * forgets sessions.
 */
export async function loadSessionIndex(api, spaceId, { first } = {}) {
  const { paths, contents } = await readSpaceFiles({ ...api, spaceId, select: (all) => all.filter((file) => file === INDEX_PATH || file === ROOT_PATH) });
  // A home page that is not ours is the Space's own site: the sessions page then lives under /sessions/ only.
  const rootTaken = contents.has(ROOT_PATH) && !contents.get(ROOT_PATH).includes(GENERATOR);
  const parsed = contents.has(INDEX_PATH) ? JSON.parse(contents.get(INDEX_PATH)) : null;
  // Anything that is not public is private; older lists also had a link-only state, which private now covers.
  const sessions = (Array.isArray(parsed?.sessions) ? parsed.sessions : [])
    .filter((session) => typeof session?.path === "string")
    .map((session) => ({ ...session, visibility: session.visibility === "public" ? "public" : "private" }));

  const listed = new Set(sessions.map((session) => session.path));
  // `first` is the session being published now: it is recovered ahead of the cap, so it keeps its address.
  const unlisted = paths
    .filter((file) => /^sessions\/[^/]+\/index\.html$/.test(file) && !listed.has(path.posix.dirname(file)))
    .sort((left, right) => (path.posix.dirname(right) === first) - (path.posix.dirname(left) === first))
    .slice(0, MAX_BACKFILL);
  if (unlisted.length === 0) return { sessions, rootTaken };

  const [pages, access] = await Promise.all([
    readSpaceFiles({ ...api, spaceId, select: () => unlisted }),
    listSpaceAccess({ ...api, spaceId }),
  ]);
  for (const file of unlisted) {
    const shell = /<script id="push-session-data" type="application\/json">([\s\S]*?)<\/script>/.exec(pages.contents.get(file) || "");
    let data;
    try { data = JSON.parse(shell?.[1]); } catch { continue; }
    const sessionPath = path.posix.dirname(file);
    sessions.push(indexEntry({
      path: sessionPath,
      session: { ...data.session, id: data.session?.threadId, agent: data.session?.provider, agentLabel: data.session?.providerLabel },
      messages: data.stats?.messages,
      publishedAt: data.publishedAt,
      visibility: visibilityOf(access, sessionPath),
    }));
  }
  return { sessions, rootTaken };
}

export function indexEntry({ path: sessionPath, session, messages, publishedAt, visibility }) {
  const iso = (value) => {
    const date = new Date(value);
    return value && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
  };
  return {
    path: sessionPath,
    sessionId: session.id || null,
    title: session.title || null,
    agent: session.agent || null,
    agentLabel: session.agentLabel || null,
    project: session.project || null,
    createdAt: iso(session.createdAt),
    updatedAt: iso(session.updatedAt),
    messages: Number.isFinite(messages) ? messages : null,
    publishedAt: iso(publishedAt) || new Date().toISOString(),
    visibility,
  };
}

export function visibilityOf(access, sessionPath) {
  const covers = (entry) => entry.resources?.include?.includes(`/${sessionPath}/**`)
    && !entry.resources?.exclude?.includes(`/${sessionPath}/**`);
  return access.some((entry) => entry.subject?.audience === "public" && covers(entry)) ? "public" : "private";
}

/** The index pages and their two listings: everything for the team, public sessions for everyone else. */
export function sessionIndexFiles(sessions, { spaceTitle, root = true } = {}) {
  const sorted = [...sessions].sort((left, right) => String(right.updatedAt || right.publishedAt).localeCompare(String(left.updatedAt || left.publishedAt)));
  const listing = (entries) => JSON.stringify({ version: 1, sessions: entries });
  const html = renderIndexHtml(spaceTitle || "AI sessions");
  return [
    ...(root ? [{ path: ROOT_PATH, content: html, contentType: "text/html; charset=utf-8" }] : []),
    { path: "sessions/index.html", content: html, contentType: "text/html; charset=utf-8" },
    // Private on purpose: opening it makes Spacefast sign a team member in, then it returns to the list.
    { path: TEAM_PATH, content: `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${root ? "/" : "/sessions/"}"><title>${escapeHtml(spaceTitle || "AI sessions")}</title>`, contentType: "text/html; charset=utf-8" },
    { path: INDEX_PATH, content: listing(sorted), contentType: "application/json; charset=utf-8" },
    { path: PUBLIC_INDEX_PATH, content: listing(sorted.filter((session) => session.visibility === "public").map(({ sessionId: _private, ...entry }) => entry)), contentType: "application/json; charset=utf-8" },
  ];
}

function renderIndexHtml(spaceTitle) {
  const title = escapeHtml(spaceTitle);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${GENERATOR}
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>
:root{color-scheme:light;--background:#fcfcfc;--foreground:#18181b;--muted:#71717a;--accent:#f4f4f5;--border:#e4e4e7;--success:#10b981;font-family:-apple-system,BlinkMacSystemFont,"Inter Variable","Segoe UI",system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--background:#000;--foreground:#f5f5f5;--muted:#a3a3a3;--accent:rgb(255 255 255/5%);--border:rgb(255 255 255/9%);--success:#34d399}}
*{box-sizing:border-box}
body{margin:0;min-width:320px;background:var(--background);color:var(--foreground);font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
main{max-width:768px;margin:0 auto;padding:56px 24px 96px}
h1{margin:0;font-size:28px;line-height:1.2;letter-spacing:-.02em}
.summary{margin:6px 0 0;color:var(--muted);font-size:13px}
ul{list-style:none;margin:28px 0 0;padding:0;border-top:1px solid var(--border)}
li{border-bottom:1px solid var(--border)}
a.row{display:block;padding:14px 8px;margin:0 -8px;border-radius:8px;color:inherit;text-decoration:none}
a.row:hover{background:var(--accent)}
a.row:focus-visible{outline:2px solid var(--foreground);outline-offset:2px}
.title{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-weight:550}
.title{align-items:flex-start}
.name{display:flex;min-width:0;align-items:flex-start;gap:8px;overflow-wrap:anywhere}
.name svg{width:16px;height:16px;flex:none;margin-top:4px}
.name span{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.badge{margin-top:2px}
.filters{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-top:24px}
.filters input{min-width:0;flex:1 1 200px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:14px}
.filters input:focus-visible,.agent-picker summary:focus-visible{outline:2px solid var(--foreground);outline-offset:1px}
.agent-picker{position:relative;font-size:14px}
.agent-picker summary{display:inline-flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;cursor:pointer;list-style:none;white-space:nowrap}
.agent-picker summary::-webkit-details-marker{display:none}
.agent-picker[open] summary,.agent-picker summary:hover{background:var(--accent)}
.agent-picker .caret{color:var(--muted);font-size:11px}
.agent-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:2;display:grid;min-width:180px;padding:4px;border:1px solid var(--border);border-radius:10px;background:var(--background);box-shadow:0 8px 28px rgb(0 0 0/18%)}
.agent-menu button{display:flex;align-items:center;gap:8px;padding:7px 8px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.agent-menu button:hover,.agent-menu button[aria-pressed="true"]{background:var(--accent)}
.agent-picker svg{width:15px;height:15px;flex:none}
.filters+ul{margin-top:16px}
.none{padding:24px 0;color:var(--muted);text-align:center}
.meta{display:flex;flex-wrap:wrap;gap:2px 14px;color:var(--muted);font-size:13px}
.badge{flex:none;padding:1px 8px;border:1px solid var(--border);border-radius:999px;color:var(--muted);font-size:12px;font-weight:500;white-space:nowrap}
.badge.public{border-color:color-mix(in srgb,var(--success) 45%,transparent);color:var(--success)}
.team{margin-top:20px;color:var(--muted);font-size:13px}
.team a{color:var(--foreground)}
.empty{margin-top:28px;padding:40px 16px;border:1px dashed var(--border);border-radius:12px;color:var(--muted);text-align:center}
@media (max-width:600px){main{padding-top:32px}}
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p class="summary" id="summary">Loading sessions…</p>
<div id="list"></div>
</main>
<script>
(async () => {
  const read = async (file) => {
    try {
      const response = await fetch("/sessions/" + file, { headers: { accept: "application/json" } });
      return response.ok ? (await response.json()).sessions : null;
    } catch { return null; }
  };
  // The full listing is private to the team; Spacefast serves it only to signed-in members.
  const all = await read("index.json");
  const sessions = all || (await read("public.json")) || [];
  const labels = { public: "Public", private: "Private" };
  const summary = document.getElementById("summary");
  const list = document.getElementById("list");
  summary.textContent = sessions.length + (all ? "" : " public") + " session" + (sessions.length === 1 ? "" : "s");
  if (!all) {
    // A team member who has not opened a private page yet is not signed in to this site.
    const team = document.createElement("p");
    team.className = "team";
    const link = document.createElement("a");
    link.href = "/${TEAM_PATH}";
    link.textContent = "Sign in";
    team.append("On the team? ", link, " to see every session.");
    list.after(team);
  }
  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = all ? "No sessions here yet." : "No public sessions here.";
    list.append(empty);
    return;
  }
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const LOGOS = ${JSON.stringify(PROVIDER_LOGOS)};
  const logo = (agent) => {
    const data = LOGOS[agent];
    if (!data) return null;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", data.viewBox);
    svg.setAttribute("fill", data.fill || "currentColor");
    svg.setAttribute("aria-hidden", "true");
    for (const part of data.paths) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", part.d || part);
      if (part.fill) path.setAttribute("fill", part.fill);
      if (data.evenOdd) { path.setAttribute("fill-rule", "evenodd"); path.setAttribute("clip-rule", "evenodd"); }
      svg.append(path);
    }
    return svg;
  };
  const agents = [...new Map(sessions.filter((session) => session.agent).map((session) => [session.agent, session.agentLabel || session.agent]))];
  let onlyAgent = null;
  let query = "";
  const ul = element("ul");
  const draw = () => {
    const terms = query.toLowerCase().split(/\\s+/).filter(Boolean);
    const shown = sessions.filter((session) => {
      const text = [session.title, session.project, session.agentLabel].filter(Boolean).join(" ").toLowerCase();
      return (!onlyAgent || session.agent === onlyAgent) && terms.every((term) => text.includes(term));
    });
    ul.replaceChildren();
    for (const session of shown) {
      const row = element("a", "row");
      row.href = "/" + session.path + "/";
      const title = element("div", "title");
      const name = element("span", "name");
      const mark = logo(session.agent);
      if (mark) name.append(mark);
      name.append(element("span", "", session.title || "Untitled session"));
      title.append(name);
      if (all) title.append(element("span", "badge " + session.visibility, labels[session.visibility] || ""));
      const meta = element("div", "meta");
      const date = session.updatedAt || session.createdAt;
      for (const text of [
        // The logo already names the agent; one without a logo is named here instead.
        !mark && session.agentLabel,
        date && new Date(date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }),
        Number.isFinite(session.messages) && session.messages + " message" + (session.messages === 1 ? "" : "s"),
        session.project,
      ]) if (text) meta.append(element("span", "", text));
      row.append(title, meta);
      const item = element("li");
      item.append(row);
      ul.append(item);
    }
    if (shown.length === 0) ul.append(element("li", "none", "No sessions match."));
  };
  if (sessions.length > 1) {
    const filters = element("div", "filters");
    const search = element("input");
    search.type = "search";
    search.placeholder = "Search sessions";
    search.setAttribute("aria-label", "Search sessions");
    search.addEventListener("input", () => { query = search.value; draw(); });
    filters.append(search);
    if (agents.length > 1) {
      // One menu instead of a row of buttons: it stays one control however many agents there are.
      const picker = element("details", "agent-picker");
      const current = element("summary");
      const menu = element("div", "agent-menu");
      const show = (agent, label) => {
        const mark = logo(agent);
        current.replaceChildren(...(mark ? [mark] : []), label, element("span", "caret", "▾"));
      };
      for (const [agent, label] of [[null, "All agents"], ...agents]) {
        const item = element("button");
        item.type = "button";
        item.setAttribute("aria-pressed", String(agent === null));
        const mark = logo(agent);
        if (mark) item.append(mark);
        item.append(label);
        item.addEventListener("click", () => {
          onlyAgent = agent;
          for (const other of menu.children) other.setAttribute("aria-pressed", String(other === item));
          show(agent, agent === null ? "Agents" : label);
          picker.open = false;
          draw();
        });
        menu.append(item);
      }
      show(null, "Agents");
      picker.append(current, menu);
      document.addEventListener("pointerdown", (event) => { if (!picker.contains(event.target)) picker.open = false; });
      document.addEventListener("keydown", (event) => { if (event.key === "Escape") picker.open = false; });
      filters.append(picker);
    }
    list.append(filters);
  }
  list.append(ul);
  draw();
})();
</script>
</body>
</html>`;
}
