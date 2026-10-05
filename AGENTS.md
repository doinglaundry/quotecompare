# 开发约定

本仓库是 QuoteCompare 产品资料和后续代码的统一位置。

- PRD：`docs/prd/`；完整界面图：`docs/product-screens/`。
- 技术方案保持 HTML 格式：`docs/technical/QuoteCompare-technical-design-v1.html`。
- 接口契约：`docs/technical/QuoteCompare-openapi-v1.json`。
- 后续前端代码放 `frontend/`，后端代码放 `backend/`。
- 前端使用 JavaScript；后端使用 Python。App 必须打包运行环境，用户无需安装 Python。
- 保留左侧 App 模块入口；报价模块内部使用四个顶部标签。
- 对比保留全部字段，只有语义与口径一致的字段才归并；缺失值不填零。
- 仅保存当前服务商和密钥；密钥保存在 macOS 钥匙串，不提交到 Git。

## 全局代码风格

写代码时，声明和赋值必须与 `if` 条件分开，不在 `if` 条件中使用初始化语句。

Go 中禁止 `if init; condition`，包括错误检查、map 检查和类型断言。先单独赋值，再写 `if`，同时保持原来的作用域与行为。此规则适用于业务代码、测试和代码示例。
