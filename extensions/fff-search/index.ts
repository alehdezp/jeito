import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FffEditor } from "./src/editor.ts";
import { FffRuntime } from "./src/fff.ts";

// Scoped fork of ShpetimA/pi-fff: @-file autocomplete only.
// No tools, no commands, no built-in read/grep overrides (see README.md).
export default function fffSearchExtension(pi: ExtensionAPI) {
	let runtime: FffRuntime | null = null;

	pi.on("session_start", async (_event, ctx) => {
		runtime?.dispose();
		try {
			const created = new FffRuntime(ctx.cwd);
			runtime = created;
			ctx.ui.setEditorComponent((tui, theme, keybindings) => new FffEditor(tui, theme, keybindings, created));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn("fff-search runtime unavailable, stock autocomplete stays active:", message);
			return;
		}

		void (async () => {
			const activeRuntime = runtime;
			if (!activeRuntime) return;
			const warmed = await activeRuntime.warm(1500);
			if (runtime !== activeRuntime) return;
			if (warmed.isErr()) {
				ctx.ui.notify(`fff-search unavailable: ${warmed.error.message}`, "warning");
				return;
			}
			const indexed = warmed.value.indexedFiles ? ` (${warmed.value.indexedFiles} files)` : "";
			ctx.ui.notify(`fff-search @ file finder enabled${indexed}`, "info");
		})();
	});

	pi.on("session_shutdown", async () => {
		runtime?.dispose();
		runtime = null;
	});
}
