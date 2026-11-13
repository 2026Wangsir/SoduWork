"""Bounded personal-library editors. Office exports are real OOXML packages."""
from io import BytesIO
import csv
from io import StringIO
from pathlib import PurePosixPath
from zipfile import BadZipFile, ZipFile

FORMATS = {
    'note': ('.md', 'text/markdown; charset=utf-8'),
    # Documents created in the library are deliberately plain text.  The
    # client chooses .txt by default and may opt into .md without introducing
    # an office-document dependency.
    'document': ('.txt', 'text/plain; charset=utf-8'),
    # Kept for content preview/edit compatibility with older uploaded .docx
    # records that use the historical ``document`` kind.
    'legacy_document': ('.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    'spreadsheet': ('.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    'presentation': ('.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
}


def editor_format(kind: str, filename: str, content_type: str = '') -> tuple[str, str | None]:
    """Select an editor by the actual extension before replacing any bytes."""
    extension = PurePosixPath(filename or '').suffix.lower()
    if kind == 'note' and extension in {'', '.md', '.txt'}:
        return kind, None
    if kind == 'document':
        if extension == '.docx':
            return 'legacy_document', None
        if extension in {'', '.md', '.txt'}:
            return kind, 'md' if extension == '.md' else 'txt'
        if content_type.startswith('text/') and extension not in {'.pdf', '.doc', '.rtf'}:
            return kind, 'txt'
    if kind == 'spreadsheet':
        if extension == '.xlsx':
            return kind, None
        if extension == '.csv':
            return 'csv', None
    if kind == 'presentation' and extension == '.pptx':
        return kind, None
    raise ValueError('此文件只支持预览和下载')


def _bounded_package(data):
    # A compressed upload can expand far beyond the editable download limit.
    try:
        with ZipFile(BytesIO(data)) as package:
            entries = package.infolist()
            if len(entries) > 2000 or sum(entry.file_size for entry in entries) > 32 * 1024 * 1024:
                raise ValueError('Editable content exceeds limit')
    except BadZipFile as exc:
        raise ValueError('此文件只支持预览和下载') from exc


def export(kind: str, title: str, content: str, text_format: str | None = None):
    if kind == 'csv':
        # The library editor uses a tab-delimited representation for CSV
        # files.  Parse that representation as TSV instead of splitting on
        # literal tabs and line breaks so quoted cell content survives a
        # read/edit/save round trip.
        reader = csv.reader(StringIO(content, newline=''), delimiter='\t', strict=True)
        out = StringIO(newline='')
        writer = csv.writer(out)
        for row_index, row in enumerate(reader):
            if row_index >= 5000 or len(row) > 100:
                raise ValueError('电子表格最多支持 5000 行和 100 列')
            writer.writerow(row)
        return out.getvalue().encode('utf-8'), '.csv', 'text/csv; charset=utf-8'
    suffix, mime = FORMATS[kind]
    out = BytesIO()
    if kind == 'document':
        if str(text_format or '').lower() == 'md':
            return content.encode('utf-8'), '.md', 'text/markdown; charset=utf-8'
        return content.encode('utf-8'), suffix, mime
    if kind == 'note':
        return content.encode('utf-8'), suffix, mime
    if kind == 'legacy_document':
        from docx import Document
        doc = Document()
        doc.core_properties.title = title
        for line in content.split('\n'):
            doc.add_paragraph(line)
        doc.save(out)
    elif kind == 'spreadsheet':
        from openpyxl import Workbook
        book = Workbook()
        sheet = book.active
        sheet.title = 'Sheet1'
        lines = content.splitlines()
        if len(lines) > 5000:
            raise ValueError('电子表格最多支持 5000 行')
        for row_index, line in enumerate(lines, 1):
            cells = line.split('\t')
            if len(cells) > 100:
                raise ValueError('电子表格最多支持 100 列')
            for column, value in enumerate(cells, 1):
                cell = sheet.cell(row_index, column, value)
                cell.data_type = 's'
        book.save(out)
    elif kind == 'presentation':
        from pptx import Presentation
        presentation = Presentation()
        pages = content.split('\n---\n')
        if len(pages) > 100:
            raise ValueError('演示文稿最多支持 100 页')
        for page in pages:
            lines = page.split('\n')
            slide = presentation.slides.add_slide(presentation.slide_layouts[1])
            slide.shapes.title.text = lines[0] or title
            slide.placeholders[1].text = '\n'.join(lines[1:])
        presentation.save(out)
    return out.getvalue(), suffix, mime


def read(kind: str, data: bytes) -> str:
    if kind in {'note', 'document'}:
        return data.decode('utf-8')
    if kind == 'csv':
        source = data.decode('utf-8-sig')
        reader = csv.reader(StringIO(source, newline=''))
        out = StringIO(newline='')
        writer = csv.writer(out, delimiter='\t', lineterminator='\n')
        for row_index, row in enumerate(reader):
            if row_index >= 5000 or len(row) > 100:
                raise ValueError('电子表格最多支持 5000 行和 100 列')
            writer.writerow(row)
        result = out.getvalue()
        # csv.writer terminates every logical row. The editor representation
        # historically omitted the final record terminator, so remove only
        # that writer-added byte; embedded newlines inside quoted cells stay
        # intact.
        if result.endswith('\n'):
            result = result[:-1]
        return result
    if kind in {'legacy_document', 'spreadsheet', 'presentation'}:
        _bounded_package(data)
    if kind == 'legacy_document':
        from docx import Document
        return '\n'.join(p.text for p in Document(BytesIO(data)).paragraphs)
    if kind == 'spreadsheet':
        from openpyxl import load_workbook
        book = load_workbook(BytesIO(data), read_only=True)
        try:
            sheet = book.active
            if not sheet or (sheet.max_row or 0) > 5000 or (sheet.max_column or 0) > 100:
                raise ValueError('电子表格最多支持 5000 行和 100 列')
            rows = []
            for row in sheet.iter_rows(values_only=True):
                if len(rows) >= 5000 or len(row) > 100:
                    raise ValueError('电子表格最多支持 5000 行和 100 列')
                rows.append('\t'.join(str(c) if c is not None else '' for c in row))
            return '\n'.join(rows)
        finally:
            book.close()
    if kind == 'presentation':
        from pptx import Presentation
        presentation = Presentation(BytesIO(data))
        if len(presentation.slides) > 100:
            raise ValueError('演示文稿最多支持 100 页')
        return '\n---\n'.join('\n'.join(shape.text for shape in slide.shapes if shape.has_text_frame)
                               for slide in presentation.slides)
    raise ValueError('此文件只支持预览和下载')
