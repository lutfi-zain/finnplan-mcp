import { Hono, type Context } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from './db/schema';
import { createMCPServer } from './mcp';
import { verifyUserToken, hashApiKey } from './utils/token';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Global Security & CORS Headers
app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, mcp-api-key, mcp-session-id, MCP-Protocol-Version');
  c.header('Access-Control-Max-Age', '86400');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');

  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }
  await next();
});

// Centralized Unhandled Error Handler (Sanitizes stack trace leaks)
app.onError((err, c) => {
  console.error('Unhandled Application Error:', err);
  return c.json({ error: 'Internal Server Error', message: err.message }, 500);
});

// Health check & Server info endpoint
app.get('/', (c) => {
  return c.json({
    name: 'eve-finance-mcp',
    status: 'ok',
    auth: 'dual-auth-api-key-and-jwt',
    description: 'Stateless Pure MCP Server for Eve Finance on Cloudflare Workers (D1)',
    authMethods: [
      'Authorization: Bearer <fp_live_apiKey>',
      'Authorization: Bearer <jwt_token>',
      'X-API-Key: <fp_live_apiKey>',
      'In-tool apiKey argument'
    ],
    authTools: {
      register: 'register_user',
      login: 'login_user'
    },
    endpoints: {
      mcp: '/mcp',
      sse: '/sse'
    }
  });
});

app.get('/health', (c) => c.text('OK'));

// Auth helper: Resolves User ID from Bearer API Key (fp_live_...), Bearer JWT, X-API-Key, or query params
async function extractAuthenticatedUserId(
  c: Context<{ Bindings: Bindings }>,
  db: DrizzleD1Database<typeof schema>
): Promise<string | null> {
  let candidate: string | null = null;

  // 1. Check Authorization Header (Bearer <key_or_jwt>)
  const authHeader = c.req.header('Authorization');
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      candidate = match[1].trim();
    }
  }

  // 2. Check X-API-Key or mcp-api-key headers
  if (!candidate) {
    candidate = c.req.header('X-API-Key') || c.req.header('x-api-key') || c.req.header('mcp-api-key') || null;
    if (candidate) candidate = candidate.trim();
  }

  // 3. Check Query Parameter (?apiKey=... or ?token=...)
  if (!candidate) {
    candidate = c.req.query('apiKey') || c.req.query('token') || null;
    if (candidate) candidate = candidate.trim();
  }

  if (!candidate) return null;

  // Case A: Persistent API Key (starts with fp_live_ or matches API key pattern)
  if (candidate.startsWith('fp_live_')) {
    try {
      const keyHash = await hashApiKey(candidate);
      const user = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.apiKeyHash, keyHash)).get();
      return user ? user.id : null;
    } catch {
      return null;
    }
  }

  // Case B: Self-Contained JWT Token
  const secret = c.env?.JWT_SECRET;
  if (!secret) {
    console.error('Configuration Error: JWT_SECRET binding is missing');
    return null;
  }

  const user = await verifyUserToken(candidate, secret);
  if (user) return user.userId;

  // Case C: Fallback check if a raw non-prefixed key was provided
  try {
    const keyHash = await hashApiKey(candidate);
    const user = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.apiKeyHash, keyHash)).get();
    return user ? user.id : null;
  } catch {
    return null;
  }
}

// Handler for MCP requests (Stateless Streamable HTTP & SSE)
async function handleMcpRequest(c: Context<{ Bindings: Bindings }>) {
  const secret = c.env?.JWT_SECRET;
  if (!secret) {
    return c.json({ error: 'Server Misconfiguration: JWT_SECRET environment variable is missing' }, 500);
  }
  if (!c.env?.DB) {
    return c.json({ error: 'Server Misconfiguration: Database (DB) binding is missing' }, 500);
  }

  // If a browser/tool performs a plain GET without SSE Accept header, return friendly info
  const rawAccept = c.req.header('accept') || '';
  if (c.req.method === 'GET' && !rawAccept.includes('text/event-stream') && !rawAccept.includes('*/*')) {
    return c.json({
      name: 'eve-finance-mcp',
      status: 'ok',
      transport: 'streamable-http',
      endpoint: c.req.url,
      tip: 'Connect via an MCP client with Streamable HTTP or SSE transport.',
    });
  }

  const db = drizzle(c.env.DB, { schema });
  const userId = await extractAuthenticatedUserId(c, db);

  // Use stateless WebStandardStreamableHTTPServerTransport
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  const mcpServer = createMCPServer(db, userId, secret);
  await mcpServer.connect(transport);

  // Normalize Request headers for maximum compatibility across various MCP clients
  const headers = new Headers(c.req.raw.headers);
  if (c.req.method === 'POST') {
    headers.set('accept', 'application/json, text/event-stream');
    const ct = headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      headers.set('content-type', 'application/json');
    }
  } else if (c.req.method === 'GET') {
    headers.set('accept', 'text/event-stream');
  }

  // Safely parse body once for POST requests
  let parsedBody: unknown = undefined;
  if (c.req.method === 'POST') {
    try {
      parsedBody = await c.req.json();
    } catch {
      // Empty or non-JSON body - transport will handle error formatting
    }
  }

  const normalizedRequest = new Request(c.req.raw.url, {
    method: c.req.method,
    headers,
  });

  const response = await transport.handleRequest(normalizedRequest, { parsedBody });

  // Ensure empty responses (such as 202 Accepted on notifications or DELETE) return valid JSON body
  // to avoid "JSON Parse error: Unexpected EOF" on clients that call res.json() unconditionally.
  if (response.status === 202 || response.status === 204 || (!response.body && response.status === 200)) {
    const resHeaders = new Headers(response.headers);
    resHeaders.set('content-type', 'application/json');
    return new Response(JSON.stringify({ jsonrpc: '2.0', result: {} }), {
      status: 200,
      headers: resHeaders,
    });
  }

  return response;
}

// Mount across all relevant routes and methods
app.all('/mcp', handleMcpRequest);
app.all('/sse', handleMcpRequest);
app.post('/', handleMcpRequest);

export default app;
