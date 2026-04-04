import type { Model } from "@mariozechner/pi-ai";
import { Agent } from "@mariozechner/pi-agent-core";
import type { LinearApiClient } from "../../../infra/linear/client";
import type { Logger } from "../../../utils/logger";
import { fetchTraceTool } from "../../tool/fetch-trace";
import { createSubmitTriageTool } from "../../tool/submit-triage";
import { loadPrompt } from "../../../utils/prompt-loader";

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
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
  };
}

// --- Image utilities ---

/** Extract image URLs from markdown content */
function extractImageUrls(markdown: string): string[] {
  const regex = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
  const urls: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    if (match[1]) urls.push(match[1]);
  }
  return urls;
}

/** Download an image and return base64 data with mime type */
async function downloadImageAsBase64(
  url: string,
): Promise<{ data: string; mimeType: string } | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "image/png";
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return { data: base64, mimeType: contentType };
  } catch {
    return null;
  }
}

// --- Triage ---

export class IssueTriage {
  private getTriagePrompt: () => string;
  private model: Model<"openai-completions">;

  constructor(
    private readonly linearClient: LinearApiClient,
    private readonly llmConfig: LLMConfig,
    private readonly logger: Logger,
    private readonly excludeUserId?: string,
  ) {
    this.model = createModel(llmConfig);
    this.getTriagePrompt = loadPrompt("triage.md");
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

  /** Run triage using pi-agent-core Agent */
  async runTriage(context: IssueContext): Promise<void> {
    const userPrompt = this.buildPrompt(context);

    // Extract and download images from description
    const imageUrls = extractImageUrls(context.description);
    const images: Array<{ type: "image"; mimeType: string; data: string }> = [];
    if (imageUrls.length > 0) {
      const results = await Promise.all(
        imageUrls.map((url) => downloadImageAsBase64(url)),
      );
      for (const result of results) {
        if (result) {
          images.push({ type: "image", mimeType: result.mimeType, data: result.data });
        }
      }
    }

    const submitTool = createSubmitTriageTool(
      this.linearClient,
      context,
      this.logger,
    );

    const agent = new Agent({
      initialState: {
        systemPrompt: this.getTriagePrompt(),
        model: this.model,
        tools: [fetchTraceTool, submitTool],
      },
      getApiKey: async () => this.llmConfig.apiKey,
      toolExecution: "sequential",
    });

    // Log tool errors
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.isError) {
        const detail = JSON.stringify(event.result);
        this.logger.warn(
          `Triage ${context.identifier}: tool ${event.toolName} error: ${detail}`,
        );
      }
    });

    await agent.prompt(userPrompt, images.length > 0 ? images : undefined);
  }

  /** Full triage flow: collect -> LLM -> apply */
  async triageIssue(issueId: string): Promise<void> {
    const context = await this.collectContext(issueId);
    if (!context) return;

    await this.runTriage(context);
  }
}
