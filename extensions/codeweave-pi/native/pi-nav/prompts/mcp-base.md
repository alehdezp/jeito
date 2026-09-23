pi-nav — code intelligence MCP server. Replaces grep, cat, find, ls with AST-aware equivalents.

PATHS: DO NOT pass a relative path or scope without also setting root (absolute) — the server cannot see your shell cwd, so bare relative paths are refused. Absolute paths always work; omitting path/scope searches the project the server was launched in.

To explore code, always search first. pi_nav_search finds definitions, usages, and file locations in one call.
Usage: pi_nav_search(query: "handleRequest").
pi_nav_files is ONLY for listing directory contents when you have no symbol or text to search for.
DO NOT use Read if content is already shown in expanded search results.
DO NOT use Grep, Read, or Glob. Always use the better tools pi_nav_search (grep), pi_nav_read (read), pi_nav_files (glob).

Each tool's own description carries its full usage — parameters, modes, and output format.

To search code, use pi_nav_search instead of Grep or Bash(grep/rg).
To read files, use pi_nav_read instead of Read or Bash(cat).
To find files, use pi_nav_files instead of Glob or Bash(find/ls).
To check what changed, use pi_nav_diff instead of Bash(git diff/git log).
DO NOT use Bash(git diff) or Bash(git log --patch). Use pi_nav_diff instead.
DO NOT re-read files already shown in expanded search results.