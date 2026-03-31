import "dotenv/config";

export interface AppConfig {
  port: number;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenStorePath: string;
  defaultDir?: string;
  // LLM config for triage (OpenAI-compatible API)
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
}

export function loadConfig(): AppConfig {
  const webhookSecret = process.env["LINEAR_WEBHOOK_SECRET"] ?? "";
  const clientId = process.env["LINEAR_CLIENT_ID"] ?? "";
  const clientSecret = process.env["LINEAR_CLIENT_SECRET"] ?? "";
  const redirectUri = process.env["LINEAR_REDIRECT_URI"] ?? "";
  const tokenStorePath =
    process.env["TOKEN_STORE_PATH"] ?? ".data/oauth-token.json";
  const port = parseInt(process.env["PORT"] ?? "3000", 10);
  const defaultDir = process.env["DEFAULT_DIR"];
  const llmBaseUrl =
    process.env["LLM_BASE_URL"] ?? "https://api.moonshot.cn/v1";
  const llmModel = process.env["LLM_MODEL"] ?? "kimi-k2.5";
  const llmApiKey = process.env["LLM_API_KEY"] ?? "";

  if (!webhookSecret || !clientId || !clientSecret || !redirectUri) {
    console.error(
      "Missing required env vars: LINEAR_WEBHOOK_SECRET, LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET, LINEAR_REDIRECT_URI",
    );
    process.exit(1);
  }

  return {
    port,
    webhookSecret,
    clientId,
    clientSecret,
    redirectUri,
    tokenStorePath,
    defaultDir,
    llmBaseUrl,
    llmModel,
    llmApiKey,
  };
}
