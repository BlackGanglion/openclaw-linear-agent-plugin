/**
 * Linear 专属 Agent 运行器
 *
 * 使用独立的 agentId ("linear") 确保：
 * - session 文件隔离：~/.openclaw/agents/linear/agent/sessions/
 * - 记忆独立：不会和 Telegram / Discord 等其他渠道的对话混淆
 * - 上下文干净：每次 triage 只包含 Linear issue 相关信息
 */

import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { PluginLogger } from "../webhook/logger-types";

// Linear 专属 agentId，与其他渠道（tg/discord/cli）完全隔离
const LINEAR_AGENT_ID = "linear";

interface EmbeddedAgentResult {
  payloads?: Array<{ text?: string }>;
  meta: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RunEmbeddedPiAgentFn = (params: any) => Promise<EmbeddedAgentResult>;

function resolveAgentDirs(): { agentDir: string; sessionsDir: string } {
  const agentDir = join(
    homedir(),
    ".openclaw",
    "agents",
    LINEAR_AGENT_ID,
    "agent",
  );
  const sessionsDir = join(agentDir, "sessions");
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }
  return { agentDir, sessionsDir };
}

export interface LinearAgentRunParams {
  /** 用于标识这次运行的唯一 key（如 triage-{issueId}） */
  sessionKey: string;
  /** 发送给 agent 的 prompt */
  prompt: string;
  /** agent 的系统级指令 */
  systemPrompt?: string;
  /** 工作目录 */
  workspaceDir?: string;
  /** 超时毫秒数 */
  timeoutMs?: number;
  /** 宿主传入的 runEmbeddedPiAgent 函数 */
  runEmbeddedPiAgent: RunEmbeddedPiAgentFn;
  logger: PluginLogger;
}

export interface LinearAgentRunResult {
  success: boolean;
  output: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟（triage 不需要太长）

/**
 * 运行 Linear 专属 agent。
 * 使用独立的 agentId 和 session 目录，不会和其他渠道混淆。
 */
export async function runLinearAgent(
  params: LinearAgentRunParams,
): Promise<LinearAgentRunResult> {
  const {
    prompt,
    systemPrompt,
    workspaceDir,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    runEmbeddedPiAgent,
    logger,
  } = params;

  const { sessionsDir } = resolveAgentDirs();
  // 所有 Linear 任务共享同一个 session，信息可以互相参考
  const sessionId = "linear-shared";
  const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
  const runId = randomUUID();

  logger.info(
    `[LinearAgent] Starting run: key=${params.sessionKey} session=${sessionId} runId=${runId}`,
  );

  try {
    const result = await runEmbeddedPiAgent({
      sessionId,
      sessionFile,
      workspaceDir: workspaceDir ?? process.cwd(),
      agentId: LINEAR_AGENT_ID,
      runId,
      prompt,
      extraSystemPrompt: systemPrompt,
      timeoutMs,
      bootstrapContextMode: "lightweight", // triage 不需要加载完整 workspace 上下文
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => false,
    });

    const output = extractOutput(result);
    logger.info(
      `[LinearAgent] Run completed: session=${sessionId} output=${output.slice(0, 200)}`,
    );
    return { success: true, output };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[LinearAgent] Run failed: session=${sessionId} error=${msg}`);
    return { success: false, output: msg };
  }
}

function extractOutput(result: EmbeddedAgentResult): string {
  const payloads = result.payloads;
  if (!Array.isArray(payloads)) return "";
  return payloads
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");
}
