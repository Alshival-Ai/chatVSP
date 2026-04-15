from types import SimpleNamespace
from uuid import uuid4

import pytest

from onyx.chat.kmz_batching import OPENAI_HARD_FILE_LIMIT_BYTES
from onyx.chat.kmz_batching import OPENAI_BATCH_TARGET_BYTES
from onyx.chat.kmz_batching import KMZ_PACKET_MAX_PDFS
from onyx.chat.kmz_batching import build_kmz_batch_additional_context
from onyx.chat.kmz_batching import detect_kmz_output_mode
from onyx.chat.kmz_batching import merge_kmz_batch_results
from onyx.chat.kmz_batching import plan_kmz_pdf_batches
from onyx.chat.kmz_batching import run_kmz_batch_preprocessing
from onyx.chat.kmz_batching import should_batch_kmz_pdfs
from onyx.chat.kmz_batching import validate_kmz_pdf_count_or_raise
from onyx.chat.kmz_batching import KmzBatchExtractionResult
from onyx.file_store.models import ChatFileType
from onyx.file_store.models import InMemoryChatFile
from onyx.llm.constants import LlmProviderNames
from onyx.llm.interfaces import LLMConfig


def _make_pdf_file(name: str, size_bytes: int) -> InMemoryChatFile:
    return InMemoryChatFile(
        file_id=str(uuid4()),
        content=b"a" * size_bytes,
        file_type=ChatFileType.DOC,
        filename=name,
    )


def _token_counter(text: str) -> int:
    return max(1, len(text) // 4)


class _FakeLlm:
    def __init__(self, responses: list[str]) -> None:
        self._responses = responses
        self.config = LLMConfig(
            model_provider=LlmProviderNames.OPENAI,
            model_name="gpt-test",
            temperature=0,
            max_input_tokens=200000,
        )

    def invoke(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        content = self._responses.pop(0)
        return SimpleNamespace(
            choice=SimpleNamespace(message=SimpleNamespace(content=content))
        )


def test_should_batch_kmz_pdfs_for_openai_and_azure_kmz_over_threshold() -> None:
    files = [
        _make_pdf_file("a.pdf", 30 * 1024 * 1024),
        _make_pdf_file("b.pdf", 25 * 1024 * 1024),
    ]

    assert (
        should_batch_kmz_pdfs(
            message="Generate a KMZ from these packets",
            llm_provider=LlmProviderNames.OPENAI,
            files=files,
        )
        is True
    )
    assert (
        should_batch_kmz_pdfs(
            message="Generate a KMZ from these packets",
            llm_provider=LlmProviderNames.AZURE,
            files=files,
        )
        is True
    )
    assert (
        should_batch_kmz_pdfs(
            message="Summarize these packets",
            llm_provider=LlmProviderNames.OPENAI,
            files=files,
        )
        is False
    )
    assert (
        should_batch_kmz_pdfs(
            message="Generate a KMZ from these packets",
            llm_provider="anthropic",
            files=files,
        )
        is False
    )


def test_should_batch_kmz_pdfs_triggers_over_batch_target_before_hard_limit() -> None:
    files = [
        _make_pdf_file("a.pdf", 23 * 1024 * 1024),
        _make_pdf_file("b.pdf", 23 * 1024 * 1024),
    ]

    assert (
        should_batch_kmz_pdfs(
            message="Generate a KMZ from these packets",
            llm_provider=LlmProviderNames.OPENAI,
            files=files,
        )
        is True
    )
    assert sum(len(file.content) for file in files) > OPENAI_BATCH_TARGET_BYTES
    assert sum(len(file.content) for file in files) <= OPENAI_HARD_FILE_LIMIT_BYTES


def test_should_batch_kmz_pdfs_does_not_trigger_below_batch_target() -> None:
    files = [
        _make_pdf_file("a.pdf", 20 * 1024 * 1024),
        _make_pdf_file("b.pdf", 20 * 1024 * 1024),
    ]

    assert (
        should_batch_kmz_pdfs(
            message="Generate a KMZ from these packets",
            llm_provider=LlmProviderNames.OPENAI,
            files=files,
        )
        is False
    )
    assert sum(len(file.content) for file in files) <= OPENAI_BATCH_TARGET_BYTES


def test_validate_kmz_pdf_count_accepts_limit_and_rejects_above_limit() -> None:
    at_limit = [
        _make_pdf_file(f"packet-{i}.pdf", 1 * 1024 * 1024)
        for i in range(KMZ_PACKET_MAX_PDFS)
    ]
    validate_kmz_pdf_count_or_raise(
        message="Generate one KMZ per packet",
        files=at_limit,
    )

    above_limit = at_limit + [_make_pdf_file("overflow.pdf", 1 * 1024 * 1024)]
    with pytest.raises(RuntimeError, match="supports up to"):
        validate_kmz_pdf_count_or_raise(
            message="Generate one KMZ per packet",
            files=above_limit,
        )


def test_plan_kmz_pdf_batches_splits_and_flags_oversized() -> None:
    files = [
        _make_pdf_file("a.pdf", 30 * 1024 * 1024),
        _make_pdf_file("b.pdf", 20 * 1024 * 1024),
        _make_pdf_file("too-big.pdf", OPENAI_HARD_FILE_LIMIT_BYTES + 1),
    ]

    plan = plan_kmz_pdf_batches(files)

    assert [batch.filenames for batch in plan.batches] == [["a.pdf"], ["b.pdf"]]
    assert plan.oversized_files == ["too-big.pdf"]


def test_detect_kmz_output_mode_supports_combined_and_per_packet() -> None:
    assert detect_kmz_output_mode("Generate one KMZ from these packets") == "combined"
    assert (
        detect_kmz_output_mode("Generate one KMZ per packet for these PDFs")
        == "per_packet"
    )


def test_merge_kmz_batch_results_deduplicates_repeated_entities() -> None:
    batch_results = [
        KmzBatchExtractionResult(
            source_files=["a.pdf"],
            anchors=[
                {
                    "source_file": "a.pdf",
                    "address": "1501 ORCHARD AVE",
                    "coordinates": {"lat": 1.0, "lon": 2.0},
                }
            ],
            features=[
                {
                    "source_file": "a.pdf",
                    "name": "Pole 1",
                    "feature_type": "pole",
                }
            ],
            warnings=["approximate"],
        ),
        KmzBatchExtractionResult(
            source_files=["b.pdf"],
            anchors=[
                {
                    "source_file": "a.pdf",
                    "address": "1501 ORCHARD AVE",
                    "coordinates": {"lat": 1.0, "lon": 2.0},
                }
            ],
            features=[
                {
                    "source_file": "a.pdf",
                    "name": "Pole 1",
                    "feature_type": "pole",
                }
            ],
            warnings=["approximate", "low confidence"],
        ),
    ]

    merged = merge_kmz_batch_results(
        batch_results,
        requested_output_mode="per_packet",
        skipped_files=["too-big.pdf"],
        failed_batches=["Batch 2 failed"],
    )

    assert merged.requested_output_mode == "per_packet"
    assert merged.source_files == ["a.pdf", "b.pdf"]
    assert [packet.source_file for packet in merged.packet_models] == ["a.pdf", "b.pdf"]
    assert len(merged.packet_models[0].anchors) == 1
    assert len(merged.anchors) == 1
    assert len(merged.features) == 1
    assert merged.warnings == ["approximate", "low confidence"]
    assert merged.skipped_files == ["too-big.pdf"]
    assert merged.failed_batches == ["Batch 2 failed"]


def test_run_kmz_batch_preprocessing_returns_non_pdf_runtime_files_and_context() -> None:
    pdf_a = _make_pdf_file("a.pdf", 30 * 1024 * 1024)
    pdf_b = _make_pdf_file("b.pdf", 25 * 1024 * 1024)
    note = InMemoryChatFile(
        file_id=str(uuid4()),
        content=b"notes",
        file_type=ChatFileType.PLAIN_TEXT,
        filename="notes.txt",
    )
    llm = _FakeLlm(
        [
            '{"source_files":["a.pdf"],"anchors":[],"features":[{"source_file":"a.pdf","name":"Pole A","feature_type":"pole"}],"connections":[],"warnings":[]}',
            '{"source_files":["b.pdf"],"anchors":[],"features":[{"source_file":"b.pdf","name":"Pole B","feature_type":"pole"}],"connections":[],"warnings":["partial"]}',
        ]
    )

    outcome = run_kmz_batch_preprocessing(
        llm=llm,  # type: ignore[arg-type]
        token_counter=_token_counter,
        user_message="Generate one KMZ per packet from these packet PDFs",
        runtime_files=[pdf_a, pdf_b, note],
        user_identity=None,
    )

    assert [desc["name"] for desc in outcome.runtime_file_descriptors] == ["notes.txt"]
    assert outcome.additional_context_appendix is not None
    assert '"requested_output_mode": "per_packet"' in outcome.additional_context_appendix
    assert '"packet_models": [' in outcome.additional_context_appendix
    assert '"source_files": [' in outcome.additional_context_appendix
    assert '"failed_batches": []' in outcome.additional_context_appendix
    assert '"skipped_files": []' in outcome.additional_context_appendix


def test_build_kmz_batch_additional_context_mentions_partial_outputs() -> None:
    merged = merge_kmz_batch_results(
        [
            KmzBatchExtractionResult(
                source_files=["a.pdf"],
                anchors=[],
                features=[],
                connections=[],
                warnings=[],
            )
        ],
        requested_output_mode="combined",
        skipped_files=["c.pdf"],
        failed_batches=["Batch 2 failed"],
    )

    context = build_kmz_batch_additional_context(merged)

    assert "partial/best-effort" in context
    assert "requested_output_mode exactly" in context
    assert '"skipped_files": [' in context
    assert '"failed_batches": [' in context


def test_run_kmz_batch_preprocessing_fails_when_all_batches_fail() -> None:
    pdf_a = _make_pdf_file("a.pdf", 30 * 1024 * 1024)
    pdf_b = _make_pdf_file("b.pdf", 25 * 1024 * 1024)
    llm = _FakeLlm(["not json", "still not json"])

    with pytest.raises(RuntimeError, match="failed for all PDF batches"):
        run_kmz_batch_preprocessing(
            llm=llm,  # type: ignore[arg-type]
            token_counter=_token_counter,
            user_message="Generate a KMZ from these packet PDFs",
            runtime_files=[pdf_a, pdf_b],
            user_identity=None,
        )


def test_run_kmz_batch_preprocessing_rejects_above_max_pdf_count() -> None:
    files = [
        _make_pdf_file(f"packet-{i}.pdf", 1 * 1024 * 1024)
        for i in range(KMZ_PACKET_MAX_PDFS + 1)
    ]
    llm = _FakeLlm([])

    with pytest.raises(RuntimeError, match="supports up to"):
        run_kmz_batch_preprocessing(
            llm=llm,  # type: ignore[arg-type]
            token_counter=_token_counter,
            user_message="Generate one KMZ per packet from these packet PDFs",
            runtime_files=files,
            user_identity=None,
        )


def test_run_kmz_batch_preprocessing_falls_back_to_per_file_extraction() -> None:
    pdf_a = _make_pdf_file("109214806_4440 HASTINGS DR.pdf", 20 * 1024 * 1024)
    pdf_b = _make_pdf_file("109232613_2275 HILLSDALE CIR.pdf", 20 * 1024 * 1024)
    llm = _FakeLlm(
        [
            '{"source_files":["109214806_4440 HASTINGS DR.pdf","109232613_2275 HILLSDALE CIR.pdf"],"anchors":[],"features":[],"connections":[],"warnings":["batch too sparse"]}',
            '{"source_files":["109214806_4440 HASTINGS DR.pdf"],"anchors":[{"source_file":"109214806_4440 HASTINGS DR.pdf","address":"4440 HASTINGS DR","coordinates":{"lat":40.0,"lon":-105.0},"confidence":"approximate","notes":"single-file fallback"}],"features":[],"connections":[],"warnings":[]}',
            '{"source_files":["109232613_2275 HILLSDALE CIR.pdf"],"anchors":[{"source_file":"109232613_2275 HILLSDALE CIR.pdf","address":"2275 HILLSDALE CIR","coordinates":{"lat":40.1,"lon":-105.1},"confidence":"approximate","notes":"single-file fallback"}],"features":[],"connections":[],"warnings":[]}',
        ]
    )

    outcome = run_kmz_batch_preprocessing(
        llm=llm,  # type: ignore[arg-type]
        token_counter=_token_counter,
        user_message="Generate a single KMZ from these packet PDFs",
        runtime_files=[pdf_a, pdf_b],
        user_identity=None,
    )

    assert outcome.additional_context_appendix is not None
    assert '"address": "4440 HASTINGS DR"' in outcome.additional_context_appendix
    assert '"address": "2275 HILLSDALE CIR"' in outcome.additional_context_appendix
    assert '"failed_batches": []' in outcome.additional_context_appendix


def test_run_kmz_batch_preprocessing_adds_filename_anchor_fallbacks() -> None:
    pdf_a = _make_pdf_file(
        "109214806_RPT_BLDR_COL_BOU_4440 HASTINGS DR_RPOH_WARD.pdf",
        20 * 1024 * 1024,
    )
    pdf_b = _make_pdf_file(
        "109232613_RPT_BLDR_COL_SUP_2275 HILLSDALE CIR_RPOH_WARD.pdf",
        20 * 1024 * 1024,
    )
    llm = _FakeLlm(
        [
            '{"source_files":["109214806_RPT_BLDR_COL_BOU_4440 HASTINGS DR_RPOH_WARD.pdf","109232613_RPT_BLDR_COL_SUP_2275 HILLSDALE CIR_RPOH_WARD.pdf"],"anchors":[],"features":[],"connections":[],"warnings":["no map geometry extracted"]}',
            "not json",
            "not json",
        ]
    )

    outcome = run_kmz_batch_preprocessing(
        llm=llm,  # type: ignore[arg-type]
        token_counter=_token_counter,
        user_message="Generate a combined KMZ from these packet PDFs",
        runtime_files=[pdf_a, pdf_b],
        user_identity=None,
    )

    assert outcome.additional_context_appendix is not None
    assert "4440 HASTINGS DR, Boulder, CO" in outcome.additional_context_appendix
    assert "2275 HILLSDALE CIR, Superior, CO" in outcome.additional_context_appendix
    assert "inferred from source filenames" in outcome.additional_context_appendix
