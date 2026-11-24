import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import "./viewer.css";
import "./pagination.css";
import "./artifact-links.css";
import { AssistantTimelineRow, UserTimelineRow, WorkGroupSection } from "./t3/MessagesTimeline.jsx";
import { ProviderLogo } from "./t3/providerIcons.jsx";
import { continuationPrompt, sessionMarkdown } from "./sessionMarkdown.js";

function readPayload() {
  const node = document.getElementById("push-session-data");
  if (!node?.textContent) throw new Error("Missing session data.");
  return JSON.parse(node.textContent);
}

function Timeline({ messages, loading }) {
  const rows = useMemo(() => buildRows(messages), [messages]);
  if (rows.length === 0) {
    return (
      <main className="timeline">
        <div className="empty">{loading ? "Loading the session…" : "Nothing to show. This session has no messages."}</div>
      </main>
    );
  }
  return (
    <main className="timeline">
      {rows.map((row) =>
        row.kind === "tools" ? (
          <WorkGroupSection key={row.id} entries={row.entries} />
        ) : row.message.itemType === "user_message" ? (
          <UserTimelineRow key={row.id} message={row.message} groupedWithNext={row.groupedWithNext} />
        ) : (
          <AssistantTimelineRow key={row.id} message={row.message} showMeta={row.showMeta} />
        ),
      )}
    </main>
  );
}

function ArtifactShelf({ artifacts }) {
  if (!artifacts?.length) return null;
  return (
    <section className="artifact-shelf" aria-label="Outputs">
      <div className="artifact-shelf-title">Outputs</div>
      <div className="artifact-cards">
        {artifacts.map((artifact) => (
          <a className="artifact-card" href={artifact.href} target="_blank" rel="noreferrer" key={artifact.id}>
            <span className="artifact-icon">{artifact.favicon || "◇"}</span>
            <span className="artifact-card-copy">
              <strong>{artifact.title || (artifact.kind === "chatgpt-site" ? "ChatGPT Site" : "Claude artifact")}</strong>
              <small>{artifact.kind === "chatgpt-site"
                ? `${plural(artifact.publishes, "saved version")} · ${artifact.recoveredVersions} recovered`
                : plural(artifact.recoveredVersions, "version")}</small>
            </span>
            <span className="artifact-arrow" aria-hidden="true">↗</span>
          </a>
        ))}
      </div>
    </section>
  );
}

// On wide screens the details and the message rail float beside the transcript (.session-aside);
// on narrow ones the details sit under the title as one wrapping row and the rail is hidden.
function SessionHeader({ session, stats, artifacts, messages, pages }) {
  return (
    <header className="session-header">
      <div className="topline">
        <div className="provider"><ProviderLogo provider={session.provider} />{session.providerLabel}</div>
        <ThemeToggle />
      </div>
      <h1>{session.title || `${session.providerLabel} session`}</h1>
      <div className="session-aside">
        <div className="session-meta">
          <span className="aside-provider"><ProviderLogo provider={session.provider} />{session.providerLabel}</span>
          {session.project ? <span title={session.project}><Icon name="folder" />{shortProject(session.project)}</span> : null}
          {session.createdAt ? <span><Icon name="calendar" /><time dateTime={session.createdAt}>{longTimestamp(session.createdAt)}</time></span> : null}
          <span><Icon name="message" />{plural(stats.messages, "message")}</span>
          {stats.tools ? <span><Icon name="terminal" />{plural(stats.tools, "tool call")}</span> : null}
          {stats.artifacts ? <span><Icon name="file" />{plural(stats.artifacts, "output")}</span> : null}
        </div>
        <SessionActions session={session} pages={pages} />
        <MessageRail messages={messages} />
      </div>
      <ArtifactShelf artifacts={artifacts} />
    </header>
  );
}

function wireItems(data) {
  return data.events
    .filter((event) => event?.type === "item.completed" && event.payload)
    .map((event) => ({ ...event.payload, itemId: event.itemId, createdAt: event.createdAt }));
}

// Copying and "Open in" need the whole session, not just the page on screen.
function useWholeSession(pages) {
  const pending = useRef(null);
  return useCallback(() => {
    pending.current ||= (async () => {
      const items = [];
      for (const url of pages) {
        const response = await fetch(url, { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`Could not load the transcript (${response.status}).`);
        items.push(...wireItems(await response.json()));
      }
      return items;
    })().catch((error) => {
      pending.current = null;
      throw error;
    });
    return pending.current;
  }, [pages]);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard access can be refused outside a secure context; the selection route still works there.
    const area = document.createElement("textarea");
    area.value = text;
    area.style.cssText = "position:fixed;opacity:0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    if (!copied) throw new Error("Copy was refused.");
  }
}

// Each agent's documented prompt link. They all open a draft the reader must send themselves.
// maxPrompt and maxUrl are the limits those docs state; Codex states none, so its link is kept to
// a length browsers and the OS pass along reliably.
const OPEN_IN = [
  { id: "codex", label: "Codex", maxUrl: 30_000, href: (prompt) => `codex://threads/new?prompt=${encodeURIComponent(prompt)}` },
  { id: "claude", label: "Claude Code", maxPrompt: 5_000, href: (prompt) => `claude-cli://open?q=${encodeURIComponent(prompt)}` },
  { id: "cursor", label: "Cursor", maxUrl: 10_000, href: (prompt) => `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(prompt)}` },
  { id: "t3", label: "T3 Code", maxPrompt: 8_000, href: (prompt) => `t3code://new?prompt=${encodeURIComponent(prompt)}` },
];

// The whole session goes in the link when the agent's limits allow it. Otherwise the link carries
// as much of the ending as fits, and `partial` says the rest has to travel by clipboard.
function openInLink(agent, session, items, url) {
  for (const budget of [Infinity, 6_000, 4_000, 2_400, 1_200, 400, 0]) {
    const prompt = continuationPrompt(session, items, url, budget);
    const href = agent.href(prompt);
    if (prompt.length <= (agent.maxPrompt || Infinity) && href.length <= (agent.maxUrl || Infinity)) {
      return { href, partial: budget !== Infinity && items.length > 0 };
    }
  }
  return { href: agent.href(`Continue from this shared session: ${url}`), partial: items.length > 0 };
}

function SessionActions({ session, pages }) {
  const loadItems = useWholeSession(pages);
  const [copyState, setCopyState] = useState("idle");
  // What Open in works from: the whole transcript, or nothing yet if loading it failed.
  const [transcript, setTranscript] = useState(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const items = transcript ? transcript.items : null;
  const menu = useRef(null);
  const pageUrl = () => `${window.location.origin}${window.location.pathname}`;

  const copy = async () => {
    try {
      await copyText(sessionMarkdown(session, await loadItems()));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 2_000);
  };
  const prepare = async (event) => {
    // A load that failed is tried again each time the menu opens.
    if (!event.currentTarget.open || (transcript && !transcript.failed)) return;
    try {
      setTranscript({ items: await loadItems(), failed: false });
    } catch {
      // Without the transcript the links still name the page.
      setTranscript({ items: [], failed: true });
    }
  };
  useEffect(() => {
    const close = (event) => {
      if (menu.current?.open && (event.key === "Escape" || (event.type === "pointerdown" && !menu.current.contains(event.target)))) menu.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);

  const links = useMemo(
    () => OPEN_IN.map((agent) => ({ agent, ...(items ? openInLink(agent, session, items, pageUrl()) : {}) })),
    [items, session],
  );

  return (
    <div className="session-actions">
      <button type="button" onClick={copy}>
        <Icon name={copyState === "copied" ? "check" : "copy"} />
        {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy as Markdown"}
      </button>
      <details className="open-in" ref={menu} onToggle={prepare}>
        <summary><Icon name="terminal" />Open in<Icon name="chevron" className="caret" /></summary>
        <div className="open-in-menu">
          {links.map(({ agent, href, partial }) => (
            <a
              key={agent.id}
              href={href}
              aria-disabled={href ? undefined : "true"}
              onClick={async (event) => {
                // A session too long for the link travels by clipboard, as the prompt says, so the agent
                // opens only once the copy has worked. After a failed copy, a second press opens it anyway.
                if (partial && !copyFailed) {
                  event.preventDefault();
                  try {
                    await copyText(sessionMarkdown(session, items));
                  } catch {
                    setCopyFailed(true);
                    return;
                  }
                  window.location.href = href;
                }
                menu.current.open = false;
              }}
            >
              <ProviderLogo provider={agent.id} />
              <span>{agent.label}</span>
            </a>
          ))}
          {transcript?.failed ? <p>Could not load the transcript, so these links carry only the page address. Reopen this menu to try again.</p>
            : copyFailed ? <p>Could not copy the transcript. Choose the agent again to open it with the ending only.</p>
              : links.some((link) => link.partial) ? <p>Too long for a link: the full transcript is also copied, ready to paste.</p> : null}
        </div>
      </details>
    </div>
  );
}

function previewText(value, max) {
  const text = String(value || "").replace(/```[\s\S]*?(```|$)/g, " ").replace(/[#*_`>]+/g, "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function userRows() {
  return [...document.querySelectorAll(".user-row[data-message-id]")];
}

const RAIL_TICKS = 15;
// Matches the tick row height in viewer.css.
const RAIL_TICK_HEIGHT = 12;

// One tick per message the user sent on this page. A tick previews the message and its reply;
// pressing it jumps there, dragging along the rail moves through them, and j and k step.
function MessageRail({ messages }) {
  const entries = useMemo(() => {
    const merged = mergeWireFragments(messages);
    return merged.flatMap((message, index) => {
      if (message.itemType !== "user_message" || !message.itemId) return [];
      const next = merged.slice(index + 1).find((item) => item.itemType === "assistant_message" || item.itemType === "user_message");
      return [{
        id: message.itemId,
        title: previewText(message.detail, 90) || "Message",
        reply: next?.itemType === "assistant_message" ? previewText(next.detail, 160) : "",
      }];
    });
  }, [messages]);
  const [active, setActive] = useState(0);
  const [preview, setPreview] = useState(null);
  const [listOpen, setListOpen] = useState(false);
  const currentItem = useRef(null);
  const sheet = useRef(null);
  const opener = useRef(null);
  const activeRef = useRef(0);
  activeRef.current = active;

  const scrubbing = useRef(null);

  const jump = useCallback((index, { instant = false } = {}) => {
    const entry = entries[index];
    if (!entry) return;
    const row = userRows().find((candidate) => candidate.dataset.messageId === entry.id);
    const calm = instant || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    row?.scrollIntoView?.({ block: "start", behavior: calm ? "auto" : "smooth" });
    setActive(index);
  }, [entries]);

  useEffect(() => {
    if (entries.length < 2) return undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      let current = 0;
      for (const row of userRows()) {
        const index = entries.findIndex((entry) => entry.id === row.dataset.messageId);
        if (index >= 0 && row.getBoundingClientRect().top <= 120) current = index;
      }
      setActive(current);
    };
    const onScroll = () => { frame ||= window.requestAnimationFrame(update); };
    const onKey = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName) || event.target?.isContentEditable) return;
      if (event.key === "j") jump(activeRef.current + 1);
      if (event.key === "k") jump(activeRef.current - 1);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("keydown", onKey);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [entries, jump]);

  // While the list is open it holds the keyboard: focus starts on the current message, Tab stays
  // inside, Escape closes, and closing hands focus back to the button that opened it.
  useEffect(() => {
    if (!listOpen) return undefined;
    const from = opener.current;
    currentItem.current?.scrollIntoView?.({ block: "center" });
    currentItem.current?.focus?.({ preventScroll: true });
    const onKey = (event) => {
      if (event.key === "Escape") setListOpen(false);
      if (event.key !== "Tab" || !sheet.current) return;
      const stops = [...sheet.current.querySelectorAll("button")];
      const inside = sheet.current.contains(document.activeElement);
      if (inside && document.activeElement !== (event.shiftKey ? stops[0] : stops.at(-1))) return;
      event.preventDefault();
      (event.shiftKey ? stops.at(-1) : stops[0])?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      from?.focus?.();
    };
  }, [listOpen]);

  if (entries.length < 2) return null;
  // A long session shows the ticks around the current message, not one for every message.
  const size = Math.min(entries.length, RAIL_TICKS);
  const first = Math.max(0, Math.min(entries.length - size, active - Math.floor(size / 2)));
  const show = (index) => (event) => {
    if (!scrubbing.current) setPreview({ index, top: event.currentTarget.offsetTop + event.currentTarget.offsetHeight / 2 });
  };
  const hide = () => { if (!scrubbing.current) setPreview(null); };
  // Pressing a tick goes to its message. Dragging from there moves one message per tick height, so
  // the rail slides under the pointer and a long session can be walked through.
  const scrubTo = (event) => {
    const list = event.currentTarget;
    const box = list.getBoundingClientRect();
    const { startY, startIndex } = scrubbing.current;
    const index = Math.max(0, Math.min(entries.length - 1, startIndex + Math.round((event.clientY - startY) / RAIL_TICK_HEIGHT)));
    setPreview({ index, top: Math.max(0, Math.min(box.height, event.clientY - box.top)) + list.offsetTop });
    if (index !== scrubbing.current.index) jump(index, { instant: true });
    scrubbing.current.index = index;
  };
  const startScrub = (event) => {
    const pressed = event.target.closest?.("[data-index]");
    if (event.button !== 0 || !pressed) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    scrubbing.current = { startY: event.clientY, startIndex: Number(pressed.dataset.index), index: -1 };
    scrubTo(event);
  };
  const endScrub = () => {
    scrubbing.current = null;
    setPreview(null);
  };
  return (
    <Fragment>
    <nav className="message-rail" aria-label="Your messages on this page">
      <ol
        onMouseLeave={hide}
        onPointerDown={startScrub}
        onPointerMove={(event) => { if (scrubbing.current) scrubTo(event); }}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
      >
        {entries.slice(first, first + size).map((entry, offset) => {
          const index = first + offset;
          // Ticks grow toward the current message and fade where the list goes on beyond the rail.
          const near = Math.min(3, Math.abs(index - active));
          const fades = (offset < 2 && first > 0) || (offset >= size - 2 && first + size < entries.length);
          return (
          <li key={entry.id}>
            <button
              type="button"
              className={`near-${near}${fades ? " fades" : ""}`}
              data-index={index}
              aria-label={`Message ${index + 1}: ${entry.title}`}
              aria-current={index === active ? "true" : undefined}
              onMouseEnter={show(index)}
              onFocus={show(index)}
              onBlur={hide}
              onClick={(event) => { if (event.detail === 0) jump(index); }}
            >
              <span />
            </button>
          </li>
          );
        })}
      </ol>
      <span className="rail-count">{active + 1} / {entries.length}</span>
      {preview ? (
        <div className="rail-preview" style={{ top: preview.top }} aria-hidden="true">
          <strong>{entries[preview.index].title}</strong>
          {entries[preview.index].reply ? <p>{entries[preview.index].reply}</p> : null}
        </div>
      ) : null}
    </nav>
    {/* Where there is no room for the rail, the same messages open as a list from a button. */}
    <button className="rail-open" type="button" ref={opener} aria-haspopup="dialog" aria-expanded={listOpen} onClick={() => setListOpen(true)}>
      <Icon name="message" />{active + 1} / {entries.length}
    </button>
    {listOpen ? (
      <div className="rail-sheet" ref={sheet} role="dialog" aria-modal="true" aria-label="Your messages" onClick={(event) => { if (event.target === event.currentTarget) setListOpen(false); }}>
        <div className="rail-sheet-panel">
          <div className="rail-sheet-head">
            <strong>Your messages</strong>
            <button type="button" aria-label="Close" onClick={() => setListOpen(false)}><Icon name="x" /></button>
          </div>
          <ol>
            {entries.map((entry, index) => (
              <li key={entry.id}>
                <button
                  type="button"
                  ref={index === active ? currentItem : undefined}
                  aria-current={index === active ? "true" : undefined}
                  onClick={() => { setListOpen(false); jump(index, { instant: true }); }}
                >
                  <span className="number">{index + 1}</span>
                  <span className="text"><strong>{entry.title}</strong>{entry.reply ? <small>{entry.reply}</small> : null}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      </div>
    ) : null}
    </Fragment>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(
    () =>
      document.documentElement.classList.contains("dark") ||
      (!document.documentElement.classList.contains("light") &&
        window.matchMedia("(prefers-color-scheme: dark)").matches),
  );
  return (
    <button
      className="theme-toggle"
      type="button"
      aria-label={`Use ${dark ? "light" : "dark"} theme`}
      onClick={() => {
        const next = !dark;
        document.documentElement.classList.toggle("dark", next);
        document.documentElement.classList.toggle("light", !next);
        setDark(next);
      }}
    >
      <Icon name={dark ? "sun" : "moon"} />
    </button>
  );
}

function Icon({ name, className = "" }) {
  const paths = {
    calendar: <Fragment><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></Fragment>,
    check: <path d="m5 12 4 4L19 6"/>,
    chevron: <path d="m6 9 6 6 6-6"/>,
    copy: <Fragment><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></Fragment>,
    eye: <Fragment><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12"/><circle cx="12" cy="12" r="3"/></Fragment>,
    file: <Fragment><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></Fragment>,
    folder: <path d="M3 6.5h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>,
    globe: <Fragment><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14 0 18M12 3c-3 3.5-3 14 0 18"/></Fragment>,
    hash: <Fragment><path d="M10 3 8 21M16 3l-2 18M4 9h16M3 15h16"/></Fragment>,
    info: <Fragment><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></Fragment>,
    message: <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>,
    moon: <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>,
    search: <Fragment><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></Fragment>,
    sun: <Fragment><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></Fragment>,
    terminal: <Fragment><path d="m4 6 5 5-5 5M12 18h8"/></Fragment>,
    tool: <Fragment><path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 9.6 6 7.3 3.7a4 4 0 0 0 5 5L5 16l3 3 7.3-7.3a4 4 0 0 0 5-5L18 9l-2.4-2.4 2.3-2.3a4 4 0 0 0-3.2 2"/></Fragment>,
    x: <Fragment><path d="m6 6 12 12M18 6 6 18"/></Fragment>,
  };
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.tool}</svg>;
}

// MessagesTimeline.logic: tool calls between messages fold into one work
// group, back-to-back user messages stack as one burst, and an assistant reply
// split around tool work shows its copy/model/time row once, on the last part.
function buildRows(messages) {
  const rows = [];
  let tools = [];
  const flush = () => {
    if (tools.length > 0) rows.push({ kind: "tools", id: `tools:${rows.length}:${tools[0].itemId || ""}`, entries: tools });
    tools = [];
  };
  for (const message of mergeWireFragments(messages)) {
    if (isToolItem(message)) tools.push(message);
    else {
      flush();
      rows.push({ kind: "message", id: message.itemId || `message:${rows.length}`, message });
    }
  }
  flush();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.kind !== "message") continue;
    const next = rows[index + 1];
    if (row.message.itemType === "user_message") {
      row.groupedWithNext = next?.kind === "message" && next.message.itemType === "user_message";
      continue;
    }
    const nextUser = rows.slice(index + 1).find((candidate) => candidate.kind === "message");
    row.showMeta = !nextUser || nextUser.message.itemType === "user_message";
  }
  return rows;
}

function mergeWireFragments(messages) {
  const merged = [];
  for (const message of messages) {
    const fragment = message.data?.wireFragment;
    if (!fragment) {
      merged.push(message);
      continue;
    }
    const data = { ...(message.data || {}) };
    delete data.wireFragment;
    const previous = merged.at(-1);
    if (fragment.index > 1 && previous?.itemId === fragment.sourceItemId) {
      previous.detail = `${previous.detail || ""}${message.detail || ""}`;
      continue;
    }
    // A page that starts inside a code block reopens its fence, so the rest still renders as code.
    const detail = fragment.fence ? `${fragment.fence}\n${message.detail || ""}` : message.detail;
    merged.push({ ...message, detail, itemId: fragment.sourceItemId, data });
  }
  return merged;
}

function plural(count, noun) {
  const value = Number(count) || 0;
  return `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
}

function shortProject(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/\/$/, "");
  const home = /^(\/(?:home|Users)\/[^/]+)(\/|$)/.exec(normalized);
  const display = home ? `~${normalized.slice(home[1].length)}` : normalized;
  if (display.length <= 52) return display;
  return `…/${display.split("/").filter(Boolean).slice(-3).join("/")}`;
}

function longTimestamp(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function isToolItem(item) {
  return !["user_message", "assistant_message", "reasoning", "plan", "error", "unknown"].includes(item.itemType);
}

function pageFromUrl(total) {
  const value = new URL(window.location.href).searchParams.get("page") || "1";
  const page = /^\d+$/.test(value) ? Number(value) : 1;
  return Math.max(1, Math.min(total || 1, Number.isSafeInteger(page) ? page : 1));
}

async function fetchWirePage(pageUrls, page, signal) {
  const response = await fetch(pageUrls[page - 1], { headers: { accept: "application/json" }, signal });
  if (!response.ok) throw new Error(`Could not load transcript page ${page} (${response.status}).`);
  const data = await response.json();
  if (data.protocol !== "t3code.provider-runtime/v2" || data.page !== page || !Array.isArray(data.events)) {
    throw new Error(`Transcript page ${page} is unreadable.`);
  }
  return wireItems(data);
}

// The transcript arrives a page at a time as the reader nears the end. A ?page=N link starts
// there, with the earlier pages one press away.
function useTranscript(pageUrls) {
  const total = pageUrls.length;
  const [loaded, setLoaded] = useState(() => {
    const start = pageFromUrl(total);
    return { first: start, last: start - 1, items: [] };
  });
  const [pending, setPending] = useState(() => (total > 0 ? pageFromUrl(total) : null));
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (pending === null) return undefined;
    const controller = new AbortController();
    setError(null);
    fetchWirePage(pageUrls, pending, controller.signal).then((items) => {
      if (controller.signal.aborted) return;
      setLoaded((current) => (pending < current.first
        ? { first: pending, last: current.last, items: [...items, ...current.items] }
        : { first: current.first, last: pending, items: [...current.items, ...items] }));
      setPending(null);
    }, (cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => controller.abort();
  }, [pending, pageUrls, attempt]);

  const idle = pending === null;
  const loadNext = useCallback(() => { if (idle && loaded.last < total) setPending(loaded.last + 1); }, [idle, loaded.last, total]);
  const loadEarlier = useCallback(() => { if (idle && loaded.first > 1) setPending(loaded.first - 1); }, [idle, loaded.first]);
  return { ...loaded, total, pending, error, loadNext, loadEarlier, retry: () => setAttempt((value) => value + 1) };
}

// Sits under the transcript and asks for the next page shortly before it scrolls into view.
function LoadMore({ onVisible, pending, total }) {
  const marker = useRef(null);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onVisible();
    }, { rootMargin: "800px 0px" });
    observer.observe(marker.current);
    return () => observer.disconnect();
  }, [onVisible]);
  return (
    <div className="page-status" ref={marker} role="status">
      {pending === null ? <button type="button" onClick={onVisible}>Load more</button> : `Loading page ${pending} of ${total}…`}
    </div>
  );
}

function App() {
  const payload = useMemo(readPayload, []);
  const pages = useMemo(() => payload.pages || [], [payload.pages]);
  const { items, first, last, total, pending, error, loadNext, loadEarlier, retry } = useTranscript(pages);
  const starting = items.length === 0 && pending !== null && !error;
  return (
    <div className="app-shell">
      <SessionHeader session={payload.session} stats={payload.stats} artifacts={payload.artifacts} messages={items} pages={pages} />
      {first > 1 && last >= first ? (
        <div className="page-status">
          <button type="button" disabled={pending !== null} onClick={loadEarlier}>Load earlier messages</button>
        </div>
      ) : null}
      <div aria-busy={pending !== null}><Timeline messages={items} loading={starting} /></div>
      {error ? <div className="page-status error" role="alert"><span>{error}</span><button type="button" onClick={retry}>Try again</button></div> : null}
      {!error && !starting && (pending !== null || last < total) ? <LoadMore onVisible={loadNext} pending={pending} total={total} /> : null}
      <footer className="site-footer">
        Shared with <a href="https://github.com/spacefast/push-session" target="_blank" rel="noreferrer">push-session</a>
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
