from types import SimpleNamespace
from unittest.mock import MagicMock

from onyx.llm.constants import LlmProviderNames
from onyx.server.features.codex_labs import provisioning


class _FakeApiKey:
    def __init__(self, value: str) -> None:
        self._value = value

    def get_value(self, apply_mask: bool = False) -> str:  # noqa: ARG002
        return self._value


def _build_default_model(
    *,
    provider_name: str,
    api_base: str,
    deployment_name: str | None,
    model_name: str,
) -> SimpleNamespace:
    provider = SimpleNamespace(
        provider=provider_name,
        api_base=api_base,
        deployment_name=deployment_name,
        api_key=_FakeApiKey("test-azure-key"),
    )
    return SimpleNamespace(name=model_name, llm_provider=provider)


def test_resolve_azure_codex_settings_prefers_provider_deployment_name(
    monkeypatch,
) -> None:
    default_model = _build_default_model(
        provider_name=str(LlmProviderNames.AZURE),
        api_base=(
            "https://example.openai.azure.com/openai/deployments/"
            "fallback-deployment/chat/completions?api-version=2025-04-01-preview"
        ),
        deployment_name="configured-codex-deployment",
        model_name="gpt-5.3-chat",
    )
    monkeypatch.setattr(
        provisioning, "fetch_default_llm_model", lambda _db_session: default_model
    )

    model_name, base_url, api_key = provisioning._resolve_azure_codex_settings(
        MagicMock()
    )

    assert model_name == "configured-codex-deployment"
    assert base_url == "https://example.openai.azure.com/openai/v1"
    assert api_key == "test-azure-key"


def test_resolve_azure_codex_settings_extracts_deployment_from_api_base(
    monkeypatch,
) -> None:
    default_model = _build_default_model(
        provider_name=str(LlmProviderNames.AZURE),
        api_base=(
            "https://example.cognitiveservices.azure.com/openai/deployments/"
            "api-base-deployment/chat/completions?api-version=2025-04-01-preview"
        ),
        deployment_name=None,
        model_name="gpt-5.3-chat",
    )
    monkeypatch.setattr(
        provisioning, "fetch_default_llm_model", lambda _db_session: default_model
    )

    model_name, base_url, api_key = provisioning._resolve_azure_codex_settings(
        MagicMock()
    )

    assert model_name == "api-base-deployment"
    assert base_url == "https://example.cognitiveservices.azure.com/openai/v1"
    assert api_key == "test-azure-key"


def test_extract_azure_deployment_name_from_api_base_handles_encoded_path() -> None:
    deployment = provisioning._extract_azure_deployment_name_from_api_base(
        "https://example.openai.azure.com/openai/deployments/my%2Ddeployment/responses"
    )

    assert deployment == "my-deployment"


def test_resolve_azure_codex_settings_returns_none_for_non_azure_provider(
    monkeypatch,
) -> None:
    default_model = _build_default_model(
        provider_name=str(LlmProviderNames.OPENAI),
        api_base="https://api.openai.com/v1",
        deployment_name=None,
        model_name="gpt-5.3-chat",
    )
    monkeypatch.setattr(
        provisioning, "fetch_default_llm_model", lambda _db_session: default_model
    )

    model_name, base_url, api_key = provisioning._resolve_azure_codex_settings(
        MagicMock()
    )

    assert model_name is None
    assert base_url is None
    assert api_key is None


def test_provision_codex_home_copies_kmz_template_when_missing(
    monkeypatch,
    tmp_path,
) -> None:
    source = tmp_path / "source.xlsx"
    source.write_bytes(b"template-content")

    monkeypatch.setattr(
        provisioning,
        "_resolve_azure_codex_settings",
        lambda _db_session: (None, None, None),
    )
    monkeypatch.setattr(
        provisioning,
        "_resolve_local_mcp_settings",
        lambda _db_session: (None, None),
    )
    monkeypatch.setattr(
        provisioning,
        "_resolve_kmz_workbook_template_path",
        lambda: source,
    )

    env_overrides = provisioning.provision_codex_home(tmp_path, MagicMock())

    assert env_overrides == {}
    assert (
        tmp_path / ".wardGPT" / "kmz-excel-template.xlsx"
    ).read_bytes() == b"template-content"


def test_provision_codex_home_does_not_overwrite_existing_kmz_template(
    monkeypatch,
    tmp_path,
) -> None:
    source = tmp_path / "source.xlsx"
    source.write_bytes(b"new-template-content")

    destination = tmp_path / ".wardGPT" / "kmz-excel-template.xlsx"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(b"user-edited-content")

    monkeypatch.setattr(
        provisioning,
        "_resolve_azure_codex_settings",
        lambda _db_session: (None, None, None),
    )
    monkeypatch.setattr(
        provisioning,
        "_resolve_local_mcp_settings",
        lambda _db_session: (None, None),
    )
    monkeypatch.setattr(
        provisioning,
        "_resolve_kmz_workbook_template_path",
        lambda: source,
    )

    provisioning.provision_codex_home(tmp_path, MagicMock())

    assert destination.read_bytes() == b"user-edited-content"


def test_provision_codex_home_continues_when_kmz_template_source_missing(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(
        provisioning,
        "_resolve_azure_codex_settings",
        lambda _db_session: ("gpt-5.3-chat", "https://example.openai.azure.com/openai/v1", "key"),
    )
    monkeypatch.setattr(
        provisioning,
        "_resolve_local_mcp_settings",
        lambda _db_session: (None, None),
    )
    monkeypatch.setattr(
        provisioning,
        "_resolve_kmz_workbook_template_path",
        lambda: None,
    )

    env_overrides = provisioning.provision_codex_home(tmp_path, MagicMock())

    assert env_overrides == {provisioning.CODEX_AZURE_API_KEY_ENV_VAR: "key"}
    assert (tmp_path / ".codex" / "config.toml").is_file()
    assert not (tmp_path / ".wardGPT" / "kmz-excel-template.xlsx").exists()
