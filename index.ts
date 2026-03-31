import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createWebhookHandler } from "./src/webhook/handler";
import { IssueTriage } from "./src/issue/triage";
import { runLinearAgent } from "./src/agent/linear-agent";
import { validateConfig } from "./src/types";
import {
  getAuthorizationUrl,
  getAccessToken,
  createOAuthCallbackHandler,
  type OAuthConfig,
} from "./src/api/oauth";

export default definePluginEntry({
  id: "openclaw-linear-agent",
  name: "Linear Agent",
  description:
    "Linear Agent Session integration — receive @mentions, run agents, stream results back to Linear",
  register(api) {
    const rawConfig = validateConfig(api.pluginConfig);
    if (!rawConfig) {
      api.logger.error(
        "openclaw-linear-agent: missing required config (webhookSecret, clientId, clientSecret, redirectUri). Plugin disabled.",
      );
      return;
    }
    const config = rawConfig;
    const logger = api.logger;

    // --- OAuth config ---
    const oauthConfig: OAuthConfig = {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
      webhookSecret: config.webhookSecret,
      tokenStorePath: config.tokenStorePath,
    };

    // --- OAuth routes ---

    // GET /oauth/authorize — redirect to Linear OAuth
    api.registerHttpRoute({
      path: "/oauth/authorize",
      auth: "plugin",
      handler: async (_req, res) => {
        const url = getAuthorizationUrl(oauthConfig);
        res.writeHead(302, { Location: url });
        res.end();
        return true;
      },
    });

    // GET /oauth/callback — handle Linear OAuth callback
    const oauthCallbackHandler = createOAuthCallbackHandler(oauthConfig, logger);
    api.registerHttpRoute({
      path: "/oauth/callback",
      auth: "plugin",
      handler: async (req, res) => {
        await oauthCallbackHandler(req, res);
        return true;
      },
    });

    // --- Token provider for Linear API ---
    async function getToken(): Promise<string> {
      const result = await getAccessToken(oauthConfig, logger);
      if (!result) {
        throw new Error(
          "No valid OAuth token. Please authorize first via /oauth/authorize",
        );
      }
      return result.accessToken;
    }

    async function getAgentId(): Promise<string> {
      const result = await getAccessToken(oauthConfig, logger);
      return result?.agentId ?? "";
    }

    // --- Issue 自动分诊 ---
    const triage = new IssueTriage(getToken, logger);

    logger.info("openclaw-linear-agent: registered (OAuth mode)");

    // Create webhook handler — agentId resolved lazily from token
    let cachedAgentId: string | null = null;

    api.registerHttpRoute({
      path: "/webhooks/linear",
      auth: "plugin",
      handler: async (req, res) => {
        // Resolve agentId on first webhook if not cached
        if (!cachedAgentId) {
          cachedAgentId = await getAgentId();
          if (!cachedAgentId) {
            logger.warn(
              "Webhook received but no OAuth token available. Please authorize first.",
            );
            res.writeHead(503, { "Content-Type": "text/plain" });
            res.end("Not authorized. Visit /oauth/authorize first.");
            return true;
          }
        }

        const webhookHandler = createWebhookHandler(
          config.webhookSecret,
          cachedAgentId,
          {
            onIssueCreated: (payload) => {
              const issueId = payload.data.id;
              if (!issueId) {
                logger.warn("Issue created without id");
                return;
              }
              logger.info(
                `New issue: ${String(payload.data.identifier)} — ${String(payload.data.title)}`,
              );
              void handleIssueTriage(issueId);
            },
          },
          logger,
        );

        await webhookHandler(req, res);
        return true;
      },
    });

    /** Issue 分诊：收集上下文 → OpenClaw agent 分析 → 应用结果 */
    async function handleIssueTriage(issueId: string): Promise<void> {
      try {
        const context = await triage.collectContext(issueId);
        if (!context) return;

        const prompt = triage.buildAgentPrompt(context);

        const agentResult = await runLinearAgent({
          sessionKey: `triage-${issueId}`,
          prompt,
          systemPrompt:
            "You are a Linear issue triage assistant. Output ONLY the JSON result, no other text.",
          workspaceDir: config.defaultDir,
          runEmbeddedPiAgent: api.runtime.agent.runEmbeddedPiAgent,
          logger,
        });

        if (!agentResult.success) {
          logger.error(
            `Triage agent failed for ${context.identifier}: ${agentResult.output}`,
          );
          return;
        }

        const result = triage.parseTriageResult(agentResult.output);
        if (result) {
          await triage.applyTriageResult(issueId, result, context);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Issue triage failed: ${msg}`);
      }
    }
  },
});
