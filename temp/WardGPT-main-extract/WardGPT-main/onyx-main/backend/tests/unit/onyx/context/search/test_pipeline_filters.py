from types import SimpleNamespace

from onyx.context.search.models import BaseFilters
from onyx.context.search.pipeline import _build_index_filters


def _build_filters(
    user_filters: BaseFilters | None,
    persona_document_sets: list[str] | None,
) -> list[str] | None:
    return _build_index_filters(
        user_provided_filters=user_filters,
        user=SimpleNamespace(),
        project_id=None,
        persona_id=1,
        user_file_ids=None,
        persona_document_sets=persona_document_sets,
        persona_time_cutoff=None,
        bypass_acl=True,
    ).document_set


def test_empty_user_document_set_inherits_persona_document_sets() -> None:
    resolved = _build_filters(
        user_filters=BaseFilters(document_set=[]),
        persona_document_sets=["sharepoint-docs"],
    )
    assert resolved == ["sharepoint-docs"]


def test_blank_user_document_set_entries_inherit_persona_document_sets() -> None:
    resolved = _build_filters(
        user_filters=BaseFilters(document_set=["", "   "]),
        persona_document_sets=["sharepoint-docs"],
    )
    assert resolved == ["sharepoint-docs"]


def test_user_document_set_overrides_persona_document_sets() -> None:
    resolved = _build_filters(
        user_filters=BaseFilters(document_set=["finance"]),
        persona_document_sets=["sharepoint-docs"],
    )
    assert resolved == ["finance"]


def test_empty_user_document_set_without_persona_scope_stays_unset() -> None:
    resolved = _build_filters(
        user_filters=BaseFilters(document_set=[]),
        persona_document_sets=None,
    )
    assert resolved is None
