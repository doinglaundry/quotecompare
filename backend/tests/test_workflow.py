import time

import httpx
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.tests.test_analysis import fact, group


class MemorySecrets:
    def __init__(self):
        self.values = {}

    def get(self, account):
        return self.values.get(account)

    def set(self, account, value):
        self.values[account] = value

    def delete(self, account):
        self.values.pop(account, None)


def finished(client, body):
    response = client.post('/api/v1/jobs', json=body)
    assert response.status_code == 202, response.text
    job = response.json()
    for attempt in range(200):
        job = client.get('/api/v1/jobs/' + job['id']).json()
        if job['state'] not in ('queued', 'running', 'cancel_requested'):
            return job
        time.sleep(.01)
    raise AssertionError(job)


def test_settings_clear_switch_and_secret_never_on_disk(tmp_path):
    secrets = MemorySecrets()
    with TestClient(create_app(tmp_path, token='t', secrets=secrets)) as client:
        client.headers['Authorization'] = 'Bearer t'
        settings = client.get('/api/v1/settings').json()
        assert settings['has_key'] is False
        response = client.put('/api/v1/settings', json={'expected_revision': 1, 'provider': 'openai', 'api_key': 'test-secret-1234'})
        assert response.status_code == 200, response.text
        assert response.json()['key_hint'] == '1234'
        assert 'test-secret' not in (tmp_path / 'settings.json').read_text()
        assert client.put('/api/v1/settings', json={'expected_revision': 1, 'provider': 'deepseek', 'api_key': 'late'}).status_code == 409
        switched = client.put('/api/v1/settings', json={'expected_revision': 2, 'provider': 'deepseek'}).json()
        assert switched['has_key'] is False
        assert not secrets.values
        assert client.get('/api/v1/balance').json()['status'] == 'not_configured'


def test_snapshot_survives_quote_deletion_and_report_redaction(tmp_path):
    with TestClient(create_app(tmp_path, token='t', secrets=MemorySecrets())) as client:
        client.headers['Authorization'] = 'Bearer t'
        client.post('/api/v1/projects', json={'request_id': 'p', 'name': 'Kitchen', 'property': 'SECRET ADDRESS', 'scope': '', 'currency': 'GBP'})
        values = []
        for index in range(2):
            qid = f'q{index}'
            imported = client.post('/api/v1/projects/p/quotes', data={'request_id': qid, 'source_type': 'text', 'expected_revision': str(index * 2 + 1), 'text': f'SECRET ADDRESS\nTotal {1200 + index * 100}', 'contractor_name': f'Contractor {index}'})
            assert imported.status_code == 201, imported.text
            value = {**fact(qid, qid, value=str(1200 + index * 100)), 'origin': 'manual', 'source_refs': [{'quote_id': qid, 'block_id': imported.json()['source_blocks'][0]['id']}]}
            values.append((qid, value))
            response = client.patch('/api/v1/quotes/' + qid, json={'expected_revision': index * 2 + 2, 'facts': [value]})
            assert response.status_code == 200, response.text
        mappings = client.put('/api/v1/projects/p/field-mappings', json={'expected_revision': 5, 'groups': [group(values)]})
        assert mappings.status_code == 200, mappings.text
        request = {'request_id': 'snapshot', 'expected_revision': 6}
        response = client.post('/api/v1/projects/p/comparisons', json=request)
        assert response.status_code == 201, response.text
        snapshot = response.json()
        cid = snapshot['comparison']['id']
        assert snapshot['comparison']['can_compare_final_total'] is False
        assert client.post('/api/v1/projects/p/comparisons', json=request).json()['comparison']['id'] == cid
        original = snapshot['sources'][0]['original_file_id']
        assert client.delete('/api/v1/quotes/q0?expected_revision=6').status_code == 204
        assert client.get('/api/v1/files/' + original).status_code == 200
        assert client.get('/api/v1/comparisons/' + cid).json()['comparison']['is_stale'] is True
        for format in ('pdf', 'csv'):
            job = finished(client, {'request_id': 'report-' + format, 'kind': 'report', 'project_id': 'p', 'comparison_id': cid,
                                   'report_options': {'format': format, 'hide_property': True, 'include_sources': True, 'include_questions': True}})
            assert job['state'] == 'succeeded', job
            preview = client.get('/api/v1/files/' + job['result']['preview_file_id'])
            assert 'SECRET ADDRESS' not in preview.text
            report = client.get('/api/v1/files/' + job['result']['report_file_id'])
            assert report.status_code == 200
            if format == 'pdf':
                import io
                from pypdf import PdfReader
                assert 'SECRET ADDRESS' not in '\n'.join(page.extract_text() for page in PdfReader(io.BytesIO(report.content)).pages)
            else:
                assert 'SECRET ADDRESS' not in report.text
        assert client.post('/api/v1/jobs', json={'request_id': 'bad', 'kind': 'report', 'project_id': 'other', 'comparison_id': cid, 'report_options': {'format': 'pdf'}}).status_code == 404

    with TestClient(create_app(tmp_path, token='t', secrets=MemorySecrets())) as client:
        client.headers['Authorization'] = 'Bearer t'
        restored = client.get('/api/v1/comparisons/' + cid).json()
        assert restored['comparison']['id'] == cid
        assert restored['sources'][0]['original_file_id'] == original
        assert client.get('/api/v1/files/' + original).status_code == 200
        assert client.get('/api/v1/files/' + job['result']['report_file_id']).status_code == 200
