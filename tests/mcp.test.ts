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
  sqlite.exec('PRAGMA foreign_keys = ON;');
  const migrationFiles = ['0002_table_prefixed_schema_and_tz.sql'];
  for (const file of migrationFiles) {
    const ddlPath = join(__dirname, `../drizzle/${file}`);
    const ddl = readFileSync(ddlPath, 'utf-8');
    const statements = ddl.split('--> statement-breakpoint');
    for (const statement of statements) {
      const trimmed = statement.trim();
      if (trimmed) {
        sqlite.exec(trimmed);
      }
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

async function listTools(server: any) {
  const handler = server._requestHandlers.get('tools/list');
  return handler({ method: 'tools/list' });
}

async function listResources(server: any) {
  const handler = server._requestHandlers.get('resources/list');
  return handler({ method: 'resources/list' });
}

async function readResource(server: any, uri: string) {
  const handler = server._requestHandlers.get('resources/read');
  return handler({
    method: 'resources/read',
    params: { uri },
  });
}

// =============================================================================
// Test Suites
// =============================================================================
describe('Eve Finance MCP Server — Complete Test Suite', () => {
  it('1. Token Utility: Sign, Verify, Claims, and Expiration', async () => {
    const payload = {
      userId: 'usr_ms83df92_8f293847',
      name: 'Lutfi Zain',
      email: 'lutfi@example.com',
      expiresInSeconds: 900,
    };

    const token = await generateUserToken(payload, TEST_JWT_SECRET);
    assert.ok(typeof token === 'string' && token.length > 20);

    const verified = await verifyUserToken(token, TEST_JWT_SECRET);
    assert.ok(verified !== null);
    assert.equal(verified?.userId, payload.userId);
    assert.equal(verified?.name, payload.name);
    assert.equal(verified?.email, payload.email);

    // Invalid secret verification
    const invalidSig = await verifyUserToken(token, 'wrong-secret-key-1234567890');
    assert.equal(invalidSig, null);

    // Expired token verification
    const expiredToken = await generateUserToken({ ...payload, expiresInSeconds: -10 }, TEST_JWT_SECRET);
    const expiredResult = await verifyUserToken(expiredToken, TEST_JWT_SECRET);
    assert.equal(expiredResult, null);

    // Email & WhatsApp Validators
    assert.equal(isValidEmail('user@test.com'), true);
    assert.equal(isValidEmail('invalid-email'), false);
    assert.equal(isValidWhatsApp('+6281234567890'), true);
    assert.equal(isValidWhatsApp('081234567890'), false); // Missing '+' and country code
  });

  it('2. MCP Tool: register_user with Server-Side UUID and SHA-256 API Key', async () => {
    const { db } = createTestDB();
    const publicServer = createMCPServer(db, null, TEST_JWT_SECRET);

    const toolsList = await listTools(publicServer);
    assert.ok(toolsList.tools.some((t: any) => t.name === 'register_user'));
    assert.ok(toolsList.tools.some((t: any) => t.name === 'login_user'));
    assert.ok(toolsList.tools.some((t: any) => t.name === 'manage_wallet'));

    // 1. First name validation
    await assert.rejects(async () => {
      await callTool(publicServer, 'register_user', {
        firstName: '',
        lastName: 'Setiawan',
        email: 'budi@example.com',
        whatsappNumber: '+6281234567890',
      });
    }, /firstName/i);

    // 2. Email format validation
    await assert.rejects(async () => {
      await callTool(publicServer, 'register_user', {
        firstName: 'Budi',
        lastName: 'Setiawan',
        email: 'invalid-email',
        whatsappNumber: '+6281234567890',
      });
    }, /invalid email/i);

    // 3. WhatsApp format validation
    await assert.rejects(async () => {
      await callTool(publicServer, 'register_user', {
        firstName: 'Budi',
        lastName: 'Setiawan',
        email: 'budi@example.com',
        whatsappNumber: '081234567890',
      });
    }, /invalid whatsapp/i);

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
    const userInDb = await db.select().from(schema.users).where(eq(schema.users.userId, regData.userId)).get();
    assert.ok(userInDb?.userApiKeyHash);
    assert.notEqual(userInDb?.userApiKeyHash, regData.apiKey);
    const expectedHash = await hashApiKey(regData.apiKey);
    assert.equal(userInDb?.userApiKeyHash, expectedHash);

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

  it('4. Robust Number, NaN, and UUID Validations', async () => {
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
      institution: 'BCA',
      balance: 1000000,
    })).content[0].text);

    assert.equal(typeof wallet.walletId, 'string', 'Wallet ID must be a string UUID');
    assert.equal(wallet.walletId.length, 36, 'Wallet ID must be 36 characters (UUID v4)');
    assert.equal(wallet.walletInstitution, 'BCA');

    const category = JSON.parse((await callTool(authServer, 'manage_category', {
      action: 'create',
      name: 'Food',
      type: 'expense',
    })).content[0].text);

    assert.equal(typeof category.categoryId, 'string', 'Category ID must be a string UUID');
    assert.equal(category.categoryId.length, 36, 'Category ID must be 36 characters (UUID v4)');

    // NaN amount rejection in record_transaction
    await assert.rejects(async () => {
      await callTool(authServer, 'record_transaction', {
        walletId: wallet.walletId,
        categoryId: category.categoryId,
        amount: NaN,
      });
    }, /positive finite number/i);

    // Negative amount rejection
    await assert.rejects(async () => {
      await callTool(authServer, 'record_transaction', {
        walletId: wallet.walletId,
        categoryId: category.categoryId,
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

  it('5. Atomic Balance Updates, UUID Keys, Budget Status Logic, Multi-Currency Summary & Offset Pagination', async () => {
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

    // 1. Create IDR and USD wallets (UUID generated)
    const wBca = JSON.parse((await callTool(authServer, 'manage_wallet', {
      action: 'create',
      name: 'BCA Main',
      institution: 'BCA',
      balance: 10000000,
      currency: 'IDR',
    })).content[0].text);
    assert.equal(typeof wBca.walletId, 'string');
    assert.equal(wBca.walletInstitution, 'BCA');

    const wUsd = JSON.parse((await callTool(authServer, 'manage_wallet', {
      action: 'create',
      name: 'Wise USD',
      institution: 'Wise',
      balance: 500,
      currency: 'USD',
    })).content[0].text);
    assert.equal(typeof wUsd.walletId, 'string');
    assert.equal(wUsd.walletInstitution, 'Wise');

    // 2. Create Categories
    const cFood = JSON.parse((await callTool(authServer, 'manage_category', {
      action: 'create',
      name: 'Food',
      type: 'expense',
    })).content[0].text);
    assert.equal(typeof cFood.categoryId, 'string');

    const cSalary = JSON.parse((await callTool(authServer, 'manage_category', {
      action: 'create',
      name: 'Salary',
      type: 'income',
    })).content[0].text);
    assert.equal(typeof cSalary.categoryId, 'string');

    // 3. Create Budget for Food
    const bAugust = JSON.parse((await callTool(authServer, 'manage_budget', {
      action: 'create',
      name: 'August Food',
      categoryId: cFood.categoryId,
      amount: 2000000,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
    })).content[0].text);
    assert.equal(typeof bAugust.budgetId, 'string');

    // 4. Record Expense (Food: Rp 500K) -> updates balance atomically
    const tx1 = JSON.parse((await callTool(authServer, 'record_transaction', {
      walletId: wBca.walletId,
      categoryId: cFood.categoryId,
      budgetId: bAugust.budgetId,
      amount: 500000,
      type: 'expense',
      transactionDate: '2026-08-10',
    })).content[0].text);
    assert.equal(typeof tx1.transactionId, 'string');

    // 5. Record Income into Food category (e.g. cashback) -> must NOT count towards budget spending!
    await callTool(authServer, 'record_transaction', {
      walletId: wBca.walletId,
      categoryId: cFood.categoryId,
      amount: 100000,
      type: 'income',
      transactionDate: '2026-08-11',
    });

    // 6. Record Salary Income
    await callTool(authServer, 'record_transaction', {
      walletId: wBca.walletId,
      categoryId: cSalary.categoryId,
      amount: 15000000,
      type: 'income',
      transactionDate: '2026-08-01',
    });

    // Check Budget Status: Only the 500K expense should be counted (25%), NOT the 100K income!
    const budgetStatus = JSON.parse((await callTool(authServer, 'manage_budget', { action: 'status' })).content[0].text);
    assert.equal(budgetStatus[0].spent, 500000);
    assert.equal(budgetStatus[0].remaining, 1500000);
    assert.equal(budgetStatus[0].percentUsed, 25);

    // Check Financial Summary: Grouped by currency & institution!
    const summary = JSON.parse((await callTool(authServer, 'financial_summary', {})).content[0].text);
    assert.equal(summary.netWorthByCurrency.IDR, 24600000); // 10M - 500K + 100K + 15M
    assert.equal(summary.netWorthByCurrency.USD, 500);
    assert.equal(summary.netWorthByInstitution.BCA, 24600000);
    assert.equal(summary.netWorthByInstitution.Wise, 500);
    assert.equal(summary.totalIncome, 15100000); // 15M + 100K
    assert.equal(summary.totalExpense, 500000);

    // Test Offset Pagination
    const page1 = JSON.parse((await callTool(authServer, 'list_transactions', { limit: 1, offset: 0 })).content[0].text);
    const page2 = JSON.parse((await callTool(authServer, 'list_transactions', { limit: 1, offset: 1 })).content[0].text);
    assert.equal(page1.length, 1);
    assert.equal(page2.length, 1);
    assert.notEqual(page1[0].transactionId, page2[0].transactionId);
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
      await callTool(serverBeta, 'manage_wallet', { action: 'update', walletId: alphaWallet.walletId, balance: 0 });
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
    assert.ok(schemaJson.tables.users.includes('user_id (PK UUID)'));
    assert.ok(schemaJson.tables.wallets.includes('wallet_id (PK UUID)'));
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
    assert.equal(createdWallet.walletName, 'E2E Bank');
    assert.equal(createdWallet.walletBalance, 5000000);
    assert.equal(typeof createdWallet.walletId, 'string', 'Wallet ID should be a string UUID');
  });

  it('9. Pure Database-Level ON DELETE CASCADE Verification', async () => {
    const { db } = createTestDB();
    const publicServer = createMCPServer(db, null, TEST_JWT_SECRET);

    // Register User A
    const userARes = await callTool(publicServer, 'register_user', {
      firstName: 'Cascade',
      lastName: 'UserA',
      email: 'cascade_a@example.com',
      whatsappNumber: '+62811111111',
    });
    const { userId: userAId } = JSON.parse(userARes.content[0].text);
    const serverA = createMCPServer(db, userAId, TEST_JWT_SECRET);

    // Register User B
    const userBRes = await callTool(publicServer, 'register_user', {
      firstName: 'Cascade',
      lastName: 'UserB',
      email: 'cascade_b@example.com',
      whatsappNumber: '+62822222222',
    });
    const { userId: userBId } = JSON.parse(userBRes.content[0].text);
    const serverB = createMCPServer(db, userBId, TEST_JWT_SECRET);

    // Populate User A data (Wallet, Category, Budget, Transaction)
    const walletA = JSON.parse((await callTool(serverA, 'manage_wallet', { action: 'create', name: 'Wallet A', balance: 500000 })).content[0].text);
    const catA = JSON.parse((await callTool(serverA, 'manage_category', { action: 'create', name: 'Cat A', type: 'expense' })).content[0].text);
    const budgetA = JSON.parse((await callTool(serverA, 'manage_budget', { action: 'create', name: 'Budget A', categoryId: catA.categoryId, amount: 100000, periodStart: '2026-08-01', periodEnd: '2026-08-31' })).content[0].text);
    await callTool(serverA, 'record_transaction', { walletId: walletA.walletId, categoryId: catA.categoryId, budgetId: budgetA.budgetId, amount: 50000, type: 'expense' });

    // Populate User B data
    const walletB = JSON.parse((await callTool(serverB, 'manage_wallet', { action: 'create', name: 'Wallet B', balance: 200000 })).content[0].text);
    const catB = JSON.parse((await callTool(serverB, 'manage_category', { action: 'create', name: 'Cat B', type: 'expense' })).content[0].text);
    const budgetB = JSON.parse((await callTool(serverB, 'manage_budget', { action: 'create', name: 'Budget B', categoryId: catB.categoryId, amount: 50000, periodStart: '2026-08-01', periodEnd: '2026-08-31' })).content[0].text);
    await callTool(serverB, 'record_transaction', { walletId: walletB.walletId, categoryId: catB.categoryId, budgetId: budgetB.budgetId, amount: 25000, type: 'expense' });

    // Verify User A records exist
    assert.equal((await db.select().from(schema.wallets).where(eq(schema.wallets.walletUserId, userAId))).length, 1);
    assert.equal((await db.select().from(schema.categories).where(eq(schema.categories.categoryUserId, userAId))).length, 1);
    assert.equal((await db.select().from(schema.budgets).where(eq(schema.budgets.budgetUserId, userAId))).length, 1);
    assert.equal((await db.select().from(schema.transactions).where(eq(schema.transactions.transactionUserId, userAId))).length, 1);

    // Execute pure database-level DELETE on users table
    await db.delete(schema.users).where(eq(schema.users.userId, userAId));

    // Assert User A record is deleted
    const deletedUserA = await db.select().from(schema.users).where(eq(schema.users.userId, userAId)).get();
    assert.equal(deletedUserA, undefined);

    // Assert all User A child data automatically cascade-deleted by SQLite foreign keys
    assert.equal((await db.select().from(schema.wallets).where(eq(schema.wallets.walletUserId, userAId))).length, 0);
    assert.equal((await db.select().from(schema.categories).where(eq(schema.categories.categoryUserId, userAId))).length, 0);
    assert.equal((await db.select().from(schema.budgets).where(eq(schema.budgets.budgetUserId, userAId))).length, 0);
    assert.equal((await db.select().from(schema.transactions).where(eq(schema.transactions.transactionUserId, userAId))).length, 0);

    // Assert User B records remain 100% untouched
    assert.equal((await db.select().from(schema.wallets).where(eq(schema.wallets.walletUserId, userBId))).length, 1);
    assert.equal((await db.select().from(schema.categories).where(eq(schema.categories.categoryUserId, userBId))).length, 1);
    assert.equal((await db.select().from(schema.budgets).where(eq(schema.budgets.budgetUserId, userBId))).length, 1);
    assert.equal((await db.select().from(schema.transactions).where(eq(schema.transactions.transactionUserId, userBId))).length, 1);
  });

  it('10. Dual-Layer Authorization: Bearer API Key, X-API-Key, and In-Tool Parameter Fallback', async () => {
    const { d1, db } = createTestDB();
    const env = { DB: d1, JWT_SECRET: TEST_JWT_SECRET };

    // 1. Register a user via MCP endpoint to get API key
    const regRes = await app.request('/mcp', {
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
            firstName: 'Auth',
            lastName: 'Master',
            email: 'auth.master@example.com',
            whatsappNumber: '+628777666555',
          },
        },
      }),
    }, env);

    assert.equal(regRes.status, 200);
    const regData = JSON.parse((await regRes.json()).result.content[0].text);
    const apiKey = regData.apiKey;
    const userId = regData.userId;
    assert.ok(apiKey.startsWith('fp_live_'));

    // 2. HTTP call using Bearer API Key (Authorization: Bearer fp_live_...) -> Zero Expiration
    const bearerKeyRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'manage_wallet',
          arguments: {
            action: 'create',
            name: 'Bearer Key Wallet',
            balance: 2500000,
          },
        },
      }),
    }, env);

    assert.equal(bearerKeyRes.status, 200);
    const bearerWallet = JSON.parse((await bearerKeyRes.json()).result.content[0].text);
    assert.equal(bearerWallet.walletName, 'Bearer Key Wallet');
    assert.equal(bearerWallet.walletUserId, userId);

    // 3. HTTP call using X-API-Key header (X-API-Key: fp_live_...)
    const xApiKeyRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'manage_category',
          arguments: {
            action: 'create',
            name: 'X-API-Key Category',
            type: 'expense',
          },
        },
      }),
    }, env);

    assert.equal(xApiKeyRes.status, 200);
    const xCat = JSON.parse((await xApiKeyRes.json()).result.content[0].text);
    assert.equal(xCat.categoryName, 'X-API-Key Category');
    assert.equal(xCat.categoryUserId, userId);

    // 4. In-Tool Parameter Fallback (No HTTP headers, apiKey passed in tool argument)
    const unauthServer = createMCPServer(db, null, TEST_JWT_SECRET);
    const inToolRes = await callTool(unauthServer, 'manage_wallet', {
      action: 'create',
      name: 'In-Tool Param Wallet',
      balance: 1000000,
      apiKey: apiKey,
    });

    const inToolWallet = JSON.parse(inToolRes.content[0].text);
    assert.equal(inToolWallet.walletName, 'In-Tool Param Wallet');
    assert.equal(inToolWallet.walletUserId, userId);

    // 5. In-Tool Parameter with invalid API key -> Throws Unauthorized
    await assert.rejects(async () => {
      await callTool(unauthServer, 'manage_wallet', {
        action: 'create',
        name: 'Should Fail',
        balance: 1000000,
        apiKey: 'fp_live_invalidkey1234567890abcdef',
      });
    }, /Unauthorized/i);

    // 6. In-Tool Call with NO key or header -> Throws Unauthorized
    await assert.rejects(async () => {
      await callTool(unauthServer, 'manage_wallet', {
        action: 'create',
        name: 'Should Fail Too',
        balance: 1000000,
      });
    }, /Unauthorized/i);
  });

  it('11. Submit Feedback to GitHub Issues with Auto Submitter Details', async () => {
    const { db } = createTestDB();

    // Mock fetch to simulate GitHub API
    let capturedRequest: any = null;
    const mockFetch = async (url: any, init?: any) => {
      capturedRequest = { url, ...init, body: JSON.parse(init?.body || '{}') };
      return new Response(
        JSON.stringify({
          html_url: 'https://github.com/lutfi-zain/finnplan-mcp/issues/42',
          number: 42,
          state: 'open',
          title: capturedRequest.body.title,
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    };

    // 1. Authenticated User Feedback Submission (Auto-resolves Name & Email from DB)
    const publicServer = createMCPServer(db, null, TEST_JWT_SECRET);
    const regRes = await callTool(publicServer, 'register_user', {
      firstName: 'Budi',
      lastName: 'Santoso',
      email: 'budi.santoso@example.com',
      whatsappNumber: '+628123456789',
    });
    const { userId, apiKey } = JSON.parse(regRes.content[0].text);

    const authServer = createMCPServer(db, userId, TEST_JWT_SECRET, {
      githubToken: 'ghp_mock_token_12345',
      githubRepo: 'lutfi-zain/finnplan-mcp',
      fetchFn: mockFetch as any,
    });

    const authFeedbackRes = await callTool(authServer, 'submit_feedback', {
      title: 'Tolong tambahkan export CSV',
      feedback: 'Aplikasi ini sangat bagus. Mohon tambahkan fitur export riwayat transaksi ke CSV atau Excel.',
      type: 'feature_request',
    });

    const authFeedback = JSON.parse(authFeedbackRes.content[0].text);
    assert.equal(authFeedback.success, true);
    assert.equal(authFeedback.issueUrl, 'https://github.com/lutfi-zain/finnplan-mcp/issues/42');
    assert.equal(authFeedback.issueNumber, 42);
    assert.equal(authFeedback.submitter.name, 'Budi Santoso');
    assert.equal(authFeedback.submitter.email, 'budi.santoso@example.com');
    assert.equal(authFeedback.submitter.userId, userId);

    assert.equal(capturedRequest.url, 'https://api.github.com/repos/lutfi-zain/finnplan-mcp/issues');
    assert.equal(capturedRequest.headers.Authorization, 'Bearer ghp_mock_token_12345');
    assert.ok(capturedRequest.body.title.includes('[FEATURE REQUEST] Tolong tambahkan export CSV'));
    assert.ok(capturedRequest.body.body.includes('Budi Santoso'));
    assert.ok(capturedRequest.body.body.includes('budi.santoso@example.com'));
    assert.ok(capturedRequest.body.body.includes(userId));

    // 2. In-Tool Auth Submission (Passing apiKey in arguments)
    const unauthServer = createMCPServer(db, null, TEST_JWT_SECRET, {
      githubToken: 'ghp_mock_token_12345',
      githubRepo: 'lutfi-zain/finnplan-mcp',
      fetchFn: mockFetch as any,
    });

    const inToolFeedbackRes = await callTool(unauthServer, 'submit_feedback', {
      title: 'Bug: Transaksi ganda di UI',
      feedback: 'Saya menemukan duplikasi tampilan transaksi saat jaringan lambat.',
      type: 'bug',
      apiKey,
    });
    const inToolFeedback = JSON.parse(inToolFeedbackRes.content[0].text);
    assert.equal(inToolFeedback.success, true);
    assert.equal(inToolFeedback.submitter.name, 'Budi Santoso');
    assert.equal(inToolFeedback.submitter.email, 'budi.santoso@example.com');

    // 3. Unauthenticated Guest Feedback with Explicit Name & Email
    const guestFeedbackRes = await callTool(unauthServer, 'submit_feedback', {
      title: 'Pertanyaan seputar keamanan',
      feedback: 'Apakah data keuangan dienkripsi dengan standar industri?',
      type: 'question',
      name: 'Guest Inquirer',
      email: 'guest@example.com',
    });
    const guestFeedback = JSON.parse(guestFeedbackRes.content[0].text);
    assert.equal(guestFeedback.success, true);
    assert.equal(guestFeedback.submitter.name, 'Guest Inquirer');
    assert.equal(guestFeedback.submitter.email, 'guest@example.com');
    assert.equal(guestFeedback.submitter.userId, null);

    // 4. Unauthenticated without Name/Email -> Throws Validation Error
    await assert.rejects(async () => {
      await callTool(unauthServer, 'submit_feedback', {
        title: 'Feedback tanpa identitas',
        feedback: 'Harusnya ini gagal karena tidak ada identitas submitter.',
      });
    }, /Submitter 'name' is required when unauthenticated/i);

    // 5. Missing GitHub Token -> Throws Server Error
    const noTokenServer = createMCPServer(db, userId, TEST_JWT_SECRET, {
      fetchFn: mockFetch as any,
    });
    await assert.rejects(async () => {
      await callTool(noTokenServer, 'submit_feedback', {
        title: 'Harusnya gagal token',
        feedback: 'Server tidak memiliki token github.',
      });
    }, /Missing GITHUB_TOKEN environment secret/i);
  });

  it('12. Transaction Enrichment: Wallet Transfers, Admin Fees, and Atomic Updates', async () => {
    const { db } = createTestDB();
    const publicServer = createMCPServer(db, null, TEST_JWT_SECRET);

    // 1. Register User
    const regRes = await callTool(publicServer, 'register_user', {
      firstName: 'Finance',
      lastName: 'Enriched',
      email: 'finance.enriched@example.com',
      whatsappNumber: '+628111222333',
    });
    const { userId } = JSON.parse(regRes.content[0].text);
    const authServer = createMCPServer(db, userId, TEST_JWT_SECRET);

    // 2. Create Wallets: BCA (10,000,000 IDR) and GoPay (500,000 IDR)
    const wBca = JSON.parse((await callTool(authServer, 'manage_wallet', { action: 'create', name: 'BCA Main', balance: 10000000 })).content[0].text);
    const wGopay = JSON.parse((await callTool(authServer, 'manage_wallet', { action: 'create', name: 'GoPay', balance: 500000 })).content[0].text);
    const catFood = JSON.parse((await callTool(authServer, 'manage_category', { action: 'create', name: 'Food', type: 'expense' })).content[0].text);

    // 3. Record Expense with Admin Fee (e.g. Food Delivery 100,000 + fee 2,500)
    const expenseTx = JSON.parse((await callTool(authServer, 'record_transaction', {
      walletId: wBca.walletId,
      categoryId: catFood.categoryId,
      amount: 100000,
      adminFee: 2500,
      description: 'Lunch with delivery fee',
    })).content[0].text);

    assert.equal(expenseTx.transactionAmount, 100000);
    assert.equal(expenseTx.transactionAdminFee, 2500);

    // Check BCA Balance: 10,000,000 - (100,000 + 2,500) = 9,897,500
    const bcaAfterExpense = (await db.select().from(schema.wallets).where(eq(schema.wallets.walletId, wBca.walletId)).get())!;
    assert.equal(bcaAfterExpense.walletBalance, 9897500);

    // 4. Transfer Funds with Admin Fee (Transfer 2,000,000 from BCA to GoPay with adminFee 6,500)
    const transferTx = JSON.parse((await callTool(authServer, 'transfer_funds', {
      sourceWalletId: wBca.walletId,
      targetWalletId: wGopay.walletId,
      amount: 2000000,
      adminFee: 6500,
      description: 'Topup GoPay from BCA',
    })).content[0].text);

    assert.equal(transferTx.transactionType, 'transfer');
    assert.equal(transferTx.transactionAmount, 2000000);
    assert.equal(transferTx.transactionAdminFee, 6500);
    assert.equal(transferTx.transactionWalletId, wBca.walletId);
    assert.equal(transferTx.transactionTargetWalletId, wGopay.walletId);

    // Check BCA Balance: 9,897,500 - (2,000,000 + 6,500) = 7,891,000
    const bcaAfterTransfer = (await db.select().from(schema.wallets).where(eq(schema.wallets.walletId, wBca.walletId)).get())!;
    assert.equal(bcaAfterTransfer.walletBalance, 7891000);

    // Check GoPay Balance: 500,000 + 2,000,000 = 2,500,000
    const gopayAfterTransfer = (await db.select().from(schema.wallets).where(eq(schema.wallets.walletId, wGopay.walletId)).get())!;
    assert.equal(gopayAfterTransfer.walletBalance, 2500000);

    // 5. Update Expense Transaction: Change amount from 100,000 to 150,000 (with fee 2,500)
    const updatedExpense = JSON.parse((await callTool(authServer, 'update_transaction', {
      transactionId: expenseTx.transactionId,
      amount: 150000,
    })).content[0].text);

    assert.equal(updatedExpense.transactionAmount, 150000);
    // BCA balance should decrease by additional 50,000 -> 7,891,000 - 50,000 = 7,841,000
    const bcaAfterUpdate = (await db.select().from(schema.wallets).where(eq(schema.wallets.walletId, wBca.walletId)).get())!;
    assert.equal(bcaAfterUpdate.walletBalance, 7841000);

    // 6. Update Transfer Transaction: Change amount from 2,000,000 to 1,000,000
    const updatedTransfer = JSON.parse((await callTool(authServer, 'update_transaction', {
      transactionId: transferTx.transactionId,
      amount: 1000000,
    })).content[0].text);

    assert.equal(updatedTransfer.transactionAmount, 1000000);
    // BCA balance should receive 1,000,000 refund -> 7,841,000 + 1,000,000 = 8,841,000
    const bcaAfterTransferUpdate = (await db.select().from(schema.wallets).where(eq(schema.wallets.walletId, wBca.walletId)).get())!;
    assert.equal(bcaAfterTransferUpdate.walletBalance, 8841000);

    // GoPay balance should decrease by 1,000,000 -> 2,500,000 - 1,000,000 = 1,500,000
    const gopayAfterTransferUpdate = (await db.select().from(schema.wallets).where(eq(schema.wallets.walletId, wGopay.walletId)).get())!;
    assert.equal(gopayAfterTransferUpdate.walletBalance, 1500000);

    // 7. Verify List Transactions Filter by targetWalletId & type
    const transfersList = JSON.parse((await callTool(authServer, 'list_transactions', { type: 'transfer' })).content[0].text);
    assert.equal(transfersList.length, 1);
    assert.equal(transfersList[0].transactionTargetWalletId, wGopay.walletId);

    // 8. Verify Financial Summary includes Admin Fees & Transfers
    const summary = JSON.parse((await callTool(authServer, 'financial_summary', {})).content[0].text);
    assert.equal(summary.totalAdminFees, 9000); // 2,500 (expense fee) + 6,500 (transfer fee)
    assert.equal(summary.transfersCount, 1);
    assert.equal(summary.totalExpense, 159000); // 152,500 (expense + fee) + 6,500 (transfer fee)
    assert.equal(summary.netWorthByCurrency.IDR, 8841000 + 1500000); // 10,341,000

    // 9. Negative Validation: Same source & target wallet
    await assert.rejects(async () => {
      await callTool(authServer, 'transfer_funds', {
        sourceWalletId: wBca.walletId,
        targetWalletId: wBca.walletId,
        amount: 50000,
      });
    }, /cannot be the same wallet/i);
  });
});
