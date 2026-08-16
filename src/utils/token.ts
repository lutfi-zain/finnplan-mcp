import { sign, verify } from 'hono/jwt';
import type { JWTPayload } from 'hono/utils/jwt/types';

export const DEFAULT_DEV_JWT_SECRET = 'finnplan-mcp-dev-super-secret-key-change-in-prod';
export const DEFAULT_TOKEN_EXPIRY_SECONDS = 15 * 60; // 15 minutes (900 seconds)

export interface UserTokenPayload extends JWTPayload {
  sub: string;
  name?: string;
  email?: string;
  iat?: number;
  exp?: number;
}

/**
 * Validate standard email format (e.g. user@example.com).
 */
export function isValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
}

/**
 * Validate WhatsApp number in E.164 international format:
 * Must start with '+' followed by country code and 6-14 digits (e.g. +6281234567890).
 */
export function isValidWhatsApp(phone: string): boolean {
  if (!phone || typeof phone !== 'string') return false;
  const phoneRegex = /^\+[1-9]\d{6,14}$/;
  return phoneRegex.test(phone.trim());
}

/**
 * Generate a cryptographically secure random API key with 'fp_live_' prefix.
 */
export function generateApiKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `fp_live_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Generate a unique user ID with 'usr_' prefix.
 */
export function generateUserId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `usr_${Date.now().toString(36)}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Generate a signed self-contained JWT token for a user with default 15-minute expiration.
 *
 * @param params User info and optional expiration time (in seconds from now)
 * @param secret Secret key for HMAC-SHA256 signature
 */
export async function generateUserToken(
  params: {
    userId: string;
    name?: string;
    email?: string;
    expiresInSeconds?: number;
  },
  secret: string = DEFAULT_DEV_JWT_SECRET
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiry = params.expiresInSeconds !== undefined ? params.expiresInSeconds : DEFAULT_TOKEN_EXPIRY_SECONDS;

  const payload: UserTokenPayload = {
    sub: params.userId,
    name: params.name,
    email: params.email,
    iat: now,
    exp: now + expiry,
  };

  return sign(payload, secret, 'HS256');
}

/**
 * Cryptographically verify a JWT Bearer token and extract user information.
 * Does NOT require any database query.
 *
 * @param token Raw JWT string
 * @param secret Secret key for HMAC-SHA256 signature
 */
export async function verifyUserToken(
  token: string,
  secret: string = DEFAULT_DEV_JWT_SECRET
): Promise<{ userId: string; name?: string; email?: string } | null> {
  try {
    const payload = (await verify(token, secret, 'HS256')) as UserTokenPayload;
    if (!payload || !payload.sub) {
      return null;
    }
    return {
      userId: payload.sub,
      name: payload.name,
      email: payload.email,
    };
  } catch {
    return null;
  }
}
