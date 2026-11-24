import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { formatSessionList, run } from "../src/cli.js";
import { saveConfig } from "../src/config.js";

const API = "https://api.spacefast.com";
const LIVE = "https://sessions.example";
const INDEX_GRANT = ["/", "/index.html", "/sessions", "/sessions/index.html", "/sessions/public.json"];

// A Space with a private session at a random address, a public one, and the sessions page.
function fakeSpace(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-manage-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PUSH_SESSION_CONFIG: path.join(root, "config.json"), SPACEFAST_HOME: root };
  saveConfig({ version: 1, owned: { [API]: { id: "spc_one", title: "AI sessions", liveUrl: `${LIVE}/` } } }, env);
  const entry = (sessionPath, sessionId, title, agent, visibility, updatedAt) => ({ path: sessionPath, sessionId, title, agent, visibility, updatedAt });
  const files = new Map([
    ["index.html", '<meta name="generator" content="push-session">'],
    ["sessions/index.json", JSON.stringify({ version: 1, sessions: [
      entry("sessions/aaaa-1111", "session-private", "Fix the importer", "claude", "private", "2026-11-20T10:00:00.000Z"),
      entry("sessions/bbbb-2222", "session-public", "Ship the pager fix", "codex", "public", "2026-11-22T10:00:00.000Z"),
    ] })],
    ["sessions/aaaa-1111/index.html", "private page"],
    ["sessions/aaaa-1111/pages/0001.json", "{}"],
    ["sessions/aaaa-11110/index.html", "another session whose address starts the same"],
    ["sessions/bbbb-2222/index.html", "public page"],
  ]);
  const grant = (id, audience, include, subject = {}) => ({ id, subject: { audience, ...subject }, capabilities: ["page.view"], resources: { include, exclude: [] }, target: { kind: "live" } });
  const access = [
    grant("grt_link", "link", ["/sessions/aaaa-1111", "/sessions/aaaa-1111/**"], { linkId: "lnk_one", landingPath: "/sessions/aaaa-1111", url: `${LIVE}/__/one` }),
    grant("grt_public", "public", ["/sessions/bbbb-2222", "/sessions/bbbb-2222/**"]),
    grant("grt_index", "public", INDEX_GRANT),
    grant("grt_member", "member", ["/**"]),
  ];
  const calls = [];
  const fail = new Set();
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method || "GET";
    if (target.origin === LIVE) return new Response(files.get(target.pathname.slice("/read/".length)));
    if (target.pathname.endsWith("/files/links")) {
      return jsonResponse(200, { data: { links: Object.fromEntries(target.searchParams.getAll("path").map((file) => [file, { url: `${LIVE}/read/${file}` }])) } });
    }
    if (target.pathname.endsWith("/files")) return jsonResponse(200, { data: { versionId: "ver_1", files: [...files.keys()].map((file) => ({ path: file })) } });
    if (target.pathname.endsWith("/access") && method === "GET") return jsonResponse(200, { data: access });
    if (target.pathname === "/v1/spaces/spc_one" && method === "GET") return jsonResponse(200, { data: { id: "spc_one", title: "Team sessions", liveUrl: `${LIVE}/` } });
    if (fail.has(`${method} ${target.pathname}`)) return jsonResponse(500, { title: "Unavailable" });
    calls.push(`${method} ${target.pathname.replace("/v1/spaces/spc_one", "")}`);
    if (method === "DELETE") {
      const id = target.pathname.split("/").pop();
      const at = access.findIndex((item) => item.id === id || item.subject.linkId === id);
      if (at >= 0) access.splice(at, 1);
      return new Response(null, { status: 204 });
    }
    const payload = JSON.parse(init.body.get("payload"));
    for (const file of payload.deletePaths || []) files.delete(file);
    for (const file of init.body.getAll("files")) files.set(file.name, await file.text());
    return jsonResponse(201, { data: { space: { id: "spc_one" }, next: { action: "done" } } });
  };
  const logged = [];
  const dependencies = { env, fetchImpl, resolveAuth: async () => ({ accessToken: "token", source: "sf" }), log: (line) => logged.push(line), interactive: false, columns: 80 };
  const listed = () => JSON.parse(files.get("sessions/index.json")).sessions.map((session) => [session.path, session.visibility]);
  return { dependencies, env, files, access, calls, fail, logged, listed, grant };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("list shows each session with its agent, who can open it, and the address that opens it", async (context) => {
  const space = fakeSpace(context);
  const result = await run(["list", "--json"], space.dependencies);
  assert.deepEqual(result.sessions.map((session) => [session.sessionId, session.route, session.agent, session.visibility, session.url]), [
    ["session-public", "sessions/bbbb-2222", "codex", "public", `${LIVE}/sessions/bbbb-2222/`],
    ["session-private", "sessions/aaaa-1111", "claude", "private", `${LIVE}/__/one`],
  ]);
  assert.deepEqual(result.sessions[1].shareLinks, [{ id: "lnk_one", url: `${LIVE}/__/one` }]);
  assert.deepEqual(JSON.parse(space.logged[0]), result);
  assert.deepEqual(space.calls, [], "listing changes nothing");

  space.logged.length = 0;
  await run(["list"], space.dependencies);
  const lines = space.logged[0].split("\n");
  assert.match(lines[1], /AI sessions · 2 sessions/);
  assert.match(lines[3], /Ship the pager fix\s+Public/);
  assert.match(lines[4], /https:\/\/sessions\.example\/sessions\/bbbb-2222\/$/);
  assert.match(lines[5], /Fix the importer\s+Private/);
  assert.match(lines[6], /https:\/\/sessions\.example\/__\/one$/);
});

test("the list keeps to the terminal's width and says so when a session has no link or there are none", () => {
  const session = { title: `A very long title ${"that keeps going ".repeat(8)}`, agent: "claude", visibility: "private", url: null, updatedAt: "2026-01-02T00:00:00.000Z" };
  const [, , , row, link] = formatSessionList({ title: "AI sessions", sessions: [session] }, { columns: 60 }).split("\n");
  assert.match(row, /…\s+Private\s+2026-01-02$/);
  assert.ok(row.replace(/\x1b\[[0-9;]*m/g, "").length <= 60, "the row fits 60 columns");
  assert.match(link, /No share link: only your team can open it/);
  assert.equal(formatSessionList({ title: "AI sessions", sessions: [] }), "No published sessions in this Space.");
});

test("unshare finds a session by its ID, ends its link, deletes only its files and takes it off the list", async (context) => {
  const space = fakeSpace(context);
  const result = await run(["unshare", "session-private", "--json"], space.dependencies);
  assert.deepEqual(result, {
    spaceId: "spc_one",
    route: "sessions/aaaa-1111",
    revokedLinkIds: ["lnk_one"],
    revokedPublicAccess: false,
    deletedPaths: ["sessions/aaaa-1111/index.html", "sessions/aaaa-1111/pages/0001.json"],
    keptFiles: false,
    stillPublic: false,
  });
  assert.deepEqual(space.calls, ["DELETE /share-links/lnk_one", "POST /v1/publish"]);
  assert.equal(space.files.has("sessions/aaaa-11110/index.html"), true, "a session whose address only starts the same is left alone");
  assert.deepEqual(space.listed(), [["sessions/bbbb-2222", "public"]]);
  assert.equal(space.access.some((item) => item.id === "grt_index"), true, "the sessions page stays public while a public session is left");

  await assert.rejects(run(["unshare", "session-private", "--json"], space.dependencies), /No published session found at sessions\/session-private/);
});

test("unsharing the last public session ends its public access and closes the sessions page", async (context) => {
  const space = fakeSpace(context);
  const result = await run(["unshare", `${LIVE}/sessions/bbbb-2222/`, "--yes"], space.dependencies);
  assert.equal(result.revokedPublicAccess, true);
  assert.deepEqual(space.calls, ["DELETE /access/grt_public", "DELETE /access/grt_index", "POST /v1/publish"]);
  assert.deepEqual(space.access.map((item) => item.id), ["grt_link", "grt_member"]);
  assert.deepEqual(space.listed(), [["sessions/aaaa-1111", "private"]]);
  assert.equal(JSON.parse(space.files.get("sessions/public.json")).sessions.length, 0);
  assert.match(space.logged[0], /Unshared "Ship the pager fix": ended public access, deleted 1 file\./);
});

test("--keep-files makes a public session private and keeps it on the list", async (context) => {
  const space = fakeSpace(context);
  const result = await run(["unshare", "sessions/bbbb-2222", "--keep-files", "--json"], space.dependencies);
  assert.deepEqual([result.revokedPublicAccess, result.deletedPaths, result.keptFiles], [true, [], true]);
  assert.equal(space.files.has("sessions/bbbb-2222/index.html"), true);
  assert.deepEqual(space.listed(), [["sessions/bbbb-2222", "private"], ["sessions/aaaa-1111", "private"]]);
});

test("a public Space keeps kept files open and says so, and a Space named with --space is read for its address", async (context) => {
  const space = fakeSpace(context);
  space.access.push(space.grant("grt_all", "public", ["/**"]));
  const listed = await run(["list", "--json"], space.dependencies);
  assert.deepEqual(listed.sessions.map((session) => session.visibility), ["public", "public"], "a session in a public Space is public whatever its own grants say");

  const result = await run(["unshare", "session-private", "--keep-files", "--yes"], space.dependencies);
  assert.equal(result.stillPublic, true);
  assert.match(space.logged.at(-1), /still open to everyone, because the Space itself is public/);
  assert.equal(space.access.some((item) => item.id === "grt_all"), true, "the Space's own access is not this command's to end");
  assert.deepEqual(space.listed().find(([file]) => file === "sessions/aaaa-1111"), ["sessions/aaaa-1111", "public"]);

  // Not the remembered Space: nothing saved says where it is served.
  saveConfig({ version: 1 }, space.env);
  const named = await run(["list", "--space", "spc_one", "--json"], space.dependencies);
  assert.equal(named.sessions[0].url, `${LIVE}/sessions/bbbb-2222/`);
  await run(["list", "--space", "spc_one"], space.dependencies);
  assert.match(space.logged.at(-1).split("\n")[1], /Team sessions/);
});

test("a failed unshare names the session's route to finish with, since an ended link no longer leads to it", async (context) => {
  const space = fakeSpace(context);
  space.fail.add("POST /v1/publish");
  await assert.rejects(run(["unshare", `${LIVE}/__/one`, "--json"], space.dependencies), /ending 1 of 1 links; file removal is not confirmed\. Run `push-session unshare sessions\/aaaa-1111` to finish\./);
  space.fail.clear();
  const finished = await run(["unshare", "sessions/aaaa-1111", "--json"], space.dependencies);
  assert.deepEqual([finished.revokedLinkIds, finished.deletedPaths.length], [[], 2]);
});

test("unshare asks first in a terminal, and both commands refuse what they cannot honour", async (context) => {
  const space = fakeSpace(context);
  const asked = [];
  const prompts = { confirm: async (question) => { asked.push(question.message); return false; }, isCancel: () => false };
  assert.deepEqual(await run(["unshare", "session-private"], { ...space.dependencies, interactive: true, prompts }), { cancelled: true });
  assert.deepEqual(asked, ['Unshare "Fix the importer"? This ends 1 share link and deletes 2 files.']);
  assert.deepEqual(space.calls, [], "declining changes nothing");

  await assert.rejects(run(["unshare", "session-private"], space.dependencies), /requires --yes or --json/);
  await assert.rejects(run(["unshare"], space.dependencies), /Usage: push-session unshare/);
  await assert.rejects(run(["unshare", "https://elsewhere.example/sessions/aaaa-1111/", "--json"], space.dependencies), /does not belong to the selected Space/);
  await assert.rejects(run(["unshare", "../index.html", "--json"], space.dependencies), /Expected a session ID/);
  await assert.rejects(run(["list", "extra"], space.dependencies), /Usage: push-session list/);
  await assert.rejects(run(["list", "--new-space"], space.dependencies), /use an existing Space/);
  await assert.rejects(run(["codex", "session-one", "--keep-files"], space.dependencies), /only supported by unshare/);
  const signedOut = { ...space.dependencies, resolveAuth: async () => null };
  await assert.rejects(run(["list"], signedOut), /No remembered session Space/);
  await assert.rejects(run(["list", "--space", "spc_one"], signedOut), /Sign in with `sf login`/);
});
