"""Tests for chat_utils.py, specifically get_custom_agent_prompt."""

from unittest.mock import MagicMock

from onyx.chat.chat_utils import _build_tool_call_response_history_message
from onyx.chat.chat_utils import convert_chat_history
from onyx.chat.chat_utils import get_custom_agent_prompt
from onyx.chat.models import ChatLoadedFile
from onyx.configs.constants import DEFAULT_PERSONA_ID
from onyx.configs.constants import MessageType
from onyx.file_store.models import ChatFileType
from onyx.llm.constants import LlmProviderNames
from onyx.prompts.chat_prompts import TOOL_CALL_RESPONSE_CROSS_MESSAGE


class TestGetCustomAgentPrompt:
    """Tests for the get_custom_agent_prompt function."""

    def _create_mock_persona(
        self,
        persona_id: int = 1,
        system_prompt: str | None = None,
        replace_base_system_prompt: bool = False,
    ) -> MagicMock:
        """Create a mock Persona with the specified attributes."""
        persona = MagicMock()
        persona.id = persona_id
        persona.system_prompt = system_prompt
        persona.replace_base_system_prompt = replace_base_system_prompt
        return persona

    def _create_mock_chat_session(
        self,
        project: MagicMock | None = None,
    ) -> MagicMock:
        """Create a mock ChatSession with the specified attributes."""
        chat_session = MagicMock()
        chat_session.project = project
        return chat_session

    def _create_mock_project(
        self,
        instructions: str = "",
    ) -> MagicMock:
        """Create a mock UserProject with the specified attributes."""
        project = MagicMock()
        project.instructions = instructions
        return project

    def test_default_persona_no_project(self) -> None:
        """Test that default persona without a project returns None."""
        persona = self._create_mock_persona(persona_id=DEFAULT_PERSONA_ID)
        chat_session = self._create_mock_chat_session(project=None)

        result = get_custom_agent_prompt(persona, chat_session)

        assert result is None

    def test_default_persona_with_project_instructions(self) -> None:
        """Test that default persona in a project returns project instructions."""
        persona = self._create_mock_persona(persona_id=DEFAULT_PERSONA_ID)
        project = self._create_mock_project(instructions="Do X and Y")
        chat_session = self._create_mock_chat_session(project=project)

        result = get_custom_agent_prompt(persona, chat_session)

        assert result == "Do X and Y"

    def test_default_persona_with_empty_project_instructions(self) -> None:
        """Test that default persona in a project with empty instructions returns None."""
        persona = self._create_mock_persona(persona_id=DEFAULT_PERSONA_ID)
        project = self._create_mock_project(instructions="")
        chat_session = self._create_mock_chat_session(project=project)

        result = get_custom_agent_prompt(persona, chat_session)

        assert result is None

    def test_custom_persona_replace_base_prompt_true(self) -> None:
        """Test that custom persona with replace_base_system_prompt=True returns None."""
        persona = self._create_mock_persona(
            persona_id=1,
            system_prompt="Custom system prompt",
            replace_base_system_prompt=True,
        )
        chat_session = self._create_mock_chat_session(project=None)

        result = get_custom_agent_prompt(persona, chat_session)

        assert result is None

    def test_custom_persona_with_system_prompt(self) -> None:
        """Test that custom persona with system_prompt returns the system_prompt."""
        persona = self._create_mock_persona(
            persona_id=1,
            system_prompt="Custom system prompt",
            replace_base_system_prompt=False,
        )
        chat_session = self._create_mock_chat_session(project=None)

        result = get_custom_agent_prompt(persona, chat_session)

        assert result == "Custom system prompt"

    def test_custom_persona_empty_string_system_prompt(self) -> None:
        """Test that custom persona with empty string system_prompt returns None."""
        persona = self._create_mock_persona(
            persona_id=1,
            system_prompt="",
            replace_base_system_prompt=False,
        )
        chat_session = self._create_mock_chat_session(project=None)

        result = get_custom_agent_prompt(persona, chat_session)

        assert result is None

    def test_custom_persona_none_system_prompt(self) -> None:
        """Test that custom persona with None system_prompt returns None."""
        persona = self._create_mock_persona(
            persona_id=1,
            system_prompt=None,
            replace_base_system_prompt=False,
        )
        chat_session = self._create_mock_chat_session(project=None)

        result = get_custom_agent_prompt(persona, chat_session)

        assert result is None

    def test_custom_persona_in_project_uses_persona_prompt(self) -> None:
        """Test that custom persona in a project uses persona's system_prompt, not project instructions."""
        persona = self._create_mock_persona(
            persona_id=1,
            system_prompt="Custom system prompt",
            replace_base_system_prompt=False,
        )
        project = self._create_mock_project(instructions="Project instructions")
        chat_session = self._create_mock_chat_session(project=project)

        result = get_custom_agent_prompt(persona, chat_session)

        # Should use persona's system_prompt, NOT project instructions
        assert result == "Custom system prompt"

    def test_custom_persona_replace_base_in_project(self) -> None:
        """Test that custom persona with replace_base_system_prompt=True in a project still returns None."""
        persona = self._create_mock_persona(
            persona_id=1,
            system_prompt="Custom system prompt",
            replace_base_system_prompt=True,
        )
        project = self._create_mock_project(instructions="Project instructions")
        chat_session = self._create_mock_chat_session(project=project)

        result = get_custom_agent_prompt(persona, chat_session)

        # Should return None because replace_base_system_prompt=True
        assert result is None


class TestBuildToolCallResponseHistoryMessage:
    def test_image_tool_uses_generated_images(self) -> None:
        message = _build_tool_call_response_history_message(
            tool_name="generate_image",
            generated_images=[{"file_id": "img-1", "revised_prompt": "p1"}],
            tool_call_response=None,
        )
        assert message == '[{"file_id": "img-1", "revised_prompt": "p1"}]'

    def test_non_image_tool_uses_placeholder(self) -> None:
        message = _build_tool_call_response_history_message(
            tool_name="web_search",
            generated_images=None,
            tool_call_response='{"raw":"value"}',
        )
        assert message == TOOL_CALL_RESPONSE_CROSS_MESSAGE


class TestConvertChatHistoryFileInjection:
    def _user_message(self, files: list[dict[str, str]], message: str) -> MagicMock:
        chat_message = MagicMock()
        chat_message.message_type = MessageType.USER
        chat_message.files = files
        chat_message.message = message
        chat_message.token_count = 5
        chat_message.tool_calls = None
        return chat_message

    @staticmethod
    def _loaded_file(filename: str) -> ChatLoadedFile:
        return ChatLoadedFile(
            file_id="f1",
            content=b"dummy",
            file_type=ChatFileType.DOC,
            filename=filename,
            content_text="Parsed content",
            token_count=7,
        )

    def test_openai_supported_attachment_is_not_injected_as_text(self) -> None:
        result = convert_chat_history(
            chat_history=[
                self._user_message(
                    files=[{"id": "f1", "type": "document", "name": "notes.pdf"}],
                    message="Please summarize this file.",
                )
            ],
            files=[self._loaded_file("notes.pdf")],
            context_image_files=[],
            additional_context=None,
            token_counter=len,
            tool_id_to_name_map={},
            llm_model_provider=LlmProviderNames.OPENAI,
        )

        assert len(result.simple_messages) == 1
        assert result.simple_messages[0].message == "Please summarize this file."
        assert result.simple_messages[0].file_id is None
        assert result.simple_messages[0].non_image_files is not None
        assert len(result.simple_messages[0].non_image_files) == 1
        assert result.all_injected_file_metadata == {}

    def test_non_openai_still_injects_text_for_non_image_files(self) -> None:
        result = convert_chat_history(
            chat_history=[
                self._user_message(
                    files=[{"id": "f1", "type": "document", "name": "notes.pdf"}],
                    message="Please summarize this file.",
                )
            ],
            files=[self._loaded_file("notes.pdf")],
            context_image_files=[],
            additional_context=None,
            token_counter=len,
            tool_id_to_name_map={},
            llm_model_provider=LlmProviderNames.OLLAMA_CHAT,
        )

        assert len(result.simple_messages) == 2
        assert result.simple_messages[0].file_id == "f1"
        assert result.simple_messages[1].message == "Please summarize this file."
        assert "f1" in result.all_injected_file_metadata

    def test_openai_unsupported_extension_still_injects_text(self) -> None:
        result = convert_chat_history(
            chat_history=[
                self._user_message(
                    files=[{"id": "f1", "type": "document", "name": "archive.kmz"}],
                    message="Use this attachment.",
                )
            ],
            files=[self._loaded_file("archive.kmz")],
            context_image_files=[],
            additional_context=None,
            token_counter=len,
            tool_id_to_name_map={},
            llm_model_provider=LlmProviderNames.OPENAI,
        )

        assert len(result.simple_messages) == 2
        assert result.simple_messages[0].file_id == "f1"
        assert "f1" in result.all_injected_file_metadata

    def test_openai_can_disable_input_file_and_inject_text(self) -> None:
        result = convert_chat_history(
            chat_history=[
                self._user_message(
                    files=[{"id": "f1", "type": "document", "name": "notes.pdf"}],
                    message="Please summarize this file.",
                )
            ],
            files=[self._loaded_file("notes.pdf")],
            context_image_files=[],
            additional_context=None,
            token_counter=len,
            tool_id_to_name_map={},
            llm_model_provider=LlmProviderNames.OPENAI,
            disable_openai_input_file_parts=True,
        )

        assert len(result.simple_messages) == 2
        assert result.simple_messages[0].file_id == "f1"
        assert result.simple_messages[1].non_image_files is None
        assert "f1" in result.all_injected_file_metadata
