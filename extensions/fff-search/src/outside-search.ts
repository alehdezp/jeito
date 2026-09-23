import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { FileItem, FffFileCandidate, Score } from "./fff-types.ts";

// The fff engine indexes exactly one root and deliberately refuses to index
// `/` or the home directory unless explicitly opted in (InitOptions
// `.enableFsRootScanning` / `.enableHomeDirScanning` in @ff-labs/fff-node):
// broad roots flood its file watcher with churn-prone events. Anchored
// queries (`/abs`, `~/…`, `../`, `./`) point outside the project index, so
// they are served here by direct single-directory completion instead of a
// second native index: one readdir per keystroke, no watcher, no scan cost.

export function isAnchoredPathQuery(normalizedQuery: string): boolean {
	return (
		normalizedQuery.startsWith("/") ||
		normalizedQuery === ".." ||
		normalizedQuery.startsWith("../") ||
		normalizedQuery.startsWith("./")
	);
}

type NameMatch = { score: number; exactMatch: boolean; matchType: string };

function scoreName(name: string, query: string): NameMatch | null {
	const lowerName = name.toLowerCase();
	const lowerQuery = query.toLowerCase();
	if (lowerName === lowerQuery) return { score: 1000, exactMatch: true, matchType: "exact" };
	if (lowerName.startsWith(lowerQuery)) return { score: 800 - name.length, exactMatch: false, matchType: "prefix" };
	// Case-insensitive in-order subsequence; bonus for contiguous runs and
	// for matches close together, mirroring the engine's preference order.
	let score = 0;
	let nameIndex = 0;
	let streak = 0;
	for (const char of lowerQuery) {
		const found = lowerName.indexOf(char, nameIndex);
		if (found === -1) return null;
		streak = found === nameIndex ? streak + 1 : 1;
		score += 10 + streak * 5 - Math.min(found - nameIndex, 10);
		nameIndex = found + 1;
	}
	return { score, exactMatch: false, matchType: "fuzzy" };
}

// What gets inserted after `@`: home paths stay readable as `~/…` (the
// runtime's normalizePathQuery expands them back), everything else stays
// absolute. Directories keep a trailing `/` so the next keystroke descends.
function displayPathFor(baseDir: string, isDirectory: boolean, name: string): string {
	const home = homedir();
	const joined = baseDir === "/" ? `/${name}` : `${baseDir}/${name}`;
	const display = home === "/" || !joined.startsWith(`${home}/`) ? joined : `~${joined.slice(home.length)}`;
	return isDirectory ? `${display}/` : display;
}

function buildCandidate(baseDir: string, isDirectory: boolean, name: string, match: NameMatch): FffFileCandidate {
	// Only `relativePath` (inserted text) and `fileName` (label) are read by
	// the autocomplete provider; the remaining FileItem fields are filled to
	// satisfy the engine's shared type without pretending we have frecency
	// or git data for files outside the indexed project.
	const displayPath = displayPathFor(baseDir, isDirectory, name);
	const item: FileItem = {
		path: displayPath,
		relativePath: displayPath,
		fileName: name,
		size: 0,
		modified: 0,
		accessFrecencyScore: 0,
		modificationFrecencyScore: 0,
		totalFrecencyScore: 0,
		gitStatus: "",
	};
	const score: Score = {
		total: match.score,
		baseScore: match.score,
		filenameBonus: 0,
		specialFilenameBonus: 0,
		frecencyBoost: 0,
		distancePenalty: 0,
		currentFilePenalty: 0,
		comboMatchBoost: 0,
		exactMatch: match.exactMatch,
		matchType: match.matchType,
	};
	return { item, score };
}

export async function completeOutsidePath(cwd: string, normalizedQuery: string, limit: number): Promise<FffFileCandidate[]> {
	let baseDir: string;
	let partial: string;
	if (normalizedQuery.endsWith("/")) {
		// Trailing slash means "list this directory": `~/`, `../`, `/usr/`.
		baseDir = resolve(cwd, normalizedQuery);
		partial = "";
	} else if (normalizedQuery === "..") {
		baseDir = resolve(cwd, "..");
		partial = "";
	} else {
		const lastSlash = normalizedQuery.lastIndexOf("/");
		// Not an anchored directory-qualified shape; nothing to complete here.
		if (lastSlash === -1) return [];
		baseDir = resolve(cwd, normalizedQuery.slice(0, lastSlash + 1));
		partial = normalizedQuery.slice(lastSlash + 1);
	}

	let entries;
	try {
		entries = await readdir(baseDir, { withFileTypes: true });
	} catch {
		// Nonexistent or unreadable directory: empty result lets the editor
		// fall back to stock suggestions (existing degradation path).
		return [];
	}

	const matchDotfiles = partial.startsWith(".");
	const scored: Array<{ name: string; isDirectory: boolean; match: NameMatch }> = [];
	for (const entry of entries) {
		if (!matchDotfiles && entry.name.startsWith(".")) continue;
		const isDirectory = entry.isDirectory();
		const match = partial ? scoreName(entry.name, partial) : { score: isDirectory ? 5 : 0, exactMatch: false, matchType: "fuzzy" };
		if (!match) continue;
		scored.push({ name: entry.name, isDirectory, match });
	}
	scored.sort((a, b) => b.match.score - a.match.score || a.name.localeCompare(b.name));

	return scored.slice(0, Math.max(1, limit)).map(({ name, isDirectory, match }) => buildCandidate(baseDir, isDirectory, name, match));
}
