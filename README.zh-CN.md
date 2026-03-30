中文 | [English](./README.md)

# openclaw-linear-agent

OpenClaw 插件 —— 将 Linear 与 OpenClaw Agent 集成，实现 Issue 自动分诊（Triage）。

当 Linear 中有新 Issue 创建时，插件会自动收集上下文，调用 OpenClaw Agent 进行分析，并将分诊结果（优先级、标签、指派等）回写到 Linear。

## 功能

- **Webhook 接收**：监听 Linear Webhook，验证签名后处理 Issue 创建事件
- **Issue 自动分诊**：收集 Issue 上下文 → 调用 Agent 分析 → 自动设置优先级 / 标签 / 指派
- **Agent Session**（规划中）：支持在 Linear 中 @mention agent 进行对话式交互

## 安装

OpenClaw 直接加载 `.ts` 源码，**无需打包**。

```bash
git clone <repo-url> openclaw-linear-agent-plugin
cd openclaw-linear-agent-plugin
npm install
```

然后在 OpenClaw 中通过本地路径安装：

```bash
openclaw plugins install ./openclaw-linear-agent-plugin
```

## 配置

在 OpenClaw 的插件配置中添加本插件，并提供以下参数：

| 参数 | 必填 | 说明 |
|------|------|------|
| `webhookSecret` | ✅ | Linear Webhook 签名密钥（HMAC-SHA256） |
| `linearApiKey` | ✅ | Linear API Key |
| `agentId` | ✅ | Linear Agent Actor ID |
| `defaultDir` | - | Agent 执行时的默认工作目录 |

`.env.example` 中包含了环境变量参考。

## Linear 侧设置

1. 在 Linear Settings → API → Webhooks 中创建 Webhook
2. URL 填写 `https://<your-openclaw-host>/webhooks/linear`
3. 勾选 **Issues** 事件，记录 Signing Secret 填入插件配置的 `webhookSecret`
4. 创建 Linear API Key，填入 `linearApiKey`

## 项目结构

```
index.ts                  # 插件入口，注册 Webhook 路由和事件处理
src/
  types.ts                # 类型定义与配置校验
  webhook/handler.ts      # Webhook 签名验证与事件分发
  issue/triage.ts         # Issue 分诊逻辑（上下文收集、prompt 构建、结果解析）
  agent/linear-agent.ts   # OpenClaw Agent 调用封装
  api/linear.ts           # Linear API 客户端（Agent Session 用）
  api/oauth.ts            # OAuth 相关
  session/manager.ts      # Agent Session 状态管理
```

## 开发

```bash
# 类型检查
npx tsc --noEmit
```

## License

Private
