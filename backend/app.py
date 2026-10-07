import hmac
import json
import os
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse

from backend.database import Database
from backend.files import Files
from backend.modules import projects, analysis, reports, settings
from backend import jobs
from backend.providers import Providers
from backend.schemas import ApiError, error_payload, uid


def create_app(directory=None, token=None, secrets=None, providers=None):
    directory = Path(directory or Path.home() / 'Library/Application Support/QuoteCompare')
    state = SimpleNamespace(directory=directory, db=Database(directory), files=Files(directory),
                            token=token or os.environ.get('QUOTECOMPARE_SESSION_TOKEN') or uid(),
                            secrets=secrets, providers=providers)

    state.secrets = secrets or settings.Keychain(directory)
    state.providers = providers or Providers()
    state.settings = settings.SettingsStore(state)
    state.jobs = jobs.Jobs(state)
    state.files.cleanup(state.db)

    @asynccontextmanager
    async def lifespan(app):
        yield
        state.jobs.close()
        state.providers.close()
        state.db.connection.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.context = state

    @app.middleware('http')
    async def authenticate(request, call_next):
        if request.headers.get('origin'):
            return JSONResponse(error_payload(ApiError(403, '不允许网页直接调用本地服务', 'FORBIDDEN_ORIGIN')), status_code=403)
        supplied = request.headers.get('authorization', '')
        if not hmac.compare_digest(supplied, 'Bearer ' + state.token):
            error = ApiError(401, '本机会话验证失败', 'UNAUTHORIZED')
            return JSONResponse(error_payload(error), status_code=401)
        try:
            return await call_next(request)
        except (json.JSONDecodeError, ValueError):
            error = ApiError(400, '输入格式不正确')
            return JSONResponse(error_payload(error), status_code=400)

    @app.exception_handler(ApiError)
    async def api_error(request, error):
        return JSONResponse(error_payload(error), status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def input_error(request, error):
        return JSONResponse(error_payload(ApiError(400, '接口参数不正确')), status_code=400)

    @app.exception_handler(sqlite3.IntegrityError)
    async def database_error(request, error):
        return JSONResponse(error_payload(ApiError(409, '数据冲突，请刷新后重试', 'DATA_CONFLICT')), status_code=409)

    @app.get('/api/v1/health')
    def health():
        return {'status': 'ready', 'api_version': '2', 'max_quotes': 5,
                'max_file_bytes': 50 * 1024 * 1024, 'max_pdf_pages': 30}

    @app.get('/api/v1/files/{file_id}')
    def file(file_id: str):
        path, mime = state.files.find(file_id)
        return FileResponse(path, media_type=mime,
                            headers={'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:;", 'X-Content-Type-Options': 'nosniff'})

    for router in (projects.router, analysis.router, reports.router, settings.router, jobs.router):
        app.include_router(router, prefix='/api/v1')
    return app
