[中文](./README.zh-CN.md) | English

# egg

A work automation agent powered by LLM, built with a main-agent + sub-agent architecture.

Currently supports automatic Linear issue triage — when a new issue is created, the agent collects context, calls an LLM for analysis, and writes triage results (priority, labels, assignee) back to Linear.

## Features

- **Agent Architecture**: Main agent + sub-agent pattern, extensible via `SubAgent` interface
- **OAuth Authentication**: Linear OAuth 2.0 flow with automatic token refresh
- **Webhook Receiver**: Listen for Linear webhooks, verify signatures via Linear SDK
- **Issue Auto-Triage**: Collect issue context → LLM analysis → auto-set priority / labels / assignee

## Quick Start

```bash
git clone <repo-url> egg
cd egg
npm install
cp .env.example .env
# Edit .env with your credentials
npm run dev

# Expose local server via Tailscale Funnel (background mode)
tailscale funnel --bg 3000
# Verify funnel is running
tailscale serve status
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
| `LLM_PROVIDER` | No | LLM provider: `moonshot` or `claude` (default: `moonshot`) |
| `LLM_BASE_URL` | No | LLM API base URL |
| `LLM_MODEL` | No | LLM model name |
| `LLM_API_KEY` | Yes | LLM API key |

## Linear Setup

1. Ensure your Linear account has **Admin** privileges (required to create OAuth applications)
2. Create a Linear OAuth app at Linear Settings → API → OAuth applications
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
bootstrap.ts                    # Entry point: Hono server
src/
  agent/
    types.ts                    # SubAgent interface
    registry.ts                 # Agent registry
    main/                       # Main agent (reserved)
    sub/
      linear-triage/            # Sub-agent: Linear issue triage
        index.ts                # SubAgent implementation
        triage.ts               # Triage logic (context → LLM → apply)
    tool/
      fetch-trace.ts            # Langfuse trace tool
      submit-triage.ts          # Triage result submission tool
  infra/
    linear/
      client.ts                 # Linear API client wrapper
      oauth.ts                  # OAuth 2.0 flow
      webhook.ts                # Webhook signature verification
  utils/
    config.ts                   # Environment variable loading
    logger.ts                   # File + console logger
  routes/
    health.ts                   # Health check routes
    oauth.ts                    # OAuth routes
    webhook.ts                  # Webhook routes
prompts/
  triage.md                     # Triage system prompt
```

## Tech Stack

- **[Hono](https://hono.dev/)** — HTTP server
- **[@linear/sdk](https://developers.linear.app/docs/sdk/getting-started)** — Linear TypeScript SDK
- **[@mariozechner/pi-agent-core](https://github.com/badlogic/pi-mono)** — Agent framework
- **[@mariozechner/pi-ai](https://github.com/badlogic/pi-mono)** — LLM completion (OpenAI-compatible)
- **TypeScript** + **tsx** — No build step required

## Development

```bash
npm run dev        # Start with watch mode
npm run typecheck  # Type check
```

## License

Private
