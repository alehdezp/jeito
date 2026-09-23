#!/usr/bin/env python3
"""
Compare old tilth (built-in tools) vs new tilth (MCP-only) exploration patterns.
"""

import json
import os
from pathlib import Path
from typing import Dict, List

def parse_jsonl(file_path: str) -> List[Dict]:
    """Parse JSONL file and return list of run results."""
    results = []
    with open(file_path, 'r') as f:
        for line in f:
            line = line.strip()
            if line:
                results.append(json.loads(line))
    return results

def main():
    # Override with PI_NAV_BENCH_RESULTS_DIR env var. Default: benchmark/results
    # relative to this file, so the script works from any clone.
    results_dir = Path(
        os.environ.get("PI_NAV_BENCH_RESULTS_DIR", str(Path(__file__).parent / "results"))
    )

    old_file = results_dir / "benchmark_20260213_131246.jsonl"
    new_file = results_dir / "benchmark_20260213_135039.jsonl"

    old_runs = parse_jsonl(str(old_file))
    new_runs = parse_jsonl(str(new_file))

    # Filter to valid runs only
    old_runs = [r for r in old_runs if 'error' not in r]
    new_runs = [r for r in new_runs if 'error' not in r]

    print("="*80)
    print("OLD TILTH (with built-in tools) vs NEW TILTH (MCP-only)")
    print("="*80)

    print(f"\nOld file: {old_file.name}")
    print(f"New file: {new_file.name}")

    # Group by task and mode
    def group_by_task_mode(runs):
        groups = {}
        for r in runs:
            key = (r['task'], r['mode'])
            if key not in groups:
                groups[key] = []
            groups[key].append(r)
        return groups

    old_groups = group_by_task_mode(old_runs)
    new_groups = group_by_task_mode(new_runs)

    # Compare pi-nav runs only.
    print("\n" + "="*80)
    print("PI-NAV MODE COMPARISON")
    print("="*80)

    all_tasks = sorted(set(k[0] for k in old_groups.keys() if k[1] == 'pi_nav'))

    for task in all_tasks:
        old_pi_nav = old_groups.get((task, 'pi_nav'), [])
        new_pi_nav = new_groups.get((task, 'pi_nav'), [])
        if old_pi_nav and new_pi_nav:
            print(f"\n{'='*80}\nTask: {task}\n{'='*80}")
            for old, new in zip(old_pi_nav, new_pi_nav):
                print(f"\nOLD: {old.get('pi_nav_version', 'unknown')}")
                print(f"  Turns: {old['num_turns']}, Tool calls: {old['num_tool_calls']}, Correct: {old['correct']}")
                print(f"\nNEW: {new.get('pi_nav_version', 'unknown')}")
                print(f"  Turns: {new['num_turns']}, Tool calls: {new['num_tool_calls']}, Correct: {new['correct']}")

    print("\n" + "="*80)
    print("SUMMARY STATISTICS")
    print("="*80)
    old_runs = [r for r in old_runs if r['mode'] == 'pi_nav' and r['model'] == 'sonnet']
    new_runs = [r for r in new_runs if r['mode'] == 'pi_nav' and r['model'] == 'sonnet']

    def avg(runs, key):
        values = [r[key] for r in runs if key in r]
        return sum(values) / len(values) if values else 0

    for key, label in [('num_turns', 'Avg turns'), ('num_tool_calls', 'Avg tool calls')]:
        old_avg, new_avg = avg(old_runs, key), avg(new_runs, key)
        print(f"{label:<30} {old_avg:>20.2f} {new_avg:>20.2f} {new_avg - old_avg:>15.2f}")

    def count_tools(runs):
        counts = {}
        for run in runs:
            for tool, count in run.get('tool_calls', {}).items():
                counts[tool] = counts.get(tool, 0) + count
        return counts

    old_tools, new_tools = count_tools(old_runs), count_tools(new_runs)

    all_tools = sorted(set(list(old_tools.keys()) + list(new_tools.keys())))

    print(f"\n{'Tool':<40} {'Old':>15} {'New':>15} {'Delta':>15}")
    print("-" * 90)

    for tool in all_tools:
        old_count = old_tools.get(tool, 0)
        new_count = new_tools.get(tool, 0)
        delta = new_count - old_count
        print(f"{tool:<40} {old_count:>15} {new_count:>15} {delta:>15}")

if __name__ == "__main__":
    main()
