"""Real Office-package regressions, including hostile editable sizes."""
import csv
import io
import unittest
from zipfile import ZIP_DEFLATED, ZipFile

from app.services import library_formats


class LibraryFormatsTests(unittest.TestCase):
    def test_csv_round_trip_preserves_embedded_newlines_tabs_commas_and_quotes(self):
        original = 'name,description\r\nAlice,"line1\nline2\twith, a comma and ""quotes"""\r\n'

        editor_content = library_formats.read('csv', original.encode('utf-8'))
        self.assertEqual(
            editor_content,
            'name\tdescription\nAlice\t"line1\nline2\twith, a comma and ""quotes"""',
        )

        saved, suffix, mime = library_formats.export('csv', 'sample', editor_content)
        self.assertEqual(suffix, '.csv')
        self.assertEqual(mime, 'text/csv; charset=utf-8')
        self.assertEqual(
            list(csv.reader(io.StringIO(saved.decode('utf-8'), newline=''))),
            list(csv.reader(io.StringIO(original, newline=''))),
        )

    def test_formula_like_spreadsheet_values_are_exported_as_literal_text(self):
        from openpyxl import load_workbook
        data, suffix, mime = library_formats.export("spreadsheet", "cells", "=1+1\t@SUM(A1:A9)")
        book = load_workbook(io.BytesIO(data))
        try:
            self.assertEqual(suffix, ".xlsx")
            self.assertEqual(book.active["A1"].value, "=1+1")
            self.assertEqual(book.active["A1"].data_type, "s")
        finally:
            book.close()

    def test_presentation_without_title_or_body_placeholder_is_readable(self):
        from pptx import Presentation
        from pptx.util import Inches
        presentation = Presentation()
        slide = presentation.slides.add_slide(presentation.slide_layouts[6])
        slide.shapes.add_textbox(Inches(1), Inches(1), Inches(3), Inches(1)).text = "No placeholders"
        stream = io.BytesIO()
        presentation.save(stream)
        self.assertEqual(library_formats.read("presentation", stream.getvalue()), "No placeholders")

    def test_oversized_spreadsheet_dimensions_and_zip_expansion_are_rejected(self):
        from openpyxl import Workbook
        book = Workbook()
        book.active.cell(5001, 1, "too many rows")
        stream = io.BytesIO()
        book.save(stream)
        with self.assertRaises(ValueError):
            library_formats.read("spreadsheet", stream.getvalue())
        stream = io.BytesIO()
        with ZipFile(stream, "w", compression=ZIP_DEFLATED) as archive:
            archive.writestr("document.xml", b"x" * (32 * 1024 * 1024 + 1))
        for kind in ("legacy_document", "spreadsheet", "presentation"):
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, "exceeds limit"):
                library_formats.read(kind, stream.getvalue())


if __name__ == "__main__":
    unittest.main()
