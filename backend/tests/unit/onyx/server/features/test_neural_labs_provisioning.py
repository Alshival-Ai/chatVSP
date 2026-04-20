from onyx.server.features.neural_labs import provisioning


def test_build_codex_config_toml_omits_mcp_servers() -> None:
    config_text = provisioning._build_codex_config_toml("gpt-5.4")

    assert 'model = "gpt-5.4"' in config_text
    assert '[model_providers.openai-custom]' in config_text
    assert "[mcp_servers." not in config_text
    assert "wardgpt" not in config_text.lower()
    assert "onyx" not in config_text.lower()


def test_resolve_bedrock_claude_settings_uses_provider_region(
    monkeypatch,
) -> None:
    class Provider:
        custom_config = {"AWS_REGION_NAME": "us-east-1"}

    monkeypatch.setattr(
        provisioning,
        "_fetch_provider_by_type",
        lambda db_session, provider_type: Provider(),
    )

    env = provisioning._resolve_bedrock_claude_settings(db_session=None)

    assert env == {
        "CLAUDE_CODE_USE_BEDROCK": "1",
        "AWS_REGION": "us-east-1",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "us.anthropic.claude-sonnet-4-6",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "us.anthropic.claude-opus-4-7",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    }


def test_resolve_bedrock_claude_settings_defaults_region(monkeypatch) -> None:
    class Provider:
        custom_config = {}

    monkeypatch.setattr(
        provisioning,
        "_fetch_provider_by_type",
        lambda db_session, provider_type: Provider(),
    )

    env = provisioning._resolve_bedrock_claude_settings(db_session=None)

    assert env is not None
    assert env["AWS_REGION"] == "us-east-1"


def test_resolve_foundry_claude_settings_uses_azure_provider(monkeypatch) -> None:
    class ApiKey:
        def get_value(self, apply_mask: bool = False) -> str:
            assert apply_mask is False
            return "azure-foundry-key"

    class Provider:
        api_base = "https://team-foundry.services.ai.azure.com"
        api_key = ApiKey()

    monkeypatch.setattr(
        provisioning,
        "_fetch_provider_by_type",
        lambda db_session, provider_type: Provider(),
    )

    env = provisioning._resolve_foundry_claude_settings(db_session=None)

    assert env == {
        "CLAUDE_CODE_USE_FOUNDRY": "1",
        "ANTHROPIC_FOUNDRY_BASE_URL": "https://team-foundry.services.ai.azure.com/anthropic",
        "ANTHROPIC_FOUNDRY_API_KEY": "azure-foundry-key",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-7",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5",
    }


def test_resolve_foundry_claude_settings_rejects_non_foundry_base(monkeypatch) -> None:
    class Provider:
        api_base = "https://example.openai.azure.com"
        api_key = None

    monkeypatch.setattr(
        provisioning,
        "_fetch_provider_by_type",
        lambda db_session, provider_type: Provider(),
    )

    assert provisioning._resolve_foundry_claude_settings(db_session=None) is None


def test_provision_neural_labs_home_returns_claude_env_without_openai(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(
        provisioning,
        "_resolve_openai_codex_settings",
        lambda db_session: ("gpt-5.4", None),
    )
    monkeypatch.setattr(
        provisioning,
        "_resolve_bedrock_claude_settings",
        lambda db_session: {
            "CLAUDE_CODE_USE_BEDROCK": "1",
            "AWS_REGION": "us-east-1",
        },
    )

    env = provisioning.provision_neural_labs_home(tmp_path, db_session=None)

    assert env == {
        "CLAUDE_CODE_USE_BEDROCK": "1",
        "AWS_REGION": "us-east-1",
    }


def test_provision_neural_labs_home_prefers_foundry_over_bedrock(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(
        provisioning,
        "_resolve_openai_codex_settings",
        lambda db_session: ("gpt-5.4", None),
    )
    monkeypatch.setattr(
        provisioning,
        "_resolve_foundry_claude_settings",
        lambda db_session: {
            "CLAUDE_CODE_USE_FOUNDRY": "1",
            "ANTHROPIC_FOUNDRY_BASE_URL": "https://team-foundry.services.ai.azure.com/anthropic",
        },
    )
    monkeypatch.setattr(
        provisioning,
        "_resolve_bedrock_claude_settings",
        lambda db_session: {
            "CLAUDE_CODE_USE_BEDROCK": "1",
            "AWS_REGION": "us-east-1",
        },
    )

    env = provisioning.provision_neural_labs_home(tmp_path, db_session=None)

    assert env == {
        "CLAUDE_CODE_USE_FOUNDRY": "1",
        "ANTHROPIC_FOUNDRY_BASE_URL": "https://team-foundry.services.ai.azure.com/anthropic",
    }
