# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

FlowPilot 是一个 Manifest V3 Chrome 侧边栏扩展，用于批量自动化 ChatGPT / OpenAI 账号注册、OAuth 授权、Plus 支付与多个平台（CPA / SUB2API / Codex2API）的接入；同时承载独立的 Kiro flow（Builder ID 注册 → 桌面授权 → `kiro.rs` 上传）。

没有构建/打包步骤——代码就是直接被 Chrome 加载的扩展产物。开发方式是「`chrome://extensions` → 加载已解压的扩展程序 → 选择仓库根目录」。

## 常用命令

```bash
# 全量测试（基于 node:test 原生 runner）
npm test

# 跑单个测试文件
node --test tests/background-step7-recovery.test.js

# 跑匹配名字的测试
node --test --test-name-pattern="add-phone" tests/*.test.js

# 静态语法检查（提交前推荐对改动文件做）
node --check path/to/file.js
```

测试是纯 Node 跑的，不会启动浏览器。它们针对 `background/*`、`flows/openai/background/steps/*`、纯工具模块等的纯函数 / 模块接入做单元/集成验证。

启动本地 helper（用于 Hotmail 本地收码与账号记录 JSON 快照同步）：

```bash
python scripts/hotmail_helper.py        # 跨平台
start-hotmail-helper.bat                # Windows
./start-hotmail-helper.command          # macOS
python scripts/gpc_sms_helper_macos.py  # GPC Plus 模式下 macOS 读 iMessage OTP
```

## 高层架构

### Flow / Workflow / nodeId 模型（重要）

项目**已经从「固定 1~10 步数字流程」升级为「flow + workflow node」模型**。所有新代码必须按此模型写：

- `activeFlowId` 决定当前 flow（`openai` | `kiro`），它会驱动步骤定义、执行器注册表、自动运行、状态同步全套装配。
- 步骤元数据的唯一来源是 [data/step-definitions.js](./data/step-definitions.js) 的 `FLOW_DEFINITION_BUILDERS`：
  - `getSteps(options)` → UI / 兼容步骤列表
  - `getNodes(options)` / `getWorkflow(options)` → 执行器与状态机用的 workflow 节点
- `step.id` 是 legacy 可见步骤号，只能用于 UI 展示。`step.key` / `node.nodeId` 才是流程执行、状态、跳过、恢复、日志归属的主键。
- 同一个可见步骤号在不同模式下可能是不同业务节点（Plus 尾链替换、绑定后重登、Codex2API 等），**不允许用 `if (step === 8)` 判断业务含义**，必须按当前 workflow 的 nodeId 解析。
- 影响步骤解析的维度至少包括：`activeFlowId`、`plusModeEnabled`、`plusPaymentMethod`、`signupMethod`、`phoneVerificationEnabled`、`phoneSignupReloginAfterBindEmailEnabled`、`contributionMode`、`stepExecutionRangeByFlow`。

### 分层

- `background.js` 只是 Service Worker 入口壳，负责按 `activeFlowId` 装配模块、运行入口与少量保留常量。**不要把新业务写回这里**。
- `background/*.js`：跨步骤的共享后台模块（自动运行控制器、消息路由、IP 代理、邮件 provider、贡献模式、账号记录、运行态等）。
- `flows/<flowId>/background/steps/*.js`：每步骤一个执行器，文件名语义化（如 `oauth-login.js`、`fetch-login-code.js`），由 `core/flow-kernel/step-registry.js` 装配。
- `core/flow-kernel/*`：flow / source / settings schema / workflow engine / runtime state / tab runtime / step registry 等 flow-aware 基础设施。
- `flows/<flowId>/content/*.js`、`content/*.js`：注入到 OpenAI 认证页、各邮箱页、PayPal / GoPay / WhatsApp / DuckDuckGo / iCloud 等页面的内容脚本。
- `sidepanel/*`：侧边栏 UI（`sidepanel.js` 是主入口，逻辑下沉到独立 manager / panel / helper 模块）。
- `*-utils.js`（根目录）：各 provider / 支付的纯工具函数，前后端共用、无副作用、可独立测试。
- `phone-sms/providers/*`：接码平台适配（HeroSMS / 5sim / NexSMS）。
- `data/step-definitions.js`：前后台共享的步骤/节点定义，是 flow 模型的事实来源。

### 运行态状态切分

后台状态被刻意按职责拆开，不能混用：

- `runtimeState`：当前轮临时状态（标签页、checkout、当前 activation 等）。
- `sharedState`：跨 flow 共享配置（IP 代理、邮件 provider 当前账号等）。
- `serviceState`：服务态（Hotmail、2925、PayPal、iCloud 等账号池）。
- `flowState`：flow 私有状态（OpenAI 的 `signupPhone*`、Kiro 的 `register / desktopAuth / upload` 等）。
- `registrationEmailState = { current, previous, source, updatedAt }`：注册邮箱共享运行态，**所有写入邮箱的路径都要经过 `background/registration-email-state.js`**，不要直接 `setEmailState`——它负责「清空当前保留比较基线」「Duck 生成前优先用侧栏当前可见邮箱」「Step 8 `add-email` 时保留手机号身份」这些边界。

`contributionMode` / `panelMode` 这类是**运行态 UI 模式**，不能混进 `PERSISTED_SETTING_DEFAULTS` 或配置导入导出。

### 日志步骤号

日志步骤号必须通过结构化元数据传递：`addLog(message, level, { step, stepKey })`。sidepanel 只从 `entry.step` / `entry.stepKey` 渲染步骤标签，**禁止用正则从日志正文解析「步骤 X / Step X」**。Plus 复用普通执行器时，必须先按当前运行态把可见步骤号解析出来再传日志，不能写死普通模式步骤号。

### OAuth / 接码 / 注册身份链路边界

这是项目最容易出问题的区域。改动前先区分注册模式（邮箱 vs 手机号）、登录身份、当前认证页状态：

- 邮箱注册：`oauth-login` 只输入邮箱身份；`fetch-login-code` 只处理邮箱登录验证码页；手机号验证只在 OAuth 后置补手机号链路出现。
- 手机号注册：`oauth-login` 只输入手机号身份；**手机号注册模式不允许回落到邮箱验证码** —— 见 `flows/openai/background/steps/oauth-login.js`。绑定邮箱要走独立 `bind-email` 节点。
- 手机号注册模式不允许号码复用 / 白嫖复用；UI 必须自动禁用。
- `confirm-oauth` 只处理 OAuth 同意页 + localhost 回调，**不允许暗中处理手机号、添加邮箱或邮箱验证码**。
- 强制邮箱重登只能通过单次执行参数覆盖登录身份，不能持久改写 `signupMethod`；`resolvedSignupMethod` 是当前轮冻结结果，不等于用户此刻 UI 选的 `signupMethod`。

详细规约见 [项目开发规范（AI协作）.md](./项目开发规范（AI协作）.md) §3.5。

### Plus 模式 / 账号接入策略

- Plus 只支持邮箱注册，不支持手机号注册。
- `plusAccountAccessStrategy` ∈ {`oauth`, `cpa_codex_session`, `sub2api_codex_session`}；由 target capability 决定可选项（CPA / SUB2API 支持会话导入，Codex2API 当前只支持 OAuth）。UI 上不支持的选项**必须直接禁用并回落为 `oauth`**，不能「看起来能选，执行时再报不支持」。
- 切到 session import 尾链时，**整段** `oauth-login → fetch-login-code → confirm-oauth → platform-verify` 被替换，而不是替换某一个固定编号步骤。session import 节点直接完成接入，不走 `platform-verify`。

### 自动运行 / Stop 语义

- `auto-run-controller.js` 用 `autoRunSessionId` 绑定每一轮，**手动停止后旧的倒计时计划/重试链路/恢复入口不能再复活已失效的自动流程**——所有新加的等待器、计时器、回调都必须做 Stop 感知。
- fresh-attempt reset 时显式保留 Plus 配置、PayPal 配置、`gmailBaseEmail` / `mail2925BaseEmail`、当前 2925 账号、`stepExecutionRangeByFlow` 等关键持久配置。
- 步骤等待、tab 等待、内容脚本重试等待都已做 Stop 感知（见 `core/flow-kernel/tab-runtime.js`）。

### 邮件 provider

新邮件 provider 至少要接入这些点：纯工具模块 → background provider（按需）→ sidepanel 配置 → Step 4/8 验证码链路 → 成功收尾。Gmail / 2925 这类「既影响注册邮箱生成、又影响 sidepanel 表单」的别名邮箱**必须**收敛到 `managed-alias-utils.js`，不能在 background / sidepanel / provider 分支各写一套。`2925 + provide` 才算别名 provider，`receive` 不算。

### 操作间延迟

- `operationDelayEnabled` 默认开，默认 2 秒，作用于内容脚本里的点击、输入和短等待。
- **显式排除** `confirm-oauth` / `platform-verify` 这类后台步骤——不要给它们加节奏门控。

## 代码改动检查清单

提交前至少确认（来自 §0.5 协作执行协议）：

1. `git status --short` 只包含本次任务文件。
2. `git diff --check` 无空白错误。
3. 改过的 JS 通过 `node --check`。
4. 跑相关定向测试，代码改动默认跑 `npm test`，无法运行需说明原因。
5. 中文文案、日志、注释、文档无可见乱码（乱码是阻塞问题）。
6. 提交信息用**中文**说明真实改动，不写「update / fix / AI 修改」这类空泛信息。
7. 涉及结构/链路变化时，同步更新 [项目文件结构说明.md](./项目文件结构说明.md) 与 [项目完整链路说明.md](./项目完整链路说明.md)。
8. `docs/md/` 是本地方案/草稿目录（`.gitignore` 忽略），除非用户明确要求否则不要 `git add` 它。

## 进一步阅读

- [项目文件结构说明.md](./项目文件结构说明.md)：全仓库非忽略文件清单与逐文件职责。新增/删除/重命名/职责变化时必须同步更新。
- [项目完整链路说明.md](./项目完整链路说明.md)：完整功能链路（注册 / 验证 / OAuth / Plus / 平台接入）的运行过程。
- [项目开发规范（AI协作）.md](./项目开发规范（AI协作）.md)：AI 协作执行协议、架构原则、模块边界、接入规范、测试与文档规范。
- `docs/错误重试分层策略.md`、`docs/多注册流程*.md`：错误恢复边界与多 flow 架构边界设计。
- `docs/ip-proxy-module.md`：IP 代理模块结构与 711Proxy 参数联动。
