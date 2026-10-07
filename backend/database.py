import sqlite3
import threading
from contextlib import contextmanager

from backend.schemas import ApiError, RESOURCES, now


class Database:
    def __init__(self, directory):
        directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.connection = sqlite3.connect(directory / 'app.db', check_same_thread=False, isolation_level=None)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute('PRAGMA foreign_keys=ON')
        self.connection.execute('PRAGMA busy_timeout=5000')
        self.connection.execute('PRAGMA journal_mode=WAL')
        exists = self.connection.execute("SELECT 1 FROM sqlite_master WHERE name='projects'").fetchone()
        if exists is None:
            script = (RESOURCES / 'database-schema-v2.sql').read_text()
            self.connection.executescript(script)

    @contextmanager
    def transaction(self):
        with self.lock:
            self.connection.execute('BEGIN IMMEDIATE')
            try:
                yield self
                self.connection.execute('COMMIT')
            except Exception:
                self.connection.execute('ROLLBACK')
                raise

    def rows(self, sql, parameters=()):
        with self.lock:
            return [dict(row) for row in self.connection.execute(sql, parameters).fetchall()]

    def get(self, table, resource_id):
        rows = self.rows(f'SELECT * FROM {table} WHERE id=?', (resource_id,))
        if not rows:
            raise ApiError(404, '记录不存在', 'NOT_FOUND')
        return rows[0]

    def insert(self, table, fields):
        columns = ','.join(fields)
        placeholders = ','.join('?' for _ in fields)
        self.connection.execute(f'INSERT INTO {table} ({columns}) VALUES ({placeholders})', tuple(fields.values()))

    def update(self, table, resource_id, fields):
        columns = ','.join(key + '=?' for key in fields)
        self.connection.execute(f'UPDATE {table} SET {columns} WHERE id=?', (*fields.values(), resource_id))

    def advance_revision(self, project_id, expected_revision, invalidate=True):
        project = self.get('projects', project_id)
        if project['revision'] != expected_revision:
            raise ApiError(409, '项目已更新，请刷新后重试', 'STALE_REVISION')
        fields = {'revision': expected_revision + 1, 'updated_at': now()}
        if invalidate:
            fields['mappings_revision'] = None
        self.update('projects', project_id, fields)
        return expected_revision + 1
