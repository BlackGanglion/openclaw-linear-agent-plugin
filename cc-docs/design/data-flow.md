# 数据流设计

## 1. 核心场景数据流

### 1.1 场景 A：Issue 自动分诊（当前 MVP）

```
用户在 Linear 中创建新 Issue
            │
            ▼
Linear 发送 webhook: Issue.create
            │
    ┌───────▼───────┐
    │ Webhook Handler│
    │ LinearWebhookClient
    │ 1. SDK 自动 HMAC 验签
    │ 2. 解析事件类型
    │ 3. 返回 200
    └───────┬───────┘
            │
    ┌───────▼───────┐
    │ Event Router  │
    │ type=Issue, action=create
    │ → onIssueCreated callback
    └───────┬───────┘
            │ async (void)
    ┌───────▼──────────────┐
    │ IssueTriage           │
    │ .collectContext()     │
    │ 1. client.issue(id)  │ ← @linear/sdk
    │ 2. issue.assignee    │   检查已有字段
    │ 3. issue.labels()    │
    │ 4. 全部已有 → 跳过   │
    │ 5. team.memberships()│   仅当需要分配
    │ 6. team.labels()     │   仅当需要标签
    │ 7. team.states()     │
    └───────┬──────────────┘
            │
    ┌───────▼──────────────┐
    │ .buildAgentPrompt()  │
    │ TRIAGE_PROMPT        │
    │ + issue 信息          │
    │ + 已有字段（标记无需判断）│
    │ + 需要判断的字段 + 选项│
    └───────┬──────────────┘
            │
    ┌───────▼──────────────┐
    │ runLinearAgent()      │
    │ agentId = "linear"   │
    │ session = "linear-shared"
    │ bootstrapContextMode │
    │   = "lightweight"    │
    │ timeout = 5min       │
    │ → 返回文本输出        │
    └───────┬──────────────┘
            │
    ┌───────▼──────────────┐
    │ .parseTriageResult() │
    │ 正则提取 JSON:       │
    │ { assigneeId,        │
    │   priority,          │
    │   labelIds,          │
    │   reason }           │
    └───────┬──────────────┘
            │
    ┌───────▼──────────────┐
    │ .applyTriageResult() │
    │ 1. issue.update({    │
    │      assigneeId,     │
    │      priority,       │ → Linear API
    │      labelIds        │
    │    })                │
    │ 2. client.createComment({
    │      issueId,        │ → 分诊理由评论
    │      body: 理由      │
    │    })                │
    └──────────────────────┘
```

**关键设计：**
- 只更新缺失字段 — 已有 assignee/priority/labels 的不覆盖
- 全部已有时直接跳过 — 不浪费 agent 调用
- agent 自身 ID (excludeUserId) 从成员列表中排除 — 避免分配给自己

### 1.2 场景 B：@mention 多轮对话（Phase 2，代码已注释）

```
用户在 Linear issue 中 @mention Agent
            │
            ▼
Linear 创建 AgentSession，发送 webhook
            │
    ┌───────▼───────┐
    │ Webhook Handler│ 验签 + 200
    └───────┬───────┘
            │
    ┌───────▼───────┐
    │ Event Router  │
    │ type=AgentSessionEvent
    │ action=created/prompted/stopped
    └───────┬───────┘
            │
    ┌───────▼──────────────┐
    │ Session Manager       │
    │ 1. 创建/查找 session  │
    │ 2. 立即发送 thought   │ ← 满足 10s 要求
    │    → Linear API       │
    └───────┬──────────────┘
            │
    ┌───────▼──────────────┐
    │ Agent 执行 + 流式回报 │
    │ → thought/action/     │
    │   response/error      │ → Linear Activity API
    │ → completeSession     │
    └──────────────────────┘
```

### 1.3 场景 C：Stop Signal（Phase 2）

```
用户点击 "Stop" 按钮
            │
            ▼
Linear 发送 webhook: AgentSessionEvent.stopped
            │
    ┌───────▼──────────────┐
    │ Session Manager       │
    │ 1. 查找活跃 session   │
    │ 2. sessions.stop()    │ ← AbortController.abort()
    │ 3. 发送 response:     │
    │    "Execution stopped"│
    └──────────────────────┘
```

---

## 2. 时序约束

### Issue Triage（当前 MVP）

```
t=0ms       收到 webhook (Issue.create)
t<100ms     SDK 验签完成，返回 HTTP 200
t~100ms     开始异步 collectContext()
t~500-2s    Linear SDK 查询完成 (issue + team + members + labels + states)
t~2-3s      buildAgentPrompt() + 启动 runEmbeddedPiAgent()
t~5s-5min   agent 执行（lightweight 模式，通常较快）
t~end       applyTriageResult(): issue.update() + createComment()
```

### AgentSession（Phase 2，设计目标）

```
t=0ms       收到 webhook
t<100ms     返回 HTTP 200 (Linear 要求 <5s)
t<2000ms    发送首个 thought activity (Linear 要求 <10s)
t~3000ms    构建 prompt，启动 agent
t~5s-5min   agent 执行中，流式发送 thought/action
t<30min     必须有 activity（否则 session 变 stale）
t=end       发送 response + completeSession
```

---

## 3. 错误处理

| 场景 | 处理 | 对用户可见 |
|------|------|-----------|
| SDK 验签失败 | LinearWebhookClient 返回错误 | 否 |
| Issue 无 team | collectContext 返回 null，跳过 | 否 |
| Issue 已完整分诊 | collectContext 返回 null，跳过 | 否 |
| Agent 执行失败 | 记录 error 日志，不更新 issue | 否 |
| Agent 输出无 JSON | parseTriageResult 返回 null | 否 |
| JSON 解析失败 | 记录 warn 日志，跳过 | 否 |
| Linear API 调用失败 | 异常冒泡，由 handleIssueTriage catch | 否（仅日志） |

---

## 4. 数据类型定义

### 4.1 Webhook 事件（由 @linear/sdk 类型约束）

```typescript
// Issue 事件 — 当前使用
import type { EntityWebhookPayloadWithIssueData } from "@linear/sdk";
// payload.action: "create" | "update" | "remove"
// payload.data.id, payload.data.identifier, payload.data.title

// AgentSession 事件 — Phase 2
import type { AgentSessionEventWebhookPayload } from "@linear/sdk";
```

### 4.2 分诊相关类型（src/issue/triage.ts）

```typescript
/** Issue 上下文 — 传给 agent 分析 */
interface IssueContext {
  identifier: string;
  title: string;
  description: string;
  teamName: string;
  teamMembers: TeamMember[];         // 仅当需要分配时非空
  availableLabels: AvailableLabel[];  // 仅当需要标签时非空
  workflowStates: WorkflowState[];
  existing: {
    hasAssignee: boolean;
    assigneeName?: string;
    hasPriority: boolean;
    priority?: number;
    hasLabels: boolean;
    labelNames?: string[];
  };
}

/** Triage 结果 — agent 返回的 JSON */
interface TriageResult {
  assigneeId?: string;
  priority?: number;     // 0=无, 1=紧急, 2=高, 3=中, 4=低
  labelIds?: string[];
  reason: string;
}

interface TeamMember { id: string; name: string; displayName: string; }
interface AvailableLabel { id: string; name: string; }
interface WorkflowState { id: string; name: string; type: string; }
```

### 4.3 Agent Runner 类型（src/agent/linear-agent.ts）

```typescript
interface LinearAgentRunParams {
  sessionKey: string;       // 标识 key（如 "triage-{issueId}"）
  prompt: string;
  systemPrompt?: string;    // extraSystemPrompt
  workspaceDir?: string;
  timeoutMs?: number;       // 默认 5 分钟
  logger: PluginLogger;
}

interface LinearAgentRunResult {
  success: boolean;
  output: string;
}
```

### 4.4 插件配置（src/types.ts）

```typescript
interface PluginConfig {
  webhookSecret: string;    // Linear webhook signing secret
  linearApiKey: string;     // Linear API key
  agentId: string;          // Linear 上注册的 agent UUID
  defaultDir?: string;      // agent 工作目录
}
```

### 4.5 内部状态（Phase 2 — src/session/manager.ts）

```typescript
interface SessionState {
  sessionId: string;
  issueId: string;
  status: "active" | "completing" | "completed" | "stopped" | "error";
  abortController?: AbortController;
  lastActivityAt: number;
  createdAt: number;
}
```
