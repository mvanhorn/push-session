import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { renderSessionBundle } from "../src/render.js";

function waitFor(window, predicate) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const observer = new window.MutationObserver(() => {
      if (predicate()) { clearTimeout(timeout); observer.disconnect(); resolve(); }
    });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Viewer did not reach expected state: ${window.document.body.textContent.slice(-1000)}`));
    }, 5000);
    observer.observe(window.document, { childList: true, subtree: true, attributes: true });
  });
}

function fixture(context, fetchPage, search = "", prepare = () => {}) {
  const bundle = renderSessionBundle({ agent: "claude", agentLabel: "Claude Code", id: "paged", title: "Paged session" }, [
    { role: "user", content: "First page prompt" },
    { role: "assistant", content: "Second page reply" },
    { role: "user", content: "Third page follow-up" },
  ], { pageItems: 1 });
  const pages = bundle.files.slice(1).map((file) => JSON.parse(file.content));
  const requests = [];
  const dom = new JSDOM(bundle.files[0].content, {
    url: `https://sessions.example/sessions/paged/${search}`, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false });
      prepare(window);
      window.fetch = async (url, options) => {
        const index = Number(/(\d+)\.json$/.exec(url)[1]) - 1;
        requests.push(index + 1);
        return fetchPage ? fetchPage(index, pages[index], options) : { ok: true, json: async () => pages[index] };
      };
    },
  });
  context.after(() => dom.window.close());
  const { window } = dom;
  const document = window.document;
  const content = () => document.querySelector(".timeline")?.textContent || "";
  return { window, document, requests, content };
}

test("the transcript loads page by page, retries a failed page, and a ?page link starts there", async (context) => {
  let failThird = true;
  const view = fixture(context, async (index, page) => {
    if (index === 2 && failThird) return { ok: false, status: 503 };
    return { ok: true, json: async () => page };
  }, "?__=share-token&page=2#transcript");
  const press = (label) => [...view.document.querySelectorAll("button")].find((button) => button.textContent === label).click();
  await waitFor(view.window, () => view.content().includes("Second page reply"));
  assert.deepEqual(view.requests, [2]);
  assert.equal(view.content().includes("First page prompt"), false);

  press("Load more");
  await waitFor(view.window, () => view.document.querySelector('[role="alert"]'));
  assert.match(view.document.querySelector('[role="alert"]').textContent, /page 3 \(503\)/);
  failThird = false;
  press("Try again");
  await waitFor(view.window, () => view.content().includes("Third page follow-up"));
  assert.match(view.content(), /Second page reply[\s\S]*Third page follow-up/, "earlier pages stay on screen");
  assert.equal([...view.document.querySelectorAll("button")].some((button) => button.textContent === "Load more"), false, "nothing is left to load");

  press("Load earlier messages");
  await waitFor(view.window, () => view.content().includes("First page prompt"));
  assert.match(view.content(), /First page prompt[\s\S]*Second page reply[\s\S]*Third page follow-up/);
  assert.deepEqual(view.requests, [2, 3, 3, 1]);
  assert.equal(new URL(view.window.location.href).searchParams.get("__"), "share-token");
});

test("pages load on their own as the end of the transcript scrolls into view", async (context) => {
  const view = fixture(context, null, "", (window) => {
    // Stands in for the browser: the marker under the transcript is always in view.
    window.IntersectionObserver = class {
      constructor(callback) { this.callback = callback; }
      observe() { window.setTimeout(() => this.callback([{ isIntersecting: true }]), 0); }
      disconnect() { this.callback = () => {}; }
    };
  });
  await waitFor(view.window, () => view.content().includes("Third page follow-up"));
  assert.match(view.content(), /First page prompt[\s\S]*Second page reply[\s\S]*Third page follow-up/);
  assert.deepEqual(view.requests, [1, 2, 3]);
});

test("a page that starts inside a code block still renders it as code", async (context) => {
  const content = `\`\`\`js\n${"const value = 1;\n".repeat(6_000)}\`\`\`\n`;
  const bundle = renderSessionBundle({ agent: "claude", agentLabel: "Claude Code", id: "fenced", title: "Fenced" },
    [{ role: "assistant", content }], { pageBytes: 32 * 1024 });
  const pages = bundle.files.slice(1).map((file) => JSON.parse(file.content));
  const dom = new JSDOM(bundle.files[0].content, {
    url: "https://sessions.example/sessions/fenced/?page=2", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false });
      window.fetch = async (url) => ({ ok: true, json: async () => pages[Number(/(\d+)\.json$/.exec(url)[1]) - 1] });
    },
  });
  context.after(() => dom.window.close());
  const { document } = dom.window;
  await waitFor(dom.window, () => document.querySelector(".timeline pre"));
  assert.match(document.querySelector(".timeline pre").textContent, /^const value = 1;/);
  assert.doesNotMatch(document.querySelector(".timeline").textContent, /```/);
});

test("the message rail lists the user's messages on the page and jumps to them", async (context) => {
  const bundle = renderSessionBundle({ agent: "claude", agentLabel: "Claude Code", id: "rail", title: "Rail", project: "/work/demo" }, [
    { role: "user", content: "First **question**" },
    { role: "assistant", content: "First answer" },
    { role: "user", content: "Second question" },
    { role: "assistant", content: "Second answer" },
  ]);
  const pages = bundle.files.slice(1).map((file) => JSON.parse(file.content));
  const scrolled = [];
  const dom = new JSDOM(bundle.files[0].content, {
    url: "https://sessions.example/sessions/rail/", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false });
      window.fetch = async () => ({ ok: true, json: async () => pages[0] });
      window.Element.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this.textContent); };
    },
  });
  context.after(() => dom.window.close());
  const { document } = dom.window;
  await waitFor(dom.window, () => document.querySelector(".message-rail"));
  // The rail's key listener is attached in an effect, just after the rail is in the page.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const ticks = [...document.querySelectorAll(".message-rail li button")];
  assert.deepEqual(ticks.map((tick) => tick.getAttribute("aria-label")), ["Message 1: First question", "Message 2: Second question"]);
  assert.match(document.querySelector(".session-aside .session-meta").textContent, /Claude Code.*\/work\/demo/);

  ticks[0].click();
  assert.match(scrolled.at(-1), /^First question/);
  dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "j" }));
  assert.match(scrolled.at(-1), /^Second question/);
  await waitFor(dom.window, () => ticks[1].getAttribute("aria-current") === "true");

  // Small screens have no rail: the same messages open as a list from a button.
  document.querySelector(".rail-open").click();
  await waitFor(dom.window, () => document.querySelector(".rail-sheet"));
  const listed = [...document.querySelectorAll(".rail-sheet li button")];
  assert.deepEqual(listed.map((item) => item.querySelector("strong").textContent), ["First question", "Second question"]);
  assert.equal(listed[1].getAttribute("aria-current"), "true");
  listed[0].click();
  assert.match(scrolled.at(-1), /^First question/);
  await waitFor(dom.window, () => !document.querySelector(".rail-sheet"));

  const single = renderSessionBundle({ agent: "claude", agentLabel: "Claude Code", id: "one", title: "One" }, [{ role: "user", content: "Only one" }]);
  assert.doesNotMatch(single.files[0].content, /class="message-rail"/, "the shell is static; the rail needs two messages");
});

test("Open in offers each agent's documented prompt link once the transcript is loaded", async (context) => {
  const bundle = renderSessionBundle({ agent: "claude", agentLabel: "Claude Code", id: "open", title: "Open me" }, [
    { role: "user", content: "Ünïcödé ".repeat(1_500) },
    { role: "assistant", content: "Done" },
  ]);
  const pages = bundle.files.slice(1).map((file) => JSON.parse(file.content));
  const dom = new JSDOM(bundle.files[0].content, {
    url: "https://sessions.example/sessions/open/?__=share-token", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false });
      window.fetch = async (url) => ({ ok: true, json: async () => pages[Number(/(\d+)\.json$/.exec(url)[1]) - 1] });
    },
  });
  context.after(() => dom.window.close());
  const { document } = dom.window;
  await waitFor(dom.window, () => document.querySelector(".open-in"));
  const menu = document.querySelector(".open-in");
  assert.deepEqual([...menu.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("aria-disabled")]),
    [["Codex", "true"], ["Claude Code", "true"], ["Cursor", "true"], ["T3 Code", "true"]]);

  menu.open = true;
  menu.dispatchEvent(new dom.window.Event("toggle"));
  await waitFor(dom.window, () => menu.querySelector("a[href]"));
  const links = Object.fromEntries([...menu.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href")]));
  assert.match(links.Codex, /^codex:\/\/threads\/new\?prompt=Continue/);
  assert.match(links["Claude Code"], /^claude-cli:\/\/open\?q=Continue/);
  assert.match(links.Cursor, /^cursor:\/\/anysphere\.cursor-deeplink\/prompt\?text=Continue/);
  assert.match(links["T3 Code"], /^t3code:\/\/new\?prompt=Continue/);
  assert.ok(links.Cursor.length <= 10_000, "Cursor rejects longer links");
  assert.match(menu.querySelector("p").textContent, /full transcript is also copied/, "a session too long for a link says how the rest travels");
  assert.ok(decodeURIComponent(links["Claude Code"].split("q=")[1]).length <= 5_000, "Claude Code rejects longer prompts");
  for (const href of Object.values(links)) {
    assert.match(decodeURIComponent(href), /Full transcript: https:\/\/sessions\.example\/sessions\/open\/\n/, "the page address, without the share token");
  }
});
