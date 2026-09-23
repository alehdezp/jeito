import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";

import { defaultAgentNavigationConfigPath } from "./navigation-automation-config.ts";

/**
 * First-startup seed of the package-owned max-quality global config.
 *
 * The file contains provider choices but never credentials. Existing user
 * configuration is authoritative and is never overwritten.
 */
export function ensureDefaultNavigationConfig(options: { home?: string; env?: Record<string, string | undefined> } = {}): { path: string; created: boolean; reason: string } {
  const home = options.home ?? homedir();
  const configPath = defaultAgentNavigationConfigPath(home);
  if (existsSync(configPath)) {
    return { path: configPath, created: false, reason: "navigation.yaml already exists; leaving untouched" };
  }
  try {
    const dir = dirname(configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(configPath, DEFAULT_NAVIGATION_YAML, { mode: 0o600 });
    try { chmodSync(configPath, 0o600); } catch {}
    return { path: configPath, created: true, reason: "seeded keyless max-quality navigation.yaml (0600)" };
  } catch (error: any) {
    return { path: configPath, created: false, reason: `navigation.yaml seed skipped: ${error?.message ?? error}` };
  }
}

const DEFAULT_NAVIGATION_YAML = `# ~/.pi/agent/navigation.yaml
# Private machine configuration for Pi jeito-codeweave-pi. This file is 0600.
# Provider choices are bundled defaults; add credentials locally and never commit them.

profile: max-quality

automation:
  mode: aggressive
  session_start: true
  first_broad_request: true
  stop_refresh: aggressive

providers:
  allow_cloud: true
  allow_embeddings: true
  allow_llm: true
  allow_local_model_downloads: true
  allowed: [openai, voyage, zeroentropy, deepseek, google, anthropic, kimi, ollama, sentence-transformers, minimax]
  defaults:
    embedding: local
    llm: deepseek
  openai:
    # api_key: paste-your-real-value
    embedding_model: text-embedding-3-small
  voyage:
    # api_key: paste-your-real-value
    embedding_model: voyage-4-large
  zeroentropy:
    # api_key: paste-your-real-value
  deepseek:
    # api_key: paste-your-real-value
    model: deepseek-v4-flash
    base_url: https://api.deepseek.com/v1

backends:
  architecture:
    enabled: true
    autoPrepare: true
  docs:
    mode: hybridDocs
    embeddings: auto
    embedding_provider: auto
    aiSummaries: auto
    summarizer_provider: deepseek
  graph:
    mode: deepExtract
    deepMode: deepExtract
    provider: deepseek
    model: deepseek-v4-flash
`;
