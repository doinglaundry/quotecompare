import json
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Request

from backend.modules import analysis, reports
from backend.providers import PRESETS, parse_result
from backend.schemas import ApiError, dump, error_payload, fingerprint, identifier, now, uid, validate

router = APIRouter()
ACTIVE = ('queued', 'running', 'cancel_requested')


def job_view(row):
    return {key: row[key] for key in ('id', 'project_id', 'kind', 'state', 'stage', 'completed_units', 'total_units', 'created_at', 'updated_at')} | {
        'result': json.loads(row['result_json']) if row['result_json'] else None, 'error': json.loads(row['error_json']) if row['error_json'] else None}


class Jobs:
    def __init__(self, state):
        self.state = state
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='quotecompare')
        with state.db.transaction():
            state.db.connection.execute("UPDATE jobs SET state='interrupted',stage='应用退出时中断；需手动重试',updated_at=? WHERE state IN ('queued','running','cancel_requested')", (now(),))
            state.db.connection.execute("UPDATE quotes SET status=CASE WHEN reviewed_facts_json='[]' THEN 'imported' ELSE 'review_required' END WHERE status='extracting'")

    def close(self):
        self.pool.shutdown(wait=True, cancel_futures=True)

    def update(self, job_id, **fields):
        with self.state.db.transaction():
            self.state.db.update('jobs', job_id, {**fields, 'updated_at': now()})

    def cancelled(self, job_id):
        return self.state.db.get('jobs', job_id)['state'] == 'cancel_requested'

    def require_active(self, job_id):
        if self.cancelled(job_id):
            raise ApiError(409, '任务已取消；已发生的调用仍可能计费', 'CANCELLED')

    def generate(self, job, payload, schema):
        self.require_active(job['id'])
        config = self.state.settings.read()
        if config['revision'] != job['connection_generation']:
            raise ApiError(409, '模型设置已变化', 'STALE_REVISION')
        key = self.state.settings.key(config)
        if not key:
            raise ApiError(422, '请先在设置中填写 API Key', 'KEY_REQUIRED')
        # Persist a pending billable call before the network request; a crash leaves an honest unknown record.
        call_id = self.state.settings.record(job, (None, None, None), {}, 'unknown')
        usage, raw, outcome = (None, None, None), {}, 'unknown'
        try:
            text, usage, raw = self.state.providers.generate(job['provider'], key, payload, schema)
            outcome = 'failed'
            self.require_active(job['id'])
            result = parse_result(text, schema)
            outcome = 'succeeded'
            return result
        except ApiError as error:
            if error.code == 'CANCELLED':
                outcome = 'cancelled'
            elif error.code == 'MODEL_HTTP_ERROR':
                outcome = 'failed'
            raise
        finally:
            self.state.settings.record(job, usage, raw, outcome, call_id)

    def run(self, job_id):
        job = self.state.db.get('jobs', job_id)
        body = json.loads(job['input_json'])
        try:
            self.require_active(job_id)
            self.update(job_id, state='running', stage='处理中')
            if job['kind'] == 'extraction':
                self.extract(job, body)
                return
            if job['kind'] == 'alignment':
                project = body['frozen_project']
                quotes = body['frozen_quotes']
                payload = {'purpose': 'alignment', 'rules': '汇总全部字段，每个字段恰好出现一次。同义字段仅在完整 signature 一致时归并，含义不明确保留独立字段。不得改变事实，status=suggested。',
                           'quotes': [{'quote_id': quote['id'], 'facts': json.loads(quote['reviewed_facts_json'])} for quote in quotes]}
                if self.state.db.get('projects', project['id'])['revision'] != body['expected_revision']:
                    raise ApiError(409, '项目已修改，请重新汇总字段', 'STALE_REVISION')
                result = self.generate(job, payload, analysis.ALIGNMENT_SCHEMA)
                for group in result['groups']:
                    group['status'] = 'suggested'
                analysis.check_groups(quotes, result['groups'])
                with self.state.db.transaction():
                    self.require_active(job_id)
                    revision = self.state.db.bump(project['id'], body['expected_revision'], invalidate=False)
                    self.state.db.update('projects', project['id'], {'field_groups_json': dump(result['groups']), 'mappings_revision': revision})
                result = {'mappings_revision': revision}
            elif job['kind'] == 'draft':
                payload = reports.draft_input(self.state, body)
                draft = self.generate(job, payload, reports.DRAFT_SCHEMA)
                draft_id = uid()
                with self.state.db.transaction():
                    self.require_active(job_id)
                    self.state.db.insert('drafts', {'id': draft_id, 'project_id': job['project_id'], 'comparison_id': body['comparison_id'],
                        'quote_id': body['quote_id'], 'language': body['language'], 'question_ids_json': dump(body['question_ids']), **draft, 'updated_at': now()})
                result = {'draft_ids': [draft_id]}
            elif job['kind'] == 'report':
                result = reports.render_report(self.state, body, job_id)
                self.require_active(job_id)
            else:
                self.generate(job, {'purpose': 'connection_test', 'instruction': '返回 {"ok":true}'},
                    {'type': 'object', 'properties': {'ok': {'const': True}}, 'required': ['ok'], 'additionalProperties': False})
                result = {'test_succeeded': True, 'message': '连接成功；测试会产生少量用量'}
            with self.state.db.transaction():
                self.require_active(job_id)
                self.state.db.update('jobs', job_id, {'state': 'succeeded', 'stage': '完成', 'completed_units': job['total_units'], 'result_json': dump(result), 'updated_at': now()})
        except Exception as error:
            error = error if isinstance(error, ApiError) else ApiError(500, '任务处理失败；请检查文件和输入后重试', 'JOB_FAILED')
            cancelled = self.cancelled(job_id)
            self.update(job_id, state='cancelled' if cancelled else 'failed', stage='已取消' if cancelled else '失败', error_json=dump(error_payload(error)))
            if job['kind'] == 'report':
                self.state.files.remove_folder(job['project_id'], f'snapshots/{body["comparison_id"]}/reports/{job_id}')

    def extract(self, job, body):
        revision = body['expected_revision']
        succeeded, failures = [], []
        for index, quote_id in enumerate(body['quote_ids']):
            self.require_active(job['id'])
            quote = next(quote for quote in body['frozen_quotes'] if quote['id'] == quote_id)
            project = body['frozen_project']
            self.update(job['id'], stage=f'提取第 {index + 1}/{len(body["quote_ids"])} 份报价')
            try:
                with self.state.db.transaction():
                    if self.state.db.get('projects', project['id'])['revision'] != revision:
                        raise ApiError(409, '项目已修改，旧提取结果不能写入', 'STALE_REVISION')
                    self.state.db.update('quotes', quote_id, {'status': 'extracting'})
                result = self.generate(job, analysis.extraction_input(project, quote), analysis.EXTRACTION_SCHEMA)
                analysis.validate_extraction(quote, result)
                with self.state.db.transaction():
                    self.require_active(job['id'])
                    revision = self.state.db.bump(project['id'], revision)
                    self.state.db.update('quotes', quote_id, {'extraction_json': dump({**result, 'model_id': job['model_id'], 'prompt_version': '1'}),
                        'reviewed_facts_json': dump(result['facts']), 'warnings_json': dump(result['warnings']), 'contractor_name': quote['contractor_name'] or result['contractor_name'],
                        'status': 'review_required', 'updated_at': now()})
                succeeded.append(quote_id)
            except Exception as error:
                error = error if isinstance(error, ApiError) else ApiError(502, '提取结果未能保存，请核对内容后重试', 'EXTRACTION_FAILED')
                with self.state.db.transaction():
                    current = self.state.db.get('quotes', quote_id)
                    if current['status'] == 'extracting':
                        self.state.db.update('quotes', quote_id, {'status': quote['status'] if json.loads(current['reviewed_facts_json']) else 'failed'})
                if error.code in ('CANCELLED', 'STALE_REVISION'):
                    raise
                failures.append(f'{quote["contractor_name"] or quote_id}：{error.message}')
            self.update(job['id'], completed_units=index + 1, result_json=dump({'quote_ids': succeeded}))
        with self.state.db.transaction():
            self.require_active(job['id'])
            self.state.db.update('jobs', job['id'], {'state': ('partial_failed' if succeeded else 'failed') if failures else 'succeeded',
                'stage': '部分失败' if failures else '完成', 'result_json': dump({'quote_ids': succeeded, 'message': '\n'.join(failures)}), 'updated_at': now(),
                'error_json': dump(error_payload(ApiError(502, '\n'.join(failures), 'EXTRACTION_FAILED'))) if failures else None})


@router.post('/jobs', status_code=202)
async def create_job(request: Request):
    state = request.app.state.context
    body = validate('JobCreate', await request.json())
    identifier(body['request_id'])
    digest = fingerprint(body)
    with state.db.transaction():
        previous = state.db.rows('SELECT * FROM jobs WHERE request_id=?', (body['request_id'],))
        if previous:
            if previous[0]['request_hash'] != digest:
                raise ApiError(409, '请求编号对应不同内容', 'IDEMPOTENCY_CONFLICT')
            return job_view(previous[0])
        config = state.settings.read()
        if body['kind'] == 'connection_test':
            if config['revision'] != body['expected_connection_revision']:
                raise ApiError(409, '模型设置已更新', 'STALE_REVISION')
        else:
            project = state.db.get('projects', body['project_id'])
            if body['kind'] in ('extraction', 'alignment'):
                if project['revision'] != body['expected_revision']:
                    raise ApiError(409, '项目已更新，请刷新', 'STALE_REVISION')
                quotes = state.db.rows('SELECT * FROM quotes WHERE project_id=?', (project['id'],))
                if body['kind'] == 'extraction':
                    selected = [quote for quote in quotes if quote['id'] in body['quote_ids']]
                    if len(selected) != len(body['quote_ids']):
                        raise ApiError(422, '报价编号重复或不属于当前项目')
                    if not body.get('replace_reviewed') and any(quote['status'] == 'reviewed' or any(fact['review_status'] == 'confirmed' or fact['origin'] == 'manual' for fact in json.loads(quote['reviewed_facts_json'])) for quote in selected):
                        raise ApiError(409, '重新提取会替换人工核对数据，请明确确认', 'REVIEWED_DATA_EXISTS')
                elif len(quotes) < 2 or any(not json.loads(quote['reviewed_facts_json']) for quote in quotes):
                    raise ApiError(422, '请先提取至少两份报价', 'NOT_READY')
            else:
                reports.snapshot(state, body['comparison_id'], body['project_id'])
                if body['kind'] == 'draft':
                    reports.draft_input(state, body)
        if body['kind'] != 'report' and not state.settings.key(config):
            raise ApiError(422, '请先在设置中填写 API Key', 'KEY_REQUIRED')
        stored = dict(body)
        if body['kind'] in ('extraction', 'alignment'):
            stored.update(frozen_project=project, frozen_quotes=selected if body['kind'] == 'extraction' else quotes)
        job_id = uid()
        ai = body['kind'] != 'report'
        state.db.insert('jobs', {'id': job_id, 'request_id': body['request_id'], 'request_hash': digest, 'project_id': body.get('project_id'), 'kind': body['kind'],
            'input_json': dump(stored), 'total_units': len(body['quote_ids']) if body['kind'] == 'extraction' else 1,
            'provider': config['provider'] if ai else None, 'model_id': PRESETS[config['provider']]['model'] if ai else None,
            'connection_generation': config['revision'] if ai else None, 'created_at': now(), 'updated_at': now()})
    state.jobs.pool.submit(state.jobs.run, job_id)
    return job_view(state.db.get('jobs', job_id))


@router.get('/jobs/{job_id}')
def get_job(job_id: str, request: Request):
    return job_view(request.app.state.context.db.get('jobs', job_id))


@router.post('/jobs/{job_id}/cancel')
def cancel_job(job_id: str, request: Request):
    state = request.app.state.context
    with state.db.transaction():
        row = state.db.get('jobs', job_id)
        if row['state'] in ACTIVE:
            state.db.update('jobs', job_id, {'state': 'cancel_requested', 'stage': '等待当前调用结束后取消', 'updated_at': now()})
    return get_job(job_id, request)
