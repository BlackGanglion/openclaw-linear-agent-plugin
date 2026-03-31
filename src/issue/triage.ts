import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LinearClient } from "@linear/sdk";
import type { PluginLogger } from "../webhook/logger-types";

export type TokenProvider = () => string | Promise<string>;

/** 团队成员信息 */
export interface TeamMember {
  id: string;
  name: string;
  displayName: string;
}

/** 可用标签 */
export interface AvailableLabel {
  id: string;
  name: string;
}

/** 工作流状态 */
export interface WorkflowState {
  id: string;
  name: string;
  type: string;
}

/** Triage 结果 — agent 分析后返回 */
export interface TriageResult {
  assigneeId?: string;
  priority?: number; // 0=无, 1=紧急, 2=高, 3=中, 4=低
  labelIds?: string[];
  reason: string; // agent 的判断理由
}

/** Issue 上下文 — 传给 agent 分析 */
export interface IssueContext {
  identifier: string;
  title: string;
  description: string;
  teamName: string;
  teamMembers: TeamMember[];
  availableLabels: AvailableLabel[];
  workflowStates: WorkflowState[];
  // 已有的字段（不需要 agent 判断）
  existing: {
    hasAssignee: boolean;
    assigneeName?: string;
    hasPriority: boolean;
    priority?: number;
    hasLabels: boolean;
    labelNames?: string[];
  };
}

// ============================================================
// Triage prompt — 从 prompts/triage.md 读取，不提交到 Git
// ============================================================
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = resolve(__dirname, "../../prompts/triage.md");

function loadTriagePrompt(): string {
  try {
    return readFileSync(PROMPT_PATH, "utf-8").trim();
  } catch {
    throw new Error(
      `Triage prompt not found at ${PROMPT_PATH}. Please create prompts/triage.md`,
    );
  }
}

/**
 * Issue 分诊器 — 收集上下文，调用 agent 分析，执行分配
 */
export class IssueTriage {
  private readonly getToken: TokenProvider;
  private readonly logger: PluginLogger;
  private readonly triagePrompt: string;

  // agent 自身的 userId，获取成员列表时排除自己
  // TODO: 后续支持 agent 处理 issue 时再移除此过滤
  private readonly excludeUserId?: string;

  constructor(
    getToken: TokenProvider,
    logger: PluginLogger,
    opts?: { triagePrompt?: string; excludeUserId?: string },
  ) {
    this.getToken = getToken;
    this.logger = logger;
    this.triagePrompt = opts?.triagePrompt ?? loadTriagePrompt();
    this.excludeUserId = opts?.excludeUserId;
  }

  private async getClient(): Promise<LinearClient> {
    const token = await this.getToken();
    return new LinearClient({ accessToken: token });
  }

  /** 收集 issue 的分诊上下文，包含已有字段信息 */
  async collectContext(issueId: string): Promise<IssueContext | null> {
    const client = await this.getClient();

    const issue = await client.issue(issueId);
    const team = await issue.team;
    if (!team) {
      this.logger.warn(`Issue ${issue.identifier} has no team`);
      return null;
    }

    // 检查已有字段
    const assignee = await issue.assignee;
    const existingLabels = await issue.labels();
    const hasAssignee = Boolean(assignee);
    const hasPriority = issue.priority > 0;
    const hasLabels = existingLabels.nodes.length > 0;

    // 全都有了，不需要分诊
    if (hasAssignee && hasPriority && hasLabels) {
      this.logger.info(`Issue ${issue.identifier} already fully triaged, skip`);
      return null;
    }

    // 获取团队成员（仅当需要分配时）
    const teamMembers: TeamMember[] = [];
    if (!hasAssignee) {
      const memberships = await team.memberships();
      for (const m of memberships.nodes) {
        const user = await m.user;
        if (user?.active) {
          // 排除 agent 自己，避免分配给自己
          // TODO: 后续支持 agent 处理 issue 时再移除此过滤
          if (this.excludeUserId && user.id === this.excludeUserId) continue;
          teamMembers.push({
            id: user.id,
            name: user.name,
            displayName: user.displayName,
          });
        }
      }
    }

    // 获取团队可用标签（仅当需要加标签时）
    const availableLabels: AvailableLabel[] = [];
    if (!hasLabels) {
      const labelsConnection = await team.labels();
      for (const l of labelsConnection.nodes) {
        availableLabels.push({ id: l.id, name: l.name });
      }
    }

    // 获取工作流状态
    const statesConnection = await team.states();
    const workflowStates: WorkflowState[] = statesConnection.nodes.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
    }));

    return {
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      teamName: team.name,
      teamMembers,
      availableLabels,
      workflowStates,
      existing: {
        hasAssignee,
        assigneeName: assignee?.name,
        hasPriority,
        priority: issue.priority,
        hasLabels,
        labelNames: existingLabels.nodes.map((l) => l.name),
      },
    };
  }

  /** 构建 agent prompt，只包含需要判断的部分 */
  buildAgentPrompt(context: IssueContext): string {
    const parts: string[] = [this.triagePrompt, "", "---", ""];

    // Issue 信息
    parts.push(
      `## Issue 信息`,
      `- 标识: ${context.identifier}`,
      `- 标题: ${context.title}`,
      `- 描述: ${context.description || "(无描述)"}`,
      `- 团队: ${context.teamName}`,
      "",
    );

    // 已有字段
    const existingParts: string[] = [];
    if (context.existing.hasAssignee) {
      existingParts.push(
        `- 负责人: ${context.existing.assigneeName} (已分配，无需判断)`,
      );
    }
    if (context.existing.hasPriority) {
      existingParts.push(
        `- 优先级: ${String(context.existing.priority)} (已设置，无需判断)`,
      );
    }
    if (context.existing.hasLabels) {
      existingParts.push(
        `- 标签: ${context.existing.labelNames?.join(", ")} (已设置，无需判断)`,
      );
    }
    if (existingParts.length > 0) {
      parts.push(`## 已有信息（无需判断）`, ...existingParts, "");
    }

    // 需要判断的字段
    parts.push(`## 需要你判断的字段`);
    if (!context.existing.hasAssignee) {
      const membersInfo = context.teamMembers
        .map((m) => `  - ${m.name} (ID: ${m.id})`)
        .join("\n");
      parts.push(`### 负责人（从以下成员中选择）`, membersInfo, "");
    }
    if (!context.existing.hasPriority) {
      parts.push(`### 优先级（1=紧急 2=高 3=中 4=低 0=无法判断）`, "");
    }
    if (!context.existing.hasLabels) {
      const labelsInfo = context.availableLabels
        .map((l) => `  - ${l.name} (ID: ${l.id})`)
        .join("\n");
      parts.push(`### 标签（从以下标签中选择，可多选）`, labelsInfo, "");
    }

    return parts.join("\n");
  }

  /** 解析 agent 返回的 JSON 结果 */
  parseTriageResult(agentOutput: string): TriageResult | null {
    const jsonMatch = agentOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      this.logger.warn("Agent output does not contain JSON");
      return null;
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      return {
        assigneeId:
          typeof parsed["assigneeId"] === "string"
            ? parsed["assigneeId"]
            : undefined,
        priority:
          typeof parsed["priority"] === "number"
            ? parsed["priority"]
            : undefined,
        labelIds: Array.isArray(parsed["labelIds"])
          ? (parsed["labelIds"] as unknown[]).filter(
              (id): id is string => typeof id === "string",
            )
          : undefined,
        reason:
          typeof parsed["reason"] === "string"
            ? parsed["reason"]
            : "No reason provided",
      };
    } catch {
      this.logger.warn(
        `Failed to parse triage JSON: ${jsonMatch[0].slice(0, 200)}`,
      );
      return null;
    }
  }

  /** 将分诊结果应用到 issue，只更新缺失的字段 */
  async applyTriageResult(
    issueId: string,
    result: TriageResult,
    context: IssueContext,
  ): Promise<void> {
    const client = await this.getClient();
    const issue = await client.issue(issueId);

    const updateInput: Record<string, unknown> = {};

    // 只更新缺失的字段
    if (!context.existing.hasAssignee && result.assigneeId) {
      updateInput["assigneeId"] = result.assigneeId;
    }

    if (
      !context.existing.hasPriority &&
      result.priority !== undefined &&
      result.priority >= 0 &&
      result.priority <= 4
    ) {
      updateInput["priority"] = result.priority;
    }

    if (
      !context.existing.hasLabels &&
      result.labelIds &&
      result.labelIds.length > 0
    ) {
      updateInput["labelIds"] = result.labelIds;
    }

    if (Object.keys(updateInput).length === 0) {
      this.logger.info(`No triage changes needed for ${issue.identifier}`);
      return;
    }

    await issue.update(updateInput);

    // 构建判断理由 comment
    const commentParts: string[] = ["**Issue 自动分诊结果：**", ""];
    if (!context.existing.hasAssignee && result.assigneeId) {
      const assigneeName =
        context.teamMembers.find((m) => m.id === result.assigneeId)?.name ??
        result.assigneeId;
      commentParts.push(`- **负责人** → ${assigneeName}`);
    }
    if (!context.existing.hasPriority && result.priority !== undefined) {
      const priorityNames: Record<number, string> = {
        0: "无",
        1: "紧急",
        2: "高",
        3: "中",
        4: "低",
      };
      commentParts.push(
        `- **优先级** → ${priorityNames[result.priority] ?? String(result.priority)}`,
      );
    }
    if (
      !context.existing.hasLabels &&
      result.labelIds &&
      result.labelIds.length > 0
    ) {
      const labelNames = result.labelIds
        .map(
          (id) => context.availableLabels.find((l) => l.id === id)?.name ?? id,
        )
        .join(", ");
      commentParts.push(`- **标签** → ${labelNames}`);
    }
    commentParts.push("", `> ${result.reason}`);

    await client.createComment({ issueId, body: commentParts.join("\n") });

    this.logger.info(
      `Triaged ${issue.identifier}: ` +
        (updateInput["assigneeId"]
          ? `assignee=${String(updateInput["assigneeId"])} `
          : "") +
        (updateInput["priority"] !== undefined
          ? `priority=${String(updateInput["priority"])} `
          : "") +
        (updateInput["labelIds"]
          ? `labels=${String(updateInput["labelIds"])} `
          : "") +
        `reason=${result.reason}`,
    );
  }
}
