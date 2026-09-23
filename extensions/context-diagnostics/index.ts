import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

interface DumpPayload {
  timestamp: string;
  modelName?: string;
  contextWindow?: number;
  tokenUsage?: { tokens: number | null; percent: number | null };
  systemPrompt: string;
  systemPromptOptions: Record<string, unknown>;
  toolDefinitions: Array<Record<string, unknown>>;
  messages: unknown[];
}

function automaticCaptureEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes(String(process.env.PI_CONTEXT_DIAGNOSTICS_AUTO ?? "").toLowerCase());
}

function safeLabel(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60) || "manual";
}

export default function contextDiagnostics(pi: ExtensionAPI) {
  const dumpDirectory = join(getAgentDir(), "context-dumps");

  function collectFullDump(ctx: ExtensionContext, extraMessages?: unknown[]): DumpPayload {
    const usage = ctx.getContextUsage?.();
    let systemPromptOptions: Record<string, unknown> = {};
    try { systemPromptOptions = (ctx as any).getSystemPromptOptions?.() ?? {}; } catch {}

    let toolDefinitions: Array<Record<string, unknown>> = [];
    try {
      toolDefinitions = ((pi as any).getAllTools?.() ?? []).map((tool: any) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        promptSnippet: tool.promptSnippet,
        promptGuidelines: tool.promptGuidelines,
        source: tool.source,
      }));
    } catch {}

    const messages = extraMessages ? [...extraMessages] : [];
    if (!messages.length) {
      try { messages.push(...((ctx.sessionManager as any)?.messages ?? [])); } catch {}
    }

    return {
      timestamp: new Date().toISOString(),
      modelName: ctx.model?.id,
      contextWindow: (ctx.model as any)?.contextWindow,
      tokenUsage: usage ? { tokens: usage.tokens, percent: usage.percent } : undefined,
      systemPrompt: ctx.getSystemPrompt(),
      systemPromptOptions,
      toolDefinitions,
      messages,
    };
  }

  function writeDump(label: string, dump: DumpPayload): string {
    mkdirSync(dumpDirectory, { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const path = join(dumpDirectory, `${timestamp}_${safeLabel(label)}.json`);
    writeFileSync(path, JSON.stringify(dump, null, 2), { encoding: "utf8", mode: 0o600 });
    return path;
  }

  pi.registerCommand("dump-context", {
    description: "Write one private diagnostic dump containing the current prompt, tool schemas, and messages",
    handler: async (args, ctx) => {
      const path = writeDump(args, collectFullDump(ctx));
      ctx.ui.notify(`Sensitive context dump: ${path}`, "warning");
    },
  });

  if (!automaticCaptureEnabled()) return;

  pi.on("context", (event: any, ctx: ExtensionContext) => {
    try { writeDump("pre-llm", collectFullDump(ctx, event.messages)); } catch {}
  });
  pi.on("agent_end", (event: any, ctx: ExtensionContext) => {
    try { writeDump("post-turn", collectFullDump(ctx, event.messages)); } catch {}
  });
  pi.on("before_agent_start", (event: any, ctx: ExtensionContext) => {
    try {
      const dump = collectFullDump(ctx);
      dump.systemPrompt = event.systemPrompt;
      dump.systemPromptOptions = event.systemPromptOptions ?? dump.systemPromptOptions;
      writeDump("pre-agent", dump);
    } catch {}
  });
}
