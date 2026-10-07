import json
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.tests.test_analysis import fact, group
from backend.tests.test_workflow import MemorySecrets


def create_snapshot(client):
    client.post('/api/v1/projects', json={'request_id': 'p', 'name': 'Kitchen', 'scope': '', 'currency': 'GBP'})
    facts = []
    for index in range(2):
        quote_id = f'q{index}'
        response = client.post('/api/v1/projects/p/quotes', data={'request_id': quote_id, 'source_type': 'text',
            'expected_revision': str(index * 2 + 1), 'text': f'Total {1200 + index * 100}'})
        assert response.status_code == 201, response.text
        value = {**fact(quote_id, quote_id, value=str(1200 + index * 100)), 'origin': 'manual',
            'source_refs': [{'quote_id': quote_id, 'block_id': response.json()['source_blocks'][0]['id']}]}
        facts.append((quote_id, value))
        response = client.patch('/api/v1/quotes/' + quote_id, json={'expected_revision': index * 2 + 2, 'facts': [value]})
        assert response.status_code == 200, response.text
    response = client.put('/api/v1/projects/p/field-mappings', json={'expected_revision': 5, 'groups': [group(facts)]})
    assert response.status_code == 200, response.text
    response = client.post('/api/v1/projects/p/comparisons', json={'request_id': 'snapshot', 'expected_revision': 6})
    assert response.status_code == 201, response.text
    return response.json()


def test_history_reads_stay_bounded_and_keep_stale_pagination(tmp_path):
    app = create_app(tmp_path, token='t', secrets=MemorySecrets())
    with TestClient(app) as client:
        client.headers['Authorization'] = 'Bearer t'
        snapshot = create_snapshot(client)
        for index in range(4):
            response = client.post('/api/v1/projects/p/comparisons', json={'request_id': f'snapshot{index}', 'expected_revision': 6})
            assert response.status_code == 201, response.text
        database = app.state.context.db
        for stale in (False, True):
            if stale:
                assert client.delete('/api/v1/quotes/q0?expected_revision=6').status_code == 204
            items, cursor = [], None
            while True:
                statements = []
                database.connection.set_trace_callback(statements.append)
                response = client.get('/api/v1/projects/p/comparisons', params={'limit': 2, **({'cursor': cursor} if cursor else {})})
                database.connection.set_trace_callback(None)
                assert response.status_code == 200, response.text
                page = response.json()
                selects = [sql for sql in statements if sql.startswith('SELECT')]
                assert len(selects) <= 2, selects
                items.extend(page['items'])
                cursor = page['next_cursor']
                if not cursor:
                    break
            assert len(items) == 5
            assert [item['id'] for item in items] == sorted({item['id'] for item in items})
            assert all(item['is_stale'] is stale for item in items)
            assert all(item['rows'] == snapshot['comparison']['rows'] for item in items)
            assert all(item['columns'] == snapshot['comparison']['columns'] for item in items)
        assert client.get('/api/v1/projects/missing/comparisons').status_code == 404


def test_draft_submission_reads_snapshot_once_and_checks_question_owner(tmp_path):
    app = create_app(tmp_path, token='t', secrets=MemorySecrets())
    with TestClient(app) as client:
        client.headers['Authorization'] = 'Bearer t'
        snapshot = create_snapshot(client)
        assert client.put('/api/v1/settings', json={'expected_revision': 1, 'provider': 'openai', 'api_key': 'test-only'}).status_code == 200
        question = snapshot['questions'][0]
        body = {'request_id': 'draft', 'kind': 'draft', 'project_id': 'p', 'comparison_id': snapshot['comparison']['id'],
            'quote_id': question['quote_id'], 'question_ids': [question['id']], 'language': 'en'}
        statements = []
        database = app.state.context.db
        # Only suppress execution: submission validation, SQL and the queued job remain real.
        with patch.object(app.state.context.jobs.pool, 'submit'):
            database.connection.set_trace_callback(statements.append)
            response = client.post('/api/v1/jobs', json=body)
            database.connection.set_trace_callback(None)
            assert response.status_code == 202, response.text
            reads = [sql for sql in statements if sql.startswith('SELECT') and 'FROM comparisons' in sql]
            assert len(reads) == 1, reads
            stored = database.get('jobs', response.json()['id'])
            assert stored['state'] == 'queued'
            assert json.loads(stored['input_json'])['question_ids'] == [question['id']]
            other = 'q1' if question['quote_id'] == 'q0' else 'q0'
            response = client.post('/api/v1/jobs', json={**body, 'request_id': 'wrong-owner', 'quote_id': other})
            assert response.status_code == 422, response.text
            assert len(database.rows('SELECT id FROM jobs')) == 1
