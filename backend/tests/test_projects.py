from fastapi.testclient import TestClient

from backend.app import create_app


def test_projects_auth_idempotency_and_revision(tmp_path):
    app = create_app(tmp_path, token='test-session')
    with TestClient(app) as client:
        assert client.get('/api/v1/health').status_code == 401
        client.headers['Authorization'] = 'Bearer test-session'
        assert client.get('/api/v1/health').json()['max_quotes'] == 5
        body = {'request_id': 'p1', 'name': '厨房维修', 'property': '房产 A', 'scope': '更换橱柜', 'currency': 'GBP'}
        response = client.post('/api/v1/projects', json=body)
        assert response.status_code == 201, response.text
        assert response.json()['revision'] == 1
        assert client.post('/api/v1/projects', json=body).json()['id'] == 'p1'
        assert client.post('/api/v1/projects', json={**body, 'name': '不同项目'}).status_code == 409
        updated = client.patch('/api/v1/projects/p1', json={'expected_revision': 1, 'name': '厨房翻新'})
        assert updated.json()['revision'] == 2
        assert client.patch('/api/v1/projects/p1', json={'expected_revision': 1, 'name': '旧修改'}).status_code == 409
        # Replay must be checked before current mutable project values.
        assert client.post('/api/v1/projects', json=body).status_code == 201
        assert client.get('/api/v1/projects').json()['items'][0]['name'] == '厨房翻新'


def test_text_import_limit_duplicate_and_edit(tmp_path):
    with TestClient(create_app(tmp_path, token='t')) as client:
        client.headers['Authorization'] = 'Bearer t'
        client.post('/api/v1/projects', json={'request_id': 'p', 'name': '维修', 'scope': '', 'currency': 'GBP'})
        for number in range(5):
            body = {'request_id': f'q{number}', 'expected_revision': str(number + 1), 'source_type': 'text', 'text': f'Contractor {number}\nTotal GBP {1000 + number}', 'contractor_name': f'公司 {number}'}
            response = client.post('/api/v1/projects/p/quotes', data=body)
            assert response.status_code == 201, response.text
            assert response.json()['source_blocks'][0]['text'].startswith('Contractor')
            # Same request succeeds even though project revision increased.
            assert client.post('/api/v1/projects/p/quotes', data=body).status_code == 201
        overflow = client.post('/api/v1/projects/p/quotes', data={'request_id': 'overflow', 'expected_revision': '6', 'source_type': 'text', 'text': 'sixth'})
        assert overflow.status_code == 422
        assert client.get('/api/v1/projects/p').json()['revision'] == 6
        deleted = client.delete('/api/v1/quotes/q0?expected_revision=6')
        assert deleted.status_code == 204
        assert client.get('/api/v1/quotes/q0').status_code == 404
        assert len(client.get('/api/v1/projects/p').json()['quotes']) == 4


def test_import_rejects_unknown_fields_and_unsafe_ids(tmp_path):
    with TestClient(create_app(tmp_path, token='t')) as client:
        client.headers['Authorization'] = 'Bearer t'
        body = {'request_id': 'p', 'name': '维修', 'scope': '', 'currency': 'GBP'}
        assert client.post('/api/v1/projects', json={**body, 'surprise': 1}).status_code == 400
        assert client.post('/api/v1/projects', json={**body, 'request_id': '../escape'}).status_code == 400
