import { PROVIDER_LOGOS } from "../vendor/t3code-viewer/t3/providerLogos.js";

/** The page `push-session web` serves: pick sessions, choose who can open them, publish. */
export function renderWebPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>push-session</title>
<style>
:root{color-scheme:light;--background:#fcfcfc;--foreground:#18181b;--card:#fff;--muted:#71717a;--accent:#f4f4f5;--border:#e4e4e7;--success:#10b981;--destructive:#ef4444;font-family:-apple-system,BlinkMacSystemFont,"Inter Variable","Segoe UI",system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--background:#000;--foreground:#f5f5f5;--card:#0f0f0f;--muted:#a3a3a3;--accent:rgb(255 255 255/5%);--border:rgb(255 255 255/9%);--success:#34d399;--destructive:#f87171}}
*{box-sizing:border-box}
body{margin:0;min-width:320px;background:var(--background);color:var(--foreground);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
main{max-width:820px;margin:0 auto;padding:40px 24px 140px}
h1{margin:0;font-size:24px;letter-spacing:-.02em}
.status{margin:4px 0 0;color:var(--muted);font-size:13px}
.filters{position:sticky;top:0;z-index:3;display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:20px;padding:10px 0;background:var(--background)}
input[type=search]{min-width:0;flex:1 1 220px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:14px}
:focus-visible{outline:2px solid var(--foreground);outline-offset:1px}
.menu{position:relative;font-size:14px}
.menu summary{display:inline-flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;cursor:pointer;list-style:none;white-space:nowrap}
.menu summary::-webkit-details-marker{display:none}
.menu[open] summary,.menu summary:hover{background:var(--accent)}
.caret{color:var(--muted);font-size:11px}
.menu-items{position:absolute;top:calc(100% + 6px);right:0;z-index:4;display:grid;min-width:180px;padding:4px;border:1px solid var(--border);border-radius:10px;background:var(--card);box-shadow:0 8px 28px rgb(0 0 0/18%)}
.menu-items button{display:flex;align-items:center;gap:8px;padding:7px 8px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.menu-items button:hover,.menu-items button[aria-pressed="true"]{background:var(--accent)}
svg.logo{width:16px;height:16px;flex:none}
ul{list-style:none;margin:4px 0 0;padding:0;border-top:1px solid var(--border)}
li{display:flex;align-items:flex-start;gap:12px;padding:12px 8px;margin:0 -8px;border-bottom:1px solid var(--border);border-radius:8px;cursor:pointer}
li:hover{background:var(--accent)}
li input{width:16px;height:16px;margin:3px 0 0;flex:none;accent-color:var(--foreground)}
.body{min-width:0;flex:1}
.name{display:flex;align-items:flex-start;gap:8px;font-weight:550;overflow-wrap:anywhere}
.name svg{margin-top:3px}
.name span{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.meta{display:flex;flex-wrap:wrap;gap:2px 14px;color:var(--muted);font-size:13px}
.result{margin-top:6px;font-size:13px}
.result a{color:inherit}
.result.ok{color:var(--success)}
.result.failed{color:var(--destructive)}
.result button{margin-left:8px;padding:2px 8px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--foreground);font:inherit;font-size:12px;cursor:pointer}
.none{padding:40px 16px;color:var(--muted);text-align:center;cursor:default}
.none:hover{background:transparent}
.bar{position:fixed;right:0;bottom:0;left:0;z-index:5;border-top:1px solid var(--border);background:var(--background)}
.bar div{display:flex;max-width:820px;align-items:center;gap:12px;margin:0 auto;padding:12px 24px calc(12px + env(safe-area-inset-bottom))}
.bar .count{flex:1;color:var(--muted);font-size:13px}
.seg{display:inline-flex;padding:2px;border:1px solid var(--border);border-radius:9px}
.seg button{padding:5px 12px;border:0;border-radius:7px;background:transparent;color:var(--muted);font:inherit;font-size:13px;cursor:pointer}
.seg button[aria-pressed="true"]{background:var(--accent);color:var(--foreground)}
.seg button:disabled{opacity:.5;cursor:default}
.publish{padding:8px 16px;border:0;border-radius:8px;background:var(--foreground);color:var(--background);font:inherit;font-size:14px;font-weight:550;cursor:pointer}
.publish:disabled{opacity:.4;cursor:default}
</style>
</head>
<body>
<main>
<h1>push-session</h1>
<p class="status" id="status">Loading your sessions…</p>
<div class="filters">
  <input type="search" id="search" placeholder="Search by title, project, agent, or ID" aria-label="Search sessions">
  <details class="menu" id="agents" hidden><summary></summary><div class="menu-items"></div></details>
</div>
<ul id="list"></ul>
</main>
<div class="bar"><div>
  <span class="count" id="count">Nothing selected</span>
  <span class="seg" id="visibility" role="group" aria-label="Who can open the published sessions">
    <button type="button" data-value="private" aria-pressed="true" title="Your team and anyone with the share link">Private</button>
    <button type="button" data-value="public" aria-pressed="false" title="Anyone, no link needed">Public</button>
  </span>
  <button type="button" class="publish" id="publish" disabled>Publish</button>
</div></div>
<script>
(async () => {
  const token = new URLSearchParams(location.search).get("t") || "";
  const api = async (path, body) => {
    const response = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: { "x-push-session-token": token, ...(body && { "content-type": "application/json" }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return response.json();
  };
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
    svg.setAttribute("class", "logo");
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
  const ago = (time) => {
    if (!time) return null;
    const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
    if (minutes < 1) return "now";
    if (minutes < 60) return minutes + "m ago";
    if (minutes < 1440) return Math.floor(minutes / 60) + "h ago";
    if (minutes < 43200) return Math.floor(minutes / 1440) + "d ago";
    return new Date(time).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  };

  const [status, listing] = await Promise.all([api("/api/status"), api("/api/sessions")]);
  const sessions = listing.sessions || [];
  const statusLine = document.getElementById("status");
  statusLine.textContent = sessions.length + " session" + (sessions.length === 1 ? "" : "s") + " on this machine · "
    + (status.signedIn ? "publishing to " + (status.space || "your AI sessions Space") : "not signed in: sessions go to a claimable Space, private only");

  const selected = new Set();
  const results = new Map();
  let visibility = "private";
  let onlyAgent = null;
  let query = "";
  let busy = false;
  const list = document.getElementById("list");
  const count = document.getElementById("count");
  const publish = document.getElementById("publish");

  const refreshBar = () => {
    count.textContent = selected.size === 0 ? "Nothing selected" : selected.size + " selected";
    publish.disabled = busy || selected.size === 0;
    publish.textContent = busy ? "Publishing…" : selected.size > 1 ? "Publish " + selected.size + " sessions" : "Publish";
  };
  const draw = () => {
    const terms = query.toLowerCase().split(/\\s+/).filter(Boolean);
    const shown = sessions.filter((session) => {
      const text = [session.title, session.project, session.id, session.agentLabel, session.agent].filter(Boolean).join(" ").toLowerCase();
      return (!onlyAgent || session.agent === onlyAgent) && terms.every((term) => text.includes(term));
    });
    list.replaceChildren();
    for (const session of shown) {
      const row = element("li");
      const box = element("input");
      box.type = "checkbox";
      box.checked = selected.has(session.key);
      box.setAttribute("aria-label", "Select " + session.title);
      const toggle = () => {
        if (selected.has(session.key)) selected.delete(session.key); else selected.add(session.key);
        box.checked = selected.has(session.key);
        refreshBar();
      };
      box.addEventListener("click", (event) => { event.stopPropagation(); toggle(); });
      row.addEventListener("click", (event) => { if (!event.target.closest("a,button")) toggle(); });
      const body = element("div", "body");
      const name = element("div", "name");
      const mark = logo(session.agent);
      if (mark) name.append(mark);
      name.append(element("span", "", session.title));
      const meta = element("div", "meta");
      for (const text of [!mark && session.agentLabel, ago(session.updatedAt), session.project, session.id.slice(0, 8)]) if (text) meta.append(element("span", "", text));
      body.append(name, meta);
      const result = results.get(session.key);
      if (result) {
        const line = element("div", "result " + result.state);
        if (result.state === "ok") {
          const link = element("a", "", result.label);
          link.href = result.url;
          link.target = "_blank";
          link.rel = "noreferrer";
          const copy = element("button", "", "Copy link");
          copy.type = "button";
          copy.addEventListener("click", async () => { await navigator.clipboard.writeText(result.url); copy.textContent = "Copied"; });
          line.append(link, copy);
        } else {
          line.textContent = result.label;
        }
        body.append(line);
      }
      row.append(box, body);
      list.append(row);
    }
    if (shown.length === 0) list.append(element("li", "none", sessions.length === 0 ? "No agent sessions found on this machine." : "No sessions match."));
  };

  document.getElementById("search").addEventListener("input", (event) => { query = event.target.value; draw(); });
  for (const button of document.querySelectorAll("#visibility button")) {
    button.addEventListener("click", () => {
      visibility = button.dataset.value;
      for (const other of document.querySelectorAll("#visibility button")) other.setAttribute("aria-pressed", String(other === button));
    });
  }
  const agents = [...new Map(sessions.map((session) => [session.agent, session.agentLabel]))];
  if (agents.length > 1) {
    const picker = document.getElementById("agents");
    const current = picker.querySelector("summary");
    const menu = picker.querySelector(".menu-items");
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
    picker.hidden = false;
    document.addEventListener("pointerdown", (event) => { if (!picker.contains(event.target)) picker.open = false; });
  }

  publish.addEventListener("click", async () => {
    busy = true;
    // The whole batch goes out as it was chosen when Publish was pressed.
    const chosen = visibility;
    for (const button of document.querySelectorAll("#visibility button")) button.disabled = true;
    refreshBar();
    // One at a time: each publish reads and rewrites the Space's session list.
    for (const key of [...selected]) {
      results.set(key, { state: "pending", label: "Publishing…" });
      draw();
      let answer;
      try {
        answer = await api("/api/publish", { key, visibility: chosen });
      } catch (error) {
        answer = { ok: false, error: "The local server did not answer. Is push-session web still running?" };
      }
      results.set(key, answer.ok
        ? { state: "ok", url: answer.url, label: (answer.visibility === "public" ? "Public" : "Private") + " · " + answer.url }
        : { state: "failed", label: answer.error });
      if (answer.ok) selected.delete(key);
      draw();
      refreshBar();
    }
    busy = false;
    for (const button of document.querySelectorAll("#visibility button")) button.disabled = false;
    refreshBar();
  });

  draw();
  refreshBar();
})();
</script>
</body>
</html>`;
}
