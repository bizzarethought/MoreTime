import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { ApiError } from "./errors.ts";

export type Authenticate = (request: Request) => Promise<string>;

export function createJwtAuthenticator(options: {
  issuer: string;
  audience: string;
  keys: JWTVerifyGetKey;
}): Authenticate {
  return async (request) => {
    const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "");
    if (!match?.[1]) throw new ApiError(401, "unauthorized", "A signed-in user's bearer token is required.");
    try {
      const { payload } = await jwtVerify(match[1], options.keys, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: ["RS256", "ES256"],
        requiredClaims: ["sub", "exp", "iss", "aud"],
      });
      if (typeof payload.sub !== "string" || !payload.sub.trim() || payload.sub.length > 256) throw new Error();
      return payload.sub;
    } catch {
      throw new ApiError(401, "unauthorized", "The sign-in token is invalid or expired.");
    }
  };
}

export function authenticationFromEnvironment(env: NodeJS.ProcessEnv): Authenticate {
  const { AUTH_JWKS_URL, AUTH_ISSUER, AUTH_AUDIENCE } = env;
  if (!AUTH_JWKS_URL || !AUTH_ISSUER || !AUTH_AUDIENCE) {
    return async () => {
      throw new ApiError(503, "auth_not_configured", "Website authentication has not been configured on the backend.");
    };
  }
  const url = new URL(AUTH_JWKS_URL);
  if (url.protocol !== "https:") throw new Error("AUTH_JWKS_URL must use HTTPS.");
  return createJwtAuthenticator({
    issuer: AUTH_ISSUER,
    audience: AUTH_AUDIENCE,
    keys: createRemoteJWKSet(url, { timeoutDuration: 5000 }),
  });
}
