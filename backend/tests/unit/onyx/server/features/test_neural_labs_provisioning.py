from onyx.server.features.neural_labs import provisioning


def test_build_codex_config_toml_omits_mcp_servers() -> None:
    config_text = provisioning._build_codex_config_toml("gpt-5.4")

    assert 'model = "gpt-5.4"' in config_text
    assert '[model_providers.openai-custom]' in config_text
    assert "[mcp_servers." not in config_text
    assert "wardgpt" not in config_text.lower()
    assert "onyx" not in config_text.lower()
