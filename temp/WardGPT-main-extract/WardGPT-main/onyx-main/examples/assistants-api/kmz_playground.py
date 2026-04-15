import os
import time
from dataclasses import dataclass
from typing import Any

import streamlit as st
from openai import OpenAI


DEFAULT_BASE_URL = "http://localhost:8080/openai-assistants"
DEFAULT_ASSISTANT_NAME = "KMZ agent"
MAX_PDF_FILES = 100
MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024
POLL_INTERVAL_SECONDS = 1.0


@dataclass
class JobResult:
    label: str
    status: str
    response_text: str
    run_id: str | None = None


def format_bytes(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def get_client(base_url: str, openai_api_key: str, onyx_api_key: str) -> OpenAI:
    return OpenAI(
        api_key=openai_api_key,
        base_url=base_url.rstrip("/"),
        default_headers={"Authorization": f"Bearer {onyx_api_key}"},
    )


def find_assistant_id(client: OpenAI, assistant_name: str) -> str | None:
    assistants = client.beta.assistants.list(limit=100)
    for assistant in assistants.data:
        if assistant.name == assistant_name:
            return assistant.id
    return None


def extract_latest_assistant_text(client: OpenAI, thread_id: str) -> str:
    messages = client.beta.threads.messages.list(thread_id=thread_id, order="desc")
    for message in messages.data:
        if getattr(message, "role", None) != "assistant":
            continue

        text_chunks: list[str] = []
        for content in getattr(message, "content", []):
            if getattr(content, "type", None) == "text":
                text_value = getattr(getattr(content, "text", None), "value", None)
                if text_value:
                    text_chunks.append(text_value)
        if text_chunks:
            return "\n\n".join(text_chunks)
    return "No assistant text response returned."


def wait_for_run(client: OpenAI, thread_id: str, run_id: str) -> Any:
    while True:
        run = client.beta.threads.runs.retrieve(thread_id=thread_id, run_id=run_id)
        if run.status in {"completed", "failed", "cancelled", "expired"}:
            return run
        time.sleep(POLL_INTERVAL_SECONDS)


def upload_pdf_files(client: OpenAI, uploaded_files: list[Any]) -> list[tuple[str, str]]:
    uploaded_ids: list[tuple[str, str]] = []
    upload_progress = st.progress(0.0, text="Uploading PDFs to assistant API...")

    total = len(uploaded_files)
    for idx, uploaded_file in enumerate(uploaded_files, start=1):
        file_name = uploaded_file.name
        file_bytes = uploaded_file.getvalue()
        created = client.files.create(
            file=(file_name, file_bytes, "application/pdf"),
            purpose="assistants",
        )
        uploaded_ids.append((file_name, created.id))
        upload_progress.progress(
            idx / total,
            text=f"Uploaded {idx}/{total}: {file_name}",
        )

    upload_progress.empty()
    return uploaded_ids


def run_job(
    client: OpenAI,
    assistant_id: str,
    file_ids: list[str],
    user_prompt: str,
) -> tuple[str, str, str]:
    thread = client.beta.threads.create()
    attachments = [{"file_id": file_id} for file_id in file_ids]
    client.beta.threads.messages.create(
        thread_id=thread.id,
        role="user",
        content=user_prompt,
        attachments=attachments,  # type: ignore[arg-type]
    )
    run = client.beta.threads.runs.create(thread_id=thread.id, assistant_id=assistant_id)
    done_run = wait_for_run(client, thread.id, run.id)
    response_text = extract_latest_assistant_text(client, thread.id)
    return done_run.status, done_run.id, response_text


def validate_uploaded_files(uploaded_files: list[Any]) -> tuple[list[Any], list[str]]:
    errors: list[str] = []
    valid_files: list[Any] = []

    if len(uploaded_files) > MAX_PDF_FILES:
        errors.append(f"Too many files. Maximum is {MAX_PDF_FILES} PDFs.")

    for f in uploaded_files:
        if not f.name.lower().endswith(".pdf"):
            errors.append(f"{f.name}: not a PDF.")
            continue
        if f.size > MAX_SINGLE_FILE_BYTES:
            errors.append(
                f"{f.name}: file too large ({format_bytes(f.size)}). "
                f"Limit is {format_bytes(MAX_SINGLE_FILE_BYTES)}."
            )
            continue
        valid_files.append(f)

    return valid_files, errors


def build_individual_prompt(file_name: str) -> str:
    return (
        "Create one KMZ from this single PDF packet. "
        "Use only data from the attached file. "
        "If geocoding confidence is low, call out assumptions. "
        "Return the generated KMZ as a downloadable file link.\n\n"
        f"PDF packet: {file_name}"
    )


def build_compiled_prompt(file_names: list[str]) -> str:
    joined_names = "\n".join(f"- {name}" for name in file_names)
    return (
        "Create one compiled KMZ that merges all attached PDF packets. "
        "Maintain source separation by folder or naming convention in the KML. "
        "Return the generated KMZ as a downloadable file link.\n\n"
        "Attached packets:\n"
        f"{joined_names}"
    )


def main() -> None:
    st.set_page_config(
        page_title="KMZ Playground",
        page_icon="K",
        layout="wide",
    )
    st.title("KMZ Playground (Bulk PDF Upload)")
    st.caption(
        "Craft-style playground for stress testing KMZ generation with large PDF batches."
    )

    with st.sidebar:
        st.subheader("Connection")
        base_url = st.text_input(
            "Assistants Base URL",
            value=os.getenv("ASSISTANTS_BASE_URL", DEFAULT_BASE_URL),
            help="Onyx assistants compatibility endpoint.",
        )
        openai_api_key = st.text_input(
            "OPENAI_API_KEY",
            type="password",
            value=os.getenv("OPENAI_API_KEY", ""),
        )
        onyx_api_key = st.text_input(
            "DANSWER_API_KEY",
            type="password",
            value=os.getenv("DANSWER_API_KEY", ""),
        )
        assistant_name = st.text_input(
            "Assistant Name",
            value=DEFAULT_ASSISTANT_NAME,
        )
        mode = st.radio(
            "Output Mode",
            options=[
                "Individual KMZ per PDF",
                "Single Compiled KMZ",
            ],
        )

    uploaded_files = st.file_uploader(
        "Upload up to 100 PDF packets",
        type=["pdf"],
        accept_multiple_files=True,
    )

    if not uploaded_files:
        st.info("Add PDF packets to begin.")
        return

    valid_files, validation_errors = validate_uploaded_files(uploaded_files)

    rows = []
    valid_names = {f.name for f in valid_files}
    for f in uploaded_files:
        rows.append(
            {
                "File": f.name,
                "Size": format_bytes(f.size),
                "Status": "Ready" if f.name in valid_names else "Invalid",
            }
        )
    st.subheader("Upload Queue")
    st.dataframe(rows, use_container_width=True, hide_index=True)

    if validation_errors:
        st.error("\n".join(validation_errors))
        return

    st.success(f"{len(valid_files)} PDF(s) ready.")

    if not st.button("Run KMZ Agent"):
        return

    if not openai_api_key or not onyx_api_key:
        st.error("Both OPENAI_API_KEY and DANSWER_API_KEY are required.")
        return

    try:
        client = get_client(
            base_url=base_url,
            openai_api_key=openai_api_key,
            onyx_api_key=onyx_api_key,
        )
        assistant_id = find_assistant_id(client, assistant_name)
        if not assistant_id:
            st.error(
                f"Assistant '{assistant_name}' not found. "
                "Create or rename the assistant first."
            )
            return

        uploaded = upload_pdf_files(client, valid_files)
        st.success(f"Uploaded {len(uploaded)} file(s) to assistant API.")

        results: list[JobResult] = []
        if mode == "Individual KMZ per PDF":
            for idx, (file_name, file_id) in enumerate(uploaded, start=1):
                st.write(f"Running {idx}/{len(uploaded)}: `{file_name}`")
                status, run_id, response = run_job(
                    client=client,
                    assistant_id=assistant_id,
                    file_ids=[file_id],
                    user_prompt=build_individual_prompt(file_name),
                )
                results.append(
                    JobResult(
                        label=file_name,
                        status=status,
                        response_text=response,
                        run_id=run_id,
                    )
                )
        else:
            file_names = [name for name, _ in uploaded]
            file_ids = [file_id for _, file_id in uploaded]
            status, run_id, response = run_job(
                client=client,
                assistant_id=assistant_id,
                file_ids=file_ids,
                user_prompt=build_compiled_prompt(file_names),
            )
            results.append(
                JobResult(
                    label=f"Compiled ({len(file_ids)} PDFs)",
                    status=status,
                    response_text=response,
                    run_id=run_id,
                )
            )

        st.subheader("Results")
        for result in results:
            with st.expander(f"{result.label} - {result.status}", expanded=True):
                if result.run_id:
                    st.caption(f"Run ID: {result.run_id}")
                st.markdown(result.response_text)

    except Exception as e:
        st.exception(e)


if __name__ == "__main__":
    main()
