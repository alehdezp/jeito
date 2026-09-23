#!/usr/bin/env node
// Populate/refresh the gitignored vendor/ reference snapshots from vendor.manifest.json.
//
// MAINTAINER-ONLY. End users installing the extension never need vendor/ — the
// extension's runtime dependencies come from package.json via npm. This script
// exists so a maintainer can inspect upstream source locally and track its
// evolution with git (the "git pull / what changed" workflow).
//
// Usage:
//   node scripts/vendor-fetch.mjs                     # clone/refresh all at pinned refs
//   node scripts/vendor-fetch.mjs --ref pi-web-access=v0.14.0   # override one ref
//
// Shallow clones keep this light. For a full-history diff between two refs:
//   git -C vendor/<name> fetch --unshallow (or fetch the specific ref), then
//   git -C vendor/<name> diff <old-ref>..<new-ref> -- <mappedPaths>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url))); // .../extensions/websift
const manifest = JSON.parse(readFileSync(join(root, "vendor.manifest.json"), "utf8"));
const vendorDir = join(root, manifest.vendorDir || "vendor");
mkdirSync(vendorDir, { recursive: true });

// Parse `--ref name=value` overrides.
const refOverrides = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--ref" && argv[i + 1]) {
    const eq = argv[i + 1].indexOf("=");
    if (eq > 0) refOverrides[argv[i + 1].slice(0, eq)] = argv[i + 1].slice(eq + 1);
    i++;
  }
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const rows = [];
for (const s of manifest.sources) {
  const dest = join(vendorDir, s.name);
  const ref = refOverrides[s.name] || s.ref;
  let note = "";
  try {
    if (existsSync(join(dest, ".git"))) {
      try { git(["fetch", "--depth", "1", "origin", ref], dest); }
      catch { git(["fetch", "--depth", "1", "origin"], dest); }
      try { git(["checkout", ref], dest); }
      catch { note = `ref '${ref}' not found; stayed on current checkout`; }
    } else {
      try {
        git(["clone", "--depth", "1", "--branch", ref, s.repo, dest]);
      } catch {
        git(["clone", "--depth", "1", s.repo, dest]);
        try { git(["checkout", ref], dest); }
        catch { note = `ref '${ref}' not found; cloned default branch`; }
      }
    }
    const sha = git(["rev-parse", "HEAD"], dest).slice(0, 12);
    rows.push({ name: s.name, role: s.role, ref, sha, sub: s.subpath || "", note });
  } catch (err) {
    rows.push({ name: s.name, role: s.role, ref, sha: "FAILED", sub: s.subpath || "", note: String(err.message || err).split("\n")[0] });
  }
}

const pad = (v, n) => String(v).padEnd(n);
console.log("\nVendored snapshots (gitignored; maintainer-only; not needed to run the extension):\n");
console.log(pad("name", 20), pad("role", 10), pad("ref", 12), pad("sha", 14), pad("subpath", 20), "note");
for (const r of rows) console.log(pad(r.name, 20), pad(r.role, 10), pad(r.ref, 12), pad(r.sha, 14), pad(r.sub, 20), r.note);
console.log(`\n${rows.length} source(s) into ${vendorDir}`);
console.log("\nNext: record each resolved SHA in docs/upstreams/<source>.md (the pinned snapshot).");
console.log("Update workflow: bump ref in vendor.manifest.json, re-run this, then");
console.log("  git -C vendor/<name> diff <old-ref>..<new-ref> -- <mappedPaths>   # see what changed");
