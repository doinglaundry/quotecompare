# QuoteCompare

面向房东与物业经理的 Mac 本地桌面 App。Quote Compare 是其中一个功能模块，用于整理承包商报价、核对字段、对比差异、生成追问和导出报告。

本仓库保存产品资料、技术方案和接口契约，后续前后端代码也在此仓库开发。当前已收录文档，尚未实现 App。

## 产品与技术资料

- [PRD 总览图](docs/prd/QuoteCompare-PRD-overview-v3.png)
- [PRD PDF](docs/prd/QuoteCompare-PRD-overview-v3.pdf)
- [最新简化技术方案（HTML）](docs/technical/QuoteCompare-technical-design-v2.html)
- [旧版技术方案（历史参考）](docs/technical/QuoteCompare-technical-design-v1.html)
- 新版架构图内嵌在简化技术方案中；[旧版架构图](docs/technical/QuoteCompare-backend-architecture.svg)仅作历史参考。
- [最新 OpenAPI 接口定义（25 项）](docs/technical/QuoteCompare-openapi-v2.json)
- [最新 SQLite 完整建表 SQL（6 张表）](docs/technical/database-schema-v2.sql)

技术方案保留现有 HTML 格式。下载仓库后，用浏览器打开该文件即可阅读；其中内嵌七张产品图，包含前端代码组织、界面调用表、六张表的完整 SQL 和二十五项接口定义。详细内容可按需展开。

## 七个产品界面

| 界面 | 完整产品图 |
| --- | --- |
| 报价资料 | [查看图片](docs/product-screens/01-报价资料.png) |
| 核对 | [查看图片](docs/product-screens/02-核对.png) |
| 对比 | [查看图片](docs/product-screens/03-对比.png) |
| 追问 | [查看图片](docs/product-screens/04-追问.png) |
| 报告预览与导出 | [查看图片](docs/product-screens/05-报告预览与导出.png) |
| 模型设置 | [查看图片](docs/product-screens/06-模型设置.png) |
| 用量与费用 | [查看图片](docs/product-screens/07-用量与费用.png) |

## 已确定的技术方向

- 前端：JavaScript / React / Electron。
- 后端：一个本地 Python / FastAPI 服务，四个业务模块。
- 存储：SQLite 与本地文件；密钥保存在 macOS 钥匙串。
- 模型服务商：OpenAI、Claude、DeepSeek；只保存当前服务商的一组配置。
- 打包：随 App 打包 Python 环境，用户无需另装 Python。
- 存储：六张表；最新提取和人工核对合并保存，历史对比快照独立保留。
- 接口：25 项本机接口，类型、功能、入参和出参见 v2 技术方案与 OpenAPI。
- 首版不保留逐次人工编辑和每次 AI 提取历史；最新模型输出与当前人工核对分别保存。
- v2 是新的首版设计契约，尚未实现 App；旧版不与新版混用。SQL 是空库建库脚本，不是旧库迁移脚本。

## 后续代码位置

```text
quotecompare/
  frontend/    # 后续桌面界面与 Electron 代码
  backend/     # 后续 Python 本地服务
  docs/
    prd/
    product-screens/
    technical/
```

`frontend/` 与 `backend/` 在开始实现时创建，具体设计以技术方案为准。
