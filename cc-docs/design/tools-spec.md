# Agent Tools 规格定义

> **当前状态：** MVP 阶段未注册独立工具。Issue Triage 通过 prompt 指令 + JSON 输出完成，不需要 agent 调用工具。以下为 Phase 2 AgentSession 的工具设计。

## 当前 MVP 实现

MVP 的 Issue Triage 不使用工具注册模式。agent 的交互方式：

1. **输入：** IssueTriage.buildAgentPrompt() 构建的 prompt，包含 issue 信息和可选项
2. **系统指令：** `extraSystemPrompt = "你是一个 Linear issue 分诊助手。只输出 JSON 结果，不要输出其他内容。"`
3. **输出：** JSON 格式的 TriageResult，由 parseTriageResult() 通过正则提取

```typescript
// Agent 输出格式
{
  "assigneeId": "成员ID 或 null",
  "priority": 0-4,
  "labelIds": ["标签ID", ...],
  "reason": "判断理由"
}
```

---

## Phase 2: Agent Tools 设计

Agent 在 AgentSession 多轮对话中可调用的 Linear 操作工具。通过 `api.registerTool()` 注册。

### 1. linear_issue

Issue 的查看和操作。

```typescript
{
  id: "linear_issue",
  name: "Linear Issue",
  description: "View, list, create, or update Linear issues",
  parameters: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: ["view", "list", "create", "update"],
      },
      // view
      issueId: {
        type: "string",
        description: "Issue ID or identifier (e.g. 'ENG-123')",
      },
      // list
      filter: {
        type: "object",
        description: "Filter criteria",
        properties: {
          teamId: { type: "string" },
          stateType: { type: "string", enum: ["triage","backlog","unstarted","started","completed","canceled"] },
          assigneeId: { type: "string" },
          priority: { type: "number", description: "1=urgent, 4=low" },
        },
      },
      limit: { type: "number", default: 20 },
      // create
      title: { type: "string" },
      description: { type: "string" },
      teamId: { type: "string" },
      priority: { type: "number" },
      labelIds: { type: "array", items: { type: "string" } },
      // update
      stateId: { type: "string" },
      assigneeId: { type: "string" },
    },
  },
}
```

**返回格式：** 结构化 JSON，agent 可直接读取。

```typescript
// view 返回
{
  id: "uuid",
  identifier: "ENG-123",
  title: "Fix login bug",
  description: "...",
  state: { name: "In Progress", type: "started" },
  priority: 2,
  assignee: { name: "John" },
  team: { key: "ENG", name: "Engineering" },
  labels: ["bug", "frontend"],
  url: "https://linear.app/team/issue/ENG-123"
}

// list 返回
{ issues: [...], total: 15 }

// create/update 返回
{ success: true, issue: { id, identifier, url } }
```

---

### 2. linear_comment

Issue comment 操作。

```typescript
{
  id: "linear_comment",
  name: "Linear Comment",
  description: "List or add comments on a Linear issue",
  parameters: {
    type: "object",
    required: ["action", "issueId"],
    properties: {
      action: {
        type: "string",
        enum: ["list", "add"],
      },
      issueId: { type: "string" },
      // add
      body: {
        type: "string",
        description: "Comment body (Markdown)",
      },
    },
  },
}
```

---

### 3. linear_session

Agent Session 管理。Agent 可以主动管理自己的 session。

```typescript
{
  id: "linear_session",
  name: "Linear Agent Session",
  description: "Manage the current agent session: view history or mark complete",
  parameters: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: ["history", "complete"],
        description: "history: 查看当前 session 的对话历史; complete: 标记 session 完成",
      },
    },
  },
}
```

**注意：** `complete` 操作会结束当前 session。Agent 应在确认任务完成后才调用。

---

## 工具优先级

| Phase | 工具 | 操作 | 状态 |
|-------|------|------|------|
| **MVP** | _(无工具)_ | prompt → JSON 输出 | ✅ 已实现 |
| Phase 2 | linear_issue | view, update | 设计中 |
| Phase 2 | linear_session | complete | 设计中 |
| Phase 2 | linear_issue | list, create | 设计中 |
| Phase 2 | linear_comment | list, add | 设计中 |
| Phase 3 | linear_team | list, members | 规划中 |
| Phase 3 | linear_project | list, view | 规划中 |
