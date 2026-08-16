import { sign, verify } from 'hono/jwt';
import type { JWTPayload } from 'hono/utils/jwt/types';

export const DEFAULT_TOKEN_EXPIRY_SECONDS = 15 * 60; // 15 minutes (900 seconds)
export const MAX_TOKEN_EXPIRY_SECONDS = 24 * 60 * 60; // 24 hours
export const MIN_TOKEN_EXPIRY_SECONDS = 60; // 1 minute
export const TOKEN_ISSUER = 'eve-finance-mcp';
export const TOKEN_AUDIENCE = 'eve-finance-client';

export interface UserTokenPayload extends JWTPayload {
  sub: string;
  name?: string;
  email?: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

/**
 * Validate standard email format (RFC 5322 compliant pattern).
 */
export function isValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
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
 * Compute SHA-256 hash of an API key for safe database storage and lookup.
 */
export async function hashApiKey(apiKey: string): Promise<string> {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('API key must be a non-empty string');
  }
  const msgBuffer = new TextEncoder().encode(apiKey.trim());
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
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
 * Generate a unique user ID with 'usr_' prefix using crypto.randomUUID.
 */
export function generateUserId(): string {
  const uuid = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `usr_${Date.now().toString(36)}_${uuid}`;
}

/**
 * Generate a signed self-contained JWT token for a user.
 * Requires an explicit secret string (no silent default).
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
  secret: string
): Promise<string> {
  if (!secret || typeof secret !== 'string' || secret.trim() === '') {
    throw new Error('Server configuration error: JWT_SECRET is required to sign tokens');
  }
  if (!params.userId || typeof params.userId !== 'string' || params.userId.trim() === '') {
    throw new Error('Validation error: Valid userId is required to generate a token');
  }

  const now = Math.floor(Date.now() / 1000);
  const requestedExpiry = params.expiresInSeconds !== undefined ? params.expiresInSeconds : DEFAULT_TOKEN_EXPIRY_SECONDS;
  // Clamp expiry between min and max bounds
  const clampedExpiry = Math.min(Math.max(MIN_TOKEN_EXPIRY_SECONDS, requestedExpiry), MAX_TOKEN_EXPIRY_SECONDS);

  const payload: UserTokenPayload = {
    sub: params.userId.trim(),
    name: params.name?.trim(),
    email: params.email?.trim().toLowerCase(),
    iss: TOKEN_ISSUER,
    aud: TOKEN_AUDIENCE,
    iat: now,
    exp: now + clampedExpiry,
  };

  return sign(payload, secret, 'HS256');
}

/**
 * Cryptographically verify a JWT Bearer token and extract user information.
 * Requires an explicit secret string.
 *
 * @param token Raw JWT string
 * @param secret Secret key for HMAC-SHA256 signature
 */
export async function verifyUserToken(
  token: string,
  secret: string
): Promise<{ userId: string; name?: string; email?: string } | null> {
  if (!token || typeof token !== 'string' || !secret || typeof secret !== 'string') {
    return null;
  }

  try {
    const payload = (await verify(token.trim(), secret, 'HS256')) as UserTokenPayload;
    if (
      !payload ||
      typeof payload.sub !== 'string' ||
      payload.sub.trim() === '' ||
      payload.iss !== TOKEN_ISSUER ||
      payload.aud !== TOKEN_AUDIENCE
    ) {
      return null;
    }
    return {
      userId: payload.sub.trim(),
      name: payload.name,
      email: payload.email,
    };
  } catch {
    return null;
  }
}
