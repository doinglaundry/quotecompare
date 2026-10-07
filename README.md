# QuoteCompare

房东与物业经理使用的 Mac 本地报价工具。左侧 Quote Compare 是 App 功能入口；右侧包含报价资料、核对、对比、追问，另有报告、模型设置和用量费用三个界面。

已实现 JavaScript / React / Electron 界面和一个 Python / FastAPI 本地服务：四个业务模块、六张 SQLite 表、25 项本机接口。直接使用 sqlite3 和 OpenAPI JSON Schema，不重复定义 ORM、DTO 或服务层。

## 使用

下载 Mac 应用，解压并打开 `QuoteCompare.app`。Python、PDF 解析和 OCR 依赖已包含在应用内，用户不用安装 Python。

1. 在模型设置里选择 OpenAI、Claude 或 DeepSeek，填写该服务商的 API Key，保存并测试连接。
2. 新建项目，导入 2–5 份 PDF、图片或文字报价。
3. AI 提取后核对字段；汇总全部字段并确认归并。
4. 保存对比快照，查看差异和缺失，生成并编辑追问邮件。
5. 预览报告，保存 PDF 或 CSV。资料保存在此 Mac，密钥仅存 macOS 钥匙串。

当前验证的安装包为 Apple Silicon / macOS 15.7。此开发包未做 Developer ID 签名和 Apple 公证；正式分发需另配置签名凭据。模型分析需要网络，并按自己的服务商账户计费。只保存当前一组连接；更换服务商会删除旧密钥，已有用量记录保留。

OpenAI 预设 `gpt-4.1-mini`、Claude 预设 `claude-sonnet-4-6`、DeepSeek 预设 `deepseek-flash`。每家模型按发布时配置固定，不增加模型选择菜单。价格数据超过七天显示过期；Token、价格或适用计费档不明时费用显示未知。DeepSeek 价格含高峰/低峰条件，应用未核验中国法定节假日，因此显示单价但不估算其调用费用；官方余额单独查询。OpenAI/Claude 的账户总余额请查看官方账单。

## 本地开发

开发者需要 Node.js 和 Python 3.14；这与最终用户安装应用是两回事。

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
npm ci
npm start
```

本地服务由 Electron 启动并监听随机的 `127.0.0.1` 端口，每次启动使用新会话令牌。界面通过固定操作的 IPC 调用服务，没有任意 URL、路径或命令接口。

```text
frontend/electron/     窗口、受控 IPC、文件选择/保存、复制
frontend/src/          七个界面与样式
backend/modules/      项目报价、分析对比、草稿报告、设置费用
backend/jobs.py       一个执行器、去重、进度、取消、重启中断
backend/sources.py    本地 PDF 读取与 macOS Vision OCR
backend/providers.py  三家 HTTP 客户端
backend/tests/        API 与数据边界测试
tests/e2e/            实际桌面操作及安装包验证
```

## 验证与打包

```sh
.venv/bin/python -m pytest backend/tests -q
.venv/bin/python tests/e2e/fixtures.py
npm run build
npm run test:e2e
npm run test:coverage
npm run test:recovery
npm run test:reads
npm run package
npm run test:packaged
```

OCR 和钥匙串测试需在原生 Mac 环境执行。桌面 E2E 使用独立测试 HTTP 模型服务，实际应用客户端仍完整执行三家请求协议；测试入口和模拟响应不进入安装包。真实个人账号的模型权限、模型内容质量及账单扣费尚未测试，不能把协议测试当成真实账户验证。

`npm run package` 内置 Python 并生成 `release/mac-arm64/QuoteCompare.app`（Intel Mac 上为 `mac`）；安装包测试把 PATH 限定为系统路径，验证不依赖开发环境。可手动触发 [Mac 构建工作流](.github/workflows/mac.yml) 生成 ARM64 / Intel 包；有证书时可选择正式签名、公证。没有证书的构建不会宣称正式分发。

本轮 25 个桌面覆盖场景、恢复/重复读取回归、21 项后端测试、代码简化和验证边界见 [验证记录](docs/implementation/verification.md)；[机器结果](docs/implementation/coverage-results.json)保留每项状态。

## 产品与接口

- [PRD 总览](docs/prd/QuoteCompare-PRD-overview-v3.png) / [PDF](docs/prd/QuoteCompare-PRD-overview-v3.pdf)
- [技术方案 v2（HTML，含七张设计图、DDL 和接口）](docs/technical/QuoteCompare-technical-design-v2.html)
- [OpenAPI（25 项接口）](docs/technical/QuoteCompare-openapi-v2.json)
- [完整建表 SQL（六张表）](docs/technical/database-schema-v2.sql)
- [实际应用截图](docs/implementation/screens)

旧版 v1 文件保留作历史资料。v2 SQL 用于首次建库；没有 v1 已上线数据的迁移实现。
