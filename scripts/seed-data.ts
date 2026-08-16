/**
 * Seed Script for Eve Finance MCP
 * Creates a complete realistic dataset (User, Wallets, Categories, Budgets, Transactions)
 * Can target Local D1 (http://localhost:8787) or Remote Cloudflare Worker (https://finnplan-mcp.lutfidmz.workers.dev)
 */

const targetUrl = process.env.WORKER_URL || 'https://finnplan-mcp.lutfidmz.workers.dev';
const mcpEndpoint = `${targetUrl}/mcp`;

async function callMcp(method: string, params: Record<string, any> = {}, token?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2024-11-05',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(mcpEndpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000000),
      method,
      params,
    }),
  });

  const data: any = await res.json();
  if (data.error) {
    throw new Error(`MCP Error: ${data.error.message}`);
  }

  const text = data.result?.content?.[0]?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return data.result;
}

async function callTool(name: string, args: Record<string, any> = {}, token?: string) {
  return callMcp('tools/call', { name, arguments: args }, token);
}

async function main() {
  console.log("");
  console.log("🌱 ========================================================");
  console.log(`🌱 Seeding Eve Finance MCP Database`);
  console.log(`🌱 Target: ${targetUrl}`);
  console.log("🌱 ========================================================");
  console.log("");

  // 1. Register User
  const email = `lutfi_${Date.now().toString().slice(-4)}@example.com`;
  console.log(`1️⃣  Registering user: ${email}...`);
  const user = await callTool('register_user', {
    firstName: 'Lutfi',
    lastName: 'Zain',
    email,
    whatsappNumber: '+6281234567890',
  });
  console.log(`    ✅ User Registered!`);
  console.log(`       User ID : ${user.userId}`);
  console.log(`       API Key : ${user.apiKey}`);
  console.log(`       Token   : ${user.token.slice(0, 25)}... (valid 15 mins)`);
  console.log("");

  const token = user.token;

  // 2. Create Wallets
  console.log("2️⃣  Creating Wallets...");
  const bca = await callTool('manage_wallet', {
    action: 'create',
    name: 'BCA Prioritas',
    type: 'bank',
    balance: 25000000,
    currency: 'IDR',
  }, token);
  console.log(`    ✅ BCA Prioritas (IDR 25,000,000) created [ID: ${bca.id}]`);

  const gopay = await callTool('manage_wallet', {
    action: 'create',
    name: 'GoPay Daily',
    type: 'e-wallet',
    balance: 1500000,
    currency: 'IDR',
  }, token);
  console.log(`    ✅ GoPay Daily (IDR 1,500,000) created [ID: ${gopay.id}]`);

  const wiseUsd = await callTool('manage_wallet', {
    action: 'create',
    name: 'Wise USD Multi-Currency',
    type: 'bank',
    balance: 1250,
    currency: 'USD',
  }, token);
  console.log(`    ✅ Wise USD (USD 1,250) created [ID: ${wiseUsd.id}]`);
  console.log("");

  // 3. Create Categories
  console.log("3️⃣  Creating Categories...");
  const catFood = await callTool('manage_category', {
    action: 'create',
    name: 'Food & Groceries',
    type: 'expense',
    icon: '🍔',
  }, token);

  const catTransport = await callTool('manage_category', {
    action: 'create',
    name: 'Transportation & Fuel',
    type: 'expense',
    icon: '🚗',
  }, token);

  const catSalary = await callTool('manage_category', {
    action: 'create',
    name: 'Tech Consulting & Salary',
    type: 'income',
    icon: '💰',
  }, token);

  const catSub = await callTool('manage_category', {
    action: 'create',
    name: 'Cloud & SaaS Subscriptions',
    type: 'expense',
    icon: '💻',
  }, token);
  console.log(`    ✅ Categories created: Food, Transport, Salary, SaaS`);
  console.log("");

  // 4. Create Budgets
  console.log("4️⃣  Creating Budgets...");
  const budgetFood = await callTool('manage_budget', {
    action: 'create',
    name: 'August Food & Dining',
    categoryId: catFood.id,
    amount: 4000000,
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
  }, token);
  console.log(`    ✅ Budget: "August Food & Dining" (IDR 4,000,000) created`);

  const budgetSub = await callTool('manage_budget', {
    action: 'create',
    name: 'August SaaS & Tools',
    categoryId: catSub.id,
    amount: 1500000,
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
  }, token);
  console.log(`    ✅ Budget: "August SaaS & Tools" (IDR 1,500,000) created`);
  console.log("");

  // 5. Record Transactions
  console.log("5️⃣  Recording Transactions...");
  
  // Transaction 1: Monthly Salary Income
  await callTool('record_transaction', {
    walletId: bca.id,
    categoryId: catSalary.id,
    amount: 35000000,
    type: 'income',
    description: 'Monthly Client Retainer',
    transactionDate: '2026-08-01',
  }, token);
  console.log(`    ✅ Income: IDR 35,000,000 recorded`);

  // Transaction 2: Food Expense
  await callTool('record_transaction', {
    walletId: bca.id,
    categoryId: catFood.id,
    budgetId: budgetFood.id,
    amount: 450000,
    type: 'expense',
    description: 'Family Dinner at Sushi Tei',
    transactionDate: '2026-08-05',
  }, token);
  console.log(`    ✅ Expense: IDR 450,000 (Sushi Tei) recorded`);

  // Transaction 3: Supermarket Expense
  await callTool('record_transaction', {
    walletId: gopay.id,
    categoryId: catFood.id,
    budgetId: budgetFood.id,
    amount: 275000,
    type: 'expense',
    description: 'Weekly Groceries at Ranch Market',
    transactionDate: '2026-08-08',
  }, token);
  console.log(`    ✅ Expense: IDR 275,000 (Ranch Market) recorded`);

  // Transaction 4: Cloudflare & SaaS
  await callTool('record_transaction', {
    walletId: bca.id,
    categoryId: catSub.id,
    budgetId: budgetSub.id,
    amount: 320000,
    type: 'expense',
    description: 'Cloudflare Pro & Worker Paid Plan',
    transactionDate: '2026-08-10',
  }, token);
  console.log(`    ✅ Expense: IDR 320,000 (Cloudflare) recorded`);

  // Transaction 5: Planned Expense (Upcoming Flight)
  await callTool('record_transaction', {
    walletId: bca.id,
    categoryId: catTransport.id,
    amount: 1850000,
    type: 'expense',
    description: 'Flight to Bali (Planned)',
    transactionDate: '2026-08-25',
    isPlanned: true,
  }, token);
  console.log(`    ✅ Planned Expense: IDR 1,850,000 (Flight) recorded`);
  console.log("");

  // 6. Print Summary
  console.log("6️⃣  Fetching Financial Summary...");
  const summary = await callTool('financial_summary', {}, token);
  console.log("    📊 Financial Summary:");
  console.log(`       - Net Worth IDR : IDR ${summary.netWorthByCurrency.IDR.toLocaleString('id-ID')}`);
  console.log(`       - Net Worth USD : USD ${summary.netWorthByCurrency.USD.toLocaleString('en-US')}`);
  console.log(`       - Total Income  : IDR ${summary.totalIncome.toLocaleString('id-ID')}`);
  console.log(`       - Total Expense : IDR ${summary.totalExpense.toLocaleString('id-ID')}`);
  console.log(`       - Savings Rate  : ${summary.savingsRate}%`);
  console.log("");

  console.log("🎉 ========================================================");
  console.log("🎉 Seeding complete! The database now has real live records.");
  console.log(`🎉 Check Cloudflare D1 Console or DBeaver!`);
  console.log("🎉 ========================================================");
  console.log("");
}

main().catch((err) => {
  console.error("❌ Seed Error:", err);
  process.exit(1);
});
