import json
import threading

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.providers import Providers
from backend.schemas import dump, validate
from backend.tests.test_analysis import fact, group
from backend.tests.test_workflow import MemorySecrets, finished


def response_for(request, control=None):
    body = json.loads(request.content) if request.content else {}
    if request.url.path.endswith('/user/balance'):
        return httpx.Response(200, json={'balance_infos': [{'currency': 'CNY', 'total_balance': '12.50', 'granted_balance': '0', 'topped_up_balance': '12.50'}]})
    content = body.get('input') or body['messages'][-1]['content']
    payload = json.loads(content)['task']
    if control:
        control['entered'].set()
        control['release'].wait(5)
    if payload['purpose'] == 'connection_test':
        result = {'ok': True}
    elif payload['purpose'] == 'extraction':
        qid = payload['quote_id']
        value = fact(qid, qid)
        value['source_refs'][0]['block_id'] = payload['source_blocks'][0]['id']
        result = {'contractor_name': 'Vendor', 'facts': [value], 'warnings': []}
    elif payload['purpose'] == 'alignment':
        values = [(quote['quote_id'], quote['facts'][0]) for quote in payload['quotes']]
        result = {'groups': [group(values)]}
    else:
        result = {'subject': 'Clarification', 'body': '\n'.join(payload['questions'])}
    text = dump(result)
    if request.url.path.endswith('/responses'):
        data = {'output': [{'content': [{'type': 'output_text', 'text': text}]}], 'usage': {'input_tokens': 1000, 'output_tokens': 100, 'input_tokens_details': {'cached_tokens': 200}}}
    elif request.url.path.endswith('/messages'):
        data = {'content': [{'type': 'text', 'text': text}], 'usage': {'input_tokens': 800, 'output_tokens': 100, 'cache_read_input_tokens': 200}}
    else:
        data = {'choices': [{'message': {'content': text}}], 'usage': {'prompt_tokens': 1000, 'completion_tokens': 100, 'prompt_cache_hit_tokens': 200}}
    return httpx.Response(200, json=data)


@pytest.mark.parametrize('provider', ['openai', 'claude', 'deepseek'])
def test_all_provider_protocols_complete_quote_to_draft(tmp_path, provider):
    with TestClient(create_app(tmp_path, token='t', secrets=MemorySecrets(), providers=Providers(httpx.MockTransport(response_for)))) as client:
        client.headers['Authorization'] = 'Bearer t'
        settings = client.put('/api/v1/settings', json={'expected_revision': 1, 'provider': provider, 'api_key': 'fake-test-key'}).json()
        validate('Settings', settings)
        connection = finished(client, {'request_id': 'connect', 'kind': 'connection_test', 'expected_connection_revision': 2})
        assert connection['state'] == 'succeeded', connection
        client.post('/api/v1/projects', json={'request_id': 'p', 'name': 'Kitchen', 'scope': '', 'currency': 'GBP'})
        for index in range(2):
            assert client.post('/api/v1/projects/p/quotes', data={'request_id': f'q{index}', 'expected_revision': str(index + 1), 'source_type': 'text', 'text': f'Quote {index}\nTotal 1200'}).status_code == 201
        extraction_body = {'request_id': 'extract', 'kind': 'extraction', 'project_id': 'p', 'expected_revision': 3, 'quote_ids': ['q0', 'q1']}
        extracted = finished(client, extraction_body)
        assert extracted['state'] == 'succeeded', extracted
        validate('Job', extracted)
        assert client.post('/api/v1/jobs', json=extraction_body).json()['id'] == extracted['id']
        revision = 5
        for qid in ['q0', 'q1']:
            quote = client.get('/api/v1/quotes/' + qid).json()
            assert quote['facts'][0]['review_status'] == 'unreviewed'
            quote['facts'][0]['review_status'] = 'confirmed'
            saved = client.patch('/api/v1/quotes/' + qid, json={'expected_revision': revision, 'facts': quote['facts']})
            assert saved.status_code == 200, saved.text
            revision += 1
        assert client.post('/api/v1/jobs', json={**extraction_body, 'request_id': 'overwrite', 'expected_revision': revision}).status_code == 409
        aligned = finished(client, {'request_id': 'align', 'kind': 'alignment', 'project_id': 'p', 'expected_revision': revision})
        assert aligned['state'] == 'succeeded', aligned
        mappings = client.get('/api/v1/projects/p/field-mappings').json()
        mappings['groups'][0]['status'] = 'confirmed'
        saved = client.put('/api/v1/projects/p/field-mappings', json={'expected_revision': mappings['project_revision'], 'groups': mappings['groups']})
        snapshot = client.post('/api/v1/projects/p/comparisons', json={'request_id': 'compare', 'expected_revision': saved.json()['project_revision']}).json()
        validate('ComparisonDetail', snapshot)
        selected = [question['id'] for question in snapshot['questions'] if question['quote_id'] == 'q0']
        draft = finished(client, {'request_id': 'draft', 'kind': 'draft', 'project_id': 'p', 'comparison_id': snapshot['comparison']['id'], 'quote_id': 'q0', 'question_ids': selected, 'language': 'en'})
        assert draft['state'] == 'succeeded', draft
        draft_id = draft['result']['draft_ids'][0]
        assert client.patch('/api/v1/drafts/' + draft_id, json={'expected_revision': 1, 'subject': 'Edited'}).json()['subject'] == 'Edited'
        assert client.patch('/api/v1/drafts/' + draft_id, json={'expected_revision': 1, 'body': 'late'}).status_code == 409
        usage = client.get('/api/v1/usage').json()
        validate('UsageReport', usage)
        assert usage['summary']['call_count'] == 5
        assert usage['summary']['input_tokens_known'] == 5000
        balance = client.get('/api/v1/balance').json()
        validate('Balance', balance)
        assert balance['status'] == ('available' if provider == 'deepseek' else 'unsupported')
        current = client.get('/api/v1/projects/p').json()
        quote = client.get('/api/v1/quotes/q0').json()
        quote['facts'][0].update(normalized_value='1250', review_status='pending')
        edited = client.patch('/api/v1/quotes/q0', json={'expected_revision': current['revision'], 'facts': quote['facts']}).json()
        blocked = client.post('/api/v1/jobs', json={'request_id': 'pending-edit', 'kind': 'extraction', 'project_id': 'p', 'expected_revision': edited['project_revision'], 'quote_ids': ['q0']})
        assert blocked.status_code == 409
        assert blocked.json()['code'] == 'REVIEWED_DATA_EXISTS'
        current = client.get('/api/v1/projects/p').json()
        assert client.delete('/api/v1/projects/p?expected_revision=' + str(current['revision'])).status_code == 204
        retained = client.get('/api/v1/usage').json()
        assert retained['summary']['call_count'] == 5
        assert all(call['project_id'] is None for call in retained['calls'])
        assert all(call['job_id'] is None for call in retained['calls'] if call['purpose'] != 'connection_test')


def test_cancellation_usage_and_stale_result_cannot_overwrite(tmp_path):
    control = {'entered': threading.Event(), 'release': threading.Event()}
    provider = Providers(httpx.MockTransport(lambda request: response_for(request, control)))
    with TestClient(create_app(tmp_path, token='t', secrets=MemorySecrets(), providers=provider)) as client:
        client.headers['Authorization'] = 'Bearer t'
        client.put('/api/v1/settings', json={'expected_revision': 1, 'provider': 'openai', 'api_key': 'fake'})
        client.post('/api/v1/projects', json={'request_id': 'p', 'name': 'Repair', 'scope': '', 'currency': 'GBP'})
        client.post('/api/v1/projects/p/quotes', data={'request_id': 'q', 'expected_revision': '1', 'source_type': 'text', 'text': 'Total 1200'})
        body = {'request_id': 'extract', 'kind': 'extraction', 'project_id': 'p', 'expected_revision': 2, 'quote_ids': ['q']}
        job = client.post('/api/v1/jobs', json=body).json()
        assert control['entered'].wait(3)
        assert client.put('/api/v1/settings', json={'expected_revision': 2, 'provider': 'claude'}).status_code == 409
        assert client.delete('/api/v1/projects/p?expected_revision=2').status_code == 409
        client.post('/api/v1/jobs/' + job['id'] + '/cancel')
        control['release'].set()
        cancelled = finished(client, body)
        assert cancelled['state'] == 'cancelled', cancelled
        assert client.get('/api/v1/quotes/q').json()['facts'] == []
        assert client.get('/api/v1/usage').json()['calls'][0]['outcome'] == 'cancelled'
        control['entered'].clear()
        control['release'].clear()
        next_body = {**body, 'request_id': 'second'}
        client.post('/api/v1/jobs', json=next_body)
        assert control['entered'].wait(3)
        assert client.patch('/api/v1/projects/p', json={'expected_revision': 2, 'scope': 'changed'}).status_code == 200
        control['release'].set()
        stale = finished(client, next_body)
        assert stale['state'] == 'failed', stale
        assert client.get('/api/v1/quotes/q').json()['facts'] == []
