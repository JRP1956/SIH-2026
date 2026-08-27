"""Measure the scanners' false-positive rate against a hand-labeled corpus.

    python -m benchmark.run           # score the corpus, exit 1 if off target
    python -m benchmark.run --dump    # print raw findings, for labeling
"""

import argparse
import json
import sys
from pathlib import Path

from app.scanners import deps_scan, gitleaks_scan, semgrep_scan
from app.scanners.base import ScannerUnavailable
from benchmark.match import SCORED_CATEGORIES, Label, match

# Only the scanners that make security claims. Lizard and drift emit categories
# this benchmark does not score, so running them would just cost time.
SCANNERS = [semgrep_scan, gitleaks_scan, deps_scan]

ROOT = Path(__file__).resolve().parent.parent
LABELS = Path(__file__).parent / "labels.json"


def _scan(repo: Path):
    findings = []
    for scanner in SCANNERS:
        # A scanner that cannot run must abort the benchmark. Skipping it would
        # silently drop both its true and false positives and report a
        # precision figure for a tool set that never ran.
        try:
            findings.extend(scanner.scan(repo, None))
        except ScannerUnavailable as exc:
            sys.exit(f"ABORT: {scanner.__name__} unavailable ({exc}). "
                     f"Install it — a partial run reports a meaningless rate.")
    return findings


def _dump(config) -> None:
    for entry in config["corpus"]:
        repo = ROOT / entry["repo"]
        print(f"\n=== {entry['repo']} ===")
        for f in sorted(_scan(repo), key=lambda f: (f.file, f.line)):
            if f.category in SCORED_CATEGORIES:
                stub = {"file": f.file, "line": f.line, "tool": f.tool,
                        "note": f.message[:60]}
                print(f"  {json.dumps(stub)},")


def _score_corpus(config) -> tuple[dict, list, list]:
    """Run the scanners over every corpus repo and tally the outcomes."""
    tolerance = config["line_tolerance"]
    totals = {"tp": 0, "fp": 0, "fn": 0, "duplicates": 0, "spurious": 0}
    rows, detail = [], []

    for entry in config["corpus"]:
        repo = ROOT / entry["repo"]
        if not repo.is_dir():
            sys.exit(f"ABORT: corpus entry {entry['repo']} does not exist")
        labels = [Label(**item) for item in entry["expected"]]
        outcome = match(_scan(repo), labels, tolerance)
        totals["tp"] += outcome.true_positives
        totals["fp"] += outcome.false_positives
        totals["fn"] += outcome.false_negatives
        totals["duplicates"] += outcome.duplicates
        totals["spurious"] += outcome.spurious
        rows.append((entry["repo"], outcome))
        detail.append({
            "repo": entry["repo"],
            "true_positives": outcome.true_positives,
            "false_positives": outcome.false_positives,
            "false_negatives": outcome.false_negatives,
            "duplicates": outcome.duplicates,
            "spurious": outcome.spurious,
            "precision": round(outcome.precision, 4),
            "recall": round(outcome.recall, 4),
            "unmatched": [f"{f.tool} {f.file}:{f.line} {f.message[:70]}"
                          for f in outcome.unmatched],
            "missed": [f"{l.file}:{l.line} {l.note}" for l in outcome.missed],
        })
    return totals, rows, detail


def _rates(totals: dict) -> dict:
    """Derive every rate the report quotes from the raw tallies."""
    reported = totals["tp"] + totals["fp"]
    real = totals["tp"] + totals["fn"]

    def share(count: int) -> float:
        return 0.0 if reported == 0 else count / reported

    return {
        "reported": reported,
        "fp_rate": share(totals["fp"]),
        "duplicate_rate": share(totals["duplicates"]),
        "spurious_rate": share(totals["spurious"]),
        "recall": 1.0 if real == 0 else totals["tp"] / real,
    }


def _print_table(totals: dict, rows: list, rates: dict) -> None:
    print(f"\n{'repo':<40} {'TP':>4} {'FP':>4} {'FN':>4} {'prec':>7}")
    print("-" * 62)
    for name, outcome in rows:
        reported_here = outcome.true_positives + outcome.false_positives
        precision_str = "n/a" if reported_here == 0 else f"{outcome.precision:.1%}"
        print(f"{name:<40} {outcome.true_positives:>4} "
              f"{outcome.false_positives:>4} {outcome.false_negatives:>4} "
              f"{precision_str:>7}")
    print("-" * 62)
    print(f"{'TOTAL':<40} {totals['tp']:>4} {totals['fp']:>4} "
          f"{totals['fn']:>4} {1 - rates['fp_rate']:>7.1%}")


def _print_report(totals: dict, rows: list, detail: list,
                  rates: dict, target: float) -> None:
    _print_table(totals, rows, rates)
    # This is the share of reported findings that were wrong (FP / (TP + FP)),
    # i.e. false discovery rate in the textbook sense — not FP / (FP + TN).
    # That's the definition scanner vendors mean by "false-positive rate" and
    # the one this benchmark measures; spelled out here since the number is
    # meant to be quoted on its own.
    print(f"\nfalse-positive rate (strict): {rates['fp_rate']:.1%}  "
          f"(share of reported findings that were wrong: "
          f"FP/(TP+FP) = {totals['fp']}/{rates['reported']}; "
          f"target <= {target:.0%}; gates pass/fail below)")
    # A split of that same FP figure into two causes, since not every FP is a
    # scanner pointing at a non-issue:
    #   duplicates — matched a real, labeled issue, but that label was already
    #                claimed by an earlier finding (the issue is real; it was
    #                just reported more than once — noise, not error).
    #   spurious   — matched no label at all, at any line, in that repo (the
    #                finding does not point at anything real).
    print(f"  of which duplicates: {totals['duplicates']} "
          f"({rates['duplicate_rate']:.1%} of reported) "
          f"— a real, already-labeled issue reported again")
    print(f"  of which spurious:   {totals['spurious']} "
          f"({rates['spurious_rate']:.1%} of reported) "
          f"— matches no labeled issue at all")
    print(f"recall:              {rates['recall']:.1%}")

    for item in detail:
        for line in item["unmatched"]:
            print(f"  FP  {item['repo']}: {line}")
        for line in item["missed"]:
            print(f"  FN  {item['repo']}: {line}")


def _write_json(path: Path, totals: dict, detail: list,
                rates: dict, target: float) -> None:
    path.write_text(json.dumps({
        "false_positive_rate": round(rates["fp_rate"], 4),
        "precision": round(1 - rates["fp_rate"], 4),
        "recall": round(rates["recall"], 4),
        "duplicate_rate": round(rates["duplicate_rate"], 4),
        "spurious_rate": round(rates["spurious_rate"], 4),
        "target_false_positive_rate": target,
        "totals": totals,
        "per_repo": detail,
    }, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", type=Path, help="write full results here")
    parser.add_argument("--dump", action="store_true",
                        help="print raw findings as label stubs, then exit")
    args = parser.parse_args()

    config = json.loads(LABELS.read_text())
    if args.dump:
        _dump(config)
        return 0

    target = config["target_false_positive_rate"]
    totals, rows, detail = _score_corpus(config)
    rates = _rates(totals)
    _print_report(totals, rows, detail, rates, target)
    if args.json:
        _write_json(args.json, totals, detail, rates, target)

    if rates["fp_rate"] > target:
        print(f"\nFAIL: {rates['fp_rate']:.1%} false positives exceeds the "
              f"{target:.0%} target")
        return 1
    print(f"\nPASS: within the {target:.0%} false-positive target")
    return 0


if __name__ == "__main__":
    sys.exit(main())
