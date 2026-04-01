import { LinearClient } from "@linear/sdk";

export type TokenProvider = () => Promise<string>;

/**
 * Linear API client — wraps @linear/sdk with token refresh support.
 */
export class LinearApiClient {
  private client: LinearClient | null = null;
  private lastToken = "";

  constructor(private readonly getToken: TokenProvider) {}

  private async ensure(): Promise<LinearClient> {
    const token = await this.getToken();
    if (!this.client || token !== this.lastToken) {
      this.client = new LinearClient({ accessToken: token });
      this.lastToken = token;
    }
    return this.client;
  }

  /** Fetch full issue with relations */
  async getIssue(issueId: string) {
    const client = await this.ensure();
    const issue = await client.issue(issueId);
    const [state, team, assignee, labels] = await Promise.all([
      issue.state,
      issue.team,
      issue.assignee,
      issue.labels(),
    ]);
    return { issue, state, team, assignee, labels: labels.nodes };
  }

  /** Get team members */
  async getTeamMembers(teamId: string) {
    const client = await this.ensure();
    const team = await client.team(teamId);
    const members = await team.members();
    return members.nodes.filter((m) => m.active);
  }

  /** Get available labels for a team */
  async getTeamLabels(teamId: string) {
    const client = await this.ensure();
    const team = await client.team(teamId);
    const labels = await team.labels();
    return labels.nodes;
  }

  /** Get workflow states for a team */
  async getWorkflowStates(teamId: string) {
    const client = await this.ensure();
    const team = await client.team(teamId);
    const states = await team.states();
    return states.nodes;
  }

  /** Update an issue */
  async updateIssue(
    issueId: string,
    input: {
      assigneeId?: string;
      priority?: number;
      labelIds?: string[];
      stateId?: string;
    },
  ) {
    const client = await this.ensure();
    return client.updateIssue(issueId, input);
  }

  /** Create a comment on an issue */
  async createComment(issueId: string, body: string) {
    const client = await this.ensure();
    return client.createComment({ issueId, body });
  }
}
