// Plain-Markdown copy of a session, and the prompt an agent is opened with.

const ROLE_HEADINGS = { user_message: "User", assistant_message: "Assistant", reasoning: "Reasoning", plan: "Plan", error: "Error" };

/** Fragments of one long item arrive as separate events; join them back before writing. */
function joinFragments(items) {
  const joined = [];
  for (const item of items) {
    const fragment = item.data?.wireFragment;
    const previous = joined.at(-1);
    if (fragment && fragment.index > 1 && previous?.itemId === fragment.sourceItemId) {
      previous.detail = `${previous.detail || ""}${item.detail || ""}`;
    } else {
      joined.push({ ...item, itemId: fragment?.sourceItemId || item.itemId });
    }
  }
  return joined;
}

// A fence longer than any run of backticks inside, so tool output cannot close it early.
function fenced(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) || []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

/** The whole session as Markdown: every message, and every tool call with its input and output. */
export function sessionMarkdown(session, items) {
  const facts = [session.providerLabel, session.project, session.createdAt && session.createdAt.slice(0, 10)].filter(Boolean);
  const blocks = [`# ${session.title || `${session.providerLabel || "Agent"} session`}`];
  if (facts.length > 0) blocks.push(facts.join(" · "));
  for (const item of joinFragments(items)) {
    const text = String(item.detail || "").trim();
    const heading = ROLE_HEADINGS[item.itemType];
    if (heading) {
      if (text) blocks.push(`## ${heading}\n\n${text}`);
      continue;
    }
    const label = `${item.data?.label || item.title || "Tool call"}${item.status === "failed" ? " (failed)" : ""}`;
    blocks.push(text ? `### Tool: ${label}\n\n${fenced(text)}` : `### Tool: ${label}`);
  }
  return `${blocks.join("\n\n")}\n`;
}

/**
 * The prompt an agent is opened with. A link can only carry so much, so when the session does not
 * fit in `budget` characters the prompt keeps its end and says where the rest is.
 */
export function continuationPrompt(session, items, url, budget = 4_000) {
  const markdown = items.length > 0 ? sessionMarkdown(session, items) : "";
  const head = `Continue from this shared session.\nFull transcript: ${url}`;
  if (!markdown || budget <= 0) return head;
  if (markdown.length <= budget) return `${head}\n\n${markdown}`;
  // A cut can land inside an emoji's two halves; half of one cannot be put in a link.
  const ending = markdown.slice(-budget).replace(/^[\uDC00-\uDFFF]/, "");
  return `${head}\nThe whole transcript is on the clipboard as Markdown; paste it here if you need more than this ending.\n\n…${ending}`;
}
