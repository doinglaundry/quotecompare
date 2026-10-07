import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

RESOURCES = Path(__file__).resolve().parents[1] / 'docs' / 'technical'
CONTRACT = json.loads((RESOURCES / 'QuoteCompare-openapi-v2.json').read_text())
SCHEMAS = CONTRACT['components']['schemas']


class ApiError(Exception):
    def __init__(self, status, message, code='INVALID_REQUEST', fields=None):
        self.status = status
        self.message = message
        self.code = code
        self.fields = fields or []
        super().__init__(message)


def validate(name, value):
    schema = {'$ref': '#/components/schemas/' + name, 'components': CONTRACT['components']}
    errors = list(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(value))
    if errors:
        fields = [{'field': '.'.join(str(x) for x in error.path), 'reason': f'不符合 {error.validator} 约束'} for error in errors[:8]]
        raise ApiError(400, '输入格式不正确', fields=fields)
    return value


def identifier(value):
    if re.fullmatch(r'[A-Za-z0-9_-]{1,80}', value) is None:
        raise ApiError(400, '编号只能包含字母、数字、下划线和短横线')
    return value


def uid():
    return uuid.uuid4().hex


def now():
    return datetime.now(timezone.utc).isoformat()


def dump(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def fingerprint(value):
    return hashlib.sha256(dump(value).encode()).hexdigest()


def error_payload(error):
    return {'code': error.code, 'message': error.message, 'request_id': uid(),
            'retryable': error.status in (409, 502, 503), 'field_errors': error.fields}
