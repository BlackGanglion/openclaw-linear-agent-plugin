[中文](./README.zh-CN.md) | English

# linear-agent

Standalone server that integrates Linear with LLM for automatic issue triage.

When a new issue is created in Linear, the server automatically collects context, calls an LLM (via OpenAI-compatible API) for analysis, and writes triage results (priority, labels, assignee) back to Linear.

## Features

- **OAuth Authentication**: Linear OAuth 2.0 flow with automatic token refresh
- **Webhook Receiver**: Listen for Linear webhooks, verify signatures via Linear SDK
- **Issue Auto-Triage**: Collect issue context → LLM analysis → auto-set priority / labels / assignee

## Quick Start

```bash
git clone <repo-url> linear-agent
cd linear-agent
npm install
cp .env.example .env
# Edit .env with your credentials
npm run dev
```

## Configuration

All configuration is via environment variables (`.env` file supported):

| Variable | Required | Description |
|----------|----------|-------------|
| `LINEAR_WEBHOOK_SECRET` | Yes | Linear webhook signing secret (HMAC-SHA256) |
| `LINEAR_CLIENT_ID` | Yes | Linear OAuth app client ID |
| `LINEAR_CLIENT_SECRET` | Yes | Linear OAuth app client secret |
| `LINEAR_REDIRECT_URI` | Yes | OAuth redirect URI (must match Linear app config) |
| `PORT` | No | Server port (default: `3000`) |
| `LLM_BASE_URL` | No | LLM API base URL (default: `https://api.moonshot.cn/v1`) |
| `LLM_MODEL` | No | LLM model name (default: `kimi-k2.5`) |
| `LLM_API_KEY` | Yes | LLM API key |

## Linear Setup

1. Create a Linear OAuth app at Linear Settings → API → OAuth applications
2. Set the callback URL to `https://<your-host>/oauth/callback`
3. Create a webhook at Linear Settings → API → Webhooks
4. Set the webhook URL to `https://<your-host>/webhooks/linear`
5. Select **Issues** events, copy the Signing Secret to `LINEAR_WEBHOOK_SECRET`
6. Start the server and visit `/oauth/authorize` to complete OAuth

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/status` | Auth status and agent ID |
| `GET` | `/oauth/authorize` | Start Linear OAuth flow |
| `GET` | `/oauth/callback` | OAuth callback handler |
| `POST` | `/webhooks/linear` | Linear webhook receiver |

## Project Structure

```
index.ts                    # Hono server entry point
src/
  config.ts                 # Environment variable loading
  logger.ts                 # File + console logger
  api/oauth.ts              # OAuth 2.0 flow (authorize, token, refresh)
  linear/client.ts          # Linear API client wrapper
  triage/triage.ts          # Issue triage (context → LLM → apply)
  webhook/handler.ts        # Webhook signature verification and event dispatch
  webhook/logger-types.ts   # Logger interface
prompts/
  triage.md                 # Triage system prompt
```

## Tech Stack

- **[Hono](https://hono.dev/)** — HTTP server
- **[@linear/sdk](https://developers.linear.app/docs/sdk)** — Linear API & webhook verification
- **[@mariozechner/pi-ai](https://github.com/badlogic/pi-mono)** — LLM completion (OpenAI-compatible)
- **TypeScript** + **tsx** — No build step required

## Development

```bash
npm run dev        # Start with watch mode
npm run typecheck  # Type check
```

## License

Private
