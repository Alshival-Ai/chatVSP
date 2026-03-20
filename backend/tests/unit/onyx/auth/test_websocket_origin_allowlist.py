from types import SimpleNamespace

from onyx.auth.users import _get_allowed_websocket_origins


def test_prefers_web_domain_and_forwarded_origin() -> None:
    websocket = SimpleNamespace(
        headers={
            "x-forwarded-proto": "https",
            "x-forwarded-host": "chat.example.com",
            "host": "api.internal:8080",
        },
        url=SimpleNamespace(scheme="ws"),
    )

    allowed = _get_allowed_websocket_origins(websocket)

    assert "https://chat.example.com" in allowed
    assert "http://api.internal:8080" in allowed


def test_handles_comma_separated_forwarded_headers() -> None:
    websocket = SimpleNamespace(
        headers={
            "x-forwarded-proto": "https,http",
            "x-forwarded-host": "chat.example.com,internal.example.net",
        },
        url=SimpleNamespace(scheme="ws"),
    )

    allowed = _get_allowed_websocket_origins(websocket)

    assert "https://chat.example.com" in allowed


def test_falls_back_to_host_for_direct_connections() -> None:
    websocket = SimpleNamespace(
        headers={"host": "chat.example.com"},
        url=SimpleNamespace(scheme="wss"),
    )

    allowed = _get_allowed_websocket_origins(websocket)

    assert "https://chat.example.com" in allowed
