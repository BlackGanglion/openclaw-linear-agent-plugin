import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { LinearApiClient } from "../linear/client";
import type { IssueContext, TriageResult } from "../triage/triage";
import type { PluginLogger } from "../webhook/logger-types";

const submitTriageParameters = Type.Object({
  shouldTriage: Type.Boolean({
    description:
      "该 issue 是否属于自动分类范围。不属于时设为 false。",
  }),
  assigneeId: Type.Union([Type.String(), Type.Null()], {
    description:
      "分配的团队成员 id，无法判断时为 null。",
  }),
  priority: Type.Integer({
    description: "优先级，取值 0-4。",
    minimum: 0,
    maximum: 4,
  }),
  labelIds: Type.Array(Type.String(), {
    description: "标签 id 数组，没有合适标签时为空数组。",
  }),
  reason: Type.String({
    description: "简要说明判断理由（2-3句话），使用中文。",
  }),
});

async function withRetry<T>(
  fn: () => Promise<T>,
  { maxRetries = 3, baseDelayMs = 1000 } = {},
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

export function createSubmitTriageTool(
  linearClient: LinearApiClient,
  context: IssueContext,
  logger: PluginLogger,
): AgentTool {
  return {
    name: "submit_triage_result",
    label: "Submit Triage Result",
    description:
      "提交最终的 issue 分诊结果。分析完成后必须调用此工具提交判断。",
    parameters: submitTriageParameters,

    execute: async (_toolCallId: string, params: unknown) => {
      const a = params as Record<string, unknown>;
      const result: TriageResult = {
        shouldTriage: a["shouldTriage"] !== false,
        assigneeId:
          typeof a["assigneeId"] === "string" ? a["assigneeId"] : null,
        priority:
          typeof a["priority"] === "number" ? a["priority"] : 0,
        labelIds: Array.isArray(a["labelIds"])
          ? (a["labelIds"] as string[])
          : [],
        reason: typeof a["reason"] === "string" ? a["reason"] : "",
      };

      logger.info(
        `Triage ${context.identifier} result:\n${JSON.stringify(result, null, 2)}`,
      );

      if (!result.shouldTriage) {
        return {
          content: [{ type: "text" as const, text: "Skipped: not eligible for auto-triage" }],
          details: { result },
        };
      }

      // Apply result to Linear directly
      const update: Record<string, unknown> = {};

      if (!context.existing.hasAssignee && result.assigneeId) {
        update["assigneeId"] = result.assigneeId;
      }
      if (!context.existing.hasPriority && result.priority > 0) {
        update["priority"] = result.priority;
      }
      if (!context.existing.hasLabels && result.labelIds.length > 0) {
        update["labelIds"] = result.labelIds;
      }

      // If current state is triage, move to backlog
      if (context.currentState?.type === "triage") {
        const backlogState = context.workflowStates.find(
          (s) => s.type === "backlog",
        );
        if (backlogState) {
          update["stateId"] = backlogState.id;
        }
      }

      if (Object.keys(update).length > 0) {
        await withRetry(() => linearClient.updateIssue(context.issueId, update));
      }

      if (result.reason) {
        await withRetry(() => linearClient.createComment(context.issueId, result.reason));
      }

      return {
        content: [{ type: "text" as const, text: "Triage result applied successfully" }],
        details: { result },
      };
    },
  };
}
