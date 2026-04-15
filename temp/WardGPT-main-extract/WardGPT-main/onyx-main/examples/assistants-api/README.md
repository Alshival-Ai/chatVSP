# Assistants API Examples

## KMZ Playground (Bulk PDF Upload)

`kmz_playground.py` is a Streamlit test UI for high-volume KMZ jobs against the Onyx OpenAI-assistants compatibility endpoint.

### What it does
- Accepts up to 100 PDF packets in one queue.
- Validates per-file size (50 MB) and file type.
- Runs the assistant in either:
  - `Individual KMZ per PDF`
  - `Single Compiled KMZ`
- Displays run status and assistant responses per job.

### Prerequisites
- A running Onyx backend exposing:
  - `http://localhost:8080/openai-assistants` (or your configured endpoint)
- A configured assistant named `KMZ agent` (or set another name in the UI).
- Python packages:
  - `streamlit`
  - `openai`

### Environment variables
- `OPENAI_API_KEY`
- `DANSWER_API_KEY`
- Optional: `ASSISTANTS_BASE_URL`

### Run
```bash
cd onyx-main/examples/assistants-api
streamlit run kmz_playground.py
```

### Notes
- This is a playground for load/UX testing, not a production UI.
- The assistant response should include downloadable KMZ links when generation succeeds.
