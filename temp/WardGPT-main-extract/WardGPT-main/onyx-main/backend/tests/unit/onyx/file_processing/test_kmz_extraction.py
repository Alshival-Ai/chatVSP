from io import BytesIO
import zipfile

from onyx.file_processing.extract_file_text import extract_file_text


def _make_kmz(kml_name: str, kml_text: str) -> BytesIO:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(kml_name, kml_text)
    buffer.seek(0)
    return buffer


def test_extract_file_text_reads_doc_kml_from_kmz() -> None:
    kmz = _make_kmz("doc.kml", "<kml><Placemark><name>P1</name></Placemark></kml>")
    text = extract_file_text(kmz, "map.kmz", break_on_unprocessable=False)
    assert "Placemark" in text
    assert "P1" in text


def test_extract_file_text_falls_back_to_first_kml_in_kmz() -> None:
    kmz = _make_kmz(
        "nested/alternate.kml",
        "<kml><Placemark><name>P5</name></Placemark></kml>",
    )
    text = extract_file_text(kmz, "map.kmz", break_on_unprocessable=False)
    assert "Placemark" in text
    assert "P5" in text
