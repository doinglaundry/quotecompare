-- QuoteCompare / SQLite：十四张业务表的首次建库 SQL。
-- 在空数据库执行；后续结构变更由 Alembic 迁移，不重复执行本文件。
-- 每次数据库连接都要开启 foreign_keys；WAL 只适用于磁盘数据库。
-- ID 由应用生成；时间统一为 UTC；金额由 Python Decimal 校验与计算。
-- JSON 列的内部字段按 OpenAPI DTO 校验；这里校验 JSON 外层类型。

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

BEGIN;

-- 01. projects：项目与当前业务版本。
CREATE TABLE projects (
    -- 项目唯一编号；同一项目下的报价通过 project_id 关联。
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80),
    -- 项目名称，例如：厨房维修。
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    -- 房产名称或地址，例如：房产 A / 12 King Street；可不填，保存为文字。
    property TEXT CHECK (property IS NULL OR length(property) <= 200),
    -- 本次施工需求：要做哪些工作、保留哪些内容、报价需包含哪些费用。
    -- 空字符串表示尚未填写；以下为填写示例，实际需求由用户确认。
    -- 厨房翻新：更换橱柜和台面，保留地板，包含垃圾清运。
    -- 卫生间设备更换：更换马桶和洗手台，保留现有瓷砖。
    -- 外墙粉刷：外墙重新粉刷两遍，包含脚手架，不含窗框粉刷。
    -- 电路改造：更换配电箱和老化电线，包含验收和合规证明。
    -- 屋顶维修：更换破损屋顶瓦片，修复漏水处，清理排水沟。
    scope TEXT NOT NULL DEFAULT '' CHECK (length(scope) <= 4000),
    -- 项目比较币种，例如 GBP、CNY；不自动换算不同币种报价。
    currency TEXT NOT NULL CHECK (
        length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'
    ),
    -- 项目状态：active 进行中、completed 已完成、archived 已归档。
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'completed', 'archived')),
    -- 内部数据版本号：业务数据变化时递增；检测过期修改和 AI 结果，界面无需展示。
    revision INTEGER NOT NULL DEFAULT 1
        CHECK (typeof(revision) = 'integer' AND revision >= 1),
    -- 创建时间，使用 UTC 保存。
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- 最近修改时间，使用 UTC 保存；由应用在更新时维护。
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_projects_status_updated
    ON projects (status, updated_at DESC, id);

-- 02. quotes：报价身份、原文件位置及核对版本。
CREATE TABLE quotes (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80),
    project_id TEXT NOT NULL,
    contractor_name TEXT CHECK (contractor_name IS NULL OR length(contractor_name) <= 200),
    filename TEXT,
    source_type TEXT NOT NULL CHECK (source_type IN ('pdf', 'image', 'text')),
    content_sha256 TEXT NOT NULL CHECK (
        length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    file_ref TEXT NOT NULL CHECK (length(file_ref) > 0),
    page_count INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(page_count) = 'integer' AND page_count BETWEEN 0 AND 30),
    source_method TEXT CHECK (
        source_method IS NULL OR source_method IN ('pdf_text', 'vision_ocr', 'mixed', 'paste')
    ),
    status TEXT NOT NULL DEFAULT 'imported' CHECK (
        status IN ('imported', 'extracting', 'review_required', 'reviewed', 'failed')
    ),
    review_version INTEGER NOT NULL DEFAULT 1
        CHECK (typeof(review_version) = 'integer' AND review_version >= 1),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CONSTRAINT uq_quotes_project_hash UNIQUE (project_id, content_sha256),
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE INDEX idx_quotes_project_created ON quotes (project_id, created_at, id);

-- 03. source_blocks：原文块、页码和归一化定位坐标。
CREATE TABLE source_blocks (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80),
    quote_id TEXT NOT NULL,
    page INTEGER CHECK (page IS NULL OR (typeof(page) = 'integer' AND page >= 1)),
    ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
    text TEXT NOT NULL,
    bbox_json TEXT CHECK (
        bbox_json IS NULL OR CASE WHEN json_valid(bbox_json) THEN
            json_type(bbox_json) = 'array'
            AND json_array_length(bbox_json) = 4
            AND json_type(bbox_json, '$[0]') IN ('integer', 'real')
            AND json_type(bbox_json, '$[1]') IN ('integer', 'real')
            AND json_type(bbox_json, '$[2]') IN ('integer', 'real')
            AND json_type(bbox_json, '$[3]') IN ('integer', 'real')
            AND json_extract(bbox_json, '$[0]') BETWEEN 0 AND 1
            AND json_extract(bbox_json, '$[1]') BETWEEN 0 AND 1
            AND json_extract(bbox_json, '$[2]') BETWEEN 0 AND 1
            AND json_extract(bbox_json, '$[3]') BETWEEN 0 AND 1
            AND json_extract(bbox_json, '$[0]') + json_extract(bbox_json, '$[2]') <= 1.000001
            AND json_extract(bbox_json, '$[1]') + json_extract(bbox_json, '$[3]') <= 1.000001
        ELSE 0 END
    ),
    ocr_confidence REAL CHECK (
        ocr_confidence IS NULL OR ocr_confidence BETWEEN 0 AND 1
    ),
    UNIQUE (quote_id, ordinal),
    FOREIGN KEY (quote_id) REFERENCES quotes (id) ON DELETE CASCADE
);

CREATE INDEX idx_source_blocks_quote_page ON source_blocks (quote_id, page, ordinal);

-- 04. extractions：不可变的原始模型提取结果。
CREATE TABLE extractions (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80),
    quote_id TEXT NOT NULL,
    source_hash TEXT NOT NULL CHECK (
        length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'
    ),
    raw_json TEXT NOT NULL CHECK (
        CASE WHEN json_valid(raw_json) THEN json_type(raw_json) = 'object' ELSE 0 END
    ),
    provider TEXT NOT NULL CHECK (provider IN ('openai', 'claude', 'deepseek')),
    model_id TEXT NOT NULL CHECK (length(model_id) > 0),
    prompt_version TEXT NOT NULL CHECK (length(prompt_version) > 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (quote_id, id),
    FOREIGN KEY (quote_id) REFERENCES quotes (id) ON DELETE CASCADE
);

CREATE INDEX idx_extractions_quote_created ON extractions (quote_id, created_at DESC);

-- 05. reviews：核对事实按版本追加；导入时建立 version=1 的空核对记录。
CREATE TABLE reviews (
    quote_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
    extraction_id TEXT,
    contractor_name TEXT,
    editable_facts_json TEXT NOT NULL DEFAULT '[]' CHECK (
        CASE WHEN json_valid(editable_facts_json)
            THEN json_type(editable_facts_json) = 'array' ELSE 0 END
    ),
    warnings_json TEXT NOT NULL DEFAULT '[]' CHECK (
        CASE WHEN json_valid(warnings_json) THEN json_type(warnings_json) = 'array' ELSE 0 END
    ),
    saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (quote_id, version),
    FOREIGN KEY (quote_id) REFERENCES quotes (id) ON DELETE CASCADE,
    FOREIGN KEY (quote_id, extraction_id) REFERENCES extractions (quote_id, id)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_reviews_extraction ON reviews (quote_id, extraction_id);

-- 06. field_mappings：整个项目的字段全集映射，每次保存追加一个版本。
CREATE TABLE field_mappings (
    project_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
    source_revision INTEGER NOT NULL CHECK (
        typeof(source_revision) = 'integer' AND source_revision >= 1
    ),
    groups_json TEXT NOT NULL CHECK (
        CASE WHEN json_valid(groups_json) THEN json_type(groups_json) = 'array' ELSE 0 END
    ),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (project_id, version),
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE INDEX idx_field_mappings_source ON field_mappings (project_id, source_revision);

-- 07. confirmations：固定项目版本、全部报价版本及字段映射版本。
CREATE TABLE confirmations (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80),
    project_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL CHECK (
        typeof(source_revision) = 'integer' AND source_revision >= 1
    ),
    mapping_version INTEGER NOT NULL CHECK (
        typeof(mapping_version) = 'integer' AND mapping_version >= 1
    ),
    quote_versions_json TEXT NOT NULL CHECK (
        CASE WHEN json_valid(quote_versions_json) THEN
            json_type(quote_versions_json) = 'array'
            AND json_array_length(quote_versions_json) BETWEEN 1 AND 5
        ELSE 0 END
    ),
    allow_pending INTEGER NOT NULL DEFAULT 0 CHECK (allow_pending IN (0, 1)),
    pending_count INTEGER NOT NULL DEFAULT 0 CHECK (
        typeof(pending_count) = 'integer' AND pending_count >= 0
    ),
    confirmed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, mapping_version) REFERENCES field_mappings (project_id, version)
        ON DELETE CASCADE
);

CREATE INDEX idx_confirmations_mapping ON confirmations (project_id, mapping_version);
CREATE INDEX idx_confirmations_source ON confirmations (project_id, source_revision);

-- 08. comparisons：不可变对比快照，包含原文与原页图副本位置。
-- 不关联当前 quotes：删除报价后，历史快照仍保留报价 ID 与依据。
CREATE TABLE comparisons (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80),
    project_id TEXT NOT NULL,
    confirmation_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL CHECK (
        typeof(source_revision) = 'integer' AND source_revision >= 1
    ),
    snapshot_json TEXT NOT NULL CHECK (
        CASE WHEN json_valid(snapshot_json) THEN json_type(snapshot_json) = 'object' ELSE 0 END
    ),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, confirmation_id) REFERENCES confirmations (project_id, id)
        ON DELETE CASCADE
);

CREATE INDEX idx_comparisons_project_created
    ON comparisons (project_id, created_at DESC, id);
CREATE INDEX idx_comparisons_confirmation ON comparisons (project_id, confirmation_id);

-- 09. drafts：可编辑草稿。quote_id 指快照中的承包商，不 FK 到当前 quotes。
CREATE TABLE drafts (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80),
    project_id TEXT NOT NULL,
    comparison_id TEXT NOT NULL,
    quote_id TEXT NOT NULL CHECK (length(quote_id) BETWEEN 1 AND 80),
    revision INTEGER NOT NULL DEFAULT 1
        CHECK (typeof(revision) = 'integer' AND revision >= 1),
    language TEXT NOT NULL CHECK (language IN ('zh-CN', 'en')),
    question_ids_json TEXT NOT NULL CHECK (
        CASE WHEN json_valid(question_ids_json) THEN json_type(question_ids_json) = 'array' ELSE 0 END
    ),
    subject TEXT NOT NULL CHECK (length(subject) <= 500),
    body TEXT NOT NULL CHECK (length(body) <= 20000),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, comparison_id) REFERENCES comparisons (project_id, id)
        ON DELETE CASCADE
);

CREATE INDEX idx_drafts_comparison_quote
    ON drafts (comparison_id, quote_id, updated_at DESC);
CREATE INDEX idx_drafts_project ON drafts (project_id);

-- 10. jobs：持久化任务队列。input/result/error JSON 不含 API Key。
CREATE TABLE jobs (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80),
    project_id TEXT,
    kind TEXT NOT NULL CHECK (
        kind IN ('extraction', 'alignment', 'draft', 'report', 'connection_test')
    ),
    state TEXT NOT NULL DEFAULT 'queued' CHECK (
        state IN ('queued', 'running', 'succeeded', 'partial_failed', 'failed',
                  'cancel_requested', 'cancelled', 'interrupted')
    ),
    stage TEXT NOT NULL DEFAULT '',
    input_json TEXT NOT NULL CHECK (
        CASE WHEN json_valid(input_json) THEN json_type(input_json) = 'object' ELSE 0 END
    ),
    result_json TEXT CHECK (
        result_json IS NULL OR CASE WHEN json_valid(result_json)
            THEN json_type(result_json) = 'object' ELSE 0 END
    ),
    error_json TEXT CHECK (
        error_json IS NULL OR CASE WHEN json_valid(error_json)
            THEN json_type(error_json) = 'object' ELSE 0 END
    ),
    completed_units INTEGER NOT NULL DEFAULT 0 CHECK (
        typeof(completed_units) = 'integer' AND completed_units >= 0
    ),
    total_units INTEGER NOT NULL DEFAULT 0 CHECK (
        typeof(total_units) = 'integer' AND total_units >= 0
    ),
    provider TEXT CHECK (provider IS NULL OR provider IN ('openai', 'claude', 'deepseek')),
    model_id TEXT,
    connection_generation INTEGER CHECK (
        connection_generation IS NULL OR
        (typeof(connection_generation) = 'integer' AND connection_generation >= 1)
    ),
    resource_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (total_units = 0 OR completed_units <= total_units),
    CHECK ((kind = 'connection_test' AND project_id IS NULL)
        OR (kind <> 'connection_test' AND project_id IS NOT NULL)),
    CHECK ((provider IS NULL AND model_id IS NULL AND connection_generation IS NULL)
        OR (provider IS NOT NULL AND model_id IS NOT NULL)),
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE INDEX idx_jobs_queue ON jobs (state, created_at, id);
CREATE INDEX idx_jobs_project ON jobs (project_id, created_at DESC);
CREATE UNIQUE INDEX uq_jobs_project_writer
    ON jobs (project_id)
    WHERE kind IN ('extraction', 'alignment')
      AND state IN ('queued', 'running', 'cancel_requested');

-- 11. reports：冻结的预览与报告文件，关联同一项目中的对比快照。
CREATE TABLE reports (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80),
    project_id TEXT NOT NULL,
    comparison_id TEXT NOT NULL,
    job_id TEXT NOT NULL UNIQUE,
    format TEXT NOT NULL CHECK (format IN ('pdf', 'csv')),
    options_json TEXT NOT NULL CHECK (
        CASE WHEN json_valid(options_json) THEN json_type(options_json) = 'object' ELSE 0 END
    ),
    preview_ref TEXT,
    file_ref TEXT,
    filename TEXT NOT NULL CHECK (length(filename) > 0),
    status TEXT NOT NULL DEFAULT 'generating'
        CHECK (status IN ('generating', 'ready', 'failed')),
    failure_code TEXT,
    source_revision INTEGER NOT NULL CHECK (
        typeof(source_revision) = 'integer' AND source_revision >= 1
    ),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at TEXT,
    CHECK (status <> 'ready' OR
        (file_ref IS NOT NULL AND preview_ref IS NOT NULL AND completed_at IS NOT NULL)),
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, comparison_id) REFERENCES comparisons (project_id, id)
        ON DELETE CASCADE,
    FOREIGN KEY (project_id, job_id) REFERENCES jobs (project_id, id)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_reports_comparison ON reports (comparison_id, created_at DESC);
CREATE INDEX idx_reports_project ON reports (project_id, created_at DESC);

-- 12. usage_calls：每次实际模型请求一条；删除业务项目后保留使用台账。
-- generation 是历史配置代际，不 FK 到只保留当前配置的 app_settings。
CREATE TABLE usage_calls (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80),
    job_id TEXT,
    project_id TEXT,
    provider TEXT NOT NULL CHECK (provider IN ('openai', 'claude', 'deepseek')),
    model_id TEXT NOT NULL CHECK (length(model_id) > 0),
    connection_generation INTEGER CHECK (
        connection_generation IS NULL OR
        (typeof(connection_generation) = 'integer' AND connection_generation >= 1)
    ),
    credential_scope TEXT NOT NULL CHECK (credential_scope IN ('saved', 'ephemeral')),
    purpose TEXT NOT NULL CHECK (purpose IN ('extraction', 'alignment', 'draft', 'connection_test')),
    outcome TEXT NOT NULL DEFAULT 'unknown'
        CHECK (outcome IN ('succeeded', 'failed', 'cancelled', 'unknown')),
    input_tokens INTEGER CHECK (
        input_tokens IS NULL OR (typeof(input_tokens) = 'integer' AND input_tokens >= 0)
    ),
    output_tokens INTEGER CHECK (
        output_tokens IS NULL OR (typeof(output_tokens) = 'integer' AND output_tokens >= 0)
    ),
    cached_input_tokens INTEGER CHECK (
        cached_input_tokens IS NULL OR
        (typeof(cached_input_tokens) = 'integer' AND cached_input_tokens >= 0)
    ),
    usage_known INTEGER NOT NULL DEFAULT 0 CHECK (usage_known IN (0, 1)),
    estimated_cost_amount TEXT CHECK (
        estimated_cost_amount IS NULL OR (
            length(estimated_cost_amount) > 0
            AND estimated_cost_amount NOT GLOB '*[^0-9.]*'
            AND substr(estimated_cost_amount, 1, 1) BETWEEN '0' AND '9'
            AND substr(estimated_cost_amount, -1, 1) BETWEEN '0' AND '9'
            AND length(estimated_cost_amount) - length(replace(estimated_cost_amount, '.', '')) <= 1
        )
    ),
    estimated_cost_currency TEXT CHECK (
        estimated_cost_currency IS NULL OR
        (length(estimated_cost_currency) = 3 AND estimated_cost_currency NOT GLOB '*[^A-Z]*')
    ),
    pricing_version TEXT,
    raw_usage_json TEXT CHECK (
        raw_usage_json IS NULL OR CASE WHEN json_valid(raw_usage_json)
            THEN json_type(raw_usage_json) = 'object' ELSE 0 END
    ),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK ((credential_scope = 'saved' AND connection_generation IS NOT NULL)
        OR (credential_scope = 'ephemeral' AND connection_generation IS NULL
            AND purpose = 'connection_test')),
    CHECK (usage_known = 0 OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL)),
    CHECK (cached_input_tokens IS NULL OR input_tokens IS NULL OR cached_input_tokens <= input_tokens),
    CHECK ((estimated_cost_amount IS NULL AND estimated_cost_currency IS NULL)
        OR (estimated_cost_amount IS NOT NULL AND estimated_cost_currency IS NOT NULL
            AND pricing_version IS NOT NULL AND usage_known = 1)),
    FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE SET NULL,
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL
);

CREATE INDEX idx_usage_calls_provider_generation_created
    ON usage_calls (provider, connection_generation, created_at, id);
CREATE INDEX idx_usage_calls_job ON usage_calls (job_id);
CREATE INDEX idx_usage_calls_project ON usage_calls (project_id);

-- 13. app_settings：固定 singleton_id=1；只存当前连接的钥匙串引用。
CREATE TABLE app_settings (
    singleton_id INTEGER NOT NULL PRIMARY KEY CHECK (singleton_id = 1),
    provider TEXT NOT NULL DEFAULT 'openai' CHECK (provider IN ('openai', 'claude', 'deepseek')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (typeof(revision) = 'integer' AND revision >= 1),
    keychain_ref TEXT,
    key_hint TEXT CHECK (key_hint IS NULL OR length(key_hint) = 4),
    balance_cache_json TEXT CHECK (
        balance_cache_json IS NULL OR CASE WHEN json_valid(balance_cache_json)
            THEN json_type(balance_cache_json) = 'object' ELSE 0 END
    ),
    balance_checked_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK ((keychain_ref IS NULL AND key_hint IS NULL)
        OR (keychain_ref IS NOT NULL AND key_hint IS NOT NULL)),
    CHECK ((balance_cache_json IS NULL AND balance_checked_at IS NULL)
        OR (balance_cache_json IS NOT NULL AND balance_checked_at IS NOT NULL))
);

-- 14. idempotency_keys：同一操作 + 同一幂等键复用响应，不重复启动任务。
CREATE TABLE idempotency_keys (
    operation TEXT NOT NULL CHECK (length(operation) > 0),
    key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 100),
    project_id TEXT,
    request_hash TEXT NOT NULL CHECK (
        length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),
    state TEXT NOT NULL DEFAULT 'in_progress'
        CHECK (state IN ('in_progress', 'completed')),
    response_status INTEGER CHECK (response_status IS NULL OR response_status BETWEEN 200 AND 599),
    response_ref TEXT,
    response_json TEXT CHECK (
        response_json IS NULL OR CASE WHEN json_valid(response_json)
            THEN json_type(response_json) = 'object' ELSE 0 END
    ),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at TEXT NOT NULL,
    PRIMARY KEY (operation, key),
    CHECK (expires_at > created_at),
    CHECK (state <> 'completed' OR (response_status IS NOT NULL AND response_json IS NOT NULL)),
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE INDEX idx_idempotency_keys_expiry ON idempotency_keys (expires_at);
CREATE INDEX idx_idempotency_keys_project ON idempotency_keys (project_id);

-- 业务约束触发器：导入数量上限、身份固定、历史版本禁止原地改写。
CREATE TRIGGER trg_quotes_limit
BEFORE INSERT ON quotes
WHEN (SELECT count(*) FROM quotes WHERE project_id = NEW.project_id) >= 5
BEGIN
    SELECT RAISE(ABORT, 'QUOTE_LIMIT');
END;

CREATE TRIGGER trg_quotes_project_immutable
BEFORE UPDATE OF project_id ON quotes
WHEN NEW.project_id <> OLD.project_id
BEGIN
    SELECT RAISE(ABORT, 'QUOTE_PROJECT_IMMUTABLE');
END;

CREATE TRIGGER trg_extractions_immutable
BEFORE UPDATE ON extractions
BEGIN
    SELECT RAISE(ABORT, 'EXTRACTION_IMMUTABLE');
END;

CREATE TRIGGER trg_reviews_immutable
BEFORE UPDATE ON reviews
BEGIN
    SELECT RAISE(ABORT, 'REVIEW_VERSION_IMMUTABLE');
END;

CREATE TRIGGER trg_field_mappings_immutable
BEFORE UPDATE ON field_mappings
BEGIN
    SELECT RAISE(ABORT, 'MAPPING_VERSION_IMMUTABLE');
END;

CREATE TRIGGER trg_confirmations_immutable
BEFORE UPDATE ON confirmations
BEGIN
    SELECT RAISE(ABORT, 'CONFIRMATION_IMMUTABLE');
END;

CREATE TRIGGER trg_comparisons_immutable
BEFORE UPDATE ON comparisons
BEGIN
    SELECT RAISE(ABORT, 'COMPARISON_IMMUTABLE');
END;

CREATE TRIGGER trg_provider_switch_clear_key
BEFORE UPDATE OF provider ON app_settings
WHEN NEW.provider <> OLD.provider AND
    (NEW.keychain_ref IS NOT NULL OR NEW.key_hint IS NOT NULL
     OR NEW.balance_cache_json IS NOT NULL OR NEW.balance_checked_at IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'PROVIDER_SWITCH_MUST_CLEAR_KEY');
END;

-- 首次启动配置；不创建或保存任何 API Key。
INSERT INTO app_settings (singleton_id, provider, revision) VALUES (1, 'openai', 1);

COMMIT;
