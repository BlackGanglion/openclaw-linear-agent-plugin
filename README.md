[中文](./README.zh-CN.md) | English

# openclaw-linear-agent

OpenClaw plugin — integrate Linear with OpenClaw Agent for automatic issue triage.

When a new issue is created in Linear, the plugin automatically collects context, runs an OpenClaw Agent for analysis, and writes triage results (priority, labels, assignee, etc.) back to Linear.

## Features

- **Webhook Receiver**: Listen for Linear webhooks, verify signatures, and handle issue creation events
- **Issue Auto-Triage**: Collect issue context → Agent analysis → auto-set priority / labels / assignee
- **Agent Session** (planned): Support @mention agent in Linear for conversational interaction

## Installation

OpenClaw loads `.ts` source directly — **no build step required**.

```bash
git clone <repo-url> openclaw-linear-agent-plugin
cd openclaw-linear-agent-plugin
npm install
```

Then install in OpenClaw via local path:

```bash
openclaw plugins install ./openclaw-linear-agent-plugin
```

## Configuration

Add the plugin to your OpenClaw config with the following parameters:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `webhookSecret` | Yes | Linear webhook signing secret (HMAC-SHA256) |
| `linearApiKey` | Yes | Linear API key |
| `agentId` | Yes | Linear agent actor ID |
| `defaultDir` | No | Default working directory for agent execution |

See `.env.example` for environment variable reference.

## Linear Setup

1. Go to Linear Settings → API → Webhooks and create a webhook
2. Set the URL to `https://<your-openclaw-host>/webhooks/linear`
3. Select **Issues** events, copy the Signing Secret into the plugin's `webhookSecret`
4. Create a Linear API Key and set it as `linearApiKey`

## Project Structure

```
index.ts                  # Plugin entry point, registers webhook routes and event handlers
src/
  types.ts                # Type definitions and config validation
  webhook/handler.ts      # Webhook signature verification and event dispatch
  issue/triage.ts         # Issue triage logic (context collection, prompt building, result parsing)
  agent/linear-agent.ts   # OpenClaw Agent invocation wrapper
  api/linear.ts           # Linear API client (for Agent Session)
  api/oauth.ts            # OAuth utilities
  session/manager.ts      # Agent Session state management
```

## Development

```bash
# Type check
npx tsc --noEmit
```

## License

Private
