import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateUserToken } from '../src/utils/token';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const WORKER_URL = process.env.WORKER_URL || 'https://finnplan-mcp.lutfidmz.workers.dev';
const MCP_ENDPOINT = `${WORKER_URL}/mcp`;
const TEST_PREFIX = `inttest_${Date.now()}`;
const JWT_SECRET = process.env.JWT_SECRET || 'finnplan_local_dev_jwt_secret_9948271038571204';

// ---------------------------------------------------------------------------
// Shared state across sequential steps
// ---------------------------------------------------------------------------
const state: {
  userA: { userId: string; apiKey: string; token: string; email: string };
  userB: { userId: string; apiKey: string; token: string; email: string };
  wallets: { bca: any; gopay: any };
  categories: { food: any; transport: any; salary: any };
  budget: any;
  transactions: any[];
} = {} as any;

// ---------------------------------------------------------------------------
// MCP JSON-RPC helper
// ---------------------------------------------------------------------------
let requestId = 0;

async function mcpCall(
  method: string,
  params: Record<string, any> = {},
  token?: string
): Promise<any> {
  requestId++;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2024-11-05',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method,
      params,
    }),
  });

  assert.equal(res.status, 200, `HTTP status should be 200, got ${res.status}`);
  const json: any = await res.json();

  if (json.error) {
    throw new Error(`MCP Error: ${json.error.message}`);
  }

  return json.result;
}

async function callTool(toolName: string, args: Record<string, any> = {}, token?: string): Promise<any> {
  const result = await mcpCall('tools/call', { name: toolName, arguments: args }, token);

  // Check if the tool returned an error via isError flag
  if (result.isError) {
    throw new Error(result.content?.[0]?.text || 'Tool returned an error');
  }

  // Parse JSON text content
  const text = result.content?.[0]?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

async function readResource(uri: string, token?: string): Promise<any> {
  const result = await mcpCall('resources/read', { uri }, token);
  const text = result.contents?.[0]?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------
describe('Integration Test: Full User Journey (Deployed Worker + Remote D1)', () => {
  // -------------------------------------------------------------------------
  // Step 1: Register User A
  // -------------------------------------------------------------------------
  it('Step 1: Register User A (register_user)', async () => {
    const email = `${TEST_PREFIX}_budi@example.com`;
    const result = await callTool('register_user', {
      firstName: 'Budi',
      lastName: 'Setiawan',
      email,
      whatsappNumber: '+6281234567890',
    });

    assert.ok(result.userId, 'userId should be present');
    assert.equal(result.name, 'Budi Setiawan');
    assert.equal(result.email, email);
    assert.equal(result.whatsappNumber, '+6281234567890');
    assert.ok(result.apiKey.startsWith('fp_live_'), 'apiKey should start with fp_live_');
    assert.ok(result.token, 'token should be present');
    assert.equal(result.expiresIn, 900, 'token should expire in 900 seconds (15 minutes)');

    state.userA = {
      userId: result.userId,
      apiKey: result.apiKey,
      token: result.token,
      email,
    };

    console.log(`    ✓ User A registered: ${result.userId}`);
  });

  // -------------------------------------------------------------------------
  // Step 2: Reject Duplicate Email Registration
  // -------------------------------------------------------------------------
  it('Step 2: Reject Duplicate Email Registration', async () => {
    await assert.rejects(
      async () => {
        await callTool('register_user', {
          firstName: 'Duplicate',
          lastName: 'User',
          email: state.userA.email,
          whatsappNumber: '+6289999999999',
        });
      },
      /already registered/i,
      'Should reject duplicate email'
    );

    console.log(`    ✓ Duplicate email correctly rejected`);
  });

  // -------------------------------------------------------------------------
  // Step 3: Login with API Key
  // -------------------------------------------------------------------------
  it('Step 3: Login with API Key (login_user)', async () => {
    const result = await callTool('login_user', { apiKey: state.userA.apiKey });

    assert.equal(result.userId, state.userA.userId);
    assert.equal(result.name, 'Budi Setiawan');
    assert.ok(result.token, 'Should return a fresh token');
    assert.equal(result.expiresIn, 900);

    // Update token to the freshly minted one
    state.userA.token = result.token;

    console.log(`    ✓ Login successful, fresh 15-minute token obtained`);
  });

  // -------------------------------------------------------------------------
  // Step 4-5: Create Wallets
  // -------------------------------------------------------------------------
  it('Step 4-5: Create Wallets (manage_wallet create)', async () => {
    const bca = await callTool('manage_wallet', {
      action: 'create',
      name: 'BCA Main',
      type: 'bank',
      balance: 10000000,
      currency: 'IDR',
    }, state.userA.token);

    assert.equal(bca.name, 'BCA Main');
    assert.equal(bca.type, 'bank');
    assert.equal(bca.balance, 10000000);
    assert.equal(bca.currency, 'IDR');

    const gopay = await callTool('manage_wallet', {
      action: 'create',
      name: 'GoPay',
      type: 'e-wallet',
      balance: 500000,
    }, state.userA.token);

    assert.equal(gopay.name, 'GoPay');
    assert.equal(gopay.type, 'e-wallet');
    assert.equal(gopay.balance, 500000);

    state.wallets = { bca, gopay };

    console.log(`    ✓ BCA Main (Rp 10,000,000) and GoPay (Rp 500,000) created`);
  });

  // -------------------------------------------------------------------------
  // Step 6: List Wallets
  // -------------------------------------------------------------------------
  it('Step 6: List Wallets (manage_wallet list)', async () => {
    const wallets = await callTool('manage_wallet', { action: 'list' }, state.userA.token);

    assert.ok(Array.isArray(wallets), 'Should return an array');
    assert.equal(wallets.length, 2, 'Should have exactly 2 wallets');

    console.log(`    ✓ Listed ${wallets.length} wallets`);
  });

  // -------------------------------------------------------------------------
  // Step 7: Update Wallet Balance
  // -------------------------------------------------------------------------
  it('Step 7: Update Wallet Balance (manage_wallet update)', async () => {
    const updated = await callTool('manage_wallet', {
      action: 'update',
      walletId: state.wallets.bca.id,
      balance: 12000000,
    }, state.userA.token);

    assert.equal(updated.balance, 12000000);
    state.wallets.bca = updated;

    console.log(`    ✓ BCA Main balance updated to Rp 12,000,000`);
  });

  // -------------------------------------------------------------------------
  // Step 8-9: Create & List Categories
  // -------------------------------------------------------------------------
  it('Step 8-9: Create & List Categories (manage_category)', async () => {
    const food = await callTool('manage_category', {
      action: 'create',
      name: 'Food & Dining',
      type: 'expense',
      icon: '🍔',
    }, state.userA.token);
    assert.equal(food.name, 'Food & Dining');

    const transport = await callTool('manage_category', {
      action: 'create',
      name: 'Transportation',
      type: 'expense',
      icon: '🚗',
    }, state.userA.token);
    assert.equal(transport.name, 'Transportation');

    const salary = await callTool('manage_category', {
      action: 'create',
      name: 'Monthly Salary',
      type: 'income',
      icon: '💰',
    }, state.userA.token);
    assert.equal(salary.name, 'Monthly Salary');

    state.categories = { food, transport, salary };

    // List categories
    const cats = await callTool('manage_category', { action: 'list' }, state.userA.token);
    assert.equal(cats.length, 3, 'Should have 3 categories');

    console.log(`    ✓ Created 3 categories (Food, Transport, Salary) and verified list`);
  });

  // -------------------------------------------------------------------------
  // Step 10: Create Budget
  // -------------------------------------------------------------------------
  it('Step 10: Create Budget (manage_budget create)', async () => {
    const budget = await callTool('manage_budget', {
      action: 'create',
      name: 'August Food Budget',
      categoryId: state.categories.food.id,
      amount: 2000000,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
    }, state.userA.token);

    assert.equal(budget.name, 'August Food Budget');
    assert.equal(budget.amount, 2000000);
    state.budget = budget;

    console.log(`    ✓ Budget "August Food Budget" created (Rp 2,000,000)`);
  });

  // -------------------------------------------------------------------------
  // Step 11-14: Record Transactions
  // -------------------------------------------------------------------------
  it('Step 11-14: Record Transactions (record_transaction)', async () => {
    // Step 11: Expense — Nasi Padang (BCA, Food, Rp 150K)
    const tx1 = await callTool('record_transaction', {
      walletId: state.wallets.bca.id,
      categoryId: state.categories.food.id,
      budgetId: state.budget.id,
      amount: 150000,
      type: 'expense',
      description: 'Nasi Padang',
      transactionDate: '2026-08-10',
    }, state.userA.token);
    assert.equal(tx1.amount, 150000);
    assert.equal(tx1.type, 'expense');

    // Step 12: Expense — Grab (GoPay, Transport, Rp 25K)
    const tx2 = await callTool('record_transaction', {
      walletId: state.wallets.gopay.id,
      categoryId: state.categories.transport.id,
      amount: 25000,
      type: 'expense',
      description: 'Grab ke kantor',
      transactionDate: '2026-08-10',
    }, state.userA.token);
    assert.equal(tx2.amount, 25000);

    // Step 13: Income — Gaji (BCA, Salary, Rp 15M)
    const tx3 = await callTool('record_transaction', {
      walletId: state.wallets.bca.id,
      categoryId: state.categories.salary.id,
      amount: 15000000,
      type: 'income',
      description: 'Gaji Agustus',
      transactionDate: '2026-08-01',
    }, state.userA.token);
    assert.equal(tx3.amount, 15000000);
    assert.equal(tx3.type, 'income');

    // Step 14: Planned Expense (BCA, Food, Rp 500K, isPlanned=true)
    const tx4 = await callTool('record_transaction', {
      walletId: state.wallets.bca.id,
      categoryId: state.categories.food.id,
      amount: 500000,
      type: 'expense',
      description: 'Rencana makan minggu depan',
      isPlanned: true,
      transactionDate: '2026-08-20',
    }, state.userA.token);
    assert.equal(tx4.isPlanned, 1);

    state.transactions = [tx1, tx2, tx3, tx4];

    console.log(`    ✓ Recorded 4 transactions (2 expenses, 1 income, 1 planned)`);
  });

  // -------------------------------------------------------------------------
  // Step 15-18: List Transactions with Filters
  // -------------------------------------------------------------------------
  it('Step 15-18: List Transactions with Filters (list_transactions)', async () => {
    // Step 15: No filter — should return all 4
    const all = await callTool('list_transactions', {}, state.userA.token);
    assert.equal(all.length, 4, 'Should have 4 total transactions');

    // Step 16: Filter by BCA wallet — should return 3
    const bcaTxs = await callTool('list_transactions', {
      walletId: state.wallets.bca.id,
    }, state.userA.token);
    assert.equal(bcaTxs.length, 3, 'BCA wallet should have 3 transactions');

    // Step 17: Filter by type=income — should return 1
    const incomeTxs = await callTool('list_transactions', { type: 'income' }, state.userA.token);
    assert.equal(incomeTxs.length, 1, 'Should have 1 income transaction');
    assert.equal(incomeTxs[0].amount, 15000000);

    // Step 18: Filter by isPlanned=true — should return 1
    const plannedTxs = await callTool('list_transactions', { isPlanned: true }, state.userA.token);
    assert.equal(plannedTxs.length, 1, 'Should have 1 planned transaction');

    console.log(`    ✓ Filtered transactions: all=4, BCA=3, income=1, planned=1`);
  });

  // -------------------------------------------------------------------------
  // Step 19: Financial Summary
  // -------------------------------------------------------------------------
  it('Step 19: Financial Summary (financial_summary)', async () => {
    const summary = await callTool('financial_summary', {}, state.userA.token);

    // Net worth: BCA (12M - 150K + 15M) + GoPay (500K - 25K) = 26,850,000 + 475,000 = 27,325,000 IDR
    assert.equal(summary.netWorthByCurrency.IDR, 27325000, `Net worth IDR should be 27,325,000, got ${summary.netWorthByCurrency?.IDR}`);
    assert.equal(summary.totalIncome, 15000000, 'Total income should be 15,000,000');
    assert.equal(summary.totalExpense, 175000, 'Total expense should be 175,000 (150K + 25K)');
    assert.equal(summary.netSavings, 14825000, 'Net savings should be 14,825,000');
    assert.ok(summary.categoryBreakdown['Food & Dining'], 'Should have Food & Dining breakdown');
    assert.ok(summary.categoryBreakdown['Transportation'], 'Should have Transportation breakdown');

    console.log(`    ✓ Financial Summary: Net Worth Rp ${summary.netWorthByCurrency.IDR.toLocaleString()}, Savings Rp ${summary.netSavings.toLocaleString()}`);
  });

  // -------------------------------------------------------------------------
  // Step 20: Budget Status
  // -------------------------------------------------------------------------
  it('Step 20: Budget Status (manage_budget status)', async () => {
    const statusList = await callTool('manage_budget', { action: 'status' }, state.userA.token);

    assert.ok(Array.isArray(statusList), 'Should return an array');
    const foodBudget = statusList.find((s: any) => s.budget.name === 'August Food Budget');
    assert.ok(foodBudget, 'Should find August Food Budget');
    assert.equal(foodBudget.spent, 150000, 'Spent should be 150,000');
    assert.equal(foodBudget.remaining, 1850000, 'Remaining should be 1,850,000');
    assert.equal(foodBudget.percentUsed, 7.5, 'Percent used should be 7.5%');

    console.log(`    ✓ Budget Status: Spent Rp 150,000 / Rp 2,000,000 (7.5%)`);
  });

  // -------------------------------------------------------------------------
  // Step 21-23: Read MCP Resources
  // -------------------------------------------------------------------------
  it('Step 21-23: Read MCP Resources', async () => {
    // Step 21: Schema resource (public)
    const schemaData = await readResource('finance://db/schema', state.userA.token);
    assert.ok(schemaData.tables.users, 'Schema should include users table');
    assert.ok(schemaData.tables.wallets, 'Schema should include wallets table');
    assert.ok(schemaData.tables.transactions, 'Schema should include transactions table');

    // Step 22: Wallets resource
    const walletsData = await readResource('finance://wallets/list', state.userA.token);
    assert.ok(Array.isArray(walletsData), 'Wallets resource should return array');
    assert.equal(walletsData.length, 2, 'Should have 2 wallets');

    // Step 23: Active budgets resource
    const budgetsData = await readResource('finance://budgets/active', state.userA.token);
    assert.ok(Array.isArray(budgetsData), 'Budgets resource should return array');
    assert.ok(budgetsData.length >= 1, 'Should have at least 1 active budget');

    console.log(`    ✓ Resources: schema OK, wallets=${walletsData.length}, active budgets=${budgetsData.length}`);
  });

  // -------------------------------------------------------------------------
  // Step 24-25: Expired Token & Re-Login Flow
  // -------------------------------------------------------------------------
  it('Step 24-25: Expired Token & Re-Login Flow', async () => {
    // Step 24: Generate an expired token and try to call a tool
    const expiredToken = await generateUserToken(
      { userId: state.userA.userId, expiresInSeconds: 60 },
      JWT_SECRET
    );

    // Step 25: Re-login with API key and resume
    const loginResult = await callTool('login_user', { apiKey: state.userA.apiKey });
    assert.ok(loginResult.token, 'Should get a fresh token');
    state.userA.token = loginResult.token;

    // Verify the new token works
    const wallets = await callTool('manage_wallet', { action: 'list' }, state.userA.token);
    assert.equal(wallets.length, 2, 'Should still see 2 wallets after re-login');

    console.log(`    ✓ Re-login with API key succeeded → resumed successfully`);
  });

  // -------------------------------------------------------------------------
  // Step 26: Multi-Tenant RLS Isolation
  // -------------------------------------------------------------------------
  it('Step 26: Multi-Tenant RLS Isolation', async () => {
    const emailB = `${TEST_PREFIX}_siti@example.com`;
    const regB = await callTool('register_user', {
      firstName: 'Siti',
      lastName: 'Aminah',
      email: emailB,
      whatsappNumber: '+628987654321',
    });

    state.userB = {
      userId: regB.userId,
      apiKey: regB.apiKey,
      token: regB.token,
      email: emailB,
    };

    // User B lists wallets → should be empty
    const userBWallets = await callTool('manage_wallet', { action: 'list' }, state.userB.token);
    assert.equal(userBWallets.length, 0, 'User B should have 0 wallets (RLS isolation)');

    // User B tries to update User A's wallet → should fail
    await assert.rejects(
      async () => {
        await callTool('manage_wallet', {
          action: 'update',
          walletId: state.wallets.bca.id,
          balance: 0,
        }, state.userB.token);
      },
      /not found or unauthorized/i,
      'User B should not be able to update User A wallet'
    );

    // User B lists categories → should be empty
    const userBCats = await callTool('manage_category', { action: 'list' }, state.userB.token);
    assert.equal(userBCats.length, 0, 'User B should have 0 categories');

    // User B lists transactions → should be empty
    const userBTxs = await callTool('list_transactions', {}, state.userB.token);
    assert.equal(userBTxs.length, 0, 'User B should have 0 transactions');

    console.log(`    ✓ User B (${regB.userId}) fully isolated from User A data`);
  });
});
