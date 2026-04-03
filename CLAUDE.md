# Linear Agent

Linear webhook agent，自动分诊新建 issue（分配负责人、优先级、标签）。

## 命令

```bash
npm run dev        # tsx --watch index.ts
npm start          # tsx index.ts
npm run typecheck  # tsc --noEmit
npm test           # vitest run
```

## 架构

- **index.ts** — Hono HTTP 服务，OAuth 流程，webhook 路由
- **src/triage/triage.ts** — 核心分诊逻辑，使用 `@mariozechner/pi-agent-core` Agent 驱动 tool-calling 循环
- **src/tool/** — Agent 工具（`fetch_trace`、`submit_triage_result`）
- **src/linear/client.ts** — Linear API 封装（@linear/sdk）
- **src/webhook/handler.ts** — Webhook 监听 Issue.create 事件
- **prompts/triage.md** — 分诊系统 prompt

## 关键模式

- 工具使用 `AgentTool`（from `@mariozechner/pi-agent-core`），错误直接 `throw`，不要返回 `isError`
- `submit_triage_result` 是工厂函数（`createSubmitTriageTool`），捕获 `linearClient` 和 `context`，在 `execute` 中直接写入 Linear
- LLM 通过 OpenAI 兼容 API 调用（默认 Moonshot/Kimi）

## 代码规范

- 仅添加必要 log，在分类 issue 的主链路上，不添加没有必要的 log
- TypeScript strict 模式，ES2022
- 中文用于面向用户的文案（Linear 评论、工具描述）
- 不要自动提交代码，每次需要提交时向用户确认
- 遇到较大变化时，自动写入 history.md 记录优化内容

## 测试

- `test/triage.test.ts` — 集成测试，mock Linear API，真实调用 LLM
- 需要 `.env` 中配置 `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY`
- 测试涉及真实 LLM 调用，不要自动运行，需要时向用户申请
- 只跑 `test/` 目录下的测试（`npx vitest run test/`），不要跑 `cc-origin/` 里的测试

## 参考代码

- `cc-origin/` — 仅用于参考，不要修改或运行其中的代码和测试

## 环境变量

必需：`LINEAR_WEBHOOK_SECRET`、`LINEAR_CLIENT_ID`、`LINEAR_CLIENT_SECRET`、`LINEAR_REDIRECT_URI`

LLM：`LLM_BASE_URL`（默认 moonshot）、`LLM_MODEL`（默认 kimi-k2.5）、`LLM_API_KEY`

可选：`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY`（fetch_trace 工具用）、`PORT`（默认 3000）
