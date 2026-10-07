import hashlib
import json
import threading
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from fastapi import APIRouter, Request

from backend.files import atomic_write
from backend.providers import PRESETS
from backend.schemas import ApiError, dump, now, uid, validate

router = APIRouter()
PRICE_DATE = '2026-10-07T00:00:00+00:00'


class Keychain:
    def __init__(self, directory):
        from keyring.backends.macOS import Keyring
        self.keyring = Keyring()
        self.service = 'com.quotecompare.' + hashlib.sha256(str(directory).encode()).hexdigest()[:16]

    def get(self, account):
        return self.keyring.get_password(self.service, account)

    def set(self, account, value):
        self.keyring.set_password(self.service, account, value)

    def delete(self, account):
        if self.get(account) is not None:
            self.keyring.delete_password(self.service, account)


class SettingsStore:
    def __init__(self, state):
        self.state = state
        self.lock = threading.RLock()
        self.path = state.directory / 'settings.json'
        self.balance_cache = None

    def read(self):
        if self.path.exists():
            return json.loads(self.path.read_text())
        return {'provider': 'openai', 'revision': 1, 'key_hint': None, 'account': None}

    def key(self, config=None):
        config = config or self.read()
        return self.state.secrets.get(config['account']) if config['account'] else None

    def pricing(self, provider):
        preset = PRESETS[provider]
        rates = preset['rates']
        stale = datetime.now(timezone.utc) - datetime.fromisoformat(PRICE_DATE) > timedelta(days=7)
        if provider == 'deepseek':
            tiers = [{'name': name, 'currency': 'USD', 'input_per_million': values[0], 'cached_input_per_million': values[1], 'output_per_million': values[2], 'conditions': condition} for name, values, condition in [('高峰', ['0.3','0.006','1.2'], '工作日 UTC 01–04、06–10，中国法定节假日除外'), ('低峰', ['0.15','0.003','0.6'], '其他时间；应用无法核验节假日，不估算调用费用')]]
            return {'provider': provider, 'model_id': preset['model'], 'status': 'stale' if stale else 'known', 'version': '2026-10-07-standard', 'checked_at': PRICE_DATE, 'tiers': tiers, 'official_url': preset['price_url']}
        return {'provider': provider, 'model_id': preset['model'], 'status': ('stale' if stale else 'known') if rates else 'unknown',
                'version': '2026-10-07-standard' if rates else None, 'checked_at': PRICE_DATE if rates else None,
                'tiers': [{'name': '标准文本请求', 'currency': 'USD', 'input_per_million': rates[0], 'cached_input_per_million': rates[1], 'output_per_million': rates[2], 'conditions': '普通同步文本请求；不含批处理、工具和显式缓存写入'}] if rates else [], 'official_url': preset['price_url']}

    def view(self):
        config = self.read()
        return {key: config[key] for key in ('provider', 'revision', 'key_hint')} | {
            'has_key': bool(self.key(config)), 'model_id': PRESETS[config['provider']]['model'], 'pricing': self.pricing(config['provider'])}

    def save(self, body):
        with self.lock, self.state.db.transaction():
            old = self.read()
            if old['revision'] != body['expected_revision']:
                raise ApiError(409, '模型设置已更新，请刷新', 'STALE_REVISION')
            busy = self.state.db.rows("SELECT id FROM jobs WHERE kind<>'report' AND state IN ('queued','running','cancel_requested')")
            if busy:
                raise ApiError(409, '请等待或取消模型任务后再修改设置', 'SETTINGS_BUSY')
            provider = body['provider']
            key = body.get('api_key') if 'api_key' in body else self.key(old) if old['provider'] == provider else None
            if isinstance(key, str):
                key = key.strip()
                if not key:
                    raise ApiError(400, 'API Key 不能为空')
            account = uid() if key else None
            new = {'provider': provider, 'revision': old['revision'] + 1, 'account': account, 'key_hint': key[-4:] if key else None}
            try:
                if key:
                    self.state.secrets.set(account, key)
                atomic_write(self.path, dump(new).encode())
            except Exception:
                if account:
                    self.state.secrets.delete(account)
                raise ApiError(503, '无法保存至 macOS 钥匙串，请检查授权', 'KEYCHAIN_UNAVAILABLE') from None
            if old['account']:
                self.state.secrets.delete(old['account'])
            self.balance_cache = None
            return self.view()

    def record(self, job, usage, raw, outcome, call_id=None):
        input_tokens, output_tokens, cached = usage
        known = all(type(value) is int and value >= 0 for value in (input_tokens, output_tokens))
        cached = cached if type(cached) is int and cached >= 0 and known and cached <= input_tokens else None
        if not known:
            input_tokens, output_tokens = None, None
        pricing = self.pricing(job['provider'])
        amount = None
        if known and cached is not None and pricing['status'] == 'known' and len(pricing['tiers']) == 1:
            rates = pricing['tiers'][0]
            amount = format((Decimal(input_tokens - cached) * Decimal(rates['input_per_million']) + Decimal(cached) * Decimal(rates['cached_input_per_million']) + Decimal(output_tokens) * Decimal(rates['output_per_million'])) / 1000000, 'f')
        with self.state.db.transaction():
            fields = {'id': call_id or uid(), 'job_id': job['id'], 'project_id': job['project_id'], 'provider': job['provider'], 'model_id': job['model_id'],
                'connection_generation': job['connection_generation'], 'credential_scope': 'saved', 'purpose': job['kind'], 'outcome': outcome,
                'input_tokens': input_tokens, 'output_tokens': output_tokens, 'cached_input_tokens': cached, 'usage_known': int(known),
                'estimated_cost_amount': amount, 'estimated_cost_currency': 'USD' if amount is not None else None,
                'pricing_version': pricing['version'] if amount is not None else None, 'raw_usage_json': dump(raw), 'created_at': now()}
            if call_id:
                fields.pop('id')
                fields.pop('created_at')
                self.state.db.update('usage_calls', call_id, fields)
            else:
                self.state.db.insert('usage_calls', fields)
            return call_id or fields['id']


@router.get('/settings')
def get_settings(request: Request):
    return request.app.state.context.settings.view()


@router.put('/settings')
async def save_settings(request: Request):
    return request.app.state.context.settings.save(validate('SettingsSave', await request.json()))


def call_view(row):
    result = {key: row[key] for key in ('id', 'job_id', 'project_id', 'provider', 'model_id', 'connection_generation', 'credential_scope', 'purpose', 'outcome', 'input_tokens', 'output_tokens', 'cached_input_tokens', 'pricing_version', 'created_at')}
    result['usage_known'] = bool(row['usage_known'])
    result['estimated_cost'] = {'amount': row['estimated_cost_amount'], 'currency': row['estimated_cost_currency']} if row['estimated_cost_amount'] is not None else None
    return result


@router.get('/usage')
def get_usage(request: Request, provider: str | None = None, connection_generation: int | None = None,
              from_: str | None = None, to: str | None = None, cursor: str | None = None, limit: int = 20):
    start = request.query_params.get('from', from_) or '1970-01-01T00:00:00+00:00'
    end = to or now()
    try:
        dates = [datetime.fromisoformat(value) for value in (start, end)]
        if any(date.tzinfo is None for date in dates) or dates[0] > dates[1]:
            raise ValueError()
    except ValueError:
        raise ApiError(400, '时间范围需使用带时区的日期时间') from None
    if provider is not None and provider not in PRESETS or not 1 <= limit <= 100 or connection_generation is not None and connection_generation < 1:
        raise ApiError(400, '用量筛选参数不正确')
    rows = request.app.state.context.db.rows('SELECT * FROM usage_calls ORDER BY created_at,id')
    rows = [row for row in rows if dates[0] <= datetime.fromisoformat(row['created_at']) <= dates[1]
            and (provider is None or provider == row['provider']) and (connection_generation is None or connection_generation == row['connection_generation'])]
    unknown = sum(row['estimated_cost_amount'] is None for row in rows)
    costs = {}
    for row in rows:
        if row['estimated_cost_amount'] is not None:
            currency = row['estimated_cost_currency']
            costs[currency] = costs.get(currency, Decimal(0)) + Decimal(row['estimated_cost_amount'])
    selected = [row for row in rows if cursor is None or row['id'] > cursor]
    selected.sort(key=lambda row: row['id'])
    return {'summary': {'provider': provider, 'connection_generation': connection_generation, 'from': start, 'to': end, 'scope': 'app_local',
            'call_count': len(rows), 'input_tokens_known': sum(row['input_tokens'] or 0 for row in rows), 'output_tokens_known': sum(row['output_tokens'] or 0 for row in rows),
            'unknown_usage_calls': sum(not row['usage_known'] for row in rows), 'costs': [{'currency': currency, 'known_estimated_amount': format(value, 'f'), 'unknown_call_count': unknown} for currency, value in costs.items()]},
            'calls': [call_view(row) for row in selected[:limit]], 'next_cursor': selected[limit - 1]['id'] if len(selected) > limit else None}


@router.get('/balance')
def get_balance(request: Request, refresh: bool = False):
    state = request.app.state.context
    with state.settings.lock:
        config = state.settings.read()
        provider = config['provider']
        result = {'provider': provider, 'connection_generation': config['revision'], 'status': 'unsupported', 'balances': [], 'checked_at': None,
                  'reason': '首版仅查询 DeepSeek 余额；请打开官方账单', 'billing_url': PRESETS[provider]['billing_url']}
        key = state.settings.key(config)
        if not key:
            return {**result, 'status': 'not_configured', 'reason': '尚未配置 API Key'}
        if provider != 'deepseek':
            return result
        cached = state.settings.balance_cache
        if cached and not refresh and datetime.now(timezone.utc) - datetime.fromisoformat(cached['checked_at']) < timedelta(minutes=5):
            return cached
        try:
            result.update(status='available', balances=state.providers.balance(key), checked_at=now(), reason=None)
            validate('Balance', result)
            state.settings.balance_cache = result
            return result
        except (ApiError, KeyError, TypeError, ValueError):
            if cached:
                return {**cached, 'status': 'stale', 'reason': '本次查询失败，显示上次余额'}
            return {**result, 'status': 'unavailable', 'reason': '无法查询官方余额，请打开官方账单', 'balances': [], 'checked_at': None}
