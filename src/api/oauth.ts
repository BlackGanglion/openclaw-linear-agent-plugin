import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";


const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_SCOPES = "read,write,app:assignable,app:mentionable";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  webhookSecret: string; // used for state validation
  tokenStorePath: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  tokenType?: string;
  agentId?: string;
  createdAt: string;
  updatedAt: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

// --- State validation ---

function generateState(webhookSecret: string): string {
  return createHash("sha256")
    .update(`linear-oauth:${webhookSecret}`)
    .digest("hex");
}

function validateState(state: string, webhookSecret: string): boolean {
  const expected = generateState(webhookSecret);
  if (state.length !== expected.length) return false;
  return timingSafeEqual(
    Buffer.from(state, "utf-8"),
    Buffer.from(expected, "utf-8"),
  );
}

// --- Token storage ---

export function loadTokenSet(path: string): TokenSet | null {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as TokenSet;
  } catch {
    return null;
  }
}

function saveTokenSet(path: string, tokenSet: TokenSet): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(tokenSet, null, 2), { mode: 0o600 });
}

// --- Token exchange ---

async function exchangeCode(
  code: string,
  config: OAuthConfig,
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  });

  const res = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  return (await res.json()) as TokenResponse;
}

// --- Refresh token ---

export async function refreshToken(
  config: OAuthConfig,
): Promise<TokenSet | null> {
  const existing = loadTokenSet(config.tokenStorePath);
  if (!existing?.refreshToken) return null;

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: existing.refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const res = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  }).catch(() => null);

  if (!res || !res.ok) {
    return null;
  }

  const payload = (await res.json().catch(() => null)) as TokenResponse | null;
  if (!payload?.access_token) {
    return null;
  }

  const now = new Date();
  const updated: TokenSet = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? existing.refreshToken,
    tokenType: payload.token_type ?? existing.tokenType,
    scope: payload.scope ?? existing.scope,
    expiresAt:
      typeof payload.expires_in === "number"
        ? new Date(now.getTime() + payload.expires_in * 1000).toISOString()
        : existing.expiresAt,
    agentId: existing.agentId,
    createdAt: existing.createdAt,
    updatedAt: now.toISOString(),
  };

  saveTokenSet(config.tokenStorePath, updated);
  return updated;
}

// --- Resolve agent ID via viewer query ---

async function resolveAgentId(accessToken: string): Promise<string> {
  const res = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: "query { viewer { id } }" }),
  });
  const json = (await res.json()) as { data?: { viewer?: { id?: string } } };
  return json.data?.viewer?.id ?? "";
}

// --- Get current access token (with auto-refresh) ---

export async function getAccessToken(
  config: OAuthConfig,
): Promise<{ accessToken: string; agentId: string } | null> {
  const tokenSet = loadTokenSet(config.tokenStorePath);
  if (!tokenSet) return null;

  // Check if expired
  if (tokenSet.expiresAt) {
    const expiresAt = new Date(tokenSet.expiresAt).getTime();
    const buffer = 5 * 60 * 1000; // refresh 5 min before expiry
    if (Date.now() > expiresAt - buffer) {
      const refreshed = await refreshToken(config);
      if (refreshed) {
        return {
          accessToken: refreshed.accessToken,
          agentId: refreshed.agentId ?? "",
        };
      }
      // If refresh fails but token hasn't actually expired, try using it
      if (Date.now() < expiresAt) {
        return {
          accessToken: tokenSet.accessToken,
          agentId: tokenSet.agentId ?? "",
        };
      }
      return null;
    }
  }

  return { accessToken: tokenSet.accessToken, agentId: tokenSet.agentId ?? "" };
}

// --- Authorization URL ---

export function getAuthorizationUrl(config: OAuthConfig): string {
  const state = generateState(config.webhookSecret);
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: LINEAR_SCOPES,
    state,
    actor: "app",
  });
  return `${LINEAR_AUTHORIZE_URL}?${params.toString()}`;
}

// --- OAuth callback (framework-agnostic) ---

export type OAuthCallbackResult =
  | { success: true; agentId: string; expiresAt?: string }
  | { success: false; status: number; title: string; message: string };

export async function handleOAuthCallback(
  config: OAuthConfig,
  code: string,
  state: string,
): Promise<OAuthCallbackResult> {
  // Validate state
  if (!validateState(state, config.webhookSecret)) {
    return {
      success: false,
      status: 403,
      title: "Invalid state parameter",
      message: "State validation failed",
    };
  }

  // Exchange code for token
  let payload: TokenResponse;
  try {
    payload = await exchangeCode(code, config);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      status: 500,
      title: "Token Exchange Failed",
      message: msg,
    };
  }

  if (payload.error || !payload.access_token) {
    const desc =
      payload.error_description ?? payload.error ?? "unknown error";
    return {
      success: false,
      status: 400,
      title: "Token Exchange Error",
      message: desc,
    };
  }

  // Resolve agent ID
  let agentId = "";
  try {
    agentId = await resolveAgentId(payload.access_token);
  } catch {
  }

  // Save token
  const now = new Date();
  const tokenSet: TokenSet = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    tokenType: payload.token_type,
    scope: payload.scope,
    expiresAt:
      typeof payload.expires_in === "number"
        ? new Date(now.getTime() + payload.expires_in * 1000).toISOString()
        : undefined,
    agentId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  saveTokenSet(config.tokenStorePath, tokenSet);

  return { success: true, agentId, expiresAt: tokenSet.expiresAt };
}
