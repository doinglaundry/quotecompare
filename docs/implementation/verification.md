# QuoteCompare v0.1 验证记录

日期：2026-10-07。环境：Apple Silicon，macOS 15.7.4，Python 3.14.3，Electron 38.8.6，React 19，SQLite。

本次实现保留一个 Python 服务、四个业务模块、六张表、25 项接口。sqlite3 直接事务处理，jsonschema 复用 OpenAPI，不增加 ORM、重复 DTO、消息队列或独立服务。

## 功能与验证对应

| 功能 | 实际验证 |
| --- | --- |
| 项目与报价资料 | 新建/编辑/状态/删除；PDF、图片、文字导入；最多五份、50MB、30页；内容去重、请求重放与过期修改；桌面编辑项目已实际点击 |
| 本地原文 | 真正 PDF 解析及 macOS Vision 图片 OCR；已有原文块编号/页码/坐标；无效及超页数文件拒绝 |
| AI 提取 | 三家实际 HTTP 客户端协议；字段原文引用校验；格式无效不写入；人工修改需明确确认后才能替换 |
| 人工核对 | 改规范值、确认状态、保存；原始字段和依据不可改写；单价/合计、币种、单位、税费分开；未知保持 null |
| 字段归并 | 全部字段并集、每个事实恰好覆盖一次；完整含义/工项/口径一致才合并；缺失列显示“— 未提供” |
| 对比与历史 | 固定快照、原文副本、差异/缺失/范围/税/币种/算术提示；删报价和重启后历史依据仍可读取 |
| 追问草稿 | 所选问题归属检查；生成、编辑、保存、复制；重新打开/刷新后恢复；不自动发送 |
| 报告 | 同一快照生成 HTML、PDF、CSV；真实保存对话框 IPC；地址正文及附录隐藏、CSV 公式转义、长单元格跨页 |
| 模型设置 | 三家枚举、一个当前配置、预设模型；切换删旧 Key；实际 macOS 钥匙串存取，明文不进入设置文件 |
| 用量与费用 | 已知 Token 和 Decimal 费用；格式失败仍记录已发生用量；网络结果不确定记录未知，禁止自动重试；删除项目保留台账 |
| 余额 | 独立账户查询；DeepSeek 按币种余额、五分钟缓存与强制刷新；其他服务商首版提供官方入口 |
| 任务 | 提交时冻结输入；后台执行、去重、取消、重启标中断；过期结果不覆盖新修改；当前配置有任务时不能更换 |
| 文件与连接 | 每次启动令牌、仅本机端口、受控 IPC、清单编号读取；网页 Origin 拒绝；重启清理孤儿/临时文件 |

## 本次运行结果

- 后端：`python -m pytest backend/tests -q`，**19 passed**。包含真实 Mac OCR 与钥匙串测试。
- 接口覆盖：应用生成的路由和 v2 OpenAPI 方法/路径集合一致，**25 项全部实现**。
- 前端：Vite 生产构建通过；Electron main/preload 语法检查通过。
- 桌面 E2E：实际启动 Electron，逐个操作七页。三份报价来自真实 PDF、真实图片 OCR、粘贴文字；完成提取 → 核对 → 归并 → 快照 → 原文依据 → 邮件编辑/复制/恢复 → PDF/CSV 保存 → 服务商切换 → 用量/余额。**通过**。
- 安装包：在系统 PATH（`/usr/bin:/bin:/usr/sbin:/sbin`）、清除 Python 环境变量、独立应用数据目录下启动打包后的 App；验证内置 Python 服务、真实 Keychain、PDF/图片 OCR、SQLite、对比与 PDF 导出。**通过**。
- 独立 agent 只读审查已执行；修改了参数不匹配、任务结果归属、草稿恢复、长表格分页、旧状态覆盖、未确认人工编辑保护等问题。未发现需要新增层次的理由。

## 验证边界

模型测试服务为测试专用的独立 HTTP 服务，覆盖真正的客户端请求/响应解析。生产应用没有模拟模型回退，始终调用当前服务商。未使用用户真实 API Key，真实账号模型可用性、自然语言提取质量、账单扣费未实测。用户仍需要核对 AI 结果。

当前安装包验证了 ARM64 Mac；Intel 构建工作流已提供但未在此机器执行。应用未做 Developer ID 签名或 Apple 公证，属于本地开发包；正式分发需要配置证书。没有“全新另一台 Mac”实机测试，本次系统 PATH 安装包测试验证了它不使用本机开发 Python 环境。

DeepSeek 存在高峰/低峰及中国法定节假日规则；本应用显示官方档位，未核验实际档位时费用保留未知。OpenAI/Claude 总账户余额并非本应用调用汇总，首版只提供官方账单入口。

## 实际应用截图

| 界面 | 截图 |
| --- | --- |
| 报价资料 | [查看](screens/01-materials.png) |
| 核对 | [查看](screens/02-review.png) |
| 对比 | [查看](screens/03-comparison.png) |
| 追问 | [查看](screens/04-questions.png) |
| 报告 | [查看](screens/05-report.png) |
| 设置 | [查看](screens/06-settings.png) |
| 用量 | [查看](screens/07-usage.png) |
| 打包运行 | [查看](screens/08-packaged.png) |

## 价格与协议依据

- [OpenAI GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini)：预设模型、标准输入/缓存/输出价格。
- [Claude 官方价格](https://platform.claude.com/docs/en/about-claude/pricing)：Sonnet 4.6 标准文本价格。
- [DeepSeek 模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)：[调用协议](https://api-docs.deepseek.com/api/create-chat-completion/)与[余额接口](https://api-docs.deepseek.com/api/get-user-balance/)。

上述价格于 2026-10-07 核对，应用超过七天后显示过期，不把过期或未知价格算成零。

独立审查最终结论：当前未发现新的阻断；版本检查、去重、快照、用量未知状态和钥匙串属于必要逻辑，不建议为减少行数删除。报告同时保留统一字段口径、币种和待确认/打包状态，避免导出后误读。
