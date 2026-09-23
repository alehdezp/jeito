import type { SmartSummaryProvider, SummaryEntry } from "../core/smart-summary-provider.ts";
import { cleanLabel, MARKDOWN_EXTENSIONS } from "./local-provider-utils.ts";

export const localMarkdownProvider: SmartSummaryProvider = {
  name: "local-markdown",
  priority: 20,
  canHandle(input) {
    return input.kind === "file" && MARKDOWN_EXTENSIONS.has(input.extension ?? "");
  },
  async summarize(input) {
    const lines = input.lines ?? [];
    const headings: { start: number; level: number; text: string }[] = [];
    let fence: string | undefined;

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      const fenceMatch = /^(\s*)(`{3,}|~{3,})/.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[2]?.[0];
        if (!fence) fence = marker;
        else if (fence === marker) fence = undefined;
        continue;
      }
      if (fence) continue;
      const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (!match) continue;
      headings.push({ start: index + 1, level: match[1]!.length, text: cleanLabel(match[2]!) });
    }
    if (headings.length === 0) return null;

    const entries: SummaryEntry[] = headings.map((heading, index) => {
      let end = lines.length;
      for (let next = index + 1; next < headings.length; next++) {
        if (headings[next]!.level <= heading.level) {
          end = headings[next]!.start - 1;
          break;
        }
      }
      const indent = "  ".repeat(Math.max(0, heading.level - 1));
      return {
        start: heading.start,
        end,
        label: `${indent}${"#".repeat(heading.level)} ${heading.text}`,
        kind: "heading",
        confidence: "high",
      };
    });

    return {
      title: "markdown summary",
      entries,
      totalLines: lines.length,
      providerName: "local-markdown",
    };
  },
};
