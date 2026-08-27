import json

from app.scanners.base import RawFinding
from app import reasoning
from app.config import settings


def make(n=2):
    return [
        RawFinding(tool="semgrep", severity="high", file=f"a{i}.py", line=i,
                   message=f"issue {i}")
        for i in range(n)
    ]


class FakeOpenAI:
    def __init__(self, payload=None, error=None):
        self._payload, self._error = payload, error
        outer = self

        class Completions:
            def create(self, **kwargs):
                outer.last_kwargs = kwargs
                if outer._error:
                    raise outer._error
                message = type("M", (), {"content": json.dumps(outer._payload)})()
                choice = type("C", (), {"message": message})()
                return type("R", (), {"choices": [choice]})()

        self.chat = type("Chat", (), {"completions": Completions()})()


def test_returns_none_without_api_key(monkeypatch):
    monkeypatch.setattr(settings, "openai_api_key", "")
    assert reasoning.annotate(make()) is None


def test_annotates_each_finding(monkeypatch):
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    fake = FakeOpenAI({"annotations": [
        {"index": 0, "explanation": "Attackers run code.", "fix": "Drop eval."},
        {"index": 1, "explanation": "Shell injection.", "fix": "Pass a list."},
    ]})
    monkeypatch.setattr(reasoning, "_client", lambda: fake)

    result = reasoning.annotate(make())
    assert len(result) == 2
    assert result[0]["explanation"] == "Attackers run code."
    assert result[1]["fix"] == "Pass a list."


def test_api_error_returns_none(monkeypatch):
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    monkeypatch.setattr(reasoning, "_client", lambda: FakeOpenAI(error=RuntimeError("503")))
    assert reasoning.annotate(make()) is None


def test_missing_annotations_are_filled_with_blanks(monkeypatch):
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    fake = FakeOpenAI({"annotations": [
        {"index": 1, "explanation": "Only the second.", "fix": "Fix it."}
    ]})
    monkeypatch.setattr(reasoning, "_client", lambda: fake)

    result = reasoning.annotate(make())
    assert len(result) == 2
    assert result[0] == {"explanation": "", "fix": ""}
    assert result[1]["explanation"] == "Only the second."


def test_extra_annotations_are_discarded(monkeypatch):
    """The model must not be able to invent findings we never detected."""
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    fake = FakeOpenAI({"annotations": [
        {"index": 0, "explanation": "Real.", "fix": "Fix."},
        {"index": 1, "explanation": "Real.", "fix": "Fix."},
        {"index": 99, "explanation": "Invented.", "fix": "Nope."},
    ]})
    monkeypatch.setattr(reasoning, "_client", lambda: fake)

    result = reasoning.annotate(make())
    assert len(result) == 2
    assert all("Invented" not in r["explanation"] for r in result)


def test_empty_findings_short_circuits(monkeypatch):
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    assert reasoning.annotate([]) == []


class FakeOpenAIMultiBatch:
    """Returns different content per call so batch order/count are observable."""

    def __init__(self, payloads):
        self._payloads = payloads
        self.call_count = 0
        outer = self

        class Completions:
            def create(self, **kwargs):
                payload = outer._payloads[outer.call_count]
                outer.call_count += 1
                message = type("M", (), {"content": json.dumps(payload)})()
                choice = type("C", (), {"message": message})()
                return type("R", (), {"choices": [choice]})()

        self.chat = type("Chat", (), {"completions": Completions()})()


def test_multi_batch_alignment(monkeypatch):
    """30 findings -> two batches (25 + 5). Global indexes must land correctly."""
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    fake = FakeOpenAIMultiBatch([
        {"annotations": [{"index": 0, "explanation": "FIRST_BATCH_ZERO", "fix": "f0"}]},
        {"annotations": [{"index": 27, "explanation": "SECOND_BATCH_27", "fix": "f27"}]},
    ])
    monkeypatch.setattr(reasoning, "_client", lambda: fake)

    result = reasoning.annotate(make(30))
    assert len(result) == 30
    assert result[0]["explanation"] == "FIRST_BATCH_ZERO"
    assert result[27]["explanation"] == "SECOND_BATCH_27"
    assert fake.call_count == 2


def test_no_api_key_is_unavailable_even_with_zero_findings(monkeypatch):
    """ai_available must reflect whether the layer works, not whether it had work."""
    from app.config import settings
    from app.reasoning import annotate

    monkeypatch.setattr(settings, "openai_api_key", "")
    assert annotate([]) is None


def test_cross_batch_index_is_rejected(monkeypatch):
    """A later batch must not overwrite an earlier finding's annotation."""
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    fake = FakeOpenAIMultiBatch([
        {"annotations": [{"index": 0, "explanation": "REAL_ZERO", "fix": "f0"}]},
        {"annotations": [{"index": 0, "explanation": "HIJACKED", "fix": "bad"}]},
    ])
    monkeypatch.setattr(reasoning, "_client", lambda: fake)

    result = reasoning.annotate(make(30))
    assert result[0]["explanation"] == "REAL_ZERO"


def test_non_string_fields_are_dropped(monkeypatch):
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    fake = FakeOpenAI({"annotations": [
        {"index": 0, "explanation": {"nested": "junk"}, "fix": ["a", "b"]},
        {"index": 1, "explanation": "Fine.", "fix": None},
    ]})
    monkeypatch.setattr(reasoning, "_client", lambda: fake)

    result = reasoning.annotate(make())
    assert result[0] == {"explanation": "", "fix": ""}
    assert result[1] == {"explanation": "Fine.", "fix": ""}


def test_blank_annotation_leaves_finding_unannotated(monkeypatch):
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    fake = FakeOpenAI({"annotations": [{"index": 0, "explanation": "   ", "fix": "\n"}]})
    monkeypatch.setattr(reasoning, "_client", lambda: fake)

    assert reasoning.annotate(make())[0] == {"explanation": "", "fix": ""}


def test_oversized_text_is_truncated(monkeypatch):
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    fake = FakeOpenAI({"annotations": [
        {"index": 0, "explanation": "x" * 50_000, "fix": "y" * 50_000}
    ]})
    monkeypatch.setattr(reasoning, "_client", lambda: fake)

    result = reasoning.annotate(make())
    assert len(result[0]["explanation"]) == reasoning.MAX_TEXT
    assert len(result[0]["fix"]) == reasoning.MAX_TEXT


def test_non_dict_annotation_items_are_skipped(monkeypatch):
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    fake = FakeOpenAI({"annotations": ["nonsense", 7, None,
                                       {"index": 1, "explanation": "Ok.", "fix": "Do it."}]})
    monkeypatch.setattr(reasoning, "_client", lambda: fake)

    result = reasoning.annotate(make())
    assert result[1]["explanation"] == "Ok."
