from app.scanners import lizard_scan


def test_flags_duplicate_function_bodies(fixture_repo):
    findings = lizard_scan.scan(fixture_repo)
    duplicates = [f for f in findings if "duplicate" in f.message.lower()]
    assert duplicates, "expected the two identical summarize_* bodies to be flagged"
    assert all(f.category == "vibe-debt" for f in duplicates)


def test_flags_high_complexity_function(fixture_repo):
    findings = lizard_scan.scan(fixture_repo)
    complex_findings = [f for f in findings if "complexity" in f.message.lower()]
    assert any("classify" in f.message for f in complex_findings)
    assert all(f.category == "vibe-debt" for f in complex_findings)


def test_all_findings_are_vibe_debt(fixture_repo):
    findings = lizard_scan.scan(fixture_repo)
    assert findings
    assert {f.category for f in findings} == {"vibe-debt"}
    assert {f.tool for f in findings} == {"lizard"}


def test_clean_code_produces_no_findings(tmp_path):
    (tmp_path / "clean.py").write_text(
        "def add(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return a * b\n"
    )
    assert lizard_scan.scan(tmp_path) == []


def test_diff_mode_scans_only_changed_files(tmp_path):
    (tmp_path / "messy.py").write_text(
        "def f(a):\n" + "".join(
            f"    if a == {i}:\n        return {i}\n" for i in range(15)
        ) + "    return None\n"
    )
    (tmp_path / "ignored.py").write_text(
        "def g(a):\n" + "".join(
            f"    if a == {i}:\n        return {i}\n" for i in range(15)
        ) + "    return None\n"
    )
    findings = lizard_scan.scan(tmp_path, files=["messy.py"])
    assert findings
    assert {f.file for f in findings} == {"messy.py"}


def test_does_not_false_positive_on_different_logic(tmp_path):
    """Verify normalization does not over-match genuinely different functions.

    Both bodies have >= 6 non-empty lines (clearing the MIN_DUPLICATE_LINES
    floor, so both are actually fingerprinted) and differ in *structure*
    (a conditional + multiply vs. two appends + a reverse), not merely in
    names, so a sane normalizer keeps them apart.
    """
    (tmp_path / "different.py").write_text(
        "def sum_data(items):\n"
        "    total = 0\n"
        "    for item in items:\n"
        "        if item['active']:\n"
        "            total += item['value']\n"
        "    total *= 2\n"
        "    return total\n"
        "\n"
        "def format_items(entries):\n"
        "    result = []\n"
        "    for entry in entries:\n"
        "        result.append(str(entry))\n"
        "        result.append('|')\n"
        "    result.reverse()\n"
        "    return result\n"
    )
    findings = lizard_scan.scan(tmp_path)
    duplicates = [f for f in findings if "duplicate" in f.message.lower()]
    assert not duplicates, "different logic should not be flagged as duplicates"


def test_does_not_collapse_different_string_literals(tmp_path):
    """Two structurally identical functions differing ONLY in string literal
    content must not be flagged as duplicates. Both bodies have 6 non-empty
    lines, clearing the MIN_DUPLICATE_LINES floor."""
    (tmp_path / "strings.py").write_text(
        "def handle_missing(record):\n"
        "    if record is None:\n"
        "        return {\"error\": \"no data found\"}\n"
        "    total = 0\n"
        "    for key in record:\n"
        "        total += 1\n"
        "    return total\n"
        "\n"
        "def handle_invalid(record):\n"
        "    if record is None:\n"
        "        return {\"error\": \"bad request sent\"}\n"
        "    total = 0\n"
        "    for key in record:\n"
        "        total += 1\n"
        "    return total\n"
    )
    findings = lizard_scan.scan(tmp_path)
    duplicates = [f for f in findings if "duplicate" in f.message.lower()]
    assert not duplicates, (
        "functions differing only in string literal content should not be "
        "flagged as duplicates"
    )


def test_markdown_is_not_parsed_as_code(tmp_path):
    # lizard's fallback C-like reader pulled a 282-line "init_db" out of a fenced
    # code block in a planning document and reported it as real.
    (tmp_path / "plan.md").write_text(
        "# Plan\n\n```python\ndef init_db():\n" + "    x = 1\n" * 80 + "```\n"
    )
    assert lizard_scan.scan(tmp_path) == []


def test_tsx_uses_the_typescript_reader(tmp_path):
    # Under the fallback reader the whole component reads as one function, so the
    # component name shows up with the line count of the entire file.
    source = (
        "export default function Widget() {\n"
        "  const handle = (n: number) => {\n"
        + "".join(f"    if (n === {i}) return {i};\n" for i in range(20))
        + "    return 0;\n  };\n"
        "  return <div onClick={() => handle(1)}>hi</div>;\n}\n"
    )
    (tmp_path / "Widget.tsx").write_text(source)
    findings = lizard_scan.scan(tmp_path)
    assert all("Widget'" not in f.message for f in findings), \
        "whole component measured as one function -> fallback parser is back"
    assert all(f.file == "Widget.tsx" for f in findings), "findings must keep the real path"


def test_unparseable_extensions_are_skipped(tmp_path):
    for name in ("data.json", "notes.txt", "styles.css", "config.yaml"):
        (tmp_path / name).write_text("{\n" + "  \"a\": 1,\n" * 80 + "}\n")
    assert lizard_scan.scan(tmp_path) == []
