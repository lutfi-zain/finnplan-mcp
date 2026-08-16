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
  hashApiKey,
} from '../src/utils/token';

const TEST_JWT_SECRET = 'super-secure-test-jwt-secret-1234567890';

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
    return Promise.all(statements.map((s) => s.all()));
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
  const ddlPath = join(__dirname, '../drizzle/0000_remarkable_quasar.sql');
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
      arguments: args,
    },
  });
}

async function listResources(server: any) {
  const handler = server._requestHandlers.get('resources/list');
  return handler({
    method: 'resources/list',
    params: {},
  });
}

async function readResource(server: any, uri: string) {
  const handler = server._requestHandlers.get('resources/read');
  return handler({
    method: 'resources/read',
    params: { uri },
  });
}

// -----------------------------------------------------------------------------
// Test Suite
// -----------------------------------------------------------------------------
describe('Eve Finance MCP Server - Hardened Security & Best Practice Suite', () => {
  it('1. Validation Helpers (Email, WhatsApp, SHA-256 API Key Hashing)', async () => {
    // Email tests
    assert.equal(isValidEmail('user@example.com'), true);
    assert.equal(isValidEmail('user.name+tag@sub.domain.co.id'), true);
    assert.equal(isValidEmail('invalid-email'), false);
    assert.equal(isValidEmail('user@'), false);
    assert.equal(isValidEmail(''), false);

    // WhatsApp tests (Must start with + and country code, then digits)
    assert.equal(isValidWhatsApp('+6281234567890'), true);
    assert.equal(isValidWhatsApp('+12025550123'), true);
    assert.equal(isValidWhatsApp('081234567890'), false);
    assert.equal(isValidWhatsApp(''), false);

    // SHA-256 Hash tests
    const key = 'fp_live_abcdef1234567890';
    const hash1 = await hashApiKey(key);
    const hash2 = await hashApiKey(key);
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64);
  });

  it('2. MCP Tool: register_user (Strict Validation, SHA-256 Hash Storage, Token)', async () => {
    const { db } = createTestDB();
    const publicServer = createMCPServer(db, null, TEST_JWT_SECRET);

    // 1. Validation error: Missing first name
    await assert.rejects(async () => {
      await callTool(publicServer, 'register_user', {
        firstName: '',
        lastName: 'Setiawan',
        email: 'budi@example.com',
        whatsappNumber: '+6281234567890',
      });
    }, /firstName.*required/i);

    // 2. Validation error: Invalid email format
    await assert.rejects(async () => {
      await callTool(publicServer, 'register_user', {
        firstName: 'Budi',
        lastName: 'Setiawan',
        email: 'invalid-email',
        whatsappNumber: '+6281234567890',
      });
    }, /invalid email format/i);

    // 3. Validation error: Invalid WhatsApp number (missing +)
    await assert.rejects(async () => {
      await callTool(publicServer, 'register_user', {
        firstName: 'Budi',
        lastName: 'Setiawan',
        email: 'budi@example.com',
        whatsappNumber: '081234567890',
      });
    }, /invalid whatsapp number format/i);

    // 4. Successful registration
    const regRes = await callTool(publicServer, 'register_user', {
      firstName: 'Budi',
      lastName: 'Setiawan',
      email: 'budi@example.com',
      whatsappNumber: '+6281234567890',
    });
    const regData = JSON.parse(regRes.content[0].text);

    assert.ok(regData.userId.startsWith('usr_'));
    assert.equal(regData.name, 'Budi Setiawan');
    assert.equal(regData.email, 'budi@example.com');
    assert.equal(regData.whatsappNumber, '+6281234567890');
    assert.ok(regData.apiKey.startsWith('fp_live_'));
    assert.ok(regData.token);
    assert.equal(regData.expiresIn, 900); // 15 minutes

    // 5. Verify API key in DB is hashed, NOT plaintext!
    const userInDb = await db.select().from(schema.users).where(eq(schema.users.id, regData.userId)).get();
    assert.ok(userInDb?.apiKeyHash);
    assert.notEqual(userInDb?.apiKeyHash, regData.apiKey);
    const expectedHash = await hashApiKey(regData.apiKey);
    assert.equal(userInDb?.apiKeyHash, expectedHash);

    // 6. Verify token signature with issuer and audience
    const verified = await verifyUserToken(regData.token, TEST_JWT_SECRET);
    assert.equal(verified?.userId, regData.userId);
    assert.equal(verified?.name, 'Budi Setiawan');

    // 7. Duplicate registration rejection
    await assert.rejects(async () => {
      await callTool(publicServer, 'register_user', {
        firstName: 'Budi Duplicate',
        lastName: 'Setiawan',
        email: 'budi@example.com',
        whatsappNumber: '+6281234567890',
      });
    }, /already registered/i);
  });

  it('3. MCP Tool: login_user with SHA-256 Hashed API Key Lookup', async () => {
    const { db } = createTestDB();
    const publicServer = createMCPServer(db, null, TEST_JWT_SECRET);

    // 1. Register user
    const regRes = await callTool(publicServer, 'register_user', {
      firstName: 'Siti',
      lastName: 'Aminah',
      email: 'siti@example.com',
      whatsappNumber: '+6281987654321',
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

    const verified = await verifyUserToken(loginData.token, TEST_JWT_SECRET);
    assert.equal(verified?.userId, userId);
  });

  it('4. Robust Number & NaN Validations', async () => {
    const { db } = createTestDB();
    const publicServer = createMCPServer(db, null, TEST_JWT_SECRET);
    const regRes = await callTool(publicServer, 'register_user', {
      firstName: 'Number',
      lastName: 'Tester',
      email: 'num@example.com',
      whatsappNumber: '+628111111111',
    });
    const { userId } = JSON.parse(regRes.content[0].text);
    const authServer = createMCPServer(db, userId, TEST_JWT_SECRET);

    const wallet = JSON.parse((await callTool(authServer, 'manage_wallet', {
      action: 'create',
      name: 'Test Bank',
      balance: 1000000,
    })).content[0].text);

    const category = JSON.parse((await callTool(authServer, 'manage_category', {
      action: 'create',
      name: 'Food',
      type: 'expense',
    })).content[0].text);

    // NaN amount rejection in record_transaction
    await assert.rejects(async () => {
      await callTool(authServer, 'record_transaction', {
        walletId: wallet.id,
        categoryId: category.id,
        amount: NaN,
      });
    }, /positive finite number/i);

    // Negative amount rejection
    await assert.rejects(async () => {
      await callTool(authServer, 'record_transaction', {
        walletId: wallet.id,
        categoryId: category.id,
        amount: -50000,
      });
    }, /positive finite number/i);

    // NaN amount rejection in manage_budget
    await assert.rejects(async () => {
      await callTool(authServer, 'manage_budget', {
        action: 'create',
        name: 'Bad Budget',
        amount: NaN,
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
      });
    }, /positive finite number/i);

    // Invalid date order in manage_budget
    await assert.rejects(async () => {
      await callTool(authServer, 'manage_budget', {
        action: 'create',
        name: 'Inverted Dates',
        amount: 100000,
        periodStart: '2026-08-31',
        periodEnd: '2026-08-01',
      });
    }, /periodStart.*after.*periodEnd/i);
  });

  it('5. Atomic Balance Updates, Budget Status Logic, Multi-Currency Summary & Offset Pagination', async () => {
    const { db } = createTestDB();
    const publicServer = createMCPServer(db, null, TEST_JWT_SECRET);

    const regRes = await callTool(publicServer, 'register_user', {
      firstName: 'Alice',
      lastName: 'Wonderland',
      email: 'alice@example.com',
      whatsappNumber: '+6281112223334',
    });
    const { userId } = JSON.parse(regRes.content[0].text);
    const authServer = createMCPServer(db, userId, TEST_JWT_SECRET);

    // 1. Create IDR and USD wallets
    const wBca = JSON.parse((await callTool(authServer, 'manage_wallet', {
      action: 'create',
      name: 'BCA Main',
      balance: 10000000,
      currency: 'IDR',
    })).content[0].text);

    const wUsd = JSON.parse((await callTool(authServer, 'manage_wallet', {
      action: 'create',
      name: 'Wise USD',
      balance: 500,
      currency: 'USD',
    })).content[0].text);

    // 2. Create Categories
    const cFood = JSON.parse((await callTool(authServer, 'manage_category', {
      action: 'create',
      name: 'Food',
      type: 'expense',
    })).content[0].text);

    const cSalary = JSON.parse((await callTool(authServer, 'manage_category', {
      action: 'create',
      name: 'Salary',
      type: 'income',
    })).content[0].text);

    // 3. Create Budget for Food
    const bAugust = JSON.parse((await callTool(authServer, 'manage_budget', {
      action: 'create',
      name: 'August Food',
      categoryId: cFood.id,
      amount: 2000000,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
    })).content[0].text);

    // 4. Record Expense (Food: Rp 500K) -> updates balance atomically
    await callTool(authServer, 'record_transaction', {
      walletId: wBca.id,
      categoryId: cFood.id,
      budgetId: bAugust.id,
      amount: 500000,
      type: 'expense',
      transactionDate: '2026-08-10',
    });

    // 5. Record Income into Food category (e.g. cashback) -> must NOT count towards budget spending!
    await callTool(authServer, 'record_transaction', {
      walletId: wBca.id,
      categoryId: cFood.id,
      amount: 100000,
      type: 'income',
      transactionDate: '2026-08-11',
    });

    // 6. Record Salary Income
    await callTool(authServer, 'record_transaction', {
      walletId: wBca.id,
      categoryId: cSalary.id,
      amount: 15000000,
      type: 'income',
      transactionDate: '2026-08-01',
    });

    // Check Budget Status: Only the 500K expense should be counted (25%), NOT the 100K income!
    const budgetStatus = JSON.parse((await callTool(authServer, 'manage_budget', { action: 'status' })).content[0].text);
    assert.equal(budgetStatus[0].spent, 500000);
    assert.equal(budgetStatus[0].remaining, 1500000);
    assert.equal(budgetStatus[0].percentUsed, 25);

    // Check Financial Summary: Grouped by currency!
    const summary = JSON.parse((await callTool(authServer, 'financial_summary', {})).content[0].text);
    assert.equal(summary.netWorthByCurrency.IDR, 24600000); // 10M - 500K + 100K + 15M
    assert.equal(summary.netWorthByCurrency.USD, 500);
    assert.equal(summary.totalIncome, 15100000); // 15M + 100K
    assert.equal(summary.totalExpense, 500000);

    // Test Offset Pagination
    const page1 = JSON.parse((await callTool(authServer, 'list_transactions', { limit: 1, offset: 0 })).content[0].text);
    const page2 = JSON.parse((await callTool(authServer, 'list_transactions', { limit: 1, offset: 1 })).content[0].text);
    assert.equal(page1.length, 1);
    assert.equal(page2.length, 1);
    assert.notEqual(page1[0].id, page2[0].id);
  });

  it('6. Multi-Tenant Row Level Security (RLS) Isolation', async () => {
    const { db } = createTestDB();
    const publicServer = createMCPServer(db, null, TEST_JWT_SECRET);

    const user1 = JSON.parse((await callTool(publicServer, 'register_user', {
      firstName: 'Alpha',
      lastName: 'User',
      email: 'alpha@example.com',
      whatsappNumber: '+628111111111',
    })).content[0].text);

    const user2 = JSON.parse((await callTool(publicServer, 'register_user', {
      firstName: 'Beta',
      lastName: 'User',
      email: 'beta@example.com',
      whatsappNumber: '+628222222222',
    })).content[0].text);

    const serverAlpha = createMCPServer(db, user1.userId, TEST_JWT_SECRET);
    const serverBeta = createMCPServer(db, user2.userId, TEST_JWT_SECRET);

    const alphaWallet = JSON.parse((await callTool(serverAlpha, 'manage_wallet', {
      action: 'create',
      name: 'Alpha Secret Bank',
      balance: 9999999,
    })).content[0].text);

    const betaWallets = JSON.parse((await callTool(serverBeta, 'manage_wallet', { action: 'list' })).content[0].text);
    assert.equal(betaWallets.length, 0);

    await assert.rejects(async () => {
      await callTool(serverBeta, 'manage_wallet', { action: 'update', walletId: alphaWallet.id, balance: 0 });
    }, /not found or unauthorized/i);
  });

  it('7. MCP Resources Access with User Session', async () => {
    const { db } = createTestDB();
    const publicServer = createMCPServer(db, null, TEST_JWT_SECRET);

    const user = JSON.parse((await callTool(publicServer, 'register_user', {
      firstName: 'Resource',
      lastName: 'Tester',
      email: 'resource@example.com',
      whatsappNumber: '+628333333333',
    })).content[0].text);

    const authServer = createMCPServer(db, user.userId, TEST_JWT_SECRET);

    const resourcesList = await listResources(authServer);
    assert.equal(resourcesList.resources.length, 3);

    const schemaRes = await readResource(authServer, 'finance://db/schema');
    const schemaJson = JSON.parse(schemaRes.contents[0].text);
    assert.ok(schemaJson.tables.users.includes('api_key_hash (UNIQUE)'));
    assert.ok(schemaJson.indexes.transactions);
  });

  it('8. Hardened HTTP POST /mcp and Security Headers', async () => {
    const { d1 } = createTestDB();
    const env = {
      DB: d1,
      JWT_SECRET: TEST_JWT_SECRET,
    };

    // 1. Health check returns security headers
    const healthRes = await app.request('/health', {}, env);
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(healthRes.headers.get('X-Frame-Options'), 'DENY');

    // 2. Register User via MCP Tool over HTTP
    const regMcpRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2024-11-05',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'register_user',
          arguments: {
            firstName: 'EndToEnd',
            lastName: 'Tester',
            email: 'e2e@example.com',
            whatsappNumber: '+628999888777',
          },
        },
      }),
    }, env);

    assert.equal(regMcpRes.status, 200);
    const regPayload = JSON.parse((await regMcpRes.json()).result.content[0].text);
    assert.ok(regPayload.token);
    assert.ok(regPayload.apiKey);

    // 3. Call manage_wallet using Bearer token
    const createWalletRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${regPayload.token}`,
        'MCP-Protocol-Version': '2024-11-05',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'manage_wallet',
          arguments: {
            action: 'create',
            name: 'E2E Bank',
            balance: 5000000,
          },
        },
      }),
    }, env);

    assert.equal(createWalletRes.status, 200);
    const createdWallet = JSON.parse((await createWalletRes.json()).result.content[0].text);
    assert.equal(createdWallet.name, 'E2E Bank');
    assert.equal(createdWallet.balance, 5000000);
  });
});
