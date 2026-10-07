# QuoteCompare

QuoteCompare 是给房东和物业经理使用的 **Mac 本地装修／维修报价对比应用**。

把同一项目的几份承包商报价导入后，应用调用用户自己的大模型 API，提取报价内容，再由用户核对，按统一维度查看价格、施工范围和缺失信息，生成追问邮件和报告。

本仓库包含应用源码、PRD、完整产品图、技术方案、数据库 SQL 和自动化测试。前端使用 JavaScript / React / Electron，后端使用 Python / FastAPI，数据使用 SQLite 和本地文件保存。

## 可以做什么

| 界面 | 功能 |
| --- | --- |
| 报价资料 | 创建、编辑、归档项目；导入 PDF、PNG/JPEG/WebP 或粘贴文字；查看项目历史 |
| 核对 | AI 提取报价；对照原文编辑字段；核对金额、材料、税费、工期和付款条件 |
| 对比 | 汇总所有报价的全部字段；同义且口径一致的字段归并；查看差异、缺失信息和风险提示；保存历史快照 |
| 追问 | 根据缺失信息选择问题；生成中英文邮件草稿；编辑、保存和复制，由用户自行发送 |
| 报告 | 预览报告；选择是否包含原文、追问或房产地址；导出 PDF / CSV |
| 模型设置 | 选择 OpenAI、Claude 或 DeepSeek；填写自己的 API Key；保存并测试连接 |
| 用量与费用 | 查看本应用调用记录、Token 和可估算费用；查询 DeepSeek 余额或打开服务商官方账单 |

例如，一份报价写“价格”，另一份写“金额”，只有含义和价格层级一致时才归并；单价与总价分别保留。所有独有字段也保留，其他报价缺失的值显示“未提供”，不补零、不猜是否包含。

每个项目最多五份报价，单份最大50MB，PDF最多30页。模型设置只保存当前一组连接；更换服务商会删除旧密钥，历史用量保留。API Key 存在 macOS 钥匙串中。

项目、原文和报告保存在此 Mac；**AI 分析需要网络**：AI 提取、归并、草稿及连接测试会通过网络调用所选服务商，发送该任务所需内容，并使用用户自己的 API 额度。未注明内容仍需人工确认。

## 从源码在本地启动

需要有访问本仓库的 GitHub 权限。完整应用依赖 macOS 的 OCR 和钥匙串；当前验证环境为 Apple Silicon / macOS 15.7，Windows / Linux 暂不支持完整流程。

开发环境需要：

- Git。
- Node.js 22.12 或更高版本，带 npm；Mac 构建工作流使用 Node.js 22。
- Python 3.14；后端和打包流程已在 Python 3.14.3 验证。

### 1. 准备环境

先查看版本：

```sh
git --version
node --version
npm --version
python3.14 --version
```

如果已安装 Homebrew，缺少依赖时可以安装：

```sh
brew install git node@22 python@3.14
export PATH="$(brew --prefix node@22)/bin:$PATH"
```

上述 PATH 只在当前终端生效。已有符合版本要求的 Node.js / Python 可以直接使用，不必重复安装。

### 2. 获取源码并安装依赖

```sh
git clone https://github.com/doinglaundry/quotecompare.git
cd quotecompare
python3.14 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
npm ci
```

如果仓库已在本机，直接进入仓库目录，从创建 `.venv` 开始。应用固定使用仓库里的 `.venv/bin/python`，不要只把依赖安装到系统 Python。若 `python3` 已是3.14，也可用 `python3 -m venv .venv`。

### 3. 启动应用

在仓库根目录执行：

```sh
npm start
```

该命令会构建前端、打开 Electron 窗口，并自动启动 Python 本地服务；不需要另开终端启动后端、手动配置端口或执行建表 SQL。首次启动会自动创建数据库，后端监听随机的 `127.0.0.1` 端口，界面通过受控 IPC 调用。

看到“项目与报价资料”页面即表示窗口已打开；应能打开“模型设置”，并正常创建项目。关闭应用窗口会退出应用并结束后端。再次启动仍使用 `npm start`。

启动步骤于2026-10-07在已有依赖的 Apple Silicon Mac 上实测：通过 `npm start` 在独立数据目录打开窗口和设置、创建项目、退出并重启，项目仍保留；未配置 API Key，也未调用模型。

### 4. 开始比较报价

1. 打开左下角“模型设置”，选择服务商，填写对应 API Key，保存并测试连接。
2. 新建项目，填写项目名称、房产和施工需求，导入2–5份报价。
3. 点击 AI 提取，逐份核对内容；确认所有字段的归并口径。
4. 保存对比，查看差异和缺失项；选择问题并生成追问草稿。
5. 预览报告并导出 PDF 或 CSV。

没有 API Key 也能启动、创建项目和导入文件；使用模型相关功能时才需要配置。密钥请在应用界面填写，不放进仓库、终端命令或聊天记录。

资料位于 Electron 的 `userData` 目录，macOS 默认为 `~/Library/Application Support/quotecompare/`；打包应用的目录名可能显示为 `QuoteCompare`。其中 `app.db` 保存业务数据。退出应用后备份整个数据目录即可保留数据库及关联文件；API Key 单独保存在系统钥匙串。

## 交给智能体的安装启动提示词

复制下面整段，交给**具备本机终端、文件和网络操作能力**的智能体。仓库为私有仓库，执行者需要已有 GitHub 访问权限。

```text
请帮我在这台 Mac 上安装并启动 QuoteCompare，仓库地址：
https://github.com/doinglaundry/quotecompare.git

请实际执行到应用窗口打开并完成验收，不要只给我命令或方案。

1. 检查系统是否为 macOS，检查 Git、Node.js、npm 和 Python 版本。
   需要 Node.js 22.12+、Python 3.14。优先使用已安装且符合要求的环境。
   缺少依赖时，使用已有包管理器安装；若已有 Homebrew，可安装 git、
   node@22、python@3.14，并将 node@22 的 bin 加入当前命令 PATH。
   缺少系统权限或包管理器时，只询问完成安装必需的信息。
   若不是 macOS，说明本应用依赖 macOS OCR/钥匙串，停止本地安装。
2. 优先复用本机已有的这个仓库，核对 Git remote；不存在时克隆到合适的
   用户目录。不得覆盖已有目录、重置代码或删除用户数据。
   若私有仓库无法访问，请帮助用户完成正常 GitHub 登录或获取访问权限；
   不要索取或打印令牌。拿到仓库后先阅读 README.md 和 AGENTS.md。
3. 在仓库根目录，用 Python 3.14 创建 .venv。已有环境先检查版本，不要
   直接删除；版本不匹配时保留旧环境，创建符合要求的环境。
   执行 .venv/bin/python -m pip install -r requirements-dev.txt 和 npm ci。
   使用 package-lock.json，不升级依赖，不修改业务代码。
4. 清除当前启动进程中的 ELECTRON_RUN_AS_NODE、QUOTECOMPARE_E2E 和
   QUOTECOMPARE_TEST_DATA（若有），然后在仓库根目录执行 npm start。
   让 Electron 自动启动本地 Python 服务，不另起无认证后端。
5. 检查应用是否显示“项目与报价资料”，是否能打开“模型设置”。
   可以使用自动化工具在独立临时 user-data-dir 下创建测试项目、重启
   并确认项目保留；测试完退出临时实例，再启动用户的正常实例。
   不向用户已有项目写测试数据。若无法操作窗口，请用户完成这两项检查，
   不要将进程存活当作界面验收成功。
6. 启动失败时读取必要错误并排查环境、依赖、构建或本地服务问题，修复后
   重试。不要假称已经启动；不要泄露密钥或使用模拟模型冒充真实连接。
7. 保持正常应用实例运行，告诉我仓库位置、实际使用的版本、验证结果，
   以及下次执行 npm start 的位置。说明 API Key 需由我在应用中自行填写；
   不替我调用付费模型、不自动发送邮件，不提交或推送任何代码改动。
```

## 直接使用打包应用

已有构建包时，解压并打开 `QuoteCompare.app`。Python、PDF解析和 OCR 依赖已包含，最终用户不需要安装 Node.js 或 Python。

可以通过 [Mac 构建工作流](.github/workflows/mac.yml) 手动生成并下载构建产物，需要仓库访问和工作流执行权限；也可按下一节本地打包。当前本地开发包未做 Developer ID 签名及 Apple 公证，正式分发需另外配置证书。

## 测试与打包

安装好开发依赖后，在仓库根目录执行：

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

`npm run package` 包含 Python 后端构建，Apple Silicon 产物为 `release/mac-arm64/QuoteCompare.app`。Intel 构建产物目录为 `release/mac/`，其安装包测试可显式指定路径：

```sh
node tests/e2e/packaged.cjs release/mac/QuoteCompare.app/Contents/MacOS/QuoteCompare
```

原生 OCR、钥匙串和桌面测试需在 Mac 执行。桌面 E2E 使用独立 HTTP 测试模型服务，验证客户端协议和桌面流程；不能证明真实个人账号的模型权限、自然语言提取质量或实际扣费。安装包另做系统 PATH 下的核心流程验收。具体结果与边界见 [验证记录](docs/implementation/verification.md) 和 [逐项测试结果](docs/implementation/coverage-results.json)。

模型使用当前预设，不提供额外模型下拉选择。费用为估算，价格过期或 Token、适用计费档不明时显示未知；DeepSeek 的高峰/低峰规则未完全核验，因此不估算其调用费用。账户余额与本应用用量分开，OpenAI / Claude 账户总余额通过官方账单查看。

## 代码与产品资料

```text
frontend/src/          七个界面与样式
frontend/electron/     窗口、本地服务启动、IPC、文件选择/保存、复制
backend/modules/      项目报价、分析对比、草稿报告、设置费用
backend/jobs.py       任务执行、进度、去重、取消和重启处理
backend/sources.py    PDF读取与 macOS Vision OCR
backend/providers.py  三家模型 HTTP 客户端
backend/tests/        后端业务与数据边界测试
tests/e2e/            实际桌面操作和安装包验证
docs/                 PRD、产品图、技术方案和验证记录
```

后端使用一个服务、四个业务模块、六张 SQLite 表和25项本机接口，直接使用 sqlite3 和 OpenAPI JSON Schema。

- [PRD总览](docs/prd/QuoteCompare-PRD-overview-v3.png) / [PDF](docs/prd/QuoteCompare-PRD-overview-v3.pdf)
- [技术方案v2：HTML，含七张设计图、DDL和接口](docs/technical/QuoteCompare-technical-design-v2.html)
- [OpenAPI：25项接口](docs/technical/QuoteCompare-openapi-v2.json)
- [建表SQL：六张表](docs/technical/database-schema-v2.sql)
- [实际应用截图](docs/implementation/screens)

v1文件保留为历史资料；v2 SQL用于首次建库，没有v1已上线数据的迁移实现。
