import assert from "node:assert/strict";
import test from "node:test";

import { listSpaces, publishSession, sessionRoute } from "../src/spacefast.js";
import { packageVersion } from "../src/version.js";

test("builds a session route from one sanitized session ID", () => {
  assert.equal(sessionRoute({ agent: "codex", id: "session/id" }), "sessions/session-id/index.html");
  assert.equal(sessionRoute({ id: ".." }), "sessions/session/index.html");
});

test("rejects paths outside the shared directory before publishing", async () => {
  let requests = 0;
  const fetchImpl = async () => { requests += 1; throw new Error("unexpected upload"); };
  await assert.rejects(publishSession({
    session: { id: "one" },
    files: [{ path: "sessions/one/../private.html", content: "secret" }],
    fetchImpl,
  }), /Invalid publish path/);
  await assert.rejects(publishSession({
    session: { id: "one" },
    basePath: "sessions/one",
    entryPath: "sessions/one/index.html",
    files: [
      { path: "sessions/one/index.html", content: "shared" },
      { path: "private.html", content: "secret" },
    ],
    fetchImpl,
  }), /inside the shared directory/);
  assert.equal(requests, 0);
});

test("publishes paged files and creates a page-view-only Spacefast link", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/share-links")) {
      return jsonResponse(201, { data: { id: "lnk_one", url: "https://sessions.example/__/recipient-key" } });
    }
    return jsonResponse(201, {
      data: {
        space: { id: "spc_one", liveUrl: "https://sessions.example/" },
        version: { immutableUrl: "https://v1.sessions.example/" },
        claim: { key: "secret-key", claimUrl: "https://claim.example/one", url: "https://sessions.example/__/key", expiresAt: "2026-08-20T00:00:00Z" },
        next: { action: "done", hint: "Done" },
      },
    });
  };
  const basePath = "sessions/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
  const entryPath = `${basePath}/index.html`;
  const result = await publishSession({
    fetchImpl,
    session: { agent: "codex", id: "private-id", title: "Demo" },
    basePath,
    entryPath,
    files: [
      { path: entryPath, content: "<h1>Hello</h1>", contentType: "text/html" },
      { path: `${basePath}/pages/0001.json`, content: '{"items":[]}', contentType: "application/json" },
    ],
  });

  assert.equal(requests[0].url, "https://api.spacefast.com/v1/publish?wait=1");
  assert.equal(requests[0].init.headers["x-spacefast-client"], `push-session/${packageVersion}`);
  assert.match(requests[0].init.headers["x-spacefast-idempotency-principal"], /^[0-9a-f]{64}$/);
  const payload = JSON.parse(requests[0].init.body.get("payload"));
  assert.equal(payload.publishMode, "additive");
  assert.equal(payload.space.title, "Shared AI sessions");
  assert.deepEqual(requests[0].init.body.getAll("files").map((file) => file.name), [entryPath, `${basePath}/pages/0001.json`]);

  const linkBody = JSON.parse(requests[1].init.body);
  assert.equal(requests[1].init.headers.authorization, "Bearer secret-key");
  assert.equal(linkBody.landingPath, `/${basePath}`);
  assert.deepEqual(linkBody.resources, { include: [`/${basePath}`, `/${basePath}/**`] });
  assert.deepEqual(linkBody.capabilities, ["page.view"]);
  assert.equal(result.shareUrl, "https://sessions.example/__/recipient-key");
  assert.equal(result.landingUrl, `https://sessions.example/${entryPath}`);
  assert.equal(result.space.claimToken, "secret-key");
});

test("updates a selected space with bearer authentication", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/access")) return jsonResponse(200, { data: [] });
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/share-links")) return jsonResponse(201, { data: { url: "https://sessions.example/__/owned-link" } });
    return jsonResponse(201, {
      data: {
        space: { id: "spc_saved", liveUrl: "https://sessions.example/" },
        version: { immutableUrl: "https://v2.sessions.example/" },
        next: { action: "done", hint: "Done" },
      },
    });
  };
  await publishSession({
    fetchImpl,
    session: { agent: "claude", id: "session-2" },
    html: "ok",
    spaceId: "spc_saved",
    accessToken: "token-value",
  });
  assert.equal(requests[0].init.headers.authorization, "Bearer token-value");
  assert.equal(JSON.parse(requests[0].init.body.get("payload")).spaceId, "spc_saved");
  assert.equal(requests[1].init.headers.authorization, "Bearer token-value");
});

test("lists only owned Spaces and surfaces problem details", async () => {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push({ url: String(url), authorization: init.headers.authorization });
    if (urls.length === 1) {
      return jsonResponse(200, { data: [{ id: "spc_team", title: "Notes", anonymous: false }, { id: "spc_anon", title: "Claimable", anonymous: true }] });
    }
    return jsonResponse(403, { title: "Forbidden", detail: "Missing spaces:read.", code: "forbidden", details: { scope: "spaces:read" } });
  };
  const spaces = await listSpaces({ apiUrl: "https://api.example", accessToken: "token-value", query: "Notes", fetchImpl });
  assert.deepEqual(spaces.map((space) => space.id), ["spc_team"]);
  assert.equal(urls[0].url, "https://api.example/v1/spaces?limit=100&query=Notes");
  assert.equal(urls[0].authorization, "Bearer token-value");
  await assert.rejects(listSpaces({ apiUrl: "https://api.example", accessToken: "token-value", fetchImpl }), (error) =>
    error.message === "Missing spaces:read." && error.status === 403 && error.details.scope === "spaces:read");
});

test("exchanges a claimed anonymous key and continues on the same space", async () => {
  const requests = [];
  let publishAttempts = 0;
  const accessChecks = [];
  let accessAfterClaim = [];
  const fetchImpl = async (url, init) => {
    const requestUrl = String(url);
    // The spent claim key cannot list access; the credential it is exchanged for can.
    if (requestUrl.endsWith("/access")) {
      accessChecks.push(init.headers.authorization);
      return init.headers.authorization === "Bearer continued-access" ? jsonResponse(200, { data: accessAfterClaim }) : jsonResponse(401, { code: "unauthorized" });
    }
    requests.push({ url: requestUrl, init });
    if (requestUrl.endsWith("/claim/exchange")) {
      return jsonResponse(200, { data: { credential: { accessToken: "continued-access" } } });
    }
    if (requestUrl.endsWith("/share-links")) {
      return jsonResponse(201, { data: { url: "https://sessions.example/__/continued-link" } });
    }
    publishAttempts += 1;
    if (publishAttempts === 1) {
      return jsonResponse(409, { code: "space_claimed_credential_available", message: "Claimed" });
    }
    return jsonResponse(201, {
      data: {
        space: { id: "spc_claimed", liveUrl: "https://sessions.example/" },
        next: { action: "done" },
      },
    });
  };

  const result = await publishSession({
    fetchImpl,
    session: { id: "session-claimed" },
    html: "ok",
    spaceId: "spc_claimed",
    claimToken: "old-claim-key",
  });

  assert.equal(requests[1].url, "https://api.spacefast.com/v1/claim/exchange");
  assert.equal(requests[1].init.headers.authorization, "Bearer old-claim-key");
  assert.equal(requests[2].init.headers.authorization, "Bearer continued-access");
  assert.equal(requests[3].init.headers.authorization, "Bearer continued-access");
  assert.equal(result.space.id, "spc_claimed");
  assert.equal(result.credential.accessToken, "continued-access");
  assert.deepEqual(accessChecks, ["Bearer old-claim-key", "Bearer continued-access"], "access is checked again with the exchanged credential");

  // Whoever claimed the Space may have made it public: the retry then stops before uploading.
  accessAfterClaim = [{ id: "grt_all", subject: { audience: "public" }, capabilities: ["page.view"], resources: { include: ["/**"], exclude: [] }, target: { kind: "live" } }];
  publishAttempts = 0;
  await assert.rejects(publishSession({ fetchImpl, session: { id: "session-claimed" }, html: "ok", spaceId: "spc_claimed", claimToken: "old-claim-key" }), /This Space is public/);
  assert.equal(publishAttempts, 1, "only the first, refused attempt reached the publish endpoint");
});

test("switches giant sessions to manifest uploads and follows upload receipts", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const requestUrl = String(url);
    requests.push({ url: requestUrl, init });
    if (requestUrl === "https://upload.example/file") return new Response(null, { status: 204 });
    if (requestUrl === "https://api.spacefast.com/resume") {
      return jsonResponse(200, {
        data: {
          space: { id: "spc_big", liveUrl: "https://big.example/" },
          version: { immutableUrl: "https://big-version.example/" },
          next: { action: "done", hint: "Done" },
        },
      });
    }
    if (requestUrl.endsWith("/share-links")) return jsonResponse(201, { data: { url: "https://big.example/__/link" } });
    return jsonResponse(201, {
      data: {
        space: { id: "spc_big", liveUrl: "https://big.example/" },
        claim: { key: "big-secret" },
        upload: {
          targets: [{ path: "sessions/a/b/index.html", method: "PUT", url: "https://upload.example/file", headers: { authorization: "Upload signed" } }],
          links: { resume: "/resume", finalize: "/finalize" },
        },
        next: { action: "upload", url: "/resume", hint: "Upload" },
      },
    });
  };
  const result = await publishSession({
    fetchImpl,
    session: { title: "Big" },
    basePath: "sessions/a/b",
    entryPath: "sessions/a/b/index.html",
    files: [{ path: "sessions/a/b/index.html", content: "large-data", contentType: "text/html" }],
    inlineLimitBytes: 1,
  });

  assert.equal(requests[0].init.headers["content-type"], "application/json");
  const manifest = JSON.parse(requests[0].init.body);
  assert.equal(manifest.files[0].size, 10);
  assert.match(manifest.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(requests[1].url, "https://upload.example/file");
  assert.equal(requests[1].init.headers.authorization, "Upload signed");
  assert.equal(requests[2].url, "https://api.spacefast.com/resume");
  assert.equal(result.shareUrl, "https://big.example/__/link");
});

test("accepts artifact-specific space and share names", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/share-links")) {
      return jsonResponse(201, { data: { url: "https://example.test/private" } });
    }
    return jsonResponse(201, {
      data: {
        space: { id: "spc_artifacts", liveUrl: "https://example.test/" },
        claim: { key: "claim-key" },
        next: { action: "done" },
      },
    });
  };
  await publishSession({
    session: { id: "artifact", title: "Artifact title" },
    files: [{ path: "artifacts/one/index.html", content: "<h1>One</h1>" }],
    entryPath: "artifacts/one/index.html",
    basePath: "artifacts/one",
    spaceTitle: "Shared AI artifacts",
    shareName: "Claude artifact: One",
    fetchImpl,
  });

  const publishPayload = JSON.parse(requests[0].init.body.get("payload"));
  assert.equal(publishPayload.space.title, "Shared AI artifacts");
  const sharePayload = JSON.parse(requests[1].init.body);
  assert.equal(sharePayload.name, "Claude artifact: One");
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("retries transient publish failures with the same idempotency key", async () => {
  const requests = [];
  const failures = [
    () => new Response("<html>Bad Gateway</html>", { status: 502, headers: { "retry-after": "0" } }),
    () => new Response(JSON.stringify({ title: "Slow down" }), { status: 429, headers: { "retry-after": "0" } }),
  ];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/share-links")) return jsonResponse(201, { data: { url: "https://sessions.example/__/link" } });
    const failure = failures.shift();
    if (failure) return failure();
    return jsonResponse(201, { data: { space: { id: "spc_one" }, next: { action: "done" } } });
  };
  const result = await publishSession({ fetchImpl, session: { id: "one" }, html: "ok", accessToken: "token" });
  assert.equal(result.shareUrl, "https://sessions.example/__/link");
  const publishes = requests.filter((request) => request.url.includes("/v1/publish"));
  assert.equal(publishes.length, 3);
  assert.equal(new Set(publishes.map((request) => request.init.headers["idempotency-key"])).size, 1);

  const denied = async () => jsonResponse(403, { title: "Forbidden" });
  await assert.rejects(publishSession({ fetchImpl: denied, session: { id: "one" }, html: "ok" }), { status: 403 });
  const hourLong = async () => new Response("{}", { status: 429, headers: { "retry-after": "3600" } });
  await assert.rejects(publishSession({ fetchImpl: hourLong, session: { id: "one" }, html: "ok" }), { status: 429 });
});

test("republishing into a Space reuses the session's existing share link", async () => {
  const link = (landingPath, overrides = {}) => ({
    id: "grt_1",
    subject: { audience: "link", linkId: `lnk_${landingPath.length}`, landingPath, url: `https://sessions.example/__${landingPath}` },
    capabilities: ["page.view"],
    resources: { include: [landingPath, `${landingPath}/**`], exclude: [] },
    target: { kind: "live" },
    ...overrides,
  });
  const publishWith = async (links, credential = { accessToken: "token" }) => {
    const requests = [];
    const fetchImpl = async (url, init = {}) => {
      requests.push({ url: String(url), method: init.method || "GET" });
      if (String(url).endsWith("/access")) return links ? jsonResponse(200, { data: links }) : jsonResponse(403, {});
      if (String(url).endsWith("/share-links")) return jsonResponse(201, { data: { id: "lnk_new", url: "https://sessions.example/__/new" } });
      return jsonResponse(201, { data: { space: { id: "spc_saved" }, next: { action: "done" } } });
    };
    const result = await publishSession({ fetchImpl, session: { id: "one" }, html: "ok", spaceId: "spc_saved", ...credential });
    return { result, created: requests.some((request) => request.url.endsWith("/share-links")) };
  };

  const reused = await publishWith([link("/sessions/other"), link("/sessions/one")]);
  assert.equal(reused.result.shareUrl, "https://sessions.example/__/sessions/one");
  assert.equal(reused.created, false);

  const editorLink = link("/sessions/one", { capabilities: ["page.view", "comments.write"] });
  const expiring = link("/sessions/one", { constraints: { expiresAt: "2030-01-01T00:00:00Z" } });
  for (const links of [[link("/sessions/other")], [editorLink, expiring]]) {
    const fresh = await publishWith(links);
    assert.equal(fresh.result.shareUrl, "https://sessions.example/__/new");
    assert.equal(fresh.created, true);
  }

  // An unread access list could hide a public grant, so a signed-in publish stops. Signed out there is none to hide.
  await assert.rejects(publishWith(null), { status: 403 });
  const signedOut = await publishWith(null, { claimToken: "claim" });
  assert.equal(signedOut.result.shareUrl, "https://sessions.example/__/new");
});

test("public and private sessions adjust the Space's access instead of making a share link", async () => {
  const session = ["/sessions/one", "/sessions/one/**"];
  const index = ["/", "/index.html", "/sessions", "/sessions/index.html", "/sessions/public.json"];
  const grant = (id, audience, include, subject = {}) => ({ id, subject: { audience, ...subject }, capabilities: ["page.view"], resources: { include, exclude: [] }, target: { kind: "live" } });
  const publishWith = async (access, options) => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      const target = new URL(url);
      const method = init.method || "GET";
      if (target.pathname.endsWith("/access") && method === "GET") return jsonResponse(200, { data: access });
      if (target.pathname.includes("/access")) {
        calls.push(method === "POST" ? `grant ${JSON.parse(init.body).audience} ${JSON.parse(init.body).resources.include[0]}` : `revoke ${target.pathname.split("/").pop()}`);
        return jsonResponse(method === "POST" ? 201 : 200, { data: {} });
      }
      if (target.pathname.endsWith("/share-links")) { calls.push("link"); return jsonResponse(201, { data: { url: "https://sessions.example/__/new" } }); }
      calls.push("upload");
      return jsonResponse(201, { data: { space: { id: "spc_saved", liveUrl: "https://sessions.example/" }, next: { action: "done" } } });
    };
    const result = await publishSession({ fetchImpl, session: { id: "one" }, html: "ok", spaceId: "spc_saved", accessToken: "token", ...options });
    return { result, calls };
  };

  const made = await publishWith([], { visibility: "public", publicIndex: true });
  assert.deepEqual(made.calls, ["upload", "grant public /sessions/one", "grant public /"]);
  assert.equal(made.result.shareUrl, "https://sessions.example/sessions/one/");
  assert.equal(made.result.visibility, "public");

  const existing = [grant("grt_link", "link", session, { landingPath: "/sessions/one", url: "https://sessions.example/__/old" }), grant("grt_public", "public", session), grant("grt_index", "public", index), grant("grt_other", "public", ["/sessions/two", "/sessions/two/**"])];
  assert.deepEqual((await publishWith(existing, { visibility: "public", publicIndex: true })).calls, ["upload"], "already public");
  const closed = await publishWith(existing, { visibility: "private", publicIndex: false });
  assert.deepEqual(closed.calls, ["revoke grt_public", "revoke grt_index", "upload"], "public access ends before the new content is live; the link stays");
  assert.equal(closed.result.shareUrl, "https://sessions.example/__/old");
  const linked = await publishWith(existing, { visibility: "private" });
  assert.deepEqual(linked.calls, ["revoke grt_public", "upload"], "the index grant is left alone when the index was not rebuilt");
  assert.equal(linked.result.shareUrl, "https://sessions.example/__/old");

  // A public Space opens every session, so a private publish stops before anything is uploaded.
  const wholeSpace = [grant("grt_all", "public", ["/**"])];
  await assert.rejects(publishWith(wholeSpace, { visibility: "private" }), /This Space is public/);
  assert.equal((await publishWith(wholeSpace, { visibility: "public" })).result.publicSpace, true);
  assert.equal((await publishWith([grant("grt_other", "public", ["/sessions/two/**"])], { visibility: "private" })).result.publicSpace, false);

  // In a Space whose home page is its own, the sessions page is public under /sessions/ only.
  const sessionsOnly = ["/sessions", "/sessions/index.html", "/sessions/public.json"];
  assert.deepEqual((await publishWith([], { visibility: "public", publicIndex: true, rootIndex: false })).calls, ["upload", "grant public /sessions/one", "grant public /sessions"]);
  assert.deepEqual((await publishWith([grant("grt_public", "public", session), grant("grt_index", "public", index)], { visibility: "public", publicIndex: true, rootIndex: false })).calls, ["revoke grt_index", "upload", "grant public /sessions"], "a grant on the home page is withdrawn");
  assert.deepEqual((await publishWith([grant("grt_public", "public", session), grant("grt_index", "public", sessionsOnly)], { visibility: "public", publicIndex: true, rootIndex: false })).calls, ["upload"]);

  await assert.rejects(publishSession({ fetchImpl: async () => { throw new Error("no request expected"); }, session: { id: "one" }, html: "ok", visibility: "public" }), /need you signed in/);
});
