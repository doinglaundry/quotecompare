import io

import pytest
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas

from backend.files import Files
from backend.modules.analysis import check_facts, check_groups
from backend.schemas import ApiError, dump
from backend.sources import read_source


def fact(fid='f1', quote='q1', kind='project_total', value='1200', tax='included'):
    return {'id': fid, 'raw_label': 'Total', 'raw_value': value, 'normalized_value': value,
            'value_type': 'decimal', 'semantic_kind': kind, 'entity_key': None,
            'unit': None, 'currency': 'GBP', 'tax_basis': tax, 'coverage': 'separate',
            'source_refs': [{'quote_id': quote, 'block_id': 'b1'}], 'origin': 'extracted', 'review_status': 'confirmed'}


def quote(qid, facts):
    return {'id': qid, 'source_blocks_json': dump([{'id': 'b1'}]),
            'extraction_json': dump({'facts': facts}), 'reviewed_facts_json': dump(facts)}


def group(facts):
    signature = {key: facts[0][1][key] for key in ('semantic_kind', 'entity_key', 'value_type', 'unit', 'currency', 'tax_basis', 'coverage')}
    return {'id': 'g1', 'label': '总价', 'signature': signature,
            'members': [{'quote_id': qid, 'fact_id': value['id']} for qid, value in facts],
            'status': 'confirmed', 'reason': '相同口径', 'display_order': 0}


def test_fields_preserve_original_and_forbid_forged_evidence():
    original = fact()
    row = quote('q1', [original])
    check_facts(row, [{**original, 'normalized_value': '1250'}])
    with pytest.raises(ApiError):
        check_facts(row, [{**original, 'raw_value': 'edited'}])
    with pytest.raises(ApiError):
        check_facts(row, [{**original, 'source_refs': [{'quote_id': 'q1', 'block_id': 'fake'}]}])
    with pytest.raises(ApiError):
        check_facts(row, [{**original, 'normalized_value': '£1,200'}])


def test_mapping_requires_full_coverage_and_matching_price_basis():
    a, b = fact('a'), fact('b', 'q2')
    rows = [quote('q1', [a]), quote('q2', [b])]
    check_groups(rows, [group([('q1', a), ('q2', b)])])
    with pytest.raises(ApiError):
        check_groups(rows, [group([('q1', a)])])
    with pytest.raises(ApiError):
        check_groups(rows, [group([('q1', a), ('q2', b)]), group([('q1', a)])])
    unit = {**b, 'semantic_kind': 'unit_price'}
    with pytest.raises(ApiError):
        check_groups([quote('q1', [a]), quote('q2', [unit])], [group([('q1', a), ('q2', unit)])])
    excluded = {**b, 'tax_basis': 'excluded'}
    with pytest.raises(ApiError):
        check_groups([quote('q1', [a]), quote('q2', [excluded])], [group([('q1', a), ('q2', excluded)])])


def test_pdf_and_real_macos_image_ocr(tmp_path):
    files = Files(tmp_path)
    pdf = io.BytesIO()
    document = canvas.Canvas(pdf)
    document.drawString(50, 750, 'Total GBP 1250')
    document.save()
    pdf_id = files.save('p', 'quotes/pdf/original.pdf', pdf.getvalue())
    blocks, pages, method = read_source(files, 'p', 'pdf', pdf_id, 'pdf')
    assert any('1250' in block['text'] for block in blocks)
    assert len(pages) == 1
    image = Image.new('RGB', (1800, 350), 'white')
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 100)
    draw.text((70, 90), 'Total GBP 2400', fill='black', font=font)
    data = io.BytesIO()
    image.save(data, format='PNG')
    image_id = files.save('p', 'quotes/image/original.png', data.getvalue())
    blocks, pages, method = read_source(files, 'p', 'image', image_id, 'image')
    assert any('2400' in block['text'] for block in blocks)
    assert method == 'vision_ocr'
    assert all(block['bbox'] is not None for block in blocks)


def test_pdf_page_limit_and_malformed_upload(tmp_path):
    files = Files(tmp_path)
    pdf = io.BytesIO()
    document = canvas.Canvas(pdf)
    for page in range(31):
        document.drawString(10, 10, str(page))
        document.showPage()
    document.save()
    file_id = files.save('p', 'quotes/long/original.pdf', pdf.getvalue())
    with pytest.raises(ApiError):
        read_source(files, 'p', 'long', file_id, 'pdf')
    malformed = files.save('p', 'quotes/bad/original.pdf', b'not PDF')
    with pytest.raises(ApiError):
        read_source(files, 'p', 'bad', malformed, 'pdf')
