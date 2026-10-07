-- QuoteCompare 简化首版：六张表。首次建库使用；不是已有 v1 数据库的升级脚本。
PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
BEGIN;

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
    -- 当前统一字段全集；不保留每一次字段归并的独立历史版本。
    field_groups_json TEXT NOT NULL DEFAULT '[]'
        CHECK (CASE WHEN json_valid(field_groups_json) THEN json_type(field_groups_json) = 'array' ELSE 0 END),
    -- 等于 revision 时当前映射有效；报价/施工需求改变时置空。
    mappings_revision INTEGER CHECK (mappings_revision IS NULL OR mappings_revision >= 1),
    -- 创建时间，使用 UTC 保存。
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- 最近修改时间，使用 UTC 保存；由应用在更新时维护。
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

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
    -- 本地解析的原文块，包含页码/坐标；内部结构由 Pydantic 校验。
    source_blocks_json TEXT NOT NULL DEFAULT '[]'
        CHECK (CASE WHEN json_valid(source_blocks_json) THEN json_type(source_blocks_json) = 'array' ELSE 0 END),
    -- 最新模型输出；含模型、提示词版本、原始结果和提取事实，不含 API Key。
    extraction_json TEXT NOT NULL DEFAULT '{}'
        CHECK (CASE WHEN json_valid(extraction_json) THEN json_type(extraction_json) = 'object' ELSE 0 END),
    -- 当前人工核对数据；保留原文和原始提取，保存时不覆盖上面两列。
    reviewed_facts_json TEXT NOT NULL DEFAULT '[]'
        CHECK (CASE WHEN json_valid(reviewed_facts_json) THEN json_type(reviewed_facts_json) = 'array' ELSE 0 END),
    page_file_ids_json TEXT NOT NULL DEFAULT '[]'
        CHECK (CASE WHEN json_valid(page_file_ids_json) THEN json_type(page_file_ids_json) = 'array' ELSE 0 END),
    warnings_json TEXT NOT NULL DEFAULT '[]'
        CHECK (CASE WHEN json_valid(warnings_json) THEN json_type(warnings_json) = 'array' ELSE 0 END),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CONSTRAINT uq_quotes_project_hash UNIQUE (project_id, content_sha256),
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE TABLE comparisons (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80),
    project_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    source_revision INTEGER NOT NULL CHECK (
        typeof(source_revision) = 'integer' AND source_revision >= 1
    ),
    snapshot_json TEXT NOT NULL CHECK (
        CASE WHEN json_valid(snapshot_json) THEN json_type(snapshot_json) = 'object' ELSE 0 END
    ),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
    CHECK (length(snapshot_json) > 0)
);

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

CREATE TABLE jobs (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80),
    request_id TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
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

CREATE INDEX idx_projects_status_updated
    ON projects (status, updated_at DESC, id);

CREATE INDEX idx_quotes_project_created ON quotes (project_id, created_at, id);

CREATE INDEX idx_comparisons_project_created
    ON comparisons (project_id, created_at DESC, id);

CREATE INDEX idx_drafts_comparison_quote
    ON drafts (comparison_id, quote_id, updated_at DESC);

CREATE INDEX idx_drafts_project ON drafts (project_id);

CREATE INDEX idx_jobs_queue ON jobs (state, created_at, id);

CREATE INDEX idx_jobs_project ON jobs (project_id, created_at DESC);

CREATE UNIQUE INDEX uq_jobs_project_writer
    ON jobs (project_id)
    WHERE kind IN ('extraction', 'alignment')
      AND state IN ('queued', 'running', 'cancel_requested');

CREATE INDEX idx_usage_calls_provider_generation_created
    ON usage_calls (provider, connection_generation, created_at, id);

CREATE INDEX idx_usage_calls_job ON usage_calls (job_id);

CREATE INDEX idx_usage_calls_project ON usage_calls (project_id);

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

CREATE TRIGGER trg_comparisons_immutable
BEFORE UPDATE ON comparisons
BEGIN
    SELECT RAISE(ABORT, 'COMPARISON_IMMUTABLE');
END;

COMMIT;
