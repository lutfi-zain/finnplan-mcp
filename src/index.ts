import { Hono, type Context } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './db/schema';
import { createMCPServer } from './mcp';
import { verifyUserToken } from './utils/token';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Global Security & CORS Headers
app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version');
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
    auth: 'pure-mcp-native-jwt',
    description: 'Stateless Pure MCP Server for Eve Finance on Cloudflare Workers (D1)',
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

// Auth helper: Cryptographically verifies Bearer JWT if provided
async function extractAuthenticatedUserId(c: Context<{ Bindings: Bindings }>): Promise<string | null> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1].trim();
  const secret = c.env?.JWT_SECRET;
  if (!secret) {
    console.error('Configuration Error: JWT_SECRET binding is missing');
    return null;
  }

  const user = await verifyUserToken(token, secret);
  return user ? user.userId : null;
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

  const userId = await extractAuthenticatedUserId(c);
  const db = drizzle(c.env.DB, { schema });

  // Use stateless WebStandardStreamableHTTPServerTransport
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  const mcpServer = createMCPServer(db, userId, secret);
  await mcpServer.connect(transport);

  return transport.handleRequest(c.req.raw);
}

// Mount explicitly on allowed methods
app.post('/mcp', handleMcpRequest);
app.get('/sse', handleMcpRequest);
app.post('/sse', handleMcpRequest);

export default app;
