from onyx.server.features.neural_labs import provisioning


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
        "AWS_DEFAULT_REGION": "us-east-1",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "us.anthropic.claude-sonnet-4-6",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "global.anthropic.claude-opus-4-6-v1",
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
        "_resolve_bedrock_claude_settings",
        lambda db_session: {
            "CLAUDE_CODE_USE_BEDROCK": "1",
            "AWS_REGION": "us-east-1",
            "AWS_DEFAULT_REGION": "us-east-1",
        },
    )

    env = provisioning.provision_neural_labs_home(tmp_path, db_session=None)

    assert env == {
        "CLAUDE_CODE_USE_BEDROCK": "1",
        "AWS_REGION": "us-east-1",
        "AWS_DEFAULT_REGION": "us-east-1",
    }


def test_provision_neural_labs_home_prefers_foundry_over_bedrock(
    monkeypatch, tmp_path
) -> None:
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


def test_build_shell_env_file_unsets_aws_keys_for_bedrock_iam() -> None:
    env_text = provisioning._build_shell_env_file(
        {
            "CLAUDE_CODE_USE_BEDROCK": "1",
            "AWS_REGION": "us-east-1",
            "AWS_DEFAULT_REGION": "us-east-1",
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "global.anthropic.claude-opus-4-6-v1",
        }
    )

    assert "unset AWS_ACCESS_KEY_ID" in env_text
    assert "unset AWS_SECRET_ACCESS_KEY" in env_text
    assert "unset AWS_SESSION_TOKEN" in env_text
    assert "export CLAUDE_CODE_USE_BEDROCK='1'" in env_text
    assert "export AWS_REGION='us-east-1'" in env_text
    assert "export AWS_DEFAULT_REGION='us-east-1'" in env_text


def test_provision_neural_labs_home_writes_shell_env_file(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(
        provisioning,
        "_resolve_bedrock_claude_settings",
        lambda db_session: {
            "CLAUDE_CODE_USE_BEDROCK": "1",
            "AWS_REGION": "us-east-1",
            "AWS_DEFAULT_REGION": "us-east-1",
        },
    )

    provisioning.provision_neural_labs_home(tmp_path, db_session=None)

    env_file = tmp_path / ".neural_labs_env"
    assert env_file.exists()
    env_text = env_file.read_text(encoding="utf-8")
    assert 'export CLAUDE_CODE_USE_BEDROCK=' in env_text
    assert '. "$HOME/.neural_labs_env"' in (tmp_path / ".bashrc").read_text(
        encoding="utf-8"
    )
