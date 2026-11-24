import { AutocompletePrompt, isCancel } from "@clack/core";
import { limitOptions, S_BAR, S_BAR_END, S_RADIO_ACTIVE, S_RADIO_INACTIVE, symbol } from "@clack/prompts";
import pc from "picocolors";

/**
 * The session list. Typing searches every session; Tab switches which agent's sessions are shown,
 * and the footer says which. Resolves to the chosen option's value, or null when cancelled.
 * With `web` set, Ctrl+X leaves the list for the picker in the browser and resolves to OPEN_WEB.
 *
 * `options` are `{ value, label, hint, agent }`, `agents` are `{ id, label, mark }`, and
 * `message(count)` is the question for a list of that many sessions.
 */
export const OPEN_WEB = Symbol("open-web");

export async function pickSession({ message, options, agents = [], filter, maxItems, web = false, input, output }) {
  let only = null;
  let leftForWeb = false;
  const shown = () => (only === null ? options : options.filter((option) => option.agent === agents[only].id));

  const prompt = new AutocompletePrompt({
    options: shown,
    filter,
    initialValue: options.length > 0 ? [options[0].value] : undefined,
    input,
    output,
    render() {
      const bar = pc.gray(S_BAR);
      const title = `${symbol(this.state)}  ${message(shown().length)}`;
      if (this.state === "submit") {
        const chosen = options.find((option) => option.value === this.selectedValues[0]);
        return `${bar}\n${title}\n${bar}  ${pc.dim(chosen?.label ?? "")}`;
      }
      if (this.state === "cancel" && leftForWeb) return `${bar}\n${title}\n${bar}  ${pc.dim("Opening the picker in your browser…")}`;
      if (this.state === "cancel") {
        return `${bar}\n${title}\n${bar}${this.userInput ? `  ${pc.strikethrough(pc.dim(this.userInput))}` : ""}`;
      }

      const guide = `${pc.cyan(S_BAR)}  `;
      const typed = this.userInput ? this.userInputWithCursor : pc.dim("Type to search by title, project, agent, or ID");
      const matches = this.filteredOptions.length === shown().length ? "" : pc.dim(` (${this.filteredOptions.length} match${this.filteredOptions.length === 1 ? "" : "es"})`);
      const head = [bar, title, guide.trimEnd(), `${guide}${pc.dim("Search:")} ${typed}${matches}`];
      if (this.filteredOptions.length === 0 && this.userInput) head.push(`${guide}${pc.yellow("No matches found")}`);

      const agent = only === null ? "all" : `${agents[only].mark} ${agents[only].label}`;
      const foot = [
        ...(agents.length > 1 ? [`${guide}${pc.dim("Agent:")} ${agent} ${pc.dim("• Tab:")} change`] : []),
        `${guide}${pc.dim("↑/↓")} to select • ${pc.dim("Enter:")} confirm • ${pc.dim("Type:")} to search${web ? ` • ${pc.dim("Ctrl+X:")} pick in browser` : ""}`,
        pc.cyan(S_BAR_END),
      ];
      const rows = this.filteredOptions.length === 0 ? [] : limitOptions({
        cursor: this.cursor,
        options: this.filteredOptions,
        columnPadding: 3,
        rowPadding: head.length + foot.length,
        maxItems,
        output,
        style: (option, active) => (active
          ? `${pc.green(S_RADIO_ACTIVE)} ${option.label}${option.hint ? pc.dim(` (${option.hint})`) : ""}`
          : `${pc.dim(S_RADIO_INACTIVE)} ${pc.dim(option.label)}`),
      });
      return [...head, ...rows.map((row) => `${guide}${row}`), ...foot].join("\n");
    },
  });

  if (agents.length > 1) {
    prompt.on("key", (_character, key) => {
      if (key?.name !== "tab") return;
      only = only === null ? 0 : only + 1 < agents.length ? only + 1 : null;
      // The prompt rebuilds its list only when the search text changes, so nudge it and set it back.
      prompt.emit("userInput", `${prompt.userInput}\u0000`);
      prompt.emit("userInput", prompt.userInput);
    });
  }

  if (web) {
    prompt.on("key", (_character, key) => {
      if (!key?.ctrl || key.name !== "x") return;
      // Ctrl+X: Ctrl+W closes the tab in many terminals.
      // Ends the prompt the way a cancel does, with its own closing line.
      leftForWeb = true;
      prompt.state = "cancel";
      prompt.emit("finalize");
      prompt.render();
      prompt.close();
    });
  }

  const value = await prompt.prompt();
  if (leftForWeb) return OPEN_WEB;
  return isCancel(value) ? null : value;
}
