from types import SimpleNamespace
from unittest.mock import MagicMock
from unittest.mock import patch

from onyx.tools.tool_constructor import construct_tools
from onyx.tools.tool_implementations.python.python_tool import PythonTool


@patch("onyx.tools.tool_constructor.get_default_document_index")
@patch("onyx.tools.tool_constructor.get_current_search_settings")
@patch("onyx.tools.tool_constructor.get_built_in_tool_by_id", return_value=PythonTool)
@patch.object(PythonTool, "is_available", return_value=True)
def test_construct_tools_skips_code_interpreter_when_user_lacks_access(
    mock_is_available: MagicMock,
    mock_get_builtin_tool_by_id: MagicMock,
    mock_get_current_search_settings: MagicMock,
    mock_get_default_document_index: MagicMock,
) -> None:
    tool_id = 17
    persona = SimpleNamespace(
        id=1,
        name="Test Persona",
        tools=[SimpleNamespace(id=tool_id, in_code_tool_id="PythonTool")],
    )
    user = SimpleNamespace(
        enable_code_interpreter=False,
        email="user@example.com",
        oauth_accounts=[],
    )

    tool_dict = construct_tools(
        persona=persona,
        db_session=MagicMock(),
        emitter=MagicMock(),
        user=user,
        llm=MagicMock(),
    )

    assert tool_id not in tool_dict
    mock_is_available.assert_called_once()
    mock_get_builtin_tool_by_id.assert_called_once()
    mock_get_current_search_settings.assert_called_once()
    mock_get_default_document_index.assert_called_once()


@patch("onyx.tools.tool_constructor.get_default_document_index")
@patch("onyx.tools.tool_constructor.get_current_search_settings")
@patch("onyx.tools.tool_constructor.get_built_in_tool_by_id", return_value=PythonTool)
@patch.object(PythonTool, "is_available", return_value=True)
def test_construct_tools_includes_code_interpreter_when_user_has_access(
    mock_is_available: MagicMock,
    mock_get_builtin_tool_by_id: MagicMock,
    mock_get_current_search_settings: MagicMock,
    mock_get_default_document_index: MagicMock,
) -> None:
    tool_id = 17
    persona = SimpleNamespace(
        id=1,
        name="Test Persona",
        tools=[SimpleNamespace(id=tool_id, in_code_tool_id="PythonTool")],
    )
    user = SimpleNamespace(
        enable_code_interpreter=True,
        email="user@example.com",
        oauth_accounts=[],
    )

    tool_dict = construct_tools(
        persona=persona,
        db_session=MagicMock(),
        emitter=MagicMock(),
        user=user,
        llm=MagicMock(),
    )

    assert tool_id in tool_dict
    assert len(tool_dict[tool_id]) == 1
    assert isinstance(tool_dict[tool_id][0], PythonTool)
    mock_is_available.assert_called_once()
    mock_get_builtin_tool_by_id.assert_called_once()
    mock_get_current_search_settings.assert_called_once()
    mock_get_default_document_index.assert_called_once()
