import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { FffRuntime } from "../src/fff.ts";

test("autocomplete runtime initializes, searches, tracks selection and disposes with the upgraded engine", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "fff-runtime-test-")));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, ".agent");
	const runtime = new FffRuntime(root);
	try {
		assert.equal(getAgentDir(), join(root, ".agent"), "test must not write host-owned databases");
		await writeFile(join(root, "AutocompleteNeedle.ts"), "export const needle = true;\n");
		const warmed = await runtime.warm(10_000);
		assert.ok(warmed.isOk(), warmed.isErr() ? warmed.error.message : "");
		let found = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			const result = await runtime.searchFileCandidates("AutocompleteNeedle");
			assert.ok(result.isOk(), result.isErr() ? result.error.message : "");
			found = result.value.some(candidate => candidate.item.relativePath === "AutocompleteNeedle.ts");
			if (found) break;
			await delay(100);
		}
		assert.ok(found, "production runtime must return the indexed candidate");
		const tracked = await runtime.trackQuery("AutocompleteNeedle", "AutocompleteNeedle.ts");
		assert.ok(tracked.isOk(), tracked.isErr() ? tracked.error.message : "");
		const anchored = await runtime.searchFileCandidates("./AutocompleteNeedle");
		assert.ok(anchored.isOk());
		assert.ok(anchored.value.some(candidate => candidate.item.fileName === "AutocompleteNeedle.ts"));
	} finally {
		runtime.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});
