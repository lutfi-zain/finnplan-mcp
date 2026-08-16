import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import { eq, and, desc, gte, lte } from "drizzle-orm";
import {
  generateApiKey,
  generateUserId,
  generateUserToken,
  isValidEmail,
  isValidWhatsApp,
  DEFAULT_TOKEN_EXPIRY_SECONDS,
  DEFAULT_DEV_JWT_SECRET,
} from "./utils/token";

export function createMCPServer(
  db: DrizzleD1Database<typeof schema>,
  userId: string | null,
  jwtSecret: string = DEFAULT_DEV_JWT_SECRET
) {
  const server = new Server(
    { name: "eve-finance-mcp", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  // ---------------------------------------------------------------------------
  // 1. Resources Registry & Handlers
  // ---------------------------------------------------------------------------
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "finance://db/schema",
        name: "Database Schema",
        mimeType: "application/json",
        description: "Returns table structures and relationship definitions for Eve Finance DB."
      },
      {
        uri: "finance://wallets/list",
        name: "User Wallets List",
        mimeType: "application/json",
        description: "Returns current list of active wallets and balances for the authenticated user."
      },
      {
        uri: "finance://budgets/active",
        name: "Active Budgets Utilization",
        mimeType: "application/json",
        description: "Returns currently active budgets and calculated spending utilization."
      }
    ]
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === "finance://db/schema") {
      const schemaDef = {
        tables: {
          users: ["id (PK)", "first_name", "last_name", "email (UNIQUE)", "whatsapp_number", "api_key (UNIQUE)", "created_at"],
          wallets: ["id (PK)", "user_id (FK)", "name", "type", "balance", "currency", "created_at"],
          categories: ["id (PK)", "user_id (FK)", "name", "type", "icon", "created_at"],
          budgets: ["id (PK)", "user_id (FK)", "name", "category_id (FK)", "amount", "period_start", "period_end", "created_at"],
          transactions: [
            "id (PK)", "user_id (FK)", "wallet_id (FK)", "category_id (FK)", "budget_id (FK)",
            "amount", "type", "description", "is_planned", "transaction_date", "created_at"
          ]
        },
        relationships: {
          wallets_to_transactions: "1-to-N (Required)",
          categories_to_transactions: "1-to-N (Required)",
          budgets_to_transactions: "1-to-N (Optional)"
        }
      };
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(schemaDef, null, 2)
          }
        ]
      };
    }

    // Require authentication for user-specific resources
    if (!userId) {
      throw new Error("Unauthorized: Session token is missing or expired (15m limit). Please call 'login_user' with your API Key to get a new session token, or call 'register_user'.");
    }

    if (uri === "finance://wallets/list") {
      const userWallets = await db.select().from(schema.wallets).where(eq(schema.wallets.userId, userId));
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(userWallets, null, 2)
          }
        ]
      };
    }

    if (uri === "finance://budgets/active") {
      const today = new Date().toISOString().split("T")[0];
      const activeBudgets = await db.select()
        .from(schema.budgets)
        .where(
          and(
            eq(schema.budgets.userId, userId),
            lte(schema.budgets.periodStart, today),
            gte(schema.budgets.periodEnd, today)
          )
        );

      const statusList = [];
      for (const b of activeBudgets) {
        const conditions = [
          eq(schema.transactions.userId, userId),
          eq(schema.transactions.isPlanned, 0),
          gte(schema.transactions.transactionDate, b.periodStart),
          lte(schema.transactions.transactionDate, b.periodEnd)
        ];
        if (b.categoryId) {
          conditions.push(eq(schema.transactions.categoryId, b.categoryId));
        } else {
          conditions.push(eq(schema.transactions.budgetId, b.id));
        }

        const txs = await db.select().from(schema.transactions).where(and(...conditions));
        const spent = txs.reduce((sum, tx) => sum + tx.amount, 0);
        statusList.push({
          budget: b,
          spent,
          remaining: b.amount - spent,
          percentUsed: b.amount > 0 ? Number(((spent / b.amount) * 100).toFixed(2)) : 0
        });
      }

      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(statusList, null, 2)
          }
        ]
      };
    }

    throw new Error(`Resource not found: ${uri}`);
  });

  // ---------------------------------------------------------------------------
  // 2. Tools Registry
  // ---------------------------------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      // Authentication Tools (Public)
      {
        name: "register_user",
        description: "Register a new user account with profile details. Returns your persistent API Key and a 15-minute JWT session token.",
        inputSchema: {
          type: "object",
          properties: {
            firstName: { type: "string", description: "User's first name" },
            lastName: { type: "string", description: "User's last name" },
            email: { type: "string", description: "Valid email address (e.g. user@example.com)" },
            whatsappNumber: { type: "string", description: "WhatsApp phone number with '+' and country code (e.g. +6281234567890)" },
            userId: { type: "string", description: "Optional custom user ID (auto-generated if omitted)" }
          },
          required: ["firstName", "lastName", "email", "whatsappNumber"]
        }
      },
      {
        name: "login_user",
        description: "Authenticate with your persistent API Key to obtain a fresh 15-minute JWT session token.",
        inputSchema: {
          type: "object",
          properties: {
            apiKey: { type: "string", description: "Your persistent API Key (e.g. fp_live_...)" }
          },
          required: ["apiKey"]
        }
      },
      // Finance Tools (Authenticated with 15-min JWT)
      {
        name: "record_transaction",
        description: "Record a financial transaction (income, expense, or transfer). Auto-updates wallet balance for actual transactions.",
        inputSchema: {
          type: "object",
          properties: {
            walletId: { type: "integer", description: "Target Wallet ID" },
            categoryId: { type: "integer", description: "Target Category ID" },
            budgetId: { type: "integer", description: "Optional: Linked Budget ID" },
            amount: { type: "number", minimum: 0.01, description: "Transaction amount (positive number)" },
            type: { type: "string", enum: ["expense", "income", "transfer"], default: "expense" },
            description: { type: "string", description: "Transaction note or description" },
            isPlanned: { type: "boolean", default: false, description: "Set true for projected transactions without altering balance" },
            transactionDate: { type: "string", description: "ISO date format (YYYY-MM-DD). Defaults to today." }
          },
          required: ["walletId", "categoryId", "amount"]
        }
      },
      {
        name: "manage_wallet",
        description: "Manage wallets: list all wallets, create a new wallet, or update an existing wallet.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "create", "update"], description: "Action to perform" },
            name: { type: "string", description: "Wallet name (e.g. Cash, BCA, Mandiri)" },
            type: { type: "string", enum: ["bank", "cash", "e-wallet", "credit"], description: "Wallet type" },
            balance: { type: "number", description: "Initial balance or updated balance" },
            currency: { type: "string", default: "IDR", description: "Currency code" },
            walletId: { type: "integer", description: "Required for update action" }
          },
          required: ["action"]
        }
      },
      {
        name: "manage_category",
        description: "Manage categories: list existing categories or create a new category.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "create"], description: "Action to perform" },
            name: { type: "string", description: "Category name (e.g. Food & Beverage, Utilities)" },
            type: { type: "string", enum: ["expense", "income"], default: "expense" },
            icon: { type: "string", description: "Emoji icon representation (e.g. 🍔, 🚗)" }
          },
          required: ["action"]
        }
      },
      {
        name: "manage_budget",
        description: "Manage financial budgets with active date windows. Create, list, or check budget status vs actual spending.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "create", "status"], description: "Action to perform" },
            name: { type: "string", description: "Budget title (e.g. August Food Budget)" },
            categoryId: { type: "integer", description: "Optional category filter ID" },
            amount: { type: "number", minimum: 0.01, description: "Budget target limit amount" },
            periodStart: { type: "string", description: "Start date of active window (YYYY-MM-DD)" },
            periodEnd: { type: "string", description: "End date of active window (YYYY-MM-DD)" }
          },
          required: ["action"]
        }
      },
      {
        name: "list_transactions",
        description: "Query transactions with structured filters (wallet, category, budget, date range, is_planned).",
        inputSchema: {
          type: "object",
          properties: {
            walletId: { type: "integer" },
            categoryId: { type: "integer" },
            budgetId: { type: "integer" },
            type: { type: "string", enum: ["expense", "income", "transfer"] },
            isPlanned: { type: "boolean" },
            startDate: { type: "string", description: "YYYY-MM-DD" },
            endDate: { type: "string", description: "YYYY-MM-DD" },
            limit: { type: "integer", default: 50, maximum: 200 }
          }
        }
      },
      {
        name: "financial_summary",
        description: "Generate a complete financial report (net worth across wallets, actual income & expenses, category breakdown).",
        inputSchema: {
          type: "object",
          properties: {
            startDate: { type: "string", description: "Start date filter (YYYY-MM-DD)" },
            endDate: { type: "string", description: "End date filter (YYYY-MM-DD)" }
          }
        }
      }
    ]
  }));

  // ---------------------------------------------------------------------------
  // 3. Tools Execution Handler
  // ---------------------------------------------------------------------------
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // --- Tool: register_user ---
    if (name === "register_user") {
      const { firstName, lastName, email, whatsappNumber, userId: customUserId } = (args || {}) as any;

      if (!firstName || typeof firstName !== "string" || firstName.trim() === "") {
        throw new Error("Validation Error: 'firstName' is required");
      }
      if (!lastName || typeof lastName !== "string" || lastName.trim() === "") {
        throw new Error("Validation Error: 'lastName' is required");
      }
      if (!isValidEmail(email)) {
        throw new Error("Validation Error: Invalid email format. Please provide a valid email (e.g. user@example.com)");
      }
      if (!isValidWhatsApp(whatsappNumber)) {
        throw new Error("Validation Error: Invalid WhatsApp number format. Must start with '+' followed by country code and 6-14 digits (e.g. +6281234567890)");
      }

      const normalizedEmail = email.trim().toLowerCase();
      const existing = await db.select().from(schema.users).where(eq(schema.users.email, normalizedEmail)).get();
      if (existing) {
        throw new Error(`Registration Error: Email '${normalizedEmail}' is already registered. Please login with your API key using the 'login_user' tool.`);
      }

      const newUserId = customUserId?.trim() || generateUserId();
      const apiKey = generateApiKey();
      const cleanFirstName = firstName.trim();
      const cleanLastName = lastName.trim();
      const cleanWhatsApp = whatsappNumber.trim();
      const fullName = `${cleanFirstName} ${cleanLastName}`;

      await db.insert(schema.users).values({
        id: newUserId,
        firstName: cleanFirstName,
        lastName: cleanLastName,
        email: normalizedEmail,
        whatsappNumber: cleanWhatsApp,
        apiKey
      });

      const token = await generateUserToken({
        userId: newUserId,
        name: fullName,
        email: normalizedEmail,
        expiresInSeconds: DEFAULT_TOKEN_EXPIRY_SECONDS
      }, jwtSecret);

      const responsePayload = {
        userId: newUserId,
        name: fullName,
        email: normalizedEmail,
        whatsappNumber: cleanWhatsApp,
        apiKey,
        token,
        tokenType: "Bearer",
        expiresIn: DEFAULT_TOKEN_EXPIRY_SECONDS,
        message: "Registration successful! Please set 'Authorization: Bearer <token>' in your MCP client headers for subsequent finance tool calls. Save your apiKey to login again via 'login_user' when your 15-minute token expires."
      };

      return { content: [{ type: "text", text: JSON.stringify(responsePayload, null, 2) }] };
    }

    // --- Tool: login_user ---
    if (name === "login_user") {
      const { apiKey } = (args || {}) as any;
      if (!apiKey || typeof apiKey !== "string" || apiKey.trim() === "") {
        throw new Error("Validation Error: 'apiKey' is required for login_user");
      }

      const cleanKey = apiKey.trim();
      const user = await db.select().from(schema.users).where(eq(schema.users.apiKey, cleanKey)).get();
      if (!user) {
        throw new Error("Authentication Error: Invalid API Key. User not found. Please verify your API Key or register via 'register_user'.");
      }

      const fullName = `${user.firstName} ${user.lastName}`.trim();
      const token = await generateUserToken({
        userId: user.id,
        name: fullName,
        email: user.email,
        expiresInSeconds: DEFAULT_TOKEN_EXPIRY_SECONDS
      }, jwtSecret);

      const responsePayload = {
        userId: user.id,
        name: fullName,
        email: user.email,
        token,
        tokenType: "Bearer",
        expiresIn: DEFAULT_TOKEN_EXPIRY_SECONDS,
        message: "Login successful! Please update 'Authorization: Bearer <token>' in your MCP client headers for subsequent tool calls."
      };

      return { content: [{ type: "text", text: JSON.stringify(responsePayload, null, 2) }] };
    }

    // -------------------------------------------------------------------------
    // Guard: Require Authentication for All Finance Tools Below
    // -------------------------------------------------------------------------
    if (!userId) {
      throw new Error("Unauthorized: JWT session token is missing or expired (15m limit). Please call 'login_user' with your API Key to obtain a fresh 15-minute session token, or call 'register_user' to create an account.");
    }

    // --- Tool: manage_wallet ---
    if (name === "manage_wallet") {
      const { action, name: walletName, type, balance, currency, walletId } = (args || {}) as any;
      
      if (action === "list") {
        const result = await db.select().from(schema.wallets).where(eq(schema.wallets.userId, userId));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      
      if (action === "create") {
        if (!walletName || typeof walletName !== "string" || walletName.trim() === "") {
          throw new Error("Wallet 'name' is required for create action");
        }
        const result = await db.insert(schema.wallets).values({
          userId,
          name: walletName.trim(),
          type: type || "bank",
          balance: typeof balance === "number" ? balance : 0,
          currency: currency || "IDR"
        }).returning();
        return { content: [{ type: "text", text: JSON.stringify(result[0], null, 2) }] };
      }
      
      if (action === "update") {
        if (!walletId || typeof walletId !== "number") {
          throw new Error("Numeric 'walletId' is required for update action");
        }
        const existing = await db.select().from(schema.wallets).where(and(eq(schema.wallets.id, walletId), eq(schema.wallets.userId, userId))).get();
        if (!existing) {
          throw new Error(`Wallet ID ${walletId} not found or unauthorized`);
        }

        const updates: any = {};
        if (walletName) updates.name = walletName.trim();
        if (balance !== undefined && typeof balance === "number") updates.balance = balance;
        if (type) updates.type = type;
        if (currency) updates.currency = currency;

        const result = await db.update(schema.wallets)
          .set(updates)
          .where(and(eq(schema.wallets.id, walletId), eq(schema.wallets.userId, userId)))
          .returning();
        return { content: [{ type: "text", text: JSON.stringify(result[0], null, 2) }] };
      }

      throw new Error(`Invalid action '${action}' for manage_wallet. Valid actions: list, create, update`);
    }

    // --- Tool: manage_category ---
    if (name === "manage_category") {
      const { action, name: catName, type, icon } = (args || {}) as any;
      
      if (action === "list") {
        const result = await db.select().from(schema.categories).where(eq(schema.categories.userId, userId));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      
      if (action === "create") {
        if (!catName || typeof catName !== "string" || catName.trim() === "") {
          throw new Error("Category 'name' is required for create action");
        }
        const result = await db.insert(schema.categories).values({
          userId,
          name: catName.trim(),
          type: type === "income" ? "income" : "expense",
          icon: icon || null
        }).returning();
        return { content: [{ type: "text", text: JSON.stringify(result[0], null, 2) }] };
      }

      throw new Error(`Invalid action '${action}' for manage_category. Valid actions: list, create`);
    }

    // --- Tool: manage_budget ---
    if (name === "manage_budget") {
      const { action, name: budgetName, categoryId, amount, periodStart, periodEnd } = (args || {}) as any;
      
      if (action === "list") {
        const result = await db.select().from(schema.budgets).where(eq(schema.budgets.userId, userId));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      
      if (action === "create") {
        if (!budgetName || !amount || !periodStart || !periodEnd) {
          throw new Error("Fields 'name', 'amount', 'periodStart', and 'periodEnd' are required for create action");
        }
        if (typeof amount !== "number" || amount <= 0) {
          throw new Error("Budget 'amount' must be a positive number");
        }

        if (categoryId) {
          const category = await db.select().from(schema.categories).where(and(eq(schema.categories.id, categoryId), eq(schema.categories.userId, userId))).get();
          if (!category) {
            throw new Error(`Category ID ${categoryId} not found or unauthorized`);
          }
        }

        const result = await db.insert(schema.budgets).values({
          userId,
          name: budgetName.trim(),
          categoryId: categoryId || null,
          amount,
          periodStart,
          periodEnd
        }).returning();
        return { content: [{ type: "text", text: JSON.stringify(result[0], null, 2) }] };
      }
      
      if (action === "status") {
        const budgets = await db.select().from(schema.budgets).where(eq(schema.budgets.userId, userId));
        const statusList = [];
        for (const b of budgets) {
          const conditions = [
            eq(schema.transactions.userId, userId),
            eq(schema.transactions.isPlanned, 0),
            gte(schema.transactions.transactionDate, b.periodStart),
            lte(schema.transactions.transactionDate, b.periodEnd)
          ];
          if (b.categoryId) {
            conditions.push(eq(schema.transactions.categoryId, b.categoryId));
          } else {
            conditions.push(eq(schema.transactions.budgetId, b.id));
          }

          const txs = await db.select().from(schema.transactions).where(and(...conditions));
          const spent = txs.reduce((sum, tx) => sum + tx.amount, 0);
          statusList.push({
            budget: b,
            spent,
            remaining: b.amount - spent,
            percentUsed: b.amount > 0 ? Number(((spent / b.amount) * 100).toFixed(2)) : 0
          });
        }
        return { content: [{ type: "text", text: JSON.stringify(statusList, null, 2) }] };
      }

      throw new Error(`Invalid action '${action}' for manage_budget. Valid actions: list, create, status`);
    }

    // --- Tool: record_transaction ---
    if (name === "record_transaction") {
      const { walletId, categoryId, budgetId, amount, type, description, isPlanned, transactionDate } = (args || {}) as any;
      
      if (typeof amount !== "number" || amount <= 0) {
        throw new Error("Transaction 'amount' must be a positive number greater than 0");
      }
      if (!walletId || typeof walletId !== "number") {
        throw new Error("Valid numeric 'walletId' is required");
      }
      if (!categoryId || typeof categoryId !== "number") {
        throw new Error("Valid numeric 'categoryId' is required");
      }

      const wallet = await db.select().from(schema.wallets).where(and(eq(schema.wallets.id, walletId), eq(schema.wallets.userId, userId))).get();
      if (!wallet) throw new Error(`Wallet ID ${walletId} not found or unauthorized`);

      const category = await db.select().from(schema.categories).where(and(eq(schema.categories.id, categoryId), eq(schema.categories.userId, userId))).get();
      if (!category) throw new Error(`Category ID ${categoryId} not found or unauthorized`);

      if (budgetId) {
        const budget = await db.select().from(schema.budgets).where(and(eq(schema.budgets.id, budgetId), eq(schema.budgets.userId, userId))).get();
        if (!budget) throw new Error(`Budget ID ${budgetId} not found or unauthorized`);
      }

      const dateStr = transactionDate || new Date().toISOString().split("T")[0];
      const isPlannedInt = isPlanned ? 1 : 0;
      const txType = type || "expense";

      const tx = await db.insert(schema.transactions).values({
        userId,
        walletId,
        categoryId,
        budgetId: budgetId || null,
        amount,
        type: txType,
        description: description || null,
        isPlanned: isPlannedInt,
        transactionDate: dateStr
      }).returning();

      // Update wallet balance if transaction is actual (isPlanned == 0)
      if (!isPlannedInt) {
        let newBalance = wallet.balance;
        if (txType === "expense") newBalance -= amount;
        else if (txType === "income") newBalance += amount;

        await db.update(schema.wallets)
          .set({ balance: newBalance })
          .where(eq(schema.wallets.id, walletId));
      }

      return { content: [{ type: "text", text: JSON.stringify(tx[0], null, 2) }] };
    }

    // --- Tool: list_transactions ---
    if (name === "list_transactions") {
      const { walletId, categoryId, budgetId, type, isPlanned, startDate, endDate, limit = 50 } = (args || {}) as any;
      const conditions = [eq(schema.transactions.userId, userId)];
      
      if (walletId !== undefined) conditions.push(eq(schema.transactions.walletId, walletId));
      if (categoryId !== undefined) conditions.push(eq(schema.transactions.categoryId, categoryId));
      if (budgetId !== undefined) conditions.push(eq(schema.transactions.budgetId, budgetId));
      if (type !== undefined) conditions.push(eq(schema.transactions.type, type));
      if (isPlanned !== undefined) conditions.push(eq(schema.transactions.isPlanned, isPlanned ? 1 : 0));
      if (startDate !== undefined) conditions.push(gte(schema.transactions.transactionDate, startDate));
      if (endDate !== undefined) conditions.push(lte(schema.transactions.transactionDate, endDate));

      const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 200);

      const txs = await db.select()
        .from(schema.transactions)
        .where(and(...conditions))
        .orderBy(desc(schema.transactions.transactionDate), desc(schema.transactions.id))
        .limit(safeLimit);

      return { content: [{ type: "text", text: JSON.stringify(txs, null, 2) }] };
    }

    // --- Tool: financial_summary ---
    if (name === "financial_summary") {
      const { startDate, endDate } = (args || {}) as any;
      
      // 1. Calculate net worth across all user wallets
      const walletsData = await db.select().from(schema.wallets).where(eq(schema.wallets.userId, userId));
      const netWorth = walletsData.reduce((sum, w) => sum + w.balance, 0);

      // 2. Query non-planned transactions
      const conditions = [
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.isPlanned, 0)
      ];
      if (startDate !== undefined) conditions.push(gte(schema.transactions.transactionDate, startDate));
      if (endDate !== undefined) conditions.push(lte(schema.transactions.transactionDate, endDate));

      const txs = await db.select().from(schema.transactions).where(and(...conditions));
      
      // 3. Map categories for human-readable breakdown
      const categoriesData = await db.select().from(schema.categories).where(eq(schema.categories.userId, userId));
      const categoryMap = new Map(categoriesData.map(c => [c.id, c.name]));

      let totalIncome = 0;
      let totalExpense = 0;
      const categoryBreakdown: Record<string, number> = {};

      for (const tx of txs) {
        if (tx.type === "income") totalIncome += tx.amount;
        if (tx.type === "expense") {
          totalExpense += tx.amount;
          const catName = categoryMap.get(tx.categoryId) || `Category #${tx.categoryId}`;
          categoryBreakdown[catName] = (categoryBreakdown[catName] || 0) + tx.amount;
        }
      }

      const summary = {
        netWorth: Number(netWorth.toFixed(2)),
        totalIncome: Number(totalIncome.toFixed(2)),
        totalExpense: Number(totalExpense.toFixed(2)),
        netSavings: Number((totalIncome - totalExpense).toFixed(2)),
        walletsCount: walletsData.length,
        transactionsCount: txs.length,
        categoryBreakdown
      };

      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }

    throw new Error(`Tool not found: ${name}`);
  });

  return server;
}
