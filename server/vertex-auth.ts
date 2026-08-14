import { GoogleAuth } from "google-auth-library";

type AuthLike = {
  getClient(): Promise<{ getAccessToken(): Promise<string | { token?: string | null } | null> }>;
};

let tokenCache: { token: string | null; expiresAt: number } = { token: null, expiresAt: 0 };

export async function getVertexAccessToken(options: {
  authImpl?: AuthLike;
  now?: () => number;
} = {}): Promise<string> {
  const now = options.now ?? (() => Date.now());
  if (tokenCache.token && tokenCache.expiresAt > now()) return tokenCache.token;

  const auth = options.authImpl
    ?? new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
  let token: string | null | undefined;
  try {
    const client = await auth.getClient();
    const result = await client.getAccessToken();
    token = typeof result === "string" ? result : result?.token;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `No Google Cloud credentials: ${message}. Run \`gcloud auth application-default login\` (or set GOOGLE_APPLICATION_CREDENTIALS).`,
    );
  }
  if (!token) {
    throw new Error(
      "Google Cloud credentials produced no access token. Run `gcloud auth application-default login`.",
    );
  }
  tokenCache = { token, expiresAt: now() + 30 * 60 * 1000 };
  return token;
}

export function resetVertexTokenCache(): void {
  tokenCache = { token: null, expiresAt: 0 };
}

