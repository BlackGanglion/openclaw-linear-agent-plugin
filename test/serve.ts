/**
 * 独立测试服务器 — 模拟 OpenClaw Gateway，接收 Linear webhook
 *
 * 用法：
 *   npx tsx test/serve.ts
 *
 * 环境变量：
 *   LINEAR_WEBHOOK_SECRET    — Linear webhook signing secret
 *   LINEAR_CLIENT_ID         — Linear OAuth app client ID
 *   LINEAR_CLIENT_SECRET     — Linear OAuth app client secret
 *   LINEAR_REDIRECT_URI      — OAuth callback URL
 *   PORT                     — 监听端口（默认 3000）
 */

import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, createWriteStream } from "node:fs";
// import type { AgentSessionEventWebhookPayload } from "@linear/sdk";
import { createWebhookHandler } from "../src/webhook/handler";
// import { LinearApiClient } from "../src/api/linear";
// import { SessionManager } from "../src/session/manager";
import { IssueTriage } from "../src/issue/triage";
import {
  createOAuthCallbackHandler,
  getAuthorizationUrl,
  getAccessToken,
  loadTokenSet,
  type OAuthConfig,
} from "../src/api/oauth";
import type { PluginLogger } from "../src/webhook/logger-types";

// --- Config from env ---
const WEBHOOK_SECRET = process.env["LINEAR_WEBHOOK_SECRET"] ?? "";
const CLIENT_ID = process.env["LINEAR_CLIENT_ID"] ?? "";
const CLIENT_SECRET = process.env["LINEAR_CLIENT_SECRET"] ?? "";
const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const REDIRECT_URI =
  process.env["LINEAR_REDIRECT_URI"] ??
  `https://hujiemacbook-pro-6.taileff05c.ts.net/oauth/callback`;

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_STORE_PATH = join(PROJECT_ROOT, ".data", "oauth-token.json");

// --- Log file ---
const LOG_DIR = join(PROJECT_ROOT, "test", "log");
mkdirSync(LOG_DIR, { recursive: true });
const logFile = join(LOG_DIR, `serve-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
const logStream = createWriteStream(logFile, { flags: "a" });

function writeLog(level: string, msg: string): void {
  const line = `[${new Date().toISOString()}] [${level.padEnd(5)}] ${msg}`;
  console.log(line);
  logStream.write(line + "\n");
}

if (!WEBHOOK_SECRET || !CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing required env vars: LINEAR_WEBHOOK_SECRET, LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET");
  process.exit(1);
}

// --- Logger ---
const logger: PluginLogger = {
  debug: (msg: string) => writeLog("DEBUG", msg),
  info: (msg: string) => writeLog("INFO", msg),
  warn: (msg: string) => writeLog("WARN", msg),
  error: (msg: string) => writeLog("ERROR", msg),
};

// --- OAuth config ---
const oauthConfig: OAuthConfig = {
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  redirectUri: REDIRECT_URI,
  webhookSecret: WEBHOOK_SECRET,
  tokenStorePath: TOKEN_STORE_PATH,
};

// --- Services ---
async function tokenProvider(): Promise<string> {
  const result = await getAccessToken(oauthConfig, logger);
  if (!result) {
    throw new Error("No OAuth token available. Visit /auth to authorize.");
  }
  return result.accessToken;
}

function getAgentId(): string {
  const tokenSet = loadTokenSet(TOKEN_STORE_PATH);
  return tokenSet?.agentId ?? "";
}

const triage = new IssueTriage(tokenProvider, logger, { excludeUserId: getAgentId() });
const oauthCallback = createOAuthCallbackHandler(oauthConfig, logger);

// --- AgentSession 相关（暂时注释掉） ---
// const linearApi = new LinearApiClient(tokenProvider);
// const sessions = new SessionManager();
//
// function extractMessage(payload: AgentSessionEventWebhookPayload): string {
//   const comments = payload.previousComments;
//   if (Array.isArray(comments) && comments.length > 0) {
//     const last = comments[comments.length - 1];
//     if (last?.body) return last.body;
//   }
//   if (payload.promptContext) return payload.promptContext;
//   if (payload.agentSession.comment?.body) return payload.agentSession.comment.body;
//   return "";
// }
//
// async function handleSession(
//   linearSessionId: string,
//   issueId: string,
//   message: string,
// ): Promise<void> {
//   sessions.create(linearSessionId, issueId);
//   logger.info(`Session created: ${linearSessionId} for issue ${issueId}`);
//   logger.info(`User message: ${message}`);
//
//   try {
//     await linearApi.emitActivity(linearSessionId, {
//       type: "thought",
//       body: "Analyzing issue...",
//     });
//     logger.info("Sent initial thought");
//   } catch (err: unknown) {
//     const msg = err instanceof Error ? err.message : String(err);
//     logger.error(`Failed to emit thought: ${msg}`);
//     return;
//   }
//
//   try {
//     const issue = await linearApi.getIssue(issueId);
//     logger.info(`Issue: ${issue.identifier} — ${issue.title}`);
//
//     await linearApi.emitActivity(linearSessionId, {
//       type: "action",
//       action: "Fetched issue details",
//       parameter: `${issue.identifier}: ${issue.title}`,
//     });
//
//     const response = [
//       `I received your message on issue **${issue.identifier}**: ${issue.title}`,
//       "",
//       message ? `Your message: "${message}"` : "(no message)",
//       "",
//       `Issue status: ${issue.state.name}`,
//       `Priority: ${String(issue.priority)}`,
//       `Team: ${issue.team.name}`,
//       "",
//       "_This is a test response from the Linear Agent Plugin._",
//     ].join("\n");
//
//     await linearApi.emitActivity(linearSessionId, {
//       type: "response",
//       body: response,
//     });
//     logger.info("Sent response");
//     sessions.complete(linearSessionId);
//     logger.info("Session completed (response sent → auto-complete)");
//   } catch (err: unknown) {
//     const msg = err instanceof Error ? err.message : String(err);
//     logger.error(`Session error: ${msg}`);
//     try {
//       await linearApi.emitActivity(linearSessionId, { type: "error", body: `Error: ${msg}` });
//     } catch { /* best effort */ }
//     sessions.markError(linearSessionId);
//   }
// }
//
// function handleStop(linearSessionId: string): void {
//   const state = sessions.get(linearSessionId);
//   if (state) {
//     logger.info(`Stopping session: ${linearSessionId}`);
//     sessions.stop(linearSessionId);
//     linearApi
//       .emitActivity(linearSessionId, { type: "response", body: "Stopped." })
//       .catch(() => {});
//   }
// }

// --- Issue 分诊处理（测试模式：随机填充缺失字段） ---
async function handleIssueTriage(issueId: string): Promise<void> {
  try {
    const context = await triage.collectContext(issueId);
    if (!context) {
      logger.info(`Issue ${issueId} does not need triage or context unavailable`);
      return;
    }

    logger.info(`Triage context for ${context.identifier}:`);
    logger.info(`  Existing: assignee=${String(context.existing.hasAssignee)}, priority=${String(context.existing.hasPriority)}, labels=${String(context.existing.hasLabels)}`);
    logger.info(`  Need: ${!context.existing.hasAssignee ? "assignee " : ""}${!context.existing.hasPriority ? "priority " : ""}${!context.existing.hasLabels ? "labels" : ""}`);

    // 测试模式：只随机填充缺失的字段
    const randomMember = context.teamMembers.length > 0
      ? context.teamMembers[Math.floor(Math.random() * context.teamMembers.length)]
      : undefined;
    const randomPriority = Math.floor(Math.random() * 4) + 1;
    const randomLabel = context.availableLabels.length > 0
      ? context.availableLabels[Math.floor(Math.random() * context.availableLabels.length)]
      : undefined;

    const mockResult = {
      assigneeId: randomMember?.id,
      priority: randomPriority,
      labelIds: randomLabel ? [randomLabel.id] : [],
      reason: `[Mock] 这是自动分诊的测试结果，正式环境将由 OpenClaw agent 分析 issue 内容后给出判断理由。`,
    };

    logger.info(`Triage result: ${JSON.stringify(mockResult)}`);
    await triage.applyTriageResult(issueId, mockResult, context);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Issue triage failed: ${msg}`);
  }
}

// --- Webhook handler ---
function getHandler() {
  const agentId = getAgentId();
  if (!agentId) return null;

  return createWebhookHandler(WEBHOOK_SECRET, agentId, {
    // AgentSession 回调（暂时注释掉）
    // onSessionCreated: (payload) => {
    //   const issueId = payload.agentSession.issueId ?? payload.agentSession.issue?.id ?? "";
    //   if (!issueId) return;
    //   void handleSession(payload.agentSession.id, issueId, extractMessage(payload));
    // },
    // onSessionPrompted: (payload) => {
    //   const issueId = payload.agentSession.issueId ?? payload.agentSession.issue?.id ?? "";
    //   if (!issueId) return;
    //   void handleSession(payload.agentSession.id, issueId, extractMessage(payload));
    // },
    // onSessionStopped: (payload) => {
    //   handleStop(payload.agentSession.id);
    // },

    // Issue 自动分诊
    onIssueCreated: (payload) => {
      const issueId = payload.data.id;
      if (!issueId) {
        logger.warn("Issue created without id");
        return;
      }
      logger.info(`New issue created: ${String(payload.data.identifier)} — ${String(payload.data.title)}`);
      void handleIssueTriage(issueId);
    },
  }, logger);
}

// --- HTTP Server ---
const server = createServer((req, res) => {
  const url = req.url?.split("?")[0];

  switch (url) {
    case "/webhooks/linear": {
      const handler = getHandler();
      if (!handler) {
        res.writeHead(503);
        res.end("Not authorized yet. Visit /auth first.");
        return;
      }
      void handler(req, res);
      break;
    }

    case "/oauth/callback":
      void oauthCallback(req, res);
      break;

    case "/auth": {
      const authUrl = getAuthorizationUrl(oauthConfig);
      res.writeHead(302, { Location: authUrl });
      res.end();
      break;
    }

    case "/status": {
      const tokenSet = loadTokenSet(TOKEN_STORE_PATH);
      const status = {
        authorized: Boolean(tokenSet?.accessToken),
        agentId: tokenSet?.agentId ?? null,
        expiresAt: tokenSet?.expiresAt ?? null,
        scope: tokenSet?.scope ?? null,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status, null, 2));
      break;
    }

    case "/health":
      res.writeHead(200);
      res.end("OK");
      break;

    default:
      res.writeHead(404);
      res.end("Not Found");
  }
});

server.listen(PORT, () => {
  const existingToken = loadTokenSet(TOKEN_STORE_PATH);
  const authorized = Boolean(existingToken?.accessToken);

  console.log(`
╔══════════════════════════════════════════════════════╗
║  Linear Agent Test Server                            ║
╠══════════════════════════════════════════════════════╣
║  Port:     ${String(PORT).padEnd(42)}║
║  Webhook:  /webhooks/linear                          ║
║  OAuth:    /oauth/callback                           ║
║  Auth:     /auth  (开始 OAuth 授权)                  ║
║  Status:   /status                                   ║
║  Health:   /health                                   ║
╠══════════════════════════════════════════════════════╣
║  Authorized: ${String(authorized).padEnd(39)}║
║  Agent ID:   ${(existingToken?.agentId ?? "N/A").padEnd(39)}║
╠══════════════════════════════════════════════════════╣
║  Log:      ${logFile.padEnd(42).slice(0, 42)}║
╠══════════════════════════════════════════════════════╣
║  ${authorized ? "Ready for webhooks!" : "Visit /auth to authorize first."}${" ".repeat(authorized ? 34 : 18)}║
╚══════════════════════════════════════════════════════╝
  `);
});
