from io import BytesIO
import zipfile

from onyx.tools.tool_implementations.python.python_tool import _is_kmz_archive
from onyx.tools.tool_implementations.python.python_tool import _normalize_generated_filename


def _build_kmz_bytes() -> bytes:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "doc.kml",
            "<kml><Placemark><name>Test</name></Placemark></kml>",
        )
    return buffer.getvalue()


def test_is_kmz_archive_true_when_zip_contains_kml() -> None:
    assert _is_kmz_archive(_build_kmz_bytes()) is True


def test_normalize_generated_filename_appends_kmz_for_extensionless_kmz() -> None:
    normalized = _normalize_generated_filename("compiled_packets", _build_kmz_bytes())
    assert normalized == "compiled_packets.kmz"


def test_normalize_generated_filename_keeps_existing_extension() -> None:
    normalized = _normalize_generated_filename("compiled_packets.kmz", _build_kmz_bytes())
    assert normalized == "compiled_packets.kmz"

