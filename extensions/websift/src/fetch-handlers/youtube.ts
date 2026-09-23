// Transcript-based YouTube extraction. The yt-dlp exec/error pattern is adapted from
// pi-web-access@0.13.0 youtube-extract.ts (7bdc30a65cf7) — see docs/upstreams/pi-web-access.md.
// Divergence (owner decision): pi-web-access pulls a stream and sends it to Gemini/Perplexity;
// we extract the captions + metadata with yt-dlp and return them directly — no model dependency.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderError } from "../failures.ts";
import type { FetchedContent } from "../types.ts";
import { formatSeconds, isTimeoutError, readExecError } from "./utils.ts";

const YOUTUBE_REGEX = /(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?.*v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

export function parseYouTubeUrl(url: string): string | null {
  try {
    if (new URL(url).hostname.toLowerCase().includes("youtube.com") === false && !url.includes("youtu.be/")) return null;
  } catch {
    return null;
  }
  return YOUTUBE_REGEX.exec(url)?.[1] ?? null;
}

export interface SubtitleFetchOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

function mapYtDlpError(err: unknown): ProviderError {
  const { code, stderr, message } = readExecError(err);
  if (code === "ENOENT") return new ProviderError("unavailable", "yt-dlp is not installed. Install with: brew install yt-dlp");
  if (isTimeoutError(err)) return new ProviderError("timeout", "yt-dlp timed out fetching the video");
  const snippet = (stderr || message).replace(/\s+/g, " ").trim().slice(0, 200);
  if (/private|unavailable|not available|removed/i.test(snippet)) return new ProviderError("policy", snippet || "Video is unavailable");
  return new ProviderError("network", snippet || "yt-dlp failed");
}

interface VideoMeta {
  title?: unknown;
  channel?: unknown;
  uploader?: unknown;
  duration?: unknown;
  upload_date?: unknown;
  description?: unknown;
}

function fetchMetadata(url: string, timeoutMs: number): VideoMeta {
  try {
    const stdout = execFileSync("yt-dlp", ["-J", "--no-warnings", "--no-playlist", url], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, encoding: "utf-8" });
    return JSON.parse(stdout) as VideoMeta;
  } catch (error) {
    throw mapYtDlpError(error);
  }
}

function fetchSubtitleText(url: string, options: SubtitleFetchOptions): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "jeito-yt-"));
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup of the temp subtitle dir
    }
  };
  return new Promise<string | null>((resolve, reject) => {
    // A precise language set (not the greedy "en.*" glob) avoids fanning out into
    // translated variants like en-de that YouTube rate-limits (HTTP 429), which would
    // otherwise make yt-dlp exit non-zero even after the English captions landed.
    const args = ["--skip-download", "--no-warnings", "--no-playlist", "--write-subs", "--write-auto-subs", "--sub-langs", "en,en-US,en-GB", "--sub-format", "vtt/srt/best", "-o", join(dir, "%(id)s"), url];
    const readSubtitles = (): string | null => {
      try {
        const subFile = readdirSync(dir).find((name) => /\.(vtt|srt)$/i.test(name));
        return subFile ? vttToText(readFileSync(join(dir, subFile), "utf-8")) : null;
      } catch {
        return null;
      }
    };
    const child = execFile("yt-dlp", args, { timeout: options.timeoutMs }, (error) => {
      // Salvage any captions that landed even if yt-dlp exits non-zero (e.g. one
      // requested variant was rate-limited); only a total failure yields null.
      const salvaged = readSubtitles();
      cleanup();
      if (salvaged) {
        resolve(salvaged);
        return;
      }
      if (error) {
        reject(mapYtDlpError(error));
        return;
      }
      resolve(null);
    });
    if (options.signal) {
      const onAbort = () => child.kill();
      options.signal.addEventListener("abort", onAbort, { once: true });
      child.on("exit", () => options.signal?.removeEventListener("abort", onAbort));
    }
    void readSubtitles;
  });
}

// Group captions into minute buckets so long transcripts retain stable, human-readable
// time locators. Exact adjacent de-duplication removes the common rolling-caption repeat.
export function vttToText(vtt: string): string {
  const groups: Array<{ bucket?: number; lines: string[] }> = [];
  let cueSeconds: number | undefined;
  let lastText = "";
  for (const raw of vtt.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^WEBVTT/i.test(line) || /^Kind:/i.test(line) || /^Language:/i.test(line) || /^\d+$/.test(line)) continue;
    const cue = /^(\d{1,2}):(\d{2}):(\d{2})[.,]\d+\s+-->/.exec(line);
    if (cue) {
      cueSeconds = Number(cue[1]) * 3600 + Number(cue[2]) * 60 + Number(cue[3]);
      continue;
    }
    const text = line.replace(/<[^>]+>/g, "").replace(/\{[^}]+\}/g, "").trim();
    if (!text || text === lastText) continue;
    lastText = text;
    const bucket = cueSeconds === undefined ? undefined : Math.floor(cueSeconds / 60) * 60;
    let group = groups.at(-1);
    if (!group || group.bucket !== bucket) {
      group = { bucket, lines: [] };
      groups.push(group);
    }
    group.lines.push(text);
  }
  return groups.map((group) => `${group.bucket === undefined ? "" : `### [${formatSeconds(group.bucket)}]\n\n`}${group.lines.join(" ")}`).join("\n\n");
}

export async function extractYouTube(url: string, options: SubtitleFetchOptions): Promise<FetchedContent> {
  const meta = fetchMetadata(url, options.timeoutMs);
  const title = typeof meta.title === "string" && meta.title ? meta.title : "YouTube video";
  const channel = typeof meta.channel === "string" ? meta.channel : typeof meta.uploader === "string" ? meta.uploader : undefined;
  const duration = typeof meta.duration === "number" ? formatSeconds(Math.floor(meta.duration)) : undefined;
  const uploaded = typeof meta.upload_date === "string" && meta.upload_date.length === 8 ? `${meta.upload_date.slice(0, 4)}-${meta.upload_date.slice(4, 6)}-${meta.upload_date.slice(6, 8)}` : undefined;
  if (options.signal?.aborted) throw new ProviderError("aborted", "YouTube fetch aborted");

  let transcript = "";
  try {
    transcript = (await fetchSubtitleText(url, options)) ?? "";
  } catch (error) {
    if (error instanceof ProviderError && error.failureClass === "aborted") throw error;
    // A missing yt-dlp or absent captions degrades to a metadata-only result rather than failing the fetch.
  }

  const header = [`# ${title}`, "", `> Source: ${url}`, [channel && `Channel: ${channel}`, duration && `Duration: ${duration}`, uploaded && `Uploaded: ${uploaded}`].filter(Boolean).map((item) => `> ${item}`).join("\n")].filter(Boolean);
  const body = transcript ? `## Transcript\n\n${transcript}` : "No captions were available for this video, so only metadata could be retrieved. Captions require the video to have manual or auto-generated subtitles.";
  return { url, title, content: `${header.join("\n")}\n\n${body}`, contentType: "text/youtube-transcript" };
}