import { readFileSync } from "node:fs";
import { join } from "node:path";
import { complete } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";
import type { LinearApiClient } from "../linear/client";
import type { PluginLogger } from "../webhook/logger-types";

// --- Types ---

export interface IssueContext {
  issueId: string;
  identifier: string;
  title: string;
  description: string;
  teamName: string;
  teamMembers: Array<{ id: string; name: string; displayName: string }>;
  availableLabels: Array<{ id: string; name: string }>;
  workflowStates: Array<{ id: string; name: string; type: string }>;
  currentState?: { id: string; name: string; type: string };
  existing: {
    hasAssignee: boolean;
    assigneeName?: string;
    hasPriority: boolean;
    priority?: number;
    hasLabels: boolean;
    labelNames?: string[];
  };
}

export interface TriageResult {
  shouldTriage: boolean;
  assigneeId: string | null;
  priority: number;
  labelIds: string[];
  reason: string;
}

export interface LLMConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

// --- Build pi-ai Model from config ---

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

// --- Triage ---

export class IssueTriage {
  private triagePrompt: string;
  private model: Model<"openai-completions">;

  constructor(
    private readonly linearClient: LinearApiClient,
    private readonly llmConfig: LLMConfig,
    private readonly logger: PluginLogger,
    private readonly excludeUserId?: string,
  ) {
    this.model = createModel(llmConfig);

    const promptPath = join(process.cwd(), "prompts", "triage.md");
    try {
      this.triagePrompt = readFileSync(promptPath, "utf-8");
    } catch {
      logger.error(`Failed to load triage prompt from ${promptPath}`);
      this.triagePrompt = "";
    }
  }

  /** Collect issue context from Linear */
  async collectContext(issueId: string): Promise<IssueContext | null> {
    const { issue, state, team, assignee, labels } =
      await this.linearClient.getIssue(issueId);

    if (!team) {
      this.logger.warn(`Issue ${issueId}: no team found, skipping`);
      return null;
    }

    const hasAssignee = !!assignee;
    const hasPriority = issue.priority > 0;
    const hasLabels = labels.length > 0;

    // Already fully triaged
    if (hasAssignee && hasPriority && hasLabels) {
      this.logger.info(
        `Issue ${issue.identifier}: already triaged, skipping`,
      );
      return null;
    }

    const [teamMembers, availableLabels, workflowStates] = await Promise.all([
      this.linearClient.getTeamMembers(team.id),
      this.linearClient.getTeamLabels(team.id),
      this.linearClient.getWorkflowStates(team.id),
    ]);

    return {
      issueId,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      teamName: team.name,
      currentState: state
        ? { id: state.id, name: state.name, type: state.type }
        : undefined,
      teamMembers: teamMembers
        .filter((m) => m.id !== this.excludeUserId)
        .map((m) => ({
          id: m.id,
          name: m.name,
          displayName: m.displayName,
        })),
      availableLabels: availableLabels.map((l) => ({
        id: l.id,
        name: l.name,
      })),
      workflowStates: workflowStates.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
      })),
      existing: {
        hasAssignee,
        assigneeName: assignee?.name,
        hasPriority,
        priority: issue.priority,
        hasLabels,
        labelNames: labels.map((l) => l.name),
      },
    };
  }

  /** Build the prompt for the LLM */
  buildPrompt(context: IssueContext): string {
    const lines: string[] = [];

    lines.push(`Issue: ${context.identifier}`);
    lines.push(`Title: ${context.title}`);
    if (context.description) {
      lines.push(`Description:\n${context.description}`);
    }
    lines.push(`Team: ${context.teamName}`);
    lines.push("");

    // Existing fields
    if (context.existing.hasAssignee) {
      lines.push(
        `Assignee: ${context.existing.assigneeName} (already set, no need to judge)`,
      );
    } else {
      lines.push("Assignee: needs to be judged");
    }

    if (context.existing.hasPriority) {
      lines.push(
        `Priority: ${context.existing.priority} (already set, no need to judge)`,
      );
    } else {
      lines.push("Priority: needs to be judged");
    }

    if (context.existing.hasLabels) {
      lines.push(
        `Labels: ${context.existing.labelNames?.join(", ")} (already set, no need to judge)`,
      );
    } else {
      lines.push("Labels: needs to be judged");
    }

    lines.push("");

    // Available choices
    if (!context.existing.hasAssignee) {
      lines.push("Available team members:");
      for (const m of context.teamMembers) {
        lines.push(`  - ${m.name} (${m.displayName}) id=${m.id}`);
      }
      lines.push("");
    }

    if (!context.existing.hasLabels) {
      lines.push("Available labels:");
      for (const l of context.availableLabels) {
        lines.push(`  - ${l.name} id=${l.id}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /** Call LLM to triage the issue */
  async runTriage(context: IssueContext): Promise<TriageResult | null> {
    const userPrompt = this.buildPrompt(context);

    this.logger.info(
      `Triage ${context.identifier}: calling ${this.llmConfig.model}`,
    );

    try {
      const response = await complete(this.model, {
        systemPrompt: this.triagePrompt,
        messages: [
          { role: "user", content: userPrompt, timestamp: Date.now() },
        ],
      }, {
        apiKey: this.llmConfig.apiKey,
        onPayload: (payload) => ({
          ...(payload as Record<string, unknown>),
          response_format: { type: "json_object" },
        }),
      });

      if (
        response.stopReason === "error" ||
        response.stopReason === "aborted"
      ) {
        this.logger.error(
          `Triage LLM error: ${response.errorMessage ?? response.stopReason}`,
        );
        return null;
      }

      const text = response.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { type: "text"; text: string }).text)
        .join("");

      this.logger.info(`Triage ${context.identifier} raw output:\n${text}`);
      return this.parseResult(text);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Triage LLM error: ${msg}`);
      return null;
    }
  }

  /** Parse JSON result from LLM output */
  parseResult(output: string): TriageResult | null {
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      this.logger.warn("Triage: no JSON found in output");
      return null;
    }

    try {
      const p = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      return {
        shouldTriage: p["shouldTriage"] !== false,
        assigneeId:
          typeof p["assigneeId"] === "string" ? p["assigneeId"] : null,
        priority:
          typeof p["priority"] === "number" ? p["priority"] : 0,
        labelIds: Array.isArray(p["labelIds"])
          ? (p["labelIds"] as string[])
          : [],
        reason: typeof p["reason"] === "string" ? p["reason"] : "",
      };
    } catch (err) {
      this.logger.warn(`Triage: JSON parse failed: ${err}`);
      return null;
    }
  }

  /** Apply triage result back to Linear */
  async applyResult(
    issueId: string,
    result: TriageResult,
    context: IssueContext,
  ): Promise<void> {
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
      await this.linearClient.updateIssue(issueId, update);
      this.logger.info(
        `Triage ${context.identifier}: updated ${Object.keys(update).join(", ")}`,
      );
    }

    if (result.reason) {
      await this.linearClient.createComment(
        issueId,
        `${result.reason}`,
      );
    }
  }

  /** Full triage flow: collect → LLM → apply */
  async triageIssue(issueId: string): Promise<void> {
    try {
      const context = await this.collectContext(issueId);
      if (!context) return;

      const result = await this.runTriage(context);
      if (!result) return;

      if (!result.shouldTriage) {
        this.logger.info(
          `Triage ${context.identifier}: LLM determined not eligible for auto-triage, skipping`,
        );
        return;
      }

      await this.applyResult(issueId, result, context);
      this.logger.info(`Triage ${context.identifier}: done`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Triage failed for ${issueId}: ${msg}`);
    }
  }
}
