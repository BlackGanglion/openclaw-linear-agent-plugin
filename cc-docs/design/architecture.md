# OpenClaw Linear Agent Plugin - 核心架构

## 1. 部署模型

```
┌─────────────┐   HTTPS Webhook   ┌─────────┐   localhost   ┌──────────────────┐
│   Linear    │ ────────────────→ │  Funnel  │ ───────────→ │  Local Mac       │
│   (Cloud)   │                   │  (隧道)   │              │                  │
│             │   @linear/sdk     │          │              │  OpenClaw        │
│             │ ←──────────────── │          │              │  + Linear Plugin │
└─────────────┘                   └─────────┘              └──────────────────┘
```

**关键约束：**
- **单实例** — 本地 Mac 运行，无需考虑水平扩展
- **内存优先** — 进程重启才丢失状态
- **Funnel 公网 URL** — 需要配置为 Linear webhook 回调地址

---

## 2. 两个核心问题的技术选型

### 2.1 Webhook 接收：OpenClaw Gateway HTTP Server

使用 `api.registerHttpRoute()` 挂载到 OpenClaw 内置的 Gateway HTTP Server。

```typescript
api.registerHttpRoute({
  path: "/webhooks/linear",
  auth: "plugin",
  handler: (req, res) => { void webhookHandler(req, res); },
});
```

Webhook 签名验证使用 `@linear/sdk/webhooks` 的 `LinearWebhookClient`，由 SDK 自动完成 HMAC-SHA256 校验和事件解析。

### 2.2 Agent 执行：`runEmbeddedPiAgent()` (轻量模式)

使用 OpenClaw 内部 `extensionAPI.js` 的 `runEmbeddedPiAgent()`。

**当前用法（Issue Triage）：**
- `bootstrapContextMode: "lightweight"` — 不加载完整 workspace 上下文
- 无流式回调 — triage 只需要最终 JSON 结果，不需要实时推送
- `shouldEmitToolResult / shouldEmitToolOutput` 均返回 false — 静默执行
- 共享 session (`linear-shared`) — 所有 triage 任务共用同一 session file，信息可互参

**代价：**
- 依赖 OpenClaw 内部未公开的 `extensionAPI.js`（通过动态 resolve 加载）
- 与 OpenClaw 版本耦合较紧

**加载方式：**

```typescript
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

let _extensionAPI: ExtensionAPI | null = null;

async function getExtensionAPI(): Promise<ExtensionAPI> {
  if (!_extensionAPI) {
    const require = createRequire(import.meta.url);
    const mainEntry = require.resolve("openclaw");
    const openclawDir = dirname(dirname(mainEntry));
    _extensionAPI = await import(join(openclawDir, "dist", "extensionAPI.js"));
  }
  return _extensionAPI;
}
```

---

## 3. 核心链路

### 3.1 当前实现（Issue 自动分诊）

```
Linear Issue.create → Webhook → SDK 验签 → Issue 路由 → 收集上下文 → 构建 prompt
                                                          → runEmbeddedPiAgent → 解析 JSON
                                                          → 更新 issue + 发评论
```

### 3.2 整体架构

```
┌────────────────────────────────────────────────────────────────┐
│                   OpenClaw Linear Agent Plugin                  │
│                                                                │
│  ┌──────────────────────────────────────────────────────┐      │
│  │ HTTP Layer (registerHttpRoute)                        │      │
│  │ POST /webhooks/linear                                │      │
│  │ → LinearWebhookClient 验签 → 事件路由 → 返回 200     │      │
│  └─────────────────────┬────────────────────────────────┘      │
│                        │                                       │
│  ┌─────────────────────▼────────────────────────────────┐      │
│  │ Event Router (webhook/handler.ts)                     │      │
│  │ Issue.create → onIssueCreated callback                │      │
│  │ (AgentSession 事件处理已注释，待 Phase 2)              │      │
│  └─────────────────────┬────────────────────────────────┘      │
│                        │                                       │
│  ┌─────────────────────▼────────────────────────────────┐      │
│  │ Issue Triage (issue/triage.ts)                        │      │
│  │ 1. collectContext() — 通过 @linear/sdk 查询          │      │
│  │    issue + team + members + labels + workflow states  │      │
│  │ 2. 检查是否已完整分诊（全有则跳过）                    │      │
│  │ 3. buildAgentPrompt() — 只包含需要判断的字段          │      │
│  │ 4. parseTriageResult() — 从 agent 输出提取 JSON      │      │
│  │ 5. applyTriageResult() — 更新 issue + 发评论         │      │
│  └─────────────────────┬────────────────────────────────┘      │
│                        │                                       │
│  ┌─────────────────────▼────────────────────────────────┐      │
│  │ Agent Runner (agent/linear-agent.ts)                   │      │
│  │                                                       │      │
│  │  agentId = "linear" (独立隔离)                        │      │
│  │  session = "linear-shared" (共享上下文)                │      │
│  │  sessionsDir = ~/.openclaw/agents/linear/agent/sessions/│     │
│  │                                                       │      │
│  │  ext.runEmbeddedPiAgent({                             │      │
│  │    bootstrapContextMode: "lightweight",               │      │
│  │    timeoutMs: 300_000,  // 5 分钟                    │      │
│  │    shouldEmitToolResult: () => false,                 │      │
│  │  })                                                   │      │
│  └───────────────────────────────────────────────────────┘      │
│                                                                │
│  ┌───────────────────────────────────────────────────────┐      │
│  │ Linear API (通过 @linear/sdk)                         │      │
│  │ - client.issue(id) — 获取 issue 详情                  │      │
│  │ - team.memberships() — 获取团队成员                   │      │
│  │ - team.labels() — 获取可用标签                        │      │
│  │ - team.states() — 获取工作流状态                      │      │
│  │ - issue.update({...}) — 更新 assignee/priority/labels │      │
│  │ - client.createComment({...}) — 发分诊评论           │      │
│  └───────────────────────────────────────────────────────┘      │
│                                                                │
│  ┌───────────────────────────────────────────────────────┐      │
│  │ 已实现但未启用（Phase 2+）                             │      │
│  │ - LinearApiClient (src/api/linear.ts) — GraphQL 封装  │      │
│  │ - SessionManager (src/session/manager.ts) — 会话管理  │      │
│  │ - OAuth (src/api/oauth.ts) — OAuth 2.0 完整流程       │      │
│  └───────────────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────────────┘
```

### 3.3 上下文组织

**当前 Triage 模式：** Agent 不需要丰富的系统上下文，只需要分析 issue 信息并返回 JSON。

```
┌────────────────────────────────────────────────────────┐
│              OpenClaw 自动注入（插件无需关心）            │
│                                                        │
│  系统 prompt    工具描述、模型能力、运行时信息            │
│  Bootstrap     lightweight 模式 — 不加载完整文件        │
│  对话历史       sessionFile (JSONL) 自动读写维护         │
├────────────────────────────────────────────────────────┤
│              插件提供                                    │
│                                                        │
│  extraSystemPrompt   "只输出 JSON 结果"                 │
│  prompt              Triage prompt + issue 上下文       │
│  workspaceDir        config.defaultDir                  │
│  sessionFile         共享 linear-shared.jsonl           │
└────────────────────────────────────────────────────────┘
```

**Prompt 构建（IssueTriage.buildAgentPrompt）：**

```
TRIAGE_PROMPT (分诊规则 + 输出格式)
---
## Issue 信息
- 标识 / 标题 / 描述 / 团队

## 已有信息（无需判断）
- 负责人: xxx (已分配)
- ...

## 需要你判断的字段
### 负责人（从以下成员中选择）
  - 成员A (ID: xxx)
  - 成员B (ID: yyy)
### 优先级
### 标签
```

---

## 4. 模块职责

| 模块 | 文件 | 职责 | 当前状态 |
|------|------|------|----------|
| **插件入口** | `index.ts` | 注册 webhook 路由，串联分诊流程 | ✅ 活跃 |
| **Webhook Handler** | `src/webhook/handler.ts` | LinearWebhookClient 验签 + 事件路由 | ✅ 活跃 (仅 Issue.create) |
| **Issue Triage** | `src/issue/triage.ts` | 上下文收集 → prompt 构建 → 结果解析 → 应用 | ✅ 活跃 |
| **Agent Runner** | `src/agent/linear-agent.ts` | extensionAPI 加载 + runEmbeddedPiAgent | ✅ 活跃 |
| **类型定义** | `src/types.ts` | PluginConfig 校验、共享类型 | ✅ 活跃 |
| **Logger 类型** | `src/webhook/logger-types.ts` | PluginLogger 接口定义 | ✅ 活跃 |
| **Linear API Client** | `src/api/linear.ts` | GraphQL 封装（AgentSession 用） | ⏸️ 已实现，未启用 |
| **Session Manager** | `src/session/manager.ts` | session Map + abort 控制 | ⏸️ 已实现，未启用 |
| **OAuth** | `src/api/oauth.ts` | OAuth 2.0 授权/刷新/存储 | ⏸️ 已实现，未启用 |

---

## 5. 配置（MVP）

```json
{
  "webhookSecret": "linear-signing-secret",
  "linearApiKey": "lin_api_xxx",
  "agentId": "agent-uuid-from-linear",
  "defaultDir": "/Users/hujie/Work/my-project"
}
```

通过 `validateConfig()` 校验，`webhookSecret`、`linearApiKey`、`agentId` 为必填。

---

## 6. 目录结构

```
├── index.ts                  # 插件入口 (registerHttpRoute + 分诊串联)
├── openclaw.plugin.json      # 插件元数据和配置 schema
├── package.json
├── tsconfig.json
├── src/
│   ├── types.ts              # PluginConfig + 共享类型定义
│   ├── webhook/
│   │   ├── handler.ts        # LinearWebhookClient 验签 + 事件路由
│   │   └── logger-types.ts   # PluginLogger 接口
│   ├── issue/
│   │   └── triage.ts         # Issue 分诊器（上下文收集 + prompt + 解析 + 应用）
│   ├── agent/
│   │   └── linear-agent.ts   # runEmbeddedPiAgent 封装（隔离 agentId）
│   ├── api/
│   │   ├── linear.ts         # GraphQL 客户端（Phase 2: AgentSession）
│   │   └── oauth.ts          # OAuth 2.0（Phase 3）
│   └── session/
│       └── manager.ts        # 会话状态管理（Phase 2: AgentSession）
└── cc-docs/
    └── design/               # 设计文档
```

---

## 7. 实现阶段

### Phase 1: MVP — Issue 自动分诊 ✅ 已完成

1. 插件入口 + webhook 路由 + HMAC 验签（LinearWebhookClient）
2. Issue.create 事件路由
3. IssueTriage: 上下文收集 → prompt 构建 → agent 执行 → JSON 解析 → issue 更新 + 评论
4. Agent Runner: 独立 agentId + 共享 session + lightweight 模式
5. 通过 `@linear/sdk` (LinearClient) 读写 Linear 数据

**验收标准：** Linear 中创建新 issue → 自动分配负责人 + 优先级 + 标签 → 发评论说明理由。

### Phase 2: AgentSession 多轮对话

1. AgentSession.created / prompted / stop 事件处理（代码已注释，待启用）
2. SessionManager 会话管理 + AbortController 取消
3. LinearApiClient 流式 Activity 推送（thought/action/response/error）
4. 多轮对话 session file 复用
5. Watchdog 超时自动 kill
6. Agent Tools 注册（linear_issue / linear_comment / linear_session）

### Phase 3: 生产化

1. OAuth 2.0 + token 自动刷新（代码已实现）
2. 多仓库路由
3. 心跳保活
