import { resolve } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { LinearApiClient } from "../../infra/linear/client";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk";
import type { LLMConfig } from "../sub/linear-triage/triage";
import type { Logger } from "../../utils/logger";
import { loadPrompt } from "../../utils/prompt-loader";
import { withRetry } from "../../utils/retry";
import type { AgentRegistry } from "../registry";
import { createRead } from "../tool/read";

function createModel(config: LLMConfig): Model<"openai-completions"> {
  return {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: "custom",
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
  };
}

export class MainAgent {
  private model: Model<"openai-completions">;
  private getSystemPrompt: () => string;
  private tools: AgentTool[];
  /** Track active sessions so we can abort on "stopped" */
  private activeSessions = new Map<string, AbortController>();

  constructor(
    private readonly linearClient: LinearApiClient,
    private readonly registry: AgentRegistry,
    private readonly llmConfig: LLMConfig,
    private readonly logger: Logger,
  ) {
    this.model = createModel(llmConfig);
    this.getSystemPrompt = loadPrompt("main-agent.md");
    const promptsDir = resolve(process.cwd(), "prompts");
    this.tools = [createRead(promptsDir), ...this.registry.asTools()];
  }

  async handleSessionEvent(payload: AgentSessionEventWebhookPayload): Promise<void> {
    const { action, agentSession } = payload;
    const sessionId = agentSession.id;

    switch (action) {
      case "created":
      case "prompted":
        await this.handlePrompt(payload);
        break;
      case "stopped":
        this.handleStop(sessionId);
        break;
    }
  }

  private handleStop(sessionId: string) {
    const controller = this.activeSessions.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeSessions.delete(sessionId);
      this.logger.info(`Session ${sessionId} stopped by user`);
    }
  }

  private async handlePrompt(payload: AgentSessionEventWebhookPayload): Promise<void> {
    const sessionId = payload.agentSession.id;

    // Send thought immediately (must respond within 10 seconds)
    await withRetry(() =>
      this.linearClient.createAgentActivity({
        agentSessionId: sessionId,
        content: { type: "thought", body: "Egg 的 token 正在疯狂燃烧..." },
      }),
    );

    // 构建 prompt
    const prompt = await this.buildPrompt(payload);

    // Set up abort controller
    const controller = new AbortController();
    this.activeSessions.set(sessionId, controller);

    try {
      const agent = new Agent({
        initialState: {
          systemPrompt: this.getSystemPrompt(),
          model: this.model,
          tools: this.tools,
        },
        getApiKey: async () => this.llmConfig.apiKey,
        toolExecution: "sequential",
      });

      // Collect final response text from message_end events
      let responseText = "";
      agent.subscribe((event) => {
        if (event.type === "message_end") {
          const msg = event.message;
          if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === "text" && part.text) {
                responseText = part.text;
              }
            }
          }
        }
        if (event.type === "tool_execution_end" && event.isError) {
          const detail = JSON.stringify(event.result);
          this.logger.warn(`Session ${sessionId}: tool ${event.toolName} error: ${detail}`);
        }
      });

      await agent.prompt(prompt);

      // Send final response
      await withRetry(() =>
        this.linearClient.createAgentActivity({
          agentSessionId: sessionId,
          content: {
            type: "response",
            body: responseText || "处理完成，但没有生成回复内容。",
          },
        }),
      );
    } catch (err: unknown) {
      if (controller.signal.aborted) return;

      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Session ${sessionId} error: ${msg}`);
      try {
        await withRetry(() =>
          this.linearClient.createAgentActivity({
            agentSessionId: sessionId,
            content: { type: "error", body: `处理出错：${msg}` },
          }),
        );
      } catch {
        this.logger.error(`Session ${sessionId}: failed to send error activity`);
      }
    } finally {
      this.activeSessions.delete(sessionId);
    }
  }

  /**
   * 构建发送给 LLM 的 prompt。
   * - created 事件：promptContext（issue 上下文）+ previousComments 最后一条（用户消息）
   * - prompted 事件：从 API 拉取历史 activities 拼成对话记录 + 当前用户消息
   */
  private async buildPrompt(payload: AgentSessionEventWebhookPayload): Promise<string> {
    const parts: string[] = [];

    if (payload.action === "prompted") {
      // 多轮对话：拉取历史 activities 作为上下文
      const history = await this.loadHistory(payload.agentSession.id);
      if (history) parts.push(history);

      // 当前用户消息
      if (payload.agentActivity?.content) {
        const content = payload.agentActivity.content as Record<string, unknown>;
        if (typeof content.body === "string") {
          parts.push(`用户消息：${content.body}`);
        }
      }
    } else {
      // 首轮：使用 Linear 提供的 promptContext
      // promptContext 由 Linear 在 created 事件中自动生成，包含：
      // - Issue 标题、描述、状态
      // - 相关标签、项目
      // - 用户的具体指令
      if (payload.promptContext) {
        parts.push(payload.promptContext);
      }
      // 用户 @mention 的评论内容
      if (payload.previousComments?.length) {
        const last = payload.previousComments[payload.previousComments.length - 1];
        if (last?.body) parts.push(`用户消息：${last.body}`);
      }
    }

    return parts.join("\n\n") || "（无具体内容）";
  }

  /**
   * 从 Linear API 拉取 session 历史 activities，拼成对话记录。
   * activity 类型映射：
   * - prompt → 用户消息
   * - response → agent 回复
   * - thought/action/error/elicitation → 忽略（不参与对话上下文）
   */
  private async loadHistory(sessionId: string): Promise<string | null> {
    try {
      const activities = await this.linearClient.getSessionActivities(sessionId);
      const lines: string[] = [];

      for (const activity of activities) {
        const content = activity.content as Record<string, unknown>;
        const type = content.type as string;
        const body = content.body as string | undefined;
        if (!body) continue;

        if (type === "prompt") {
          lines.push(`用户：${body}`);
        } else if (type === "response") {
          lines.push(`egg：${body}`);
        }
      }

      if (lines.length === 0) return null;
      return `对话历史：\n${lines.join("\n")}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to load session history: ${msg}`);
      return null;
    }
  }
}
