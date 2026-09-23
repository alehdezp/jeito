// Contamination-controlled eval surface for query-guided section retrieval (Tier 1 gate).
// Every fixture is self-authored; every `fact` is a unique improbable string (fake tool
// names, versions, flags, error codes, rule numbers) that cannot exist in any model's
// training data. A query answered correctly therefore proves the retrieved bytes carried
// the fact — memory cannot. Tiers: easy (exact terms), medium (conceptual), hard
// (paraphrase — logged, not gated yet), vague (research-shaped hint queries whose
// vocabulary deliberately does not match the answer section — logged, not gated; they
// measure where Tier 1's lexical ceiling ends and where a future LLM tier would earn its
// cost), negative (must return not found, not fabricate).
export const novelManifest = [
  {
    file: "zarq-tool.md",
    label: "zarq — fake CLI tool (tool-doc shape)",
    queries: [
      { q: "what zarq version does uv tool install", tier: "easy", section: "Install", fact: "9.2.1-rc" },
      { q: "zarq reify flag writes the ledger file", tier: "easy", section: "CLI reference", fact: "--reify" },
      { q: "corpus lock contention error code", tier: "medium", section: "Error codes", fact: "ZARQ-0x4F" },
      { q: "disable the memo cache so every run is fresh", tier: "medium", section: "CLI reference", fact: "--no-memo" },
      { q: "what happens when another process holds the corpus lock", tier: "hard", section: "Error codes", fact: "ZARQ-0x4F" },
      { q: "machine learning inference latency", tier: "negative", section: null, fact: null },
      { q: "coffee roasting temperature", tier: "negative", section: null, fact: null },
      { q: "does this program phone home", tier: "vague", section: "Overview", fact: "no telemetry" },
      { q: "what happens if the ledger is corrupted", tier: "vague", section: "Error codes", fact: "ZARQ-0x22" },
    ],
  },
  {
    file: "acme-guidelines.md",
    label: "ACME playbook — fake guidelines (guideline shape)",
    queries: [
      { q: "rule about hot-swapping the ledger partition", tier: "easy", section: "Severity ladder", fact: "RULE-17" },
      { q: "which partition rotates at 02:30", tier: "easy", section: "Rotation procedure", fact: "ledger-partition-7" },
      { q: "one replica at a time deployment rule", tier: "medium", section: "Deployments", fact: "RULE-21" },
      { q: "when do you page the storage lead", tier: "medium", section: "Escalation", fact: "RULE-23" },
      { q: "we missed the drain window, can we rotate late", tier: "hard", section: "Rotation procedure", fact: "do not rotate late" },
      { q: "holiday schedule", tier: "negative", section: null, fact: null },
      { q: "budget approval workflow", tier: "negative", section: null, fact: null },
      { q: "who gets paged at night", tier: "vague", section: "Escalation", fact: "RULE-23" },
      { q: "we hot-swapped the partition anyway, what happens", tier: "vague", section: "Severity ladder", fact: "RULE-17" },
    ],
  },
  {
    file: "beluga-changelog.md",
    label: "beluga-bridge — fake changelog (changelog shape)",
    queries: [
      { q: "what flag replaced listen", tier: "easy", section: "0.5.0", fact: "--attach" },
      { q: "newest version number", tier: "easy", section: "0.5.0", fact: "0.5.0" },
      { q: "how fast does reconnect happen now", tier: "medium", section: "0.5.0", fact: "400ms" },
      { q: "what got fixed in 0.4.2", tier: "medium", section: "0.4.2", fact: "wisp" },
      { q: "we saw dropped first frames on reconnect, was that fixed", tier: "hard", section: "0.4.2", fact: "wisp handshake" },
      { q: "gpu acceleration", tier: "negative", section: null, fact: null },
      { q: "who reads the log correlation data", tier: "vague", section: "0.4.1", fact: "beluga.trace_id" },
      { q: "we lost power and everything, is anything kept", tier: "vague", section: "0.4.0", fact: "persisted" },
    ],
  },
];
