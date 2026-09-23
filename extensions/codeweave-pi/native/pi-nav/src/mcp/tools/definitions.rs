use serde_json::Value;

pub(crate) fn tool_definitions(edit_mode: bool) -> Vec<Value> {
    let read_desc = if edit_mode {
        "Read a file with smart outlining. Replaces cat/head/tail and the host Read tool — \
         use this for all file reading. Output uses hashline format (line:hash|content) — \
         the line:hash anchors are required by pi_nav_write. Small files return full hashlined content. \
         Large files return a structural outline (no hashlines); use `section` to get hashlined \
         content for the lines you want to edit. Use `sections` to grab several disjoint slices \
         from the same file in one call. Use `full` to force complete content. \
         Use `paths` to read multiple files in one call."
    } else {
        "Read a file with smart outlining. Replaces cat/head/tail and the host Read tool — \
         use this for all file reading. Small files return full content. Large files return \
         a structural outline (functions, classes, imports) so you see the shape without \
         consuming your context window. Use `section` to read a specific line range or heading. \
         Use `sections` to grab several disjoint slices from the same file in one call. \
         Use `full` to force complete content. Use `paths` to read multiple files in one call."
    };
    let mut tools = vec![
        serde_json::json!({
            "name": "pi_nav_search",
            "annotations": { "readOnlyHint": true },
            "description": "Search for symbols, text, or regex patterns in code. Replaces grep/rg and the host Grep tool — use this for all code search. Symbol search returns definitions first (via tree-sitter AST), then usages, with full source code inlined for top matches. Content search finds literal text. Regex search supports full regex patterns. For cross-file tracing, pass comma-separated symbol names (max 5).",
            "inputSchema": {
                "type": "object",
                "required": ["query"],
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Symbol name, text string, or regex pattern to search for. e.g. 'resolve_dependencies' or 'ServeHTTP,Next' for comma-separated multi-symbol lookup (max 5)."
                    },
                    "scope": {
                        "type": "string",
                        "description": "Only use scope to search a specific subdirectory. DO NOT USE scope if you want to search the current working directory (initial search)."
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["auto", "symbol", "content", "regex", "callers"],
                        "default": "auto",
                        "description": "Search type. auto resolves only to symbol, slash-regex, or literal content."
                    },
                    "case": {
                        "type": "string",
                        "enum": ["smart", "sensitive", "insensitive"],
                        "default": "smart"
                    },
                    "visibility": {
                        "type": "string",
                        "enum": ["project", "all"],
                        "default": "project"
                    },
                    "expand": {
                        "type": "number",
                        "default": 2,
                        "description": "Number of top matches to expand with full source code. Definitions show the full function/class body. Usages show ±10 context lines."
                    },
                    "context": {
                        "type": "string",
                        "description": "Path to the file the agent is currently editing. Boosts ranking of matches in the same directory or package."
                    },
                    "budget": {
                        "type": "number",
                        "description": "Max tokens in response."
                    },
                    "glob": {
                        "oneOf": [
                            { "type": "string" },
                            { "type": "array", "items": { "type": "string" }, "maxItems": 20 }
                        ],
                        "description": "At most 20 include/exclude patterns. Includes OR; ! exclusions subtract."
                    },
                    "root": {
                        "type": "string",
                        "description": "Absolute project root; anchors relative paths and scopes. Required with any relative path/scope."
                    }
                }
            }
        }),
        serde_json::json!({
            "name": "pi_nav_read",
            "annotations": { "readOnlyHint": true },
            "description": read_desc,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute or relative file path to read. A relative path requires an absolute `root`; the server cannot see your shell cwd."
                    },
                    "paths": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Multiple file paths to read in one call. Each file gets independent smart handling. Saves round-trips vs multiple single reads."
                    },
                    "section": {
                        "type": "string",
                        "description": "Line range e.g. '45-89', or heading e.g. '## Architecture'. Bypasses smart view. Use `sections` for multiple ranges."
                    },
                    "sections": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Multiple ranges from the same file in one call. Each entry is a line range or heading. Emits each block in user-supplied order, separated by `─── lines X-Y ───` delimiters. Mutually exclusive with `section`. Capped at 20 ranges."
                    },
                    "full": {
                        "type": "boolean",
                        "default": false,
                        "description": "Legacy alias for mode='full'. Force full content output, bypass smart outlining."
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["auto", "full", "signature", "stripped"],
                        "default": "auto",
                        "description": "Read view. auto: smart default. full: full content. signature: hash-prefixed declarations only. stripped: whole-file content with plain comments/debug logs/extra blanks removed."
                    },
                    "budget": {
                        "type": "number",
                        "description": "Max tokens in response."
                    },
                    "root": {
                        "type": "string",
                        "description": "Absolute project root; anchors relative paths and scopes. Required with any relative path/scope."
                    }
                }
            }
        }),
        serde_json::json!({
            "name": "pi_nav_files",
            "annotations": { "readOnlyHint": true },
            "description": "Find files matching a glob pattern. Replaces find/ls/pwd and the host Glob tool — use this for all file discovery. Returns matched file paths sorted by relevance with token size estimates. Use `patterns` to run several globs in one call.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Glob pattern e.g. '*' (list directory), '*.rs', 'src/**/*.ts'. Use `patterns` for multiple globs."
                    },
                    "patterns": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Multiple glob patterns to run in one call against the same scope. Each pattern emits its own `# Glob: ...` block, separated by a blank line. Mutually exclusive with `pattern`. Capped at 20."
                    },
                    "scope": {
                        "type": "string",
                        "description": "Only use scope to list a specific subdirectory. DO NOT USE scope if you want to list the current working directory."
                    },
                    "type": {
                        "type": "string",
                        "enum": ["any", "file", "directory"],
                        "default": "any"
                    },
                    "visibility": {
                        "type": "string",
                        "enum": ["project", "all"],
                        "default": "project"
                    },
                    "sort": {
                        "type": "string",
                        "enum": ["mtime", "path"],
                        "default": "mtime"
                    },
                    "budget": {
                        "type": "number",
                        "description": "Max tokens in response."
                    },
                    "root": {
                        "type": "string",
                        "description": "Absolute project root; anchors relative paths and scopes. Required with any relative path/scope."
                    }
                }
            }
        }),
        serde_json::json!({
            "name": "pi_nav_deps",
            "annotations": { "readOnlyHint": true },
            "description": "Blast-radius check before breaking changes. Shows what a file imports (local + external) and what other files call its exports, with symbol-level detail. Use ONLY when your planned edit changes a function signature, removes/renames an export, or modifies behavior that callers rely on. Do NOT use for reading files, adding new code, or internal-only changes — use pi_nav_read instead.",
            "inputSchema": {
                "type": "object",
                "required": ["path"],
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File to check before making breaking changes."
                    },
                    "scope": {
                        "type": "string",
                        "description": "Directory to search for dependents. Default: project root."
                    },
                    "budget": {
                        "type": "number",
                        "description": "Max tokens. Truncates 'Used by' first."
                    },
                    "root": {
                        "type": "string",
                        "description": "Absolute project root; anchors relative paths and scopes. Required with any relative path/scope."
                    }
                }
            }
        }),
        serde_json::json!({
            "name": "pi_nav_grok",
            "annotations": { "readOnlyHint": true },
            "description": "Get everything structural about a symbol in one call — definition, body, signature, doc, callees, callers, siblings, tests. Use ONLY for 'understand this symbol' questions. Do NOT use for concept search (use pi_nav_search) or reading file contents (use pi_nav_read).",
            "inputSchema": {
                "type": "object",
                "required": ["target"],
                "properties": {
                    "target": {
                        "type": "string",
                        "description": "Symbol name, e.g. 'parse_unified_diff'. Also accepts 'src/diff/parse.rs:7' or 'Type::method'."
                    },
                    "scope": {
                        "type": "string",
                        "description": "Subdirectory to narrow the search. Default: project root."
                    },
                    "full": {
                        "type": "boolean",
                        "default": false,
                        "description": "Widen caps: 50 callers, 30 callees, 30 siblings, 30 tests (default 5/5/8/8)."
                    },
                    "root": {
                        "type": "string",
                        "description": "Absolute project root; anchors relative paths and scopes. Required with any relative path/scope."
                    }
                }
            }
        }),
        serde_json::json!({
            "name": "pi_nav_diff",
            "annotations": { "readOnlyHint": true },
            "description": "Structural diff showing function-level changes. Replaces git diff. Call with no args for uncommitted changes overview.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "source": {
                        "type": "string",
                        "description": "Diff source: 'uncommitted' (default), 'staged', or a git ref (e.g. 'HEAD~1', 'main..feat'). Ignored when a, b, patch, or log is set."
                    },
                    "scope": {
                        "type": "string",
                        "description": "Restrict diff output to a specific file or directory path."
                    },
                    "a": {
                        "type": "string",
                        "description": "First file for a file-to-file diff. Must be used together with b."
                    },
                    "b": {
                        "type": "string",
                        "description": "Second file for a file-to-file diff. Must be used together with a."
                    },
                    "patch": {
                        "type": "string",
                        "description": "Path to a .patch file to parse instead of running git diff."
                    },
                    "log": {
                        "type": "string",
                        "description": "Git log range (e.g. 'HEAD~5..HEAD') — shows per-commit structural summaries."
                    },
                    "search": {
                        "type": "string",
                        "description": "Filter output to symbols or files matching this substring (case-insensitive)."
                    },
                    "blast": {
                        "type": "boolean",
                        "default": false,
                        "description": "Show blast-radius warnings for signature-changed symbols."
                    },
                    "expand": {
                        "type": "number",
                        "default": 0,
                        "description": "Number of changed symbols to expand with full source context."
                    },
                    "budget": {
                        "type": "number",
                        "description": "Max tokens in response."
                    }
                }
            }
        }),
        serde_json::json!({
            "name": "pi_nav_savings",
            "annotations": { "readOnlyHint": true },
            "description": "Report tokens pi-nav saved this session vs naive grep/cat (conservative lower bound). Call ONLY when the user explicitly asks how much pi-nav saved — never proactively.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }),
        serde_json::json!({
            "name": "pi_nav_session",
            "annotations": { "readOnlyHint": true },
            "description": "Reset or report the native session state. Reset before an operation when prior shown-content state must not outlive the model context.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["reset", "stats"],
                        "default": "stats",
                        "description": "reset clears session state; stats reports the current state."
                    }
                }
            }
        }),
        serde_json::json!({
            "name": "pi_nav_ls",
            "annotations": { "readOnlyHint": true },
            "description": "List one directory or a bounded filesystem tree.",
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string" }, "view": { "type": "string", "enum": ["list", "tree"], "default": "list" },
                "depth": { "type": "integer", "minimum": 1, "maximum": 8 }, "glob": { "type": "string" }, "visibility": { "type": "string", "enum": ["project", "all"], "default": "project" },
                "sort": { "type": "string", "enum": ["mtime", "path"] }, "budget": { "type": "number" }, "root": { "type": "string" }
            } }
        }),
        serde_json::json!({
            "name": "pi_nav_map",
            "annotations": { "readOnlyHint": true },
            "description": "Generate a bounded structural codebase map.",
            "inputSchema": { "type": "object", "properties": { "scope": { "type": "string" }, "depth": { "type": "integer", "minimum": 1, "maximum": 8, "default": 3 }, "budget": { "type": "number" }, "root": { "type": "string" } } }
        }),
        serde_json::json!({
            "name": "pi_nav_overview",
            "annotations": { "readOnlyHint": true },
            "description": "Summarize the current project root.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
    ];

    if edit_mode {
        tools.push(serde_json::json!({
            "name": "pi_nav_write",
            "annotations": { "readOnlyHint": false },
            "description": "Batch write one or more files in one call. Replaces the host Edit and Write tools — DO NOT use those. Three per-file modes: `hash` (default — replace lines at hash anchors from pi_nav_read), `overwrite` (whole file; create-only by default — pass `overwrite: true` to replace an existing file), `append` (append `content`, creates if absent). overwrite/append responses echo the file's hashlines so you can chain anchored edits in the next call without re-reading. ALWAYS group writes to multiple files into a single pi_nav_write call — never call pi_nav_write twice in a row. Each file is processed independently (best-effort): a failure on one file does not block the others; results are reported per file. Partial success returns isError: false — scan the per-file `## <path>` sections for failures rather than trusting the top-level status. A parse error on one edit invalidates ALL edits for that file (none applied); retry the whole file after fixing the malformed entry. Each file path may appear at most once per call. Max 20 files per call. Example overwrite (new file): `pi_nav_write(files: [{path: \"src/new.rs\", mode: \"overwrite\", content: \"fn main(){}\\n\"}])`.",
            "inputSchema": {
                "type": "object",
                "required": ["files"],
                "properties": {
                    "files": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 20,
                        "description": "One entry per file. Use a single-element array for a single-file write. Each path must be unique within the call.",
                        "items": {
                            "type": "object",
                            "required": ["path"],
                            "properties": {
                                "path": {
                                    "type": "string",
                                    "description": "Absolute or relative file path. A relative path requires an absolute `root`; the server cannot see your shell cwd."
                                },
                                "mode": {
                                    "type": "string",
                                    "enum": ["hash", "h", "overwrite", "w", "append", "a"],
                                    "default": "hash",
                                    "description": "Write mode. hash (default): replace lines at hash anchors via `edits`. overwrite: write whole file from `content`; create-only by default — set `overwrite: true` to replace existing. append: append `content`, creates if absent."
                                },
                                "edits": {
                                    "type": "array",
                                    "minItems": 1,
                                    "description": "Hash-mode only: edit operations for this file, applied atomically per file.",
                                    "items": {
                                        "type": "object",
                                        "required": ["start", "content"],
                                        "properties": {
                                            "start": {
                                                "type": "string",
                                                "description": "Start anchor: 'line:hash' (e.g. '42:a3f'). Hash from pi_nav_read hashline output."
                                            },
                                            "end": {
                                                "type": "string",
                                                "description": "End anchor: 'line:hash'. If omitted, replaces only the start line."
                                            },
                                            "content": {
                                                "type": "string",
                                                "description": "Replacement text (can be multi-line). Empty string to delete the line(s)."
                                            }
                                        }
                                    }
                                },
                                "content": {
                                    "type": "string",
                                    "description": "overwrite / append mode only: the file contents (overwrite) or text to append (append)."
                                },
                                "overwrite": {
                                    "type": "boolean",
                                    "default": false,
                                    "description": "overwrite mode only: when true, replace an existing file. Default false fails with `AlreadyExists` so you don't clobber by accident."
                                }
                            },
                            "allOf": [
                                {
                                    "if": {"properties": {"mode": {"enum": ["hash", "h"]}}},
                                    "then": {"required": ["edits"]}
                                },
                                {
                                    "if": {
                                        "required": ["mode"],
                                        "properties": {
                                            "mode": {"enum": ["overwrite", "w", "append", "a"]}
                                        }
                                    },
                                    "then": {"required": ["content"]}
                                }
                            ]
                        }
                    },
                    "diff": {
                        "type": "boolean",
                        "default": false,
                        "description": "Set true to include a compact diff of changes in the response per file."
                    },
                    "root": {
                        "type": "string",
                        "description": "Optional absolute path. When provided, every RELATIVE file path in this call is anchored under `root` instead of the server's process cwd. Absolute file paths are used as-is. Use this when the server was launched from a different directory than the worktree you are editing."
                    }
                }
            }
        }));
    }

    for tool in &mut tools {
        tool["outputSchema"] = crate::output::output_schema();
    }

    tools
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_nav_write_schema_requires_mode_specific_fields() {
        let tools = tool_definitions(true);
        let write = tools
            .iter()
            .find(|t| t.get("name").and_then(|v| v.as_str()) == Some("pi_nav_write"))
            .expect("pi_nav_write tool definition present in edit mode");
        let items = &write["inputSchema"]["properties"]["files"]["items"];
        let all_of = items["allOf"]
            .as_array()
            .expect("items.allOf clauses present");
        assert_eq!(all_of.len(), 2, "expected hash-branch + content-branch");
        // Hash branch: when mode absent or in {hash, h}, require edits.
        assert_eq!(all_of[0]["then"]["required"][0], "edits");
        // Content branch: when mode in {overwrite, w, append, a}, require content.
        assert_eq!(all_of[1]["then"]["required"][0], "content");
        let content_modes = all_of[1]["if"]["properties"]["mode"]["enum"]
            .as_array()
            .expect("content-mode enum present");
        let modes: Vec<&str> = content_modes.iter().filter_map(|v| v.as_str()).collect();
        assert!(modes.contains(&"overwrite") && modes.contains(&"append"));
    }

    #[test]
    fn edit_mode_exposes_pi_nav_write_not_pi_nav_edit() {
        let tools = tool_definitions(true);
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|t| t.get("name").and_then(|v| v.as_str()))
            .collect();
        assert!(
            names.contains(&"pi_nav_write"),
            "pi_nav_write must be exposed"
        );
        assert!(
            !names.contains(&"pi_nav_edit"),
            "pi_nav_edit must be renamed away"
        );
    }
}
