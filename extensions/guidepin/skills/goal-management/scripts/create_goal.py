#!/usr/bin/env python3
"""Scaffold a new goal from owned templates; never overwrite or select one."""
import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

FILES = {
    "goal.md": (
        "Current intent",
        "Shared intent, material uncertainty, success and authority",
    ),
    "work.md": (
        "Remaining work",
        "Open intent branches and unresolved possibilities",
    ),
    "decisions.md": (
        "Decision rationale",
        "Consequential choices, reasons and reconsideration conditions",
    ),
}


def main():
    parser = argparse.ArgumentParser(
        description="Create a new goal folder without overwriting existing work."
    )
    parser.add_argument("slug", help="Lowercase hyphenated goal name")
    parser.add_argument("--title", help="Human-readable goal title")
    parser.add_argument("--project", type=Path, default=Path("."))
    args = parser.parse_args()

    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", args.slug):
        parser.error("slug must contain lowercase words or numbers joined by hyphens")

    title = args.title if args.title is not None else args.slug.replace("-", " ").capitalize()
    if not title.strip() or title.splitlines() != [title]:
        parser.error("title must be a nonempty single line")
    title = title.strip()

    templates = Path(__file__).resolve().parent.parent / "templates"
    now = datetime.now(timezone.utc)
    today = now.date().isoformat()
    updated = now.strftime("%Y-%m-%d %HZ")

    try:
        project = args.project.resolve(strict=True)
        if not project.is_dir():
            parser.error("--project must be an existing directory")

        for parent in (project / ".pi", project / ".pi" / "goals"):
            if parent.is_symlink():
                parser.error(f"refusing to write through symlink: {parent}")

        destination = project / ".pi" / "goals" / args.slug
        rendered = {}

        # Read every template before creating the destination.
        for filename, (label, ownership) in FILES.items():
            body = (templates / filename).read_text(encoding="utf-8")
            heading = f"{title} — {label}"
            rendered[filename] = (
                "---\n"
                f"title: {json.dumps(heading, ensure_ascii=False)}\n"
                f"description: {json.dumps(ownership)}\n"
                "tags: [goal, intent]\n"
                f"created: {today}\n"
                f"updated: {json.dumps(updated)}\n"
                "status: draft\n"
                f"owns: {json.dumps(ownership)}\n"
                "---\n\n"
                f"# {heading}\n\n{body.rstrip()}\n"
            )

        # No --force, replacement, merging, or automatic repair.
        destination.mkdir(parents=True, exist_ok=False)
        for filename, content in rendered.items():
            with (destination / filename).open("x", encoding="utf-8") as output:
                output.write(content)

    except (OSError, UnicodeError) as error:
        parser.exit(
            1,
            f"Could not create goal: {error}\n"
            "Existing files were not overwritten. If creation started, "
            "inspect the incomplete folder before continuing.\n",
        )

    print(destination)
    print("Draft created. Fill current understanding before relying on it.")


if __name__ == "__main__":
    main()
