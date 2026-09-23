#!/usr/bin/env python3
"""
Benchmark analysis and report generation.

Reads JSONL results from run.py and generates a markdown report
with context efficiency metrics and comparisons.
"""

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from statistics import median, mean, stdev


# Anthropic Claude pricing (per million tokens)
PRICING = {
    "cache_creation": 3.75,  # $3.75 per MTok
    "cache_read": 0.30,      # $0.30 per MTok
    "output": 15.00,         # $15.00 per MTok
    "input": 3.00,           # $3.00 per MTok
}


def compute_cost_breakdown(run: dict) -> dict[str, float]:
    """Compute cost breakdown by token category."""
    return {
        "cache_creation_cost": run.get("cache_creation_tokens", 0) * PRICING["cache_creation"] / 1_000_000,
        "cache_read_cost": run.get("cache_read_tokens", 0) * PRICING["cache_read"] / 1_000_000,
        "output_cost": run.get("output_tokens", 0) * PRICING["output"] / 1_000_000,
        "input_cost": run.get("input_tokens", 0) * PRICING["input"] / 1_000_000,
    }


def format_cost_breakdown(costs: dict[str, float], indent: str = "  ") -> str:
    """Format cost breakdown as single line."""
    parts = [
        f"cache_create=${costs['cache_creation_cost']:.3f}",
        f"cache_read=${costs['cache_read_cost']:.3f}",
        f"output=${costs['output_cost']:.3f}",
        f"input=${costs['input_cost']:.3f}",
    ]
    return f"{indent}{' '.join(parts)}"


def format_cost_delta(baseline_costs: dict[str, float], pi_nav_costs: dict[str, float], indent: str = "  ") -> str:
    """Format cost delta breakdown."""
    deltas = {
        key: pi_nav_costs[f'{key}_cost'] - baseline_costs[f'{key}_cost']
        for key in ('cache_creation', 'cache_read', 'output', 'input')
    }
    return indent + ' '.join(
        f"Δ{key}={'+' if value >= 0 else ''}${value:.3f}" for key, value in deltas.items()
    )


def load_results(path: Path) -> list[dict]:
    """Load JSONL results file."""
    results = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                results.append(json.loads(line))
    return results


def group_by(results: list[dict], *keys: str) -> dict:
    """Group results by specified keys."""
    groups = defaultdict(list)
    for result in results:
        # Skip error entries that don't have all required fields
        if "error" in result:
            continue
        key = tuple(result.get(k) for k in keys)
        groups[key].append(result)
    return dict(groups)


def compute_stats(values: list) -> dict:
    """Compute statistics for a list of values."""
    if not values:
        return {
            "median": 0,
            "mean": 0,
            "stdev": 0,
            "min": 0,
            "max": 0,
        }

    return {
        "median": median(values),
        "mean": mean(values),
        "stdev": stdev(values) if len(values) > 1 else 0,
        "min": min(values),
        "max": max(values),
    }


def ascii_sparkline(values: list[int]) -> str:
    """Generate ASCII sparkline from values."""
    if not values:
        return ""

    if max(values) == min(values):
        return "▄" * len(values)

    chars = " ▁▂▃▄▅▆▇█"
    lo, hi = min(values), max(values)
    return "".join(
        chars[min(int((v - lo) / (hi - lo) * 8), 8)]
        for v in values
    )


def format_delta(baseline_val: float, pi_nav_val: float) -> str:
    """Format delta as percentage change."""
    if baseline_val == 0:
        return "—"
    pct_change = ((pi_nav_val - baseline_val) / baseline_val) * 100
    sign = "+" if pct_change > 0 else ""
    return f"{sign}{pct_change:.0f}%"


def find_median_run(runs: list[dict], metric: str) -> dict:
    """Find the run with median value for given metric."""
    if not runs:
        return {}
    sorted_runs = sorted(runs, key=lambda r: r.get(metric, 0))
    return sorted_runs[len(sorted_runs) // 2]


def merge_tool_calls(runs: list[dict]) -> dict[str, float]:
    """Merge tool_calls dicts from multiple runs and compute median counts."""
    # Collect all tool names
    all_tools = set()
    for run in runs:
        if "tool_calls" in run:
            all_tools.update(run["tool_calls"].keys())

    # Compute median count for each tool
    result = {}
    for tool in all_tools:
        counts = [run.get("tool_calls", {}).get(tool, 0) for run in runs]
        result[tool] = median(counts)

    return result


def generate_report(results: list[dict]) -> str:
    """Generate markdown report from results."""
    if not results:
        return "# Error\n\nNo valid results found in file.\n"

    # Filter out error entries
    valid_results = [r for r in results if "error" not in r]
    error_count = len(results) - len(valid_results)

    if not valid_results:
        return f"# Error\n\nAll {len(results)} runs failed.\n"

    # Extract metadata
    models = sorted(set(r["model"] for r in valid_results))
    tasks = sorted(set(r["task"] for r in valid_results))
    modes = sorted(set(r["mode"] for r in valid_results))
    repos = sorted(set(r.get("repo", "synthetic") for r in valid_results))
    max_rep = max(r["repetition"] for r in valid_results)
    num_reps = max_rep + 1

    # Build header
    lines = [
        "# pi-nav Benchmark Results",
        "",
        f"**Generated:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        f"**Runs:** {len(valid_results)} valid",
    ]

    if error_count > 0:
        lines.append(f" ({error_count} errors)")

    lines.extend([
        f" | **Models:** {', '.join(models)} | **Repos:** {', '.join(repos)} | **Reps:** {num_reps}",
        "",
        "## Context Efficiency",
        "",
        "The primary metric. Context tokens (input + cached) represent the actual context processed each turn. This compounds because each turn re-sends conversation history.",
        "",
        "### Per-task comparison",
        "",
    ])

    # Group by task
    task_groups = group_by(valid_results, "task")

    for task_name in tasks:
        task_results = task_groups.get((task_name,), [])
        if not task_results:
            continue

        lines.append(f"#### {task_name}")
        lines.append("")

        # Show repo for the task
        task_repo = task_results[0].get("repo", "synthetic") if task_results else "synthetic"
        if task_repo != "synthetic":
            lines.append(f"*Repo: {task_repo}*")
            lines.append("")

        # Group by mode
        mode_groups = group_by(task_results, "mode")

        # Check if we have both baseline and pi-nav.
        has_baseline = ("baseline",) in mode_groups
        has_pi_nav = ("pi_nav",) in mode_groups

        if has_baseline and has_pi_nav:
            baseline_runs = mode_groups[("baseline",)]
            pi_nav_runs = mode_groups[("pi_nav",)]
            metrics = [
                ("Context tokens", "context_tokens"),
                ("Output tokens", "output_tokens"),
                ("Turns", "num_turns"),
                ("Tool calls", "num_tool_calls"),
                ("Cost USD", "total_cost_usd"),
                ("Duration ms", "duration_ms"),
            ]
            lines.append("| Metric | baseline | pi-nav | delta |")
            lines.append("|--------|----------|--------|-------|")
            for label, key in metrics:
                baseline_stats = compute_stats([r[key] for r in baseline_runs])
                pi_nav_stats = compute_stats([r[key] for r in pi_nav_runs])
                delta = format_delta(baseline_stats["median"], pi_nav_stats["median"])
                if key == "total_cost_usd":
                    baseline_fmt = f"${baseline_stats['median']:.4f}"
                    pi_nav_fmt = f"${pi_nav_stats['median']:.4f}"
                else:
                    baseline_fmt = f"{baseline_stats['median']:.0f}"
                    pi_nav_fmt = f"{pi_nav_stats['median']:.0f}"
                lines.append(f"| {label} (median) | {baseline_fmt} | {pi_nav_fmt} | {delta} |")

            baseline_correct = sum(1 for r in baseline_runs if r["correct"])
            pi_nav_correct = sum(1 for r in pi_nav_runs if r["correct"])
            baseline_pct = (baseline_correct / len(baseline_runs)) * 100
            pi_nav_pct = (pi_nav_correct / len(pi_nav_runs)) * 100

            lines.append(f"| Correctness | {baseline_pct:.0f}% | {pi_nav_pct:.0f}% | — |")
            lines.append("")

            baseline_median_run_cost = find_median_run(baseline_runs, "total_cost_usd")
            pi_nav_median_run_cost = find_median_run(pi_nav_runs, "total_cost_usd")
            baseline_costs = compute_cost_breakdown(baseline_median_run_cost)
            pi_nav_costs = compute_cost_breakdown(pi_nav_median_run_cost)
            baseline_total = baseline_median_run_cost.get("total_cost_usd", 0.0)
            pi_nav_total = pi_nav_median_run_cost.get("total_cost_usd", 0.0)
            baseline_turns = baseline_median_run_cost.get("num_turns", 0)
            pi_nav_turns = pi_nav_median_run_cost.get("num_turns", 0)
            lines.append("**Cost breakdown (median run):**")
            lines.append(f"  baseline: {baseline_turns} turns, ${baseline_total:.2f}")
            lines.append(format_cost_breakdown(baseline_costs))
            lines.append(f"  pi-nav:    {pi_nav_turns} turns, ${pi_nav_total:.2f}")
            lines.append(format_cost_breakdown(pi_nav_costs))
            lines.append(format_cost_delta(baseline_costs, pi_nav_costs))
            lines.append("")

            baseline_per_turn = find_median_run(baseline_runs, "context_tokens").get("per_turn_context_tokens", [])
            pi_nav_per_turn = find_median_run(pi_nav_runs, "context_tokens").get("per_turn_context_tokens", [])
            if baseline_per_turn and pi_nav_per_turn:
                lines.append("**Per-turn context tokens (median run):**")
                lines.append(f"  baseline: {ascii_sparkline(baseline_per_turn)}")
                lines.append(f"  pi-nav:    {ascii_sparkline(pi_nav_per_turn)}")
                lines.append("")

            baseline_tools = merge_tool_calls(baseline_runs)
            pi_nav_tools = merge_tool_calls(pi_nav_runs)
            if baseline_tools or pi_nav_tools:
                lines.append("**Tool breakdown (median counts):**")
                if baseline_tools:
                    lines.append(f"  baseline: {', '.join(f'{name}={count:.0f}' for name, count in baseline_tools.items())}")
                if pi_nav_tools:
                    lines.append(f"  pi-nav:    {', '.join(f'{name}={count:.0f}' for name, count in pi_nav_tools.items())}")
                lines.append("")
                lines.append("")

        else:
            # Only one mode available
            for mode_name in modes:
                mode_results = mode_groups.get((mode_name,), [])
                if not mode_results:
                    continue

                lines.append(f"**Mode: {mode_name}**")
                lines.append("")
                lines.append("| Metric | Median |")
                lines.append("|--------|--------|")

                metrics = [
                    ("Context tokens", "context_tokens"),
                    ("Output tokens", "output_tokens"),
                    ("Turns", "num_turns"),
                    ("Tool calls", "num_tool_calls"),
                    ("Cost USD", "total_cost_usd"),
                    ("Duration ms", "duration_ms"),
                ]

                for label, key in metrics:
                    stats = compute_stats([r[key] for r in mode_results])
                    if key == "total_cost_usd":
                        val_fmt = f"${stats['median']:.4f}"
                    else:
                        val_fmt = f"{stats['median']:.0f}"
                    lines.append(f"| {label} | {val_fmt} |")

                correct = sum(1 for r in mode_results if r["correct"])
                pct = (correct / len(mode_results)) * 100
                lines.append(f"| Correctness | {pct:.0f}% |")
                lines.append("")

        lines.append("")

    # Summary section (only if we have both modes)
    baseline_all = [r for r in valid_results if r["mode"] == "baseline"]
    pi_nav_all = [r for r in valid_results if r["mode"] == "pi_nav"]
    if baseline_all and pi_nav_all:
        lines.extend(["## Summary", "", "| Metric | baseline | pi-nav | Improvement |", "|--------|----------|--------|-------------|"])
        for label, key in [("Context tokens", "context_tokens"), ("Turns", "num_turns"), ("Tool calls", "num_tool_calls"), ("Cost USD", "total_cost_usd")]:
            baseline_groups = group_by(baseline_all, "task")
            pi_nav_groups = group_by(pi_nav_all, "task")
            baseline_values = [compute_stats([r[key] for r in runs])["median"] for runs in baseline_groups.values()]
            pi_nav_values = [compute_stats([r[key] for r in runs])["median"] for runs in pi_nav_groups.values()]
            if baseline_values and pi_nav_values:
                baseline_value = median(baseline_values)
                pi_nav_value = median(pi_nav_values)
                if key == "total_cost_usd":
                    baseline_fmt, pi_nav_fmt = f"${baseline_value:.4f}", f"${pi_nav_value:.4f}"
                else:
                    baseline_fmt, pi_nav_fmt = f"{baseline_value:.0f}", f"{pi_nav_value:.0f}"
                lines.append(f"| {label} | {baseline_fmt} | {pi_nav_fmt} | {format_delta(baseline_value, pi_nav_value)} |")
        lines.append("")

        lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Analyze benchmark results and generate report",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python analyze.py results/benchmark_20260212_150000.jsonl
  python analyze.py results/benchmark_20260212_150000.jsonl -o report.md
        """,
    )

    parser.add_argument(
        "results_file",
        type=Path,
        help="Path to JSONL results file from run.py",
    )
    parser.add_argument(
        "-o", "--output",
        type=Path,
        help="Output path for markdown report (default: print to stdout)",
    )

    args = parser.parse_args()

    # Validate input file
    if not args.results_file.exists():
        print(f"ERROR: File not found: {args.results_file}", file=sys.stderr)
        sys.exit(1)

    # Load and analyze
    try:
        results = load_results(args.results_file)
    except Exception as e:
        print(f"ERROR: Failed to load results: {e}", file=sys.stderr)
        sys.exit(1)

    report = generate_report(results)

    # Output
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report)
        print(f"Report written to: {args.output}")
    else:
        print(report)


if __name__ == "__main__":
    main()
