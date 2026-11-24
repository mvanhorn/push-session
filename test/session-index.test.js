import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { renderSessionBundle } from "../src/render.js";
import { indexEntry, loadSessionIndex, sessionIndexFiles } from "../src/session-index.js";

const entry = (id, visibility) => indexEntry({
  path: `sessions/${id}`,
  session: { title: `Session ${id}`, agent: "claude", agentLabel: "Claude Code", updatedAt: `2026-11-2${id}T10:00:00Z` },
  messages: 2,
  visibility,
});

async function openIndex(context, files, signedIn) {
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const dom = new JSDOM(byPath.get("index.html"), {
    url: "https://sessions.example/", runScripts: "dangerously",
    beforeParse(window) {
      window.fetch = async (url) => {
        const file = String(url).replace(/^\//, "");
        if (file === "sessions/index.json" && !signedIn) return { ok: false, status: 403 };
        return { ok: true, json: async () => JSON.parse(byPath.get(file)) };
      };
    },
  });
  context.after(() => dom.window.close());
  const { document } = dom.window;
  for (let attempt = 0; attempt < 50 && document.getElementById("summary").textContent.startsWith("Loading"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return document;
}

test("the sessions page lists everything for the team and only public sessions for everyone else", async (context) => {
  const files = sessionIndexFiles([entry(1, "private"), entry(2, "public"), entry(3, "private")], { spaceTitle: "AI <sessions>" });
  assert.deepEqual(files.map((file) => file.path), ["index.html", "sessions/index.html", "sessions/team.html", "sessions/index.json", "sessions/public.json"]);
  assert.deepEqual(JSON.parse(files[4].content).sessions.map((session) => session.path), ["sessions/2"]);
  assert.match(files[0].content, /<title>AI &lt;sessions&gt;<\/title>/);

  const team = await openIndex(context, files, true);
  assert.equal(team.getElementById("summary").textContent, "3 sessions");
  assert.deepEqual([...team.querySelectorAll("a.row")].map((row) => row.getAttribute("href")), ["/sessions/3/", "/sessions/2/", "/sessions/1/"], "newest first");
  assert.deepEqual([...team.querySelectorAll(".badge")].map((badge) => badge.textContent), ["Private", "Public", "Private"]);
  assert.equal(team.querySelector(".team"), null);

  const visitor = await openIndex(context, files, false);
  assert.equal(visitor.getElementById("summary").textContent, "1 public session");
  assert.deepEqual([...visitor.querySelectorAll("a.row")].map((row) => row.getAttribute("href")), ["/sessions/2/"]);
  assert.equal(visitor.querySelector(".badge"), null);
  assert.equal(visitor.querySelector(".team a").getAttribute("href"), "/sessions/team.html", "a private page signs a team member in");

  const none = await openIndex(context, sessionIndexFiles([entry(1, "private")]), false);
  assert.equal(none.querySelector(".empty").textContent, "No public sessions here.");
});

test("reads the Space's session list and recovers sessions published before the list existed", async () => {
  const shell = renderSessionBundle({ agent: "codex", agentLabel: "Codex", id: "old", title: "Older session", project: "/work" }, [{ role: "user", content: "Hi" }]).files[0].content;
  const stored = { "sessions/index.json": JSON.stringify({ version: 1, sessions: [entry(1, "public"), { ...entry(2, "private"), visibility: "link" }] }), "sessions/old/index.html": shell, "sessions/1/index.html": "" };
  const fetchImpl = async (url) => {
    const target = new URL(url);
    if (target.pathname.endsWith("/files")) return json({ data: { versionId: "ver_1", files: Object.keys(stored).map((path) => ({ path })) } });
    if (target.pathname.endsWith("/files/links")) {
      return json({ data: { links: Object.fromEntries(target.searchParams.getAll("path").map((path) => [path, { url: `https://files.example/${path}` }])) } });
    }
    if (target.pathname.endsWith("/access")) {
      return json({ data: [{ subject: { audience: "link" }, resources: { include: ["/sessions/old", "/sessions/old/**"] } }] });
    }
    return new Response(stored[target.pathname.slice(1)]);
  };
  const { sessions, rootTaken } = await loadSessionIndex({ fetchImpl, accessToken: "token" }, "spc_one");
  assert.equal(rootTaken, false);
  assert.deepEqual(sessions.map((session) => [session.path, session.title, session.visibility]), [
    ["sessions/1", "Session 1", "public"],
    ["sessions/2", "Session 2", "private"],
    ["sessions/old", "Older session", "private"],
  ]);
  assert.equal(sessions[2].agentLabel, "Codex");
  assert.equal(sessions[2].sessionId, "old", "so a later publish finds the session at its old address");

  const failing = async () => new Response("{}", { status: 500 });
  await assert.rejects(loadSessionIndex({ fetchImpl: failing, accessToken: "token" }, "spc_one"), { status: 500 });
});

function json(body) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

test("the sessions page shows each agent's logo and filters by agent and by search", async (context) => {
  const codex = { ...entry(4, "public"), agent: "codex", agentLabel: "Codex", title: "Fix the router" };
  const gemini = { ...entry(5, "public"), agent: "gemini", agentLabel: "Gemini CLI", title: "Tidy the docs" };
  const pi = { ...entry(3, "public"), agent: "pi", agentLabel: "Pi", title: "Trim the logs" };
  const document = await openIndex(context, sessionIndexFiles([entry(1, "private"), codex, gemini, pi]), true);
  const titles = () => [...document.querySelectorAll("a.row .name")].map((name) => name.textContent);
  assert.deepEqual([...document.querySelectorAll("a.row .name")].map((name) => Boolean(name.querySelector("svg"))), [false, true, true, true], "Gemini has no logo; the others have theirs before the title");
  const subtitles = [...document.querySelectorAll("a.row .meta")].map((meta) => meta.textContent);
  assert.match(subtitles[0], /^Gemini CLI/, "an agent without a logo is named in the subtitle");
  assert.equal(document.querySelectorAll("a.row .name")[2].querySelectorAll("svg path[fill]").length, 3, "Pi's logo keeps its three colours");
  assert.doesNotMatch(subtitles.slice(1).join(" "), /Codex|Claude Code/, "the logo already names the others");
  const picker = document.querySelector(".agent-picker");
  const chips = [...picker.querySelectorAll(".agent-menu button")];
  assert.deepEqual(chips.map((chip) => chip.textContent), ["All agents", "Gemini CLI", "Codex", "Pi", "Claude Code"]);
  assert.match(picker.querySelector("summary").textContent, /^Agents/);

  chips[2].click();
  assert.deepEqual(titles(), ["Fix the router"]);
  assert.equal(chips[2].getAttribute("aria-pressed"), "true");
  assert.match(picker.querySelector("summary").textContent, /^Codex/, "the control shows what is selected");
  assert.equal(picker.open, false);
  chips[0].click();
  const search = document.querySelector(".filters input");
  search.value = "session claude";
  search.dispatchEvent(new document.defaultView.Event("input"));
  assert.deepEqual(titles(), ["Session 1"]);
  search.value = "nothing like this";
  search.dispatchEvent(new document.defaultView.Event("input"));
  assert.equal(document.querySelector(".none").textContent, "No sessions match.");
});

test("the session being published is recovered first when a Space has more old sessions than one pass covers", async () => {
  const shell = (id) => renderSessionBundle({ agent: "codex", agentLabel: "Codex", id, title: `Old ${id}` }, [{ role: "user", content: "Hi" }]).files[0].content;
  const ids = Array.from({ length: 60 }, (_, index) => `old-${String(index).padStart(2, "0")}`);
  const fetchImpl = async (url) => {
    const target = new URL(url);
    if (target.pathname.endsWith("/files")) return json({ data: { versionId: "ver_1", files: ids.map((id) => ({ path: `sessions/${id}/index.html` })) } });
    if (target.pathname.endsWith("/files/links")) return json({ data: { links: Object.fromEntries(target.searchParams.getAll("path").map((file) => [file, { url: `https://files.example/${file}` }])) } });
    if (target.pathname.endsWith("/access")) return json({ data: [] });
    return new Response(shell(target.pathname.split("/")[2]));
  };
  const { sessions } = await loadSessionIndex({ fetchImpl, accessToken: "token" }, "spc_one", { first: "sessions/old-59" });
  assert.equal(sessions.length, 50);
  assert.ok(sessions.some((session) => session.path === "sessions/old-59"), "so it is republished at its old address");
});

test("a Space's own home page is left alone; ours is recognised and replaced", async () => {
  const ours = sessionIndexFiles([entry(1, "public")]);
  assert.deepEqual(ours.map((file) => file.path), ["index.html", "sessions/index.html", "sessions/team.html", "sessions/index.json", "sessions/public.json"]);
  const elsewhere = sessionIndexFiles([entry(1, "public")], { root: false });
  assert.deepEqual(elsewhere.map((file) => file.path), ["sessions/index.html", "sessions/team.html", "sessions/index.json", "sessions/public.json"]);
  assert.match(elsewhere[1].content, /url=\/sessions\//, "signing in returns to the sessions page, not the Space's home page");

  const load = (home) => loadSessionIndex({
    accessToken: "token",
    fetchImpl: async (url) => {
      const target = new URL(url);
      if (target.pathname.endsWith("/files")) return json({ data: { versionId: "ver_1", files: home === null ? [] : [{ path: "index.html" }] } });
      if (target.pathname.endsWith("/files/links")) return json({ data: { links: { "index.html": { url: "https://files.example/index.html" } } } });
      return new Response(home);
    },
  }, "spc_one");
  assert.equal((await load("<h1>My site</h1>")).rootTaken, true);
  assert.equal((await load(ours[0].content)).rootTaken, false);
  assert.equal((await load(null)).rootTaken, false);
});
