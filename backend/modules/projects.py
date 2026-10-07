import hashlib
import json

from fastapi import APIRouter, Request, Response

from backend.schemas import ApiError, dump, fingerprint, identifier, now, uid, validate

router = APIRouter()


def project_view(row):
    return {key: row[key] for key in ('id', 'name', 'property', 'scope', 'currency', 'status', 'revision', 'created_at', 'updated_at')}


def quote_summary(row):
    return {key: row[key] for key in ('id', 'project_id', 'contractor_name', 'filename', 'source_type', 'page_count', 'status')}


def quote_view(state, row):
    extraction = json.loads(row['extraction_json'])
    return {**quote_summary(row), 'project_revision': state.db.get('projects', row['project_id'])['revision'],
            'original_file_id': row['file_ref'], 'page_file_ids': json.loads(row['page_file_ids_json']),
            'source_blocks': json.loads(row['source_blocks_json']), 'extracted_facts': extraction.get('facts', []),
            'facts': json.loads(row['reviewed_facts_json']), 'warnings': json.loads(row['warnings_json'])}


def check_busy(state, project_id):
    running = state.db.rows("SELECT id FROM jobs WHERE project_id=? AND state IN ('queued','running','cancel_requested')", (project_id,))
    if running:
        raise ApiError(409, '请先等待或取消当前任务', 'PROJECT_BUSY')


@router.get('/projects')
def list_projects(request: Request, cursor: str | None = None, limit: int = 20):
    if not 1 <= limit <= 100:
        raise ApiError(400, '每页数量应为 1–100')
    rows = request.app.state.context.db.rows('SELECT * FROM projects WHERE id>? ORDER BY id LIMIT ?', (cursor or '', limit + 1))
    return {'items': [project_view(row) for row in rows[:limit]], 'next_cursor': rows[limit - 1]['id'] if len(rows) > limit else None}


@router.post('/projects', status_code=201)
async def create_project(request: Request):
    state = request.app.state.context
    body = validate('ProjectCreate', await request.json())
    project_id = identifier(body['request_id'])
    values = {'name': body['name'], 'property': body.get('property'), 'scope': body['scope'], 'currency': body['currency']}
    request_hash = fingerprint(values)
    with state.db.transaction():
        existing = state.db.rows('SELECT * FROM projects WHERE id=?', (project_id,))
        if existing:
            if existing[0]['request_hash'] != request_hash:
                raise ApiError(409, '同一请求编号对应不同内容', 'IDEMPOTENCY_CONFLICT')
            return project_view(existing[0])
        state.db.insert('projects', {'id': project_id, **values, 'request_hash': request_hash, 'created_at': now(), 'updated_at': now()})
        return project_view(state.db.get('projects', project_id))


@router.get('/projects/{project_id}')
def get_project(project_id: str, request: Request):
    state = request.app.state.context
    row = state.db.get('projects', project_id)
    quotes = state.db.rows('SELECT * FROM quotes WHERE project_id=? ORDER BY created_at,id', (project_id,))
    return {**project_view(row), 'quotes': [quote_summary(quote) for quote in quotes],
            'field_groups': json.loads(row['field_groups_json']), 'mappings_revision': row['mappings_revision']}


@router.patch('/projects/{project_id}')
async def update_project(project_id: str, request: Request):
    state = request.app.state.context
    body = validate('ProjectUpdate', await request.json())
    if len(body) == 1:
        raise ApiError(400, '没有要保存的修改')
    with state.db.transaction():
        state.db.advance_revision(project_id, body.pop('expected_revision'))
        state.db.update('projects', project_id, body)
        return project_view(state.db.get('projects', project_id))


@router.delete('/projects/{project_id}', status_code=204)
def delete_project(project_id: str, expected_revision: int, request: Request):
    state = request.app.state.context
    with state.db.transaction():
        check_busy(state, project_id)
        state.db.advance_revision(project_id, expected_revision)
        state.db.connection.execute('DELETE FROM projects WHERE id=?', (project_id,))
        state.files.remove_project(project_id)
    return Response(status_code=204)


@router.post('/projects/{project_id}/quotes', status_code=201)
async def import_quote(project_id: str, request: Request):
    state = request.app.state.context
    form = await request.form(max_part_size=50 * 1024 * 1024 + 1)
    upload = form.get('file')
    body = dict(form)
    body['expected_revision'] = int(body.get('expected_revision', '0'))
    if upload is not None:
        body['file'] = 'binary'
    validate('QuoteImport', body)
    quote_id = identifier(body['request_id'])
    source_type = body['source_type']
    content = await upload.read(50 * 1024 * 1024 + 1) if upload is not None else body['text'].encode()
    if len(content) > 50 * 1024 * 1024:
        raise ApiError(413, '单个文件不能超过 50MB', 'LIMIT_EXCEEDED')
    content_hash = hashlib.sha256(content).hexdigest()
    request_hash = fingerprint({'hash': content_hash, 'project_id': project_id,
                             'source_type': source_type, 'contractor_name': body.get('contractor_name')})
    with state.db.transaction():
        existing = state.db.rows('SELECT * FROM quotes WHERE id=?', (quote_id,))
        if existing:
            if existing[0]['request_hash'] != request_hash:
                raise ApiError(409, '同一请求编号对应不同报价', 'IDEMPOTENCY_CONFLICT')
            return quote_view(state, existing[0])
        project = state.db.get('projects', project_id)
        if project['revision'] != body['expected_revision']:
            raise ApiError(409, '项目已更新，请刷新后重试', 'STALE_REVISION')
        quotes = state.db.rows('SELECT id FROM quotes WHERE project_id=?', (project_id,))
        if len(quotes) >= 5:
            raise ApiError(422, '一个项目最多五份报价', 'QUOTE_LIMIT')
        duplicate = state.db.rows('SELECT id FROM quotes WHERE project_id=? AND content_sha256=?', (project_id, content_hash))
        if duplicate:
            raise ApiError(409, '这份报价已经导入', 'DUPLICATE_QUOTE')
        extension = {'text': 'txt', 'pdf': 'pdf', 'image': 'png'}[source_type]
        original = state.files.save(project_id, f'quotes/{quote_id}/original.{extension}', content)
        if source_type == 'text':
            blocks = [{'id': uid(), 'page': None, 'text': body['text'], 'bbox': None, 'ocr_confidence': None}]
            pages = []
            method = 'paste'
        else:
            from backend.sources import read_source
            try:
                blocks, pages, method = read_source(state.files, project_id, quote_id, original, source_type)
            except Exception:
                state.files.remove_folder(project_id, f'quotes/{quote_id}')
                raise
        state.db.insert('quotes', {'id': quote_id, 'project_id': project_id, 'contractor_name': body.get('contractor_name'),
                                   'filename': upload.filename if upload is not None else None, 'source_type': source_type,
                                   'content_sha256': content_hash, 'file_ref': original,
                                   'page_count': len(pages), 'source_method': method, 'request_hash': request_hash,
                                   'source_blocks_json': dump(blocks), 'page_file_ids_json': dump(pages)})
        state.db.advance_revision(project_id, body['expected_revision'])
        return quote_view(state, state.db.get('quotes', quote_id))


@router.get('/quotes/{quote_id}')
def get_quote(quote_id: str, request: Request):
    state = request.app.state.context
    return quote_view(state, state.db.get('quotes', quote_id))


@router.patch('/quotes/{quote_id}')
async def update_quote(quote_id: str, request: Request):
    state = request.app.state.context
    body = validate('QuoteUpdate', await request.json())
    with state.db.transaction():
        quote = state.db.get('quotes', quote_id)
        fields = {}
        if 'contractor_name' in body:
            fields['contractor_name'] = body['contractor_name']
        if 'facts' in body:
            from backend.modules.analysis import check_facts
            check_facts(quote, body['facts'])
            fields.update(reviewed_facts_json=dump(body['facts']), status='reviewed')
        if not fields:
            raise ApiError(400, '没有要保存的修改')
        fields['updated_at'] = now()
        state.db.advance_revision(quote['project_id'], body['expected_revision'])
        state.db.update('quotes', quote_id, fields)
        return quote_view(state, state.db.get('quotes', quote_id))


@router.delete('/quotes/{quote_id}', status_code=204)
def delete_quote(quote_id: str, expected_revision: int, request: Request):
    state = request.app.state.context
    with state.db.transaction():
        quote = state.db.get('quotes', quote_id)
        check_busy(state, quote['project_id'])
        state.db.advance_revision(quote['project_id'], expected_revision)
        state.db.connection.execute('DELETE FROM quotes WHERE id=?', (quote_id,))
        state.files.remove_folder(quote['project_id'], f'quotes/{quote_id}')
    return Response(status_code=204)
