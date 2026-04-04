import { createReadTool } from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";

export function createRead(cwd: string): AgentTool {
  return createReadTool(cwd) as unknown as AgentTool;
}
