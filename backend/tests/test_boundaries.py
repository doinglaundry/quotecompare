import json
import threading

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.modules.analysis import check_facts
from backend.modules.settings import Keychain
from backend.providers import Providers
from backend.schemas import ApiError, dump, now
from backend.tests.test_analysis import fact, quote
from backend.tests.test_jobs import response_for
from backend.tests.test_workflow import MemorySecrets, finished


def test_money_type_cannot_break_program_arithmetic():
    value = {**fact(), 'value_type': 'text', 'normalized_value': 'unknown'}
    with pytest.raises(ApiError):
        check_facts(quote('q1', [value]), [value])


def test_restart_marks_jobs_interrupted_keeps_sources_and_removes_orphans(tmp_path):
    with TestClient(create_app(tmp_path, token='t', secrets=MemorySecrets())) as client:
        client.headers['Authorization'] = 'Bearer t'
        client.post('/api/v1/projects', json={'request_id': 'p', 'name': 'Repair', 'scope': '', 'currency': 'GBP'})
        imported = client.post('/api/v1/projects/p/quotes', data={'request_id': 'q', 'source_type': 'text', 'expected_revision': '1', 'text': 'Total 1200'}).json()
        state = client.app.state.context
        orphan = state.files.save('p', 'quotes/orphan/original.txt', b'orphan')
        state.files.save('orphan-project', 'unused.txt', b'unused')
        with state.db.transaction():
            state.db.insert('jobs', {'id': 'pending', 'request_id': 'pending', 'request_hash': 'test', 'project_id': 'p', 'kind': 'extraction', 'input_json': '{}', 'state': 'running'})
            state.db.update('quotes', 'q', {'status': 'extracting'})
    with TestClient(create_app(tmp_path, token='t', secrets=MemorySecrets())) as client:
        client.headers['Authorization'] = 'Bearer t'
        assert client.get('/api/v1/jobs/pending').json()['state'] == 'interrupted'
        assert client.get('/api/v1/quotes/q').json()['status'] == 'imported'
        assert client.get('/api/v1/files/' + imported['original_file_id']).content == b'Total 1200'
        assert client.get('/api/v1/files/' + orphan).status_code == 404
        assert not (tmp_path / 'projects/orphan-project').exists()
        assert client.get('/api/v1/health', headers={'Origin': 'https://evil.example'}).status_code == 403


def test_invalid_model_result_still_records_real_usage(tmp_path):
    def malformed(request):
        return httpx.Response(200, json={'output': [{'content': [{'type': 'output_text', 'text': '{bad json'}]}], 'usage': {'input_tokens': 100, 'output_tokens': 50}})
    with TestClient(create_app(tmp_path, token='t', secrets=MemorySecrets(), providers=Providers(httpx.MockTransport(malformed)))) as client:
        client.headers['Authorization'] = 'Bearer t'
        client.put('/api/v1/settings', json={'expected_revision': 1, 'provider': 'openai', 'api_key': 'fake'})
        result = finished(client, {'request_id': 'test', 'kind': 'connection_test', 'expected_connection_revision': 2})
        assert result['state'] == 'failed'
        usage = client.get('/api/v1/usage').json()
        assert usage['summary']['call_count'] == 1
        assert usage['calls'][0]['input_tokens'] == 100
        assert usage['calls'][0]['outcome'] == 'failed'
        assert usage['calls'][0]['estimated_cost']['amount'] == '0.00012'


def test_network_timeout_does_not_retry_or_invent_zero_usage(tmp_path):
    calls = []
    def timeout(request):
        calls.append(request)
        raise httpx.ReadTimeout('secret detail that must never be logged')
    with TestClient(create_app(tmp_path, token='t', secrets=MemorySecrets(), providers=Providers(httpx.MockTransport(timeout)))) as client:
        client.headers['Authorization'] = 'Bearer t'
        client.put('/api/v1/settings', json={'expected_revision': 1, 'provider': 'openai', 'api_key': 'fake'})
        result = finished(client, {'request_id': 'test', 'kind': 'connection_test', 'expected_connection_revision': 2})
        assert result['state'] == 'failed'
        assert 'secret detail' not in dump(result)
        usage = client.get('/api/v1/usage').json()
        assert len(calls) == 1
        assert usage['summary']['unknown_usage_calls'] == 1
        assert usage['calls'][0]['input_tokens'] is None
        assert usage['calls'][0]['estimated_cost'] is None
        assert usage['calls'][0]['outcome'] == 'unknown'


def test_real_macos_keychain_roundtrip(tmp_path):
    # Only touches a fresh, test-scoped item; never reads user credentials.
    keychain = Keychain(tmp_path)
    try:
        keychain.set('roundtrip', 'fake-test-secret')
        assert keychain.get('roundtrip') == 'fake-test-secret'
    finally:
        keychain.delete('roundtrip')
    assert keychain.get('roundtrip') is None


def test_long_report_cells_paginate_and_csv_formula_is_escaped(tmp_path):
    from backend.modules.reports import render_report
    from types import SimpleNamespace
    from backend.database import Database
    from backend.files import Files
    state = SimpleNamespace(db=Database(tmp_path), files=Files(tmp_path))
    text = '=SUM(A1:A2) ' + 'Long material description ' * 1000
    data = {'project': {'name': 'Report', 'property': None, 'scope': '', 'currency': 'GBP'},
            'comparison': {'columns': [{'quote_id': 'q', 'contractor_name': 'Vendor'}], 'rows': [{'label': 'Materials', 'cells': [{'quote_id': 'q', 'display_value': text}]}], 'created_at': now(), 'summary': ''},
            'flags': [], 'questions': [], 'sources': []}
    with state.db.transaction():
        state.db.insert('projects', {'id': 'p', 'name': 'Report', 'scope': '', 'currency': 'GBP', 'request_hash': 'hash'})
        state.db.insert('comparisons', {'id': 'c', 'project_id': 'p', 'request_id': 'c', 'request_hash': 'hash', 'source_revision': 1, 'snapshot_json': dump(data)})
    try:
        pdf = render_report(state, {'project_id': 'p', 'comparison_id': 'c', 'report_options': {'format': 'pdf'}}, 'pdf')
        pdf_path, mime = state.files.find(pdf['report_file_id'])
        from pypdf import PdfReader
        assert len(PdfReader(pdf_path).pages) > 1
        csv = render_report(state, {'project_id': 'p', 'comparison_id': 'c', 'report_options': {'format': 'csv'}}, 'csv')
        csv_path, mime = state.files.find(csv['report_file_id'])
        assert "'=SUM(A1:A2)" in csv_path.read_text(encoding='utf-8-sig')
    finally:
        state.db.connection.close()
