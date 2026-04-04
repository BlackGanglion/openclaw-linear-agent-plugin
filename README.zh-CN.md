中文 | [English](./README.md)

# egg

LLM 驱动的工作自动化 Agent，采用主子 agent 架构。

当前支持 Linear Issue 自动分诊 — 当新 Issue 创建时，自动收集上下文，调用 LLM 分析，并将分诊结果（优先级、标签、指派）回写到 Linear。

## 功能

- **Agent 架构**：主子 agent 模式，通过 `SubAgent` 接口扩展
- **OAuth 认证**：Linear OAuth 2.0 流程，自动刷新 Token
- **Webhook 接收**：监听 Linear Webhook，通过 Linear SDK 验证签名
- **Issue 自动分诊**：收集 Issue 上下文 → LLM 分析 → 自动设置优先级 / 标签 / 指派

## 快速开始

```bash
git clone <repo-url> egg
cd egg
npm install
cp .env.example .env
# 编辑 .env 填入凭证
npm run dev

# 通过 Tailscale Funnel 暴露本地服务（后台模式）
tailscale funnel --bg 3000
# 验证 Funnel 正在运行
tailscale serve status
```

## 配置

所有配置通过环境变量（支持 `.env` 文件）：

| 变量 | 必填 | 说明 |
|------|------|------|
| `LINEAR_WEBHOOK_SECRET` | 是 | Linear Webhook 签名密钥（HMAC-SHA256） |
| `LINEAR_CLIENT_ID` | 是 | Linear OAuth 应用 Client ID |
| `LINEAR_CLIENT_SECRET` | 是 | Linear OAuth 应用 Client Secret |
| `LINEAR_REDIRECT_URI` | 是 | OAuth 回调地址（须与 Linear 应用配置一致） |
| `PORT` | 否 | 服务端口（默认 `3000`） |
| `LLM_PROVIDER` | 否 | LLM 提供商：`moonshot` 或 `claude`（默认 `moonshot`） |
| `LLM_BASE_URL` | 否 | LLM API 地址 |
| `LLM_MODEL` | 否 | LLM 模型名称 |
| `LLM_API_KEY` | 是 | LLM API Key |

## Linear 侧设置

1. 确保你的 Linear 账号拥有 **Admin** 权限（创建 OAuth 应用需要管理员权限）
2. 在 Linear Settings → API → OAuth applications 中创建 OAuth 应用
2. 回调地址填写 `https://<your-host>/oauth/callback`
3. 在 Linear Settings → API → Webhooks 中创建 Webhook
4. URL 填写 `https://<your-host>/webhooks/linear`
5. 勾选 **Issues** 事件，将 Signing Secret 填入 `LINEAR_WEBHOOK_SECRET`
6. 启动服务后访问 `/oauth/authorize` 完成 OAuth 授权

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `GET` | `/status` | 认证状态与 Agent ID |
| `GET` | `/oauth/authorize` | 发起 Linear OAuth 授权 |
| `GET` | `/oauth/callback` | OAuth 回调处理 |
| `POST` | `/webhooks/linear` | Linear Webhook 接收 |

## 项目结构

```
bootstrap.ts                    # 入口：Hono 服务
src/
  agent/
    types.ts                    # SubAgent 接口
    registry.ts                 # Agent 注册表
    main/                       # 主 agent（预留）
    sub/
      linear-triage/            # 子 agent：Linear issue 分诊
        index.ts                # SubAgent 实现
        triage.ts               # 分诊逻辑（上下文收集 → LLM → 应用结果）
    tool/
      fetch-trace.ts            # Langfuse trace 工具
      submit-triage.ts          # 分诊结果提交工具
  infra/
    linear/
      client.ts                 # Linear API 客户端封装
      oauth.ts                  # OAuth 2.0 流程
      webhook.ts                # Webhook 签名验证
  utils/
    config.ts                   # 环境变量加载
    logger.ts                   # 文件 + 控制台日志
  routes/
    health.ts                   # 健康检查路由
    oauth.ts                    # OAuth 路由
    webhook.ts                  # Webhook 路由
prompts/
  triage.md                     # 分诊系统提示词
```

## 技术栈

- **[Hono](https://hono.dev/)** — HTTP 服务
- **[@linear/sdk](https://developers.linear.app/docs/sdk/getting-started)** — Linear TypeScript SDK
- **[@mariozechner/pi-agent-core](https://github.com/badlogic/pi-mono)** — Agent 框架
- **[@mariozechner/pi-ai](https://github.com/badlogic/pi-mono)** — LLM 调用（OpenAI 兼容）
- **TypeScript** + **tsx** — 无需构建

## 开发

```bash
npm run dev        # 开发模式（带 watch）
npm run typecheck  # 类型检查
```

## License

Private
