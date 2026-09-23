import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { FileFinder } from "@ff-labs/fff-node";

function unwrap(result) {
	assert.ok(result.ok, result.error);
	return result.value;
}

async function eventually(check, message) {
	const deadline = Date.now() + 15_000;
	do {
		if (await check()) return;
		await delay(100);
	} while (Date.now() < deadline);
	assert.fail(message);
}

test("rescan subscriptions do not reindex directories; live file updates still work", async () => {
	// Canonicalize macOS /var -> /private/var: otherwise 0.9.6's Git path
	// prefix error can bypass the expensive operation this test must exercise.
	const sandbox = await realpath(await mkdtemp(join(tmpdir(), "fff-watch-test-")));
	const root = join(sandbox, "repo");
	let finder;
	try {
		await mkdir(root);
		for (let i = 0; i < 32; i++) {
			await mkdir(join(root, `dir-${i}`));
			await writeFile(join(root, `dir-${i}/alpha.ts`), "export const alpha = 1;\n");
			await writeFile(join(root, `dir-${i}/beta.ts`), "export const beta = 2;\n");
		}
		execFileSync("git", ["init", "-q", root]);
		execFileSync("git", ["-C", root, "add", "."]);
		// Match the extension's production settings: watching, content indexing
		// and warmup all remain enabled. Logs and databases stay outside the tree.
		finder = unwrap(FileFinder.create({
			basePath: root, aiMode: true,
			frecencyDbPath: join(sandbox, "frecency.db"),
			historyDbPath: join(sandbox, "history.db"),
			logFilePath: join(sandbox, "watcher.log"), logLevel: "debug",
		}));
		const ready = () => {
			const progress = unwrap(finder.getScanProgress());
			return progress.isWatcherReady && !progress.isScanning && progress.isWarmupComplete;
		};
		const has = (path) => unwrap(finder.fileSearch(path, { pageSize: 100 })).items.some(item => item.relativePath === path);
		await eventually(ready, "initial scan/watcher did not become ready");
		assert.ok(has("dir-12/alpha.ts"));
		await delay(500);
		const logName = (await readdir(sandbox)).find(name => name.startsWith("watcher") && name.endsWith(".log"));
		assert.ok(logName, "native tracing must be active for the regression assertion");
		const logPath = join(sandbox, logName);
		const offset = (await readFile(logPath, "utf8")).length;
		unwrap(finder.scanFiles());
		await eventually(async () => (await readFile(logPath, "utf8")).slice(offset).includes("rescubscribe_watcher_post_scan"), "explicit rescan never reached watcher resubscription");
		await eventually(ready, "rescan did not finish");
		await delay(1500);
		const rescanLog = (await readFile(logPath, "utf8")).slice(offset);
		assert.equal(/fff-watcher-own[^\n]*git_status_for_paths/.test(rescanLog), false, "resubscribing existing directories must not enqueue per-directory Git queries");
		assert.doesNotMatch(rescanLog, /ERROR/, "native rescan must not silently fail");

		await mkdir(join(root, "new-directory"));
		await writeFile(join(root, "new-directory/created.ts"), "export const fresh = true;\n");
		await eventually(() => has("new-directory/created.ts"), "new directory/file not indexed by watcher");
		await rename(join(root, "new-directory/created.ts"), join(root, "new-directory/renamed.ts"));
		await eventually(() => has("new-directory/renamed.ts") && !has("new-directory/created.ts"), "rename not reflected in search");
		await unlink(join(root, "new-directory/renamed.ts"));
		await eventually(() => !has("new-directory/renamed.ts"), "deleted file still searchable");
	} finally {
		finder?.destroy();
		await rm(sandbox, { recursive: true, force: true });
	}
});
