import { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './db/schema';
import { createMCPServer } from './mcp';
import { verifyUserToken, DEFAULT_DEV_JWT_SECRET } from './utils/token';

type Bindings = {
  DB: D1Database;
  JWT_SECRET?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Global CORS & preflight handling
app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version');
  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }
  await next();
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
async function extractAuthenticatedUserId(c: any): Promise<string | null> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return null;

  const secret = c.env?.JWT_SECRET || DEFAULT_DEV_JWT_SECRET;
  const user = await verifyUserToken(token, secret);
  return user ? user.userId : null;
}

// Handler for MCP requests (Stateless Streamable HTTP & SSE)
async function handleMcpRequest(c: any) {
  const secret = c.env?.JWT_SECRET || DEFAULT_DEV_JWT_SECRET;
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

// Mount on /mcp and /sse
app.all('/mcp', handleMcpRequest);
app.all('/sse', handleMcpRequest);

export default app;
