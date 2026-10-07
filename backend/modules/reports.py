import copy
import csv
import html
import io
import json

from fastapi import APIRouter, Request
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

from backend.schemas import ApiError, now, validate

router = APIRouter()
DRAFT_SCHEMA = {'type': 'object', 'properties': {'subject': {'type': 'string', 'maxLength': 500}, 'body': {'type': 'string', 'maxLength': 20000}}, 'required': ['subject', 'body'], 'additionalProperties': False}


def load_snapshot(state, comparison_id, project_id):
    row = state.db.get('comparisons', comparison_id)
    if row['project_id'] != project_id:
        raise ApiError(404, '对比记录不属于当前项目', 'NOT_FOUND')
    return json.loads(row['snapshot_json'])


def draft_view(row):
    return {key: row[key] for key in ('id', 'project_id', 'comparison_id', 'quote_id', 'language', 'subject', 'body', 'revision', 'updated_at')} | {'question_ids': json.loads(row['question_ids_json'])}


@router.get('/drafts/{draft_id}')
def get_draft(draft_id: str, request: Request):
    return draft_view(request.app.state.context.db.get('drafts', draft_id))


@router.patch('/drafts/{draft_id}')
async def save_draft(draft_id: str, request: Request):
    state = request.app.state.context
    body = validate('DraftUpdate', await request.json())
    if len(body) == 1:
        raise ApiError(400, '没有要保存的修改')
    with state.db.transaction():
        row = state.db.get('drafts', draft_id)
        if row['revision'] != body.pop('expected_revision'):
            raise ApiError(409, '草稿已更新，请刷新', 'STALE_REVISION')
        state.db.update('drafts', draft_id, {**body, 'revision': row['revision'] + 1, 'updated_at': now()})
    return get_draft(draft_id, request)


def draft_input(state, body):
    data = load_snapshot(state, body['comparison_id'], body['project_id'])
    columns = {column['quote_id']: column for column in data['comparison']['columns']}
    if body['quote_id'] not in columns:
        raise ApiError(404, '承包商不属于该对比快照', 'NOT_FOUND')
    questions = {question['id']: question for question in data['questions'] if question['quote_id'] == body['quote_id']}
    if len(set(body['question_ids'])) != len(body['question_ids']) or not set(body['question_ids']) <= set(questions):
        raise ApiError(422, '追问问题不属于当前承包商')
    return {'purpose': 'draft', 'language': body['language'], 'contractor': columns[body['quote_id']]['contractor_name'],
            'project_name': data['project']['name'], 'questions': [questions[key]['text'] for key in body['question_ids']],
            'rules': '仅根据所选问题拟写礼貌的邮件，不添加新的事实或承诺，不实际发送邮件。'}


def report_sections(data, options):
    data = copy.deepcopy(data)
    property_name = data['project']['property']
    if options.get('hide_property') and property_name:
        # Redact every report string, including original-text appendix and AI-generated questions.
        def redact(value):
            if isinstance(value, str):
                return value.replace(property_name, '[房产信息已隐藏]')
            if isinstance(value, list):
                return [redact(item) for item in value]
            if isinstance(value, dict):
                return {key: redact(item) for key, item in value.items()}
            return value
        data = redact(data)
        data['project']['property'] = None
    comparison = data['comparison']
    columns = comparison['columns']
    contractor_names = {column['quote_id']: column['contractor_name'] for column in columns}
    table = [['统一字段 / 口径', *[column['contractor_name'] + '\n' + (column.get('currency') or '币种未注明') for column in columns]]]
    for row in comparison['rows']:
        cells = {cell['quote_id']: cell for cell in row['cells']}
        basis = row.get('signature', {})
        kind = {'project_total': '总价', 'line_total': '分项金额', 'unit_price': '单价', 'quantity': '数量', 'material': '材料', 'scope': '施工范围', 'term': '条款', 'tax': '税费', 'other': '其他'}.get(basis.get('semantic_kind'), '')
        tax = {'included': '含税', 'excluded': '未含税', 'unknown': '税费未注明', 'not_applicable': '税费不适用'}.get(basis.get('tax_basis'), '')
        caption = ' · '.join(value for value in [kind, basis.get('entity_key'), basis.get('unit'), basis.get('currency'), tax, {'separate':'独立项目','bundled':'打包包含','unknown':'包含范围未注明','not_applicable':'范围不适用'}.get(basis.get('coverage'))] if value)
        values = []
        for column in columns:
            cell = cells[column['quote_id']]
            status = {'pending': '待确认', 'bundled': '打包包含', 'not_comparable': '不能直接比较'}.get(cell.get('state'))
            values.append(cell['display_value'] + ('（' + status + '）' if status else ''))
        table.append([row['label'] + ('\n' + caption if caption else ''), *values])
    sections = [('项目', [data['project']['name'], data['project']['property'] or '', data['project']['scope'],
                         '比较币种：' + data['project']['currency'], '快照时间：' + comparison['created_at'], comparison['summary']]),
                ('缺失与风险提示', [flag['message'] for flag in data['flags']])]
    if options.get('include_questions'):
        sections.append(('承包商追问', [contractor_names[question['quote_id']] + '：' + question['text'] for question in data['questions']]))
    if options.get('include_sources'):
        sections.append(('原文依据（文字）', [f'{source["contractor_name"] or source["quote_id"]} · 第 {block["page"] or "文字"} 页：{block["text"]}'
                                          for source in data['sources'] for block in source['blocks']]))
    return table, sections


def render_report(state, body, job_id):
    data = load_snapshot(state, body['comparison_id'], body['project_id'])
    table, sections = report_sections(data, body['report_options'])
    escape = html.escape
    preview = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{font:15px -apple-system,sans-serif;max-width:1100px;margin:40px;color:#163c37}table{border-collapse:collapse;width:100%}td,th{padding:12px;border:1px solid #ddd}th{background:#e8f3ef}p{white-space:pre-wrap}</style><h1>报价对比报告</h1>'
    preview += '<table>' + ''.join('<tr>' + ''.join('<' + ('th' if index == 0 else 'td') + '>' + escape(cell) + '</' + ('th' if index == 0 else 'td') + '>' for cell in row) + '</tr>' for index, row in enumerate(table)) + '</table>'
    for title, lines in sections:
        preview += '<h2>' + escape(title) + '</h2>' + ''.join('<p>' + escape(line) + '</p>' for line in lines if line)
    preview += '</html>'
    relative = f'snapshots/{body["comparison_id"]}/reports/{job_id}'
    preview_id = state.files.save(body['project_id'], relative + '/preview.html', preview.encode(), 'text/html')
    output = io.BytesIO()
    if body['report_options']['format'] == 'csv':
        text = io.StringIO(newline='')
        writer = csv.writer(text)
        def safe(value):
            return "'" + value if value.lstrip().startswith(('=', '+', '-', '@', '\t', '\r')) else value
        for row in table:
            writer.writerow([safe(cell) for cell in row])
        for title, lines in sections:
            writer.writerow([])
            writer.writerow([title])
            for line in lines:
                writer.writerow([safe(line)])
        contents, mime, extension = text.getvalue().encode('utf-8-sig'), 'text/csv', 'csv'
    else:
        pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
        styles = getSampleStyleSheet()
        for style in styles.byName.values():
            style.fontName = 'STSong-Light'
        styles['BodyText'].wordWrap = 'CJK'
        paragraph = lambda value: Paragraph(escape(value).replace('\n', '<br/>'), styles['BodyText'])
        document = SimpleDocTemplate(output, pagesize=(842, 595), leftMargin=30, rightMargin=30, topMargin=30, bottomMargin=30)
        story = [Paragraph('报价对比报告', styles['Title']), Spacer(1, 12)]
        grid = Table([[paragraph(cell) for cell in row] for row in table], colWidths=[782 / len(table[0])] * len(table[0]), repeatRows=1, splitInRow=1)
        grid.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#e8f3ef')), ('GRID', (0, 0), (-1, -1), .5, colors.lightgrey), ('VALIGN', (0, 0), (-1, -1), 'TOP'), ('BOTTOMPADDING', (0, 0), (-1, -1), 8)]))
        story.append(grid)
        for title, lines in sections:
            story.extend([Spacer(1, 14), Paragraph(title, styles['Heading2'])])
            story.extend(paragraph(line) for line in lines if line)
        document.build(story)
        contents, mime, extension = output.getvalue(), 'application/pdf', 'pdf'
    report_id = state.files.save(body['project_id'], relative + '/report.' + extension, contents, mime)
    return {'preview_file_id': preview_id, 'report_file_id': report_id}
