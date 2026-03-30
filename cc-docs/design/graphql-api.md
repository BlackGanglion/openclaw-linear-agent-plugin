# Linear API 使用规格

## 1. 认证

MVP 使用静态 API Key，通过 `@linear/sdk` 的 `LinearClient`：

```typescript
import { LinearClient } from "@linear/sdk";
const client = new LinearClient({ accessToken: config.linearApiKey });
```

OAuth 2.0 流程已实现 (`src/api/oauth.ts`)，但未启用（Phase 3）。

## 2. SDK 调用（当前 MVP — Issue Triage）

MVP 通过 `@linear/sdk` 的 LinearClient 方法访问 Linear，不直接使用 GraphQL。

### 2.1 获取 Issue 详情

```typescript
const issue = await client.issue(issueId);
// issue.identifier, issue.title, issue.description, issue.priority
```

### 2.2 获取关联数据（按需）

```typescript
// 团队
const team = await issue.team;

// 负责人（检查是否已分配）
const assignee = await issue.assignee;

// 已有标签
const existingLabels = await issue.labels();
// existingLabels.nodes[].name

// 团队成员（仅当需要分配时）
const memberships = await team.memberships();
for (const m of memberships.nodes) {
  const user = await m.user;
  // user.id, user.name, user.displayName, user.active
}

// 团队可用标签（仅当需要加标签时）
const labels = await team.labels();
// labels.nodes[].id, labels.nodes[].name

// 工作流状态
const states = await team.states();
// states.nodes[].id, states.nodes[].name, states.nodes[].type
```

### 2.3 更新 Issue

```typescript
await issue.update({
  assigneeId: "user-uuid",
  priority: 2,
  labelIds: ["label-uuid-1", "label-uuid-2"],
});
```

### 2.4 创建 Comment

```typescript
await client.createComment({
  issueId: "issue-uuid",
  body: "**Issue 自动分诊结果：**\n\n- **负责人** → John\n- **优先级** → 高\n\n> 判断理由...",
});
```

## 3. Webhook 签名验证

使用 `@linear/sdk/webhooks` 的 `LinearWebhookClient`，自动完成 HMAC-SHA256 验签：

```typescript
import { LinearWebhookClient } from "@linear/sdk/webhooks";

const webhookClient = new LinearWebhookClient(webhookSecret);
const handler = webhookClient.createHandler();

// 注册事件处理
handler.on("Issue", (payload) => {
  // payload 已验签且类型安全
  if (payload.action === "create") {
    // payload.data.id, payload.data.identifier, payload.data.title
  }
});

// Phase 2: AgentSession 事件
handler.on("AgentSessionEvent", (payload) => {
  // payload.action: "created" | "prompted" | "stopped"
  // payload.agentSession.id
  // payload.previousComments, payload.promptContext
});
```

## 4. Phase 2: AgentSession GraphQL API

以下 API 在 AgentSession 多轮对话功能启用后使用。`LinearApiClient` (`src/api/linear.ts`) 已实现封装。

### 4.1 创建 Agent Activity

核心 API — agent 通过此接口向 Linear 发送思考/行动/回复。

```graphql
mutation CreateAgentActivity($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) {
    success
    agentActivity {
      id
    }
  }
}
```

**Input 结构：**

```typescript
{
  sessionId: string;
  type: "thought" | "action" | "elicitation" | "response" | "error";
  content: string;
}
```

### 4.2 完成 Agent Session

```graphql
mutation CompleteAgentSession($id: String!) {
  agentSessionComplete(id: $id) {
    success
  }
}
```

### 4.3 获取 Agent Session Activities

```graphql
query GetSessionActivities($sessionId: String!) {
  agentSession(id: $sessionId) {
    id
    status
    activities {
      nodes {
        id
        type
        content
        createdAt
      }
    }
  }
}
```

## 5. Phase 3: 其他 GraphQL 查询

以下查询在工具注册后使用（Agent Tools 的 list/create 操作）。

### 5.1 列出 Issue（按过滤条件）

```graphql
query ListIssues($filter: IssueFilter, $first: Int) {
  issues(filter: $filter, first: $first) {
    nodes {
      id
      identifier
      title
      priority
      state { name type }
      assignee { name }
    }
  }
}
```

### 5.2 创建 Issue

```graphql
mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      id
      identifier
      url
    }
  }
}
```

### 5.3 获取 Issue Comments

```graphql
query GetIssueComments($issueId: String!) {
  issue(id: $issueId) {
    comments {
      nodes {
        id
        body
        createdAt
        user { id name }
      }
    }
  }
}
```
