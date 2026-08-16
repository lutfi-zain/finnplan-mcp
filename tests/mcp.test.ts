import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '../src/db/schema';
import { createMCPServer } from '../src/mcp';
import app from '../src/index';
import {
  generateUserToken,
  verifyUserToken,
  isValidEmail,
  isValidWhatsApp,
  DEFAULT_DEV_JWT_SECRET,
} from '../src/utils/token';

// -----------------------------------------------------------------------------
// D1 Mock Implementation over node:sqlite
// -----------------------------------------------------------------------------
class MockD1Database {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  prepare(query: string) {
    return new MockD1PreparedStatement(this.db, query);
  }

  async batch(statements: MockD1PreparedStatement[]) {
    return Promise.all(statements.map(s => s.all()));
  }

  async exec(query: string) {
    this.db.exec(query);
    return { count: 0, duration: 0 };
  }
}

class MockD1PreparedStatement {
  private db: DatabaseSync;
  private query: string;
  private params: any[] = [];

  constructor(db: DatabaseSync, query: string, params: any[] = []) {
    this.db = db;
    this.query = query;
    this.params = params;
  }

  bind(...params: any[]) {
    return new MockD1PreparedStatement(this.db, this.query, params);
  }

  async all() {
    const stmt = this.db.prepare(this.query);
    const results = stmt.all(...this.params);
    return { results, success: true, meta: {} };
  }

  async get() {
    const stmt = this.db.prepare(this.query);
    const result = stmt.get(...this.params);
    return result || null;
  }

  async run() {
    const stmt = this.db.prepare(this.query);
    const info = stmt.run(...this.params);
    return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
  }

  async raw() {
    const stmt = this.db.prepare(this.query);
    return stmt.all(...this.params).map((r: any) => Object.values(r));
  }
}

function createTestDB() {
  const sqlite = new DatabaseSync(':memory:');
  const ddlPath = join(__dirname, '../drizzle/0000_real_rocket_racer.sql');
  const ddl = readFileSync(ddlPath, 'utf-8');
  const statements = ddl.split('--> statement-breakpoint');
  for (const statement of statements) {
    const trimmed = statement.trim();
    if (trimmed) {
      sqlite.exec(trimmed);
    }
  }

  const d1 = new MockD1Database(sqlite) as unknown as D1Database;
  const db = drizzle(d1, { schema });
  return { sqlite, d1, db };
}

// Helpers for direct MCP Server handler calls
async function callTool(server: any, name: string, args: Record<string, any> = {}) {
  const handler = server._requestHandlers.get('tools/call');
  return handler({
    method: 'tools/call',
    params: {
      name,
      arguments: args
    }
  });
}

async function listTools(server: any) {
  const handler = server._requestHandlers.get('tools/list');
  return handler({
    method: 'tools/list',
    params: {}
  });
}

async function listResources(server: any) {
  const handler = server._requestHandlers.get('resources/list');
  return handler({
    method: 'resources/list',
    params: {}
  });
}

async function readResource(server: any, uri: string) {
  const handler = server._requestHandlers.get('resources/read');
  return handler({
    method: 'resources/read',
    params: { uri }
  });
}

// -----------------------------------------------------------------------------
// Test Suite
// -----------------------------------------------------------------------------
describe('Eve Finance MCP Server - Pure MCP-Native Authentication Suite', () => {
  it('1. Validation Helpers (Email & WhatsApp Number)', () => {
    // Email tests
    assert.equal(isValidEmail('user@example.com'), true);
    assert.equal(isValidEmail('user.name+tag@sub.domain.co.id'), true);
    assert.equal(isValidEmail('invalid-email'), false);
    assert.equal(isValidEmail('user@'), false);
    assert.equal(isValidEmail(''), false);

    // WhatsApp tests (Must start with + and country code, then digits)
    assert.equal(isValidWhatsApp('+6281234567890'), true);
    assert.equal(isValidWhatsApp('+12025550123'), true);
    assert.equal(isValidWhatsApp('+447911123456'), true);
    assert.equal(isValidWhatsApp('081234567890'), false); // Missing +
    assert.equal(isValidWhatsApp('6281234567890'), false); // Missing +
    assert.equal(isValidWhatsApp('+012345'), false); // Invalid country code (+0)
    assert.equal(isValidWhatsApp('+62abc'), false); // Non-numeric
    assert.equal(isValidWhatsApp(''), false);
  });

  it('2. MCP Tool: register_user (Validation & Token Generation)', async () => {
    const { db } = createTestDB();
    const publicServer = createMCPServer(db, null);

    // 1. Validation error: Missing first name
    await assert.rejects(async () => {
      await callTool(publicServer, 'register_user', {
        firstName: '',
        lastName: 'Setiawan',
        email: 'budi@example.com',
        whatsappNumber: '+6281234567890'
      });
    }, /firstName.*required/i);

    // 2. Validation error: Invalid email format
    await assert.rejects(async () => {
      await callTool(publicServer, 'register_user', {
        firstName: 'Budi',
        lastName: 'Setiawan',
        email: 'invalid-email',
        whatsappNumber: '+6281234567890'
      });
    }, /invalid email format/i);

    // 3. Validation error: Invalid WhatsApp number (missing +)
    await assert.rejects(async () => {
      await callTool(publicServer, 'register_user', {
        firstName: 'Budi',
        lastName: 'Setiawan',
        email: 'budi@example.com',
        whatsappNumber: '081234567890'
      });
    }, /invalid whatsapp number format/i);

    // 4. Successful registration
    const regRes = await callTool(publicServer, 'register_user', {
      firstName: 'Budi',
      lastName: 'Setiawan',
      email: 'budi@example.com',
      whatsappNumber: '+6281234567890'
    });
    const regData = JSON.parse(regRes.content[0].text);

    assert.ok(regData.userId.startsWith('usr_'));
    assert.equal(regData.name, 'Budi Setiawan');
    assert.equal(regData.email, 'budi@example.com');
    assert.equal(regData.whatsappNumber, '+6281234567890');
    assert.ok(regData.apiKey.startsWith('fp_live_'));
    assert.ok(regData.token);
    assert.equal(regData.expiresIn, 900); // 15 minutes

    // 5. Verify token payload
    const verified = await verifyUserToken(regData.token);
    assert.equal(verified?.userId, regData.userId);
    assert.equal(verified?.name, 'Budi Setiawan');

    // 6. Duplicate registration prevention
    await assert.rejects(async () => {
      await callTool(publicServer, 'register_user', {
        firstName: 'Budi Duplicate',
        lastName: 'Setiawan',
        email: 'budi@example.com',
        whatsappNumber: '+6281234567890'
      });
    }, /already registered/i);
  });

  it('3. MCP Tool: login_user with API Key', async () => {
    const { db } = createTestDB();
    const publicServer = createMCPServer(db, null);

    // 1. Register user
    const regRes = await callTool(publicServer, 'register_user', {
      firstName: 'Siti',
      lastName: 'Aminah',
      email: 'siti@example.com',
      whatsappNumber: '+6281987654321'
    });
    const { apiKey, userId } = JSON.parse(regRes.content[0].text);

    // 2. Login with invalid API Key -> fails
    await assert.rejects(async () => {
      await callTool(publicServer, 'login_user', { apiKey: 'fp_live_invalidkey12345' });
    }, /invalid api key/i);

    // 3. Login with valid API Key -> returns fresh 15-minute token
    const loginRes = await callTool(publicServer, 'login_user', { apiKey });
    const loginData = JSON.parse(loginRes.content[0].text);

    assert.equal(loginData.userId, userId);
    assert.equal(loginData.name, 'Siti Aminah');
    assert.equal(loginData.email, 'siti@example.com');
    assert.ok(loginData.token);
    assert.equal(loginData.expiresIn, 900);

    const verified = await verifyUserToken(loginData.token);
    assert.equal(verified?.userId, userId);
  });

  it('4. Calling Finance Tools without JWT Auth is Protected', async () => {
    const { db } = createTestDB();
    const unauthServer = createMCPServer(db, null);

    // Attempting to call manage_wallet without auth -> rejected
    await assert.rejects(async () => {
      await callTool(unauthServer, 'manage_wallet', { action: 'list' });
    }, /unauthorized.*login_user/i);

    // Attempting to call record_transaction without auth -> rejected
    await assert.rejects(async () => {
      await callTool(unauthServer, 'record_transaction', {
        walletId: 1,
        categoryId: 1,
        amount: 50000
      });
    }, /unauthorized.*login_user/i);
  });

  it('5. Finance Tools Execution with Valid 15-Minute JWT Session', async () => {
    const { db } = createTestDB();
    const publicServer = createMCPServer(db, null);

    // Register user Alice
    const regRes = await callTool(publicServer, 'register_user', {
      firstName: 'Alice',
      lastName: 'Wonderland',
      email: 'alice@example.com',
      whatsappNumber: '+6281112223334'
    });
    const { userId } = JSON.parse(regRes.content[0].text);

    // Create authenticated server instance for Alice
    const authServer = createMCPServer(db, userId);

    // 1. Create Wallets
    const wBca = JSON.parse((await callTool(authServer, 'manage_wallet', {
      action: 'create',
      name: 'BCA Main',
      balance: 10000000
    })).content[0].text);
    assert.equal(wBca.name, 'BCA Main');
    assert.equal(wBca.balance, 10000000);

    // 2. Create Categories
    const cFood = JSON.parse((await callTool(authServer, 'manage_category', {
      action: 'create',
      name: 'Food & Dining',
      type: 'expense'
    })).content[0].text);

    const cSalary = JSON.parse((await callTool(authServer, 'manage_category', {
      action: 'create',
      name: 'Monthly Salary',
      type: 'income'
    })).content[0].text);

    // 3. Create Budget
    const bAugust = JSON.parse((await callTool(authServer, 'manage_budget', {
      action: 'create',
      name: 'August Food Budget',
      categoryId: cFood.id,
      amount: 2000000,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31'
    })).content[0].text);

    // 4. Record Expense (deducts balance)
    await callTool(authServer, 'record_transaction', {
      walletId: wBca.id,
      categoryId: cFood.id,
      budgetId: bAugust.id,
      amount: 500000,
      type: 'expense',
      transactionDate: '2026-08-10'
    });

    // 5. Record Income (adds balance)
    await callTool(authServer, 'record_transaction', {
      walletId: wBca.id,
      categoryId: cSalary.id,
      amount: 15000000,
      type: 'income',
      transactionDate: '2026-08-01'
    });

    // 6. Record Planned Expense (does NOT alter balance)
    await callTool(authServer, 'record_transaction', {
      walletId: wBca.id,
      categoryId: cFood.id,
      amount: 300000,
      type: 'expense',
      isPlanned: true,
      transactionDate: '2026-08-20'
    });

    // Check Wallet Balance: 10M - 500K + 15M = 24.5M
    const walletCheck = await db.select().from(schema.wallets).where(eq(schema.wallets.id, wBca.id)).get();
    assert.equal(walletCheck?.balance, 24500000);

    // Check Budget Status: 500K spent out of 2M (25%)
    const budgetStatus = JSON.parse((await callTool(authServer, 'manage_budget', { action: 'status' })).content[0].text);
    assert.equal(budgetStatus[0].spent, 500000);
    assert.equal(budgetStatus[0].remaining, 1500000);
    assert.equal(budgetStatus[0].percentUsed, 25);

    // Financial Summary
    const summary = JSON.parse((await callTool(authServer, 'financial_summary', {})).content[0].text);
    assert.equal(summary.netWorth, 24500000);
    assert.equal(summary.totalIncome, 15000000);
    assert.equal(summary.totalExpense, 500000);
    assert.equal(summary.netSavings, 14500000);
  });

  it('6. Multi-Tenant Row Level Security (RLS) Isolation', async () => {
    const { db } = createTestDB();
    const publicServer = createMCPServer(db, null);

    // Register User 1 (Alpha)
    const user1 = JSON.parse((await callTool(publicServer, 'register_user', {
      firstName: 'Alpha',
      lastName: 'User',
      email: 'alpha@example.com',
      whatsappNumber: '+628111111111'
    })).content[0].text);

    // Register User 2 (Beta)
    const user2 = JSON.parse((await callTool(publicServer, 'register_user', {
      firstName: 'Beta',
      lastName: 'User',
      email: 'beta@example.com',
      whatsappNumber: '+628222222222'
    })).content[0].text);

    const serverAlpha = createMCPServer(db, user1.userId);
    const serverBeta = createMCPServer(db, user2.userId);

    // Alpha creates wallet
    const alphaWallet = JSON.parse((await callTool(serverAlpha, 'manage_wallet', {
      action: 'create',
      name: 'Alpha Secret Bank',
      balance: 9999999
    })).content[0].text);

    // Beta lists wallets -> MUST BE EMPTY
    const betaWallets = JSON.parse((await callTool(serverBeta, 'manage_wallet', { action: 'list' })).content[0].text);
    assert.equal(betaWallets.length, 0);

    // Beta attempts to update Alpha's wallet -> MUST FAIL
    await assert.rejects(async () => {
      await callTool(serverBeta, 'manage_wallet', { action: 'update', walletId: alphaWallet.id, balance: 0 });
    }, /not found or unauthorized/i);
  });

  it('7. MCP Resources Access with User Session', async () => {
    const { db } = createTestDB();
    const publicServer = createMCPServer(db, null);

    const user = JSON.parse((await callTool(publicServer, 'register_user', {
      firstName: 'Resource',
      lastName: 'Tester',
      email: 'resource@example.com',
      whatsappNumber: '+628333333333'
    })).content[0].text);

    const authServer = createMCPServer(db, user.userId);

    // List resources
    const resourcesList = await listResources(authServer);
    assert.equal(resourcesList.resources.length, 3);

    // Read schema
    const schemaRes = await readResource(authServer, 'finance://db/schema');
    const schemaJson = JSON.parse(schemaRes.contents[0].text);
    assert.ok(schemaJson.tables.users.includes('whatsapp_number'));
    assert.ok(schemaJson.tables.wallets);
  });

  it('8. Pure MCP End-to-End Lifecycle over HTTP POST /mcp', async () => {
    const { d1 } = createTestDB();
    const env = {
      DB: d1,
      JWT_SECRET: 'super-custom-production-mcp-secret'
    };

    // 1. List tools without any Authorization header (Public tools accessible)
    const listRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2024-11-05'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      })
    }, env);

    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    const toolNames = listJson.result.tools.map((t: any) => t.name);
    assert.ok(toolNames.includes('register_user'));
    assert.ok(toolNames.includes('login_user'));
    assert.ok(toolNames.includes('manage_wallet'));

    // 2. Register User via MCP Tool over HTTP
    const regMcpRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2024-11-05'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'register_user',
          arguments: {
            firstName: 'EndToEnd',
            lastName: 'Tester',
            email: 'e2e@example.com',
            whatsappNumber: '+628999888777'
          }
        }
      })
    }, env);

    assert.equal(regMcpRes.status, 200);
    const regPayload = JSON.parse((await regMcpRes.json()).result.content[0].text);
    assert.ok(regPayload.token);
    assert.ok(regPayload.apiKey);

    const initialToken = regPayload.token;
    const apiKey = regPayload.apiKey;

    // 3. Call manage_wallet using the 15-minute JWT in Bearer header
    const createWalletRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${initialToken}`,
        'MCP-Protocol-Version': '2024-11-05'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'manage_wallet',
          arguments: {
            action: 'create',
            name: 'E2E Bank',
            balance: 5000000
          }
        }
      })
    }, env);

    assert.equal(createWalletRes.status, 200);
    const createdWallet = JSON.parse((await createWalletRes.json()).result.content[0].text);
    assert.equal(createdWallet.name, 'E2E Bank');
    assert.equal(createdWallet.balance, 5000000);

    // 4. Simulate Token Expiration -> Call manage_wallet with expired token -> returns MCP Tool Error
    const expiredToken = await generateUserToken({ userId: regPayload.userId, expiresInSeconds: -5 }, env.JWT_SECRET);
    const expiredCallRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${expiredToken}`,
        'MCP-Protocol-Version': '2024-11-05'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'manage_wallet',
          arguments: { action: 'list' }
        }
      })
    }, env);

    assert.equal(expiredCallRes.status, 200);
    const expiredCallJson = await expiredCallRes.json();
    assert.ok(expiredCallJson.error || expiredCallJson.result?.isError);
    const errMsg = expiredCallJson.error?.message || expiredCallJson.result?.content?.[0]?.text;
    assert.match(errMsg, /unauthorized|login_user/i);

    // 5. Re-Login via login_user MCP Tool using API Key to obtain new token
    const loginMcpRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2024-11-05'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'login_user',
          arguments: { apiKey }
        }
      })
    }, env);

    assert.equal(loginMcpRes.status, 200);
    const freshTokenPayload = JSON.parse((await loginMcpRes.json()).result.content[0].text);
    assert.ok(freshTokenPayload.token);
    assert.equal(freshTokenPayload.expiresIn, 900);

    // 6. Resume calling manage_wallet with the fresh token
    const resumeCallRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${freshTokenPayload.token}`,
        'MCP-Protocol-Version': '2024-11-05'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'manage_wallet',
          arguments: { action: 'list' }
        }
      })
    }, env);

    assert.equal(resumeCallRes.status, 200);
    const resumedWallets = JSON.parse((await resumeCallRes.json()).result.content[0].text);
    assert.equal(resumedWallets.length, 1);
    assert.equal(resumedWallets[0].name, 'E2E Bank');
  });
});
