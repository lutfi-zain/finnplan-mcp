import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import { eq, and, desc, gte, lte, sql } from "drizzle-orm";
import {
  generateApiKey,
  generateUserId,
  generateUserToken,
  verifyUserToken,
  hashApiKey,
  isValidEmail,
  isValidWhatsApp,
  DEFAULT_TOKEN_EXPIRY_SECONDS,
} from "./utils/token";

// Helper validators
function isValidPositiveNumber(val: any): boolean {
  return typeof val === "number" && Number.isFinite(val) && val > 0;
}

function isValidFiniteNumber(val: any): boolean {
  return typeof val === "number" && Number.isFinite(val);
}

function isValidDate(dateStr: string): boolean {
  if (!dateStr || typeof dateStr !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const timestamp = Date.parse(dateStr);
  return !isNaN(timestamp);
}

function isValidUUID(id: any): boolean {
  return typeof id === "string" && id.trim().length > 0;
}

export function createMCPServer(
  db: DrizzleD1Database<typeof schema>,
  userId: string | null,
  jwtSecret: string
) {
  if (!jwtSecret || typeof jwtSecret !== "string" || jwtSecret.trim() === "") {
    throw new Error("Server configuration error: JWT_SECRET is required to initialize MCP server");
  }

  // Helper to dynamically resolve user ID from HTTP headers (userId) or tool arguments (apiKey/token)
  async function resolveEffectiveUserId(args?: any): Promise<string | null> {
    if (userId) return userId;

    const candidate = args?.apiKey || args?.token;
    if (!candidate || typeof candidate !== "string") return null;
    const clean = candidate.trim();
    if (clean.length === 0) return null;

    // Case A: Persistent API Key (starts with fp_live_ or raw key)
    if (clean.startsWith("fp_live_")) {
      try {
        const hash = await hashApiKey(clean);
        const user = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.apiKeyHash, hash)).get();
        return user ? user.id : null;
      } catch {
        return null;
      }
    }

    // Case B: Self-Contained JWT Token
    try {
      const jwtUser = await verifyUserToken(clean, jwtSecret);
      if (jwtUser) return jwtUser.userId;
    } catch {
      // Continue to fallback
    }

    // Case C: Fallback raw API key lookup
    try {
      const hash = await hashApiKey(clean);
      const user = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.apiKeyHash, hash)).get();
      return user ? user.id : null;
    } catch {
      return null;
    }
  }

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
          users: ["id (PK UUID)", "first_name", "last_name", "email (UNIQUE)", "whatsapp_number", "api_key_hash (UNIQUE)", "created_at"],
          wallets: ["id (PK UUID)", "user_id (FK CASCADE)", "name", "type", "balance", "currency", "created_at"],
          categories: ["id (PK UUID)", "user_id (FK CASCADE)", "name", "type", "icon", "created_at"],
          budgets: ["id (PK UUID)", "user_id (FK CASCADE)", "name", "category_id (FK SET NULL)", "amount", "period_start", "period_end", "created_at"],
          transactions: [
            "id (PK UUID)", "user_id (FK CASCADE)", "wallet_id (FK RESTRICT)", "category_id (FK RESTRICT)", "budget_id (FK SET NULL)",
            "amount", "type", "description", "is_planned", "transaction_date", "created_at"
          ]
        },
        indexes: {
          users: ["users_email_idx", "users_api_key_hash_idx"],
          wallets: ["wallets_user_id_idx"],
          categories: ["categories_user_id_idx"],
          budgets: ["budgets_user_period_idx", "budgets_category_id_idx"],
          transactions: ["transactions_user_date_idx", "transactions_wallet_id_idx", "transactions_category_id_idx", "transactions_budget_id_idx"]
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
    const effectiveUserId = await resolveEffectiveUserId();
    if (!effectiveUserId) {
      throw new Error("Unauthorized: Session token is missing or expired. Please set 'Authorization: Bearer <apiKey>' in your MCP client headers or call 'login_user' / 'register_user'.");
    }

    if (uri === "finance://wallets/list") {
      const userWallets = await db.select().from(schema.wallets).where(eq(schema.wallets.userId, effectiveUserId));
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
            eq(schema.budgets.userId, effectiveUserId),
            lte(schema.budgets.periodStart, today),
            gte(schema.budgets.periodEnd, today)
          )
        );

      const statusList = [];
      for (const b of activeBudgets) {
        const conditions = [
          eq(schema.transactions.userId, effectiveUserId),
          eq(schema.transactions.isPlanned, 0),
          eq(schema.transactions.type, "expense"),
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
          spent: Number(spent.toFixed(2)),
          remaining: Number((b.amount - spent).toFixed(2)),
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
            firstName: { type: "string", description: "User's first name (1-100 characters)" },
            lastName: { type: "string", description: "User's last name (1-100 characters)" },
            email: { type: "string", description: "Valid email address (e.g. user@example.com)" },
            whatsappNumber: { type: "string", description: "WhatsApp phone number with '+' and country code (e.g. +6281234567890)" }
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
      // Finance Tools (Authenticated with Persistent API Key or JWT)
      {
        name: "record_transaction",
        description: "Record a financial transaction (expense or income). Automatically and atomically updates wallet balance.",
        inputSchema: {
          type: "object",
          properties: {
            walletId: { type: "string", description: "Target Wallet UUID" },
            categoryId: { type: "string", description: "Target Category UUID" },
            budgetId: { type: "string", description: "Optional: Linked Budget UUID" },
            amount: { type: "number", minimum: 0.01, description: "Transaction amount (positive finite number)" },
            type: { type: "string", enum: ["expense", "income"], default: "expense" },
            description: { type: "string", description: "Transaction note or description (max 500 characters)" },
            isPlanned: { type: "boolean", default: false, description: "Set true for projected transactions without altering balance" },
            transactionDate: { type: "string", description: "ISO date format (YYYY-MM-DD). Defaults to today." },
            apiKey: { type: "string", description: "Optional: Your persistent API Key (fp_live_...) if not set in headers" }
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
            name: { type: "string", description: "Wallet name (1-100 characters)" },
            type: { type: "string", enum: ["bank", "cash", "e-wallet", "credit"], description: "Wallet type" },
            balance: { type: "number", description: "Initial balance or updated balance (finite number)" },
            currency: { type: "string", default: "IDR", description: "Currency code (e.g. IDR, USD)" },
            walletId: { type: "string", description: "Required for update action (Wallet UUID)" },
            apiKey: { type: "string", description: "Optional: Your persistent API Key (fp_live_...) if not set in headers" }
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
            name: { type: "string", description: "Category name (1-100 characters)" },
            type: { type: "string", enum: ["expense", "income"], default: "expense" },
            icon: { type: "string", description: "Emoji icon representation (max 10 characters)" },
            apiKey: { type: "string", description: "Optional: Your persistent API Key (fp_live_...) if not set in headers" }
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
            name: { type: "string", description: "Budget title (1-100 characters)" },
            categoryId: { type: "string", description: "Optional category filter UUID" },
            amount: { type: "number", minimum: 0.01, description: "Budget target limit amount (positive finite number)" },
            periodStart: { type: "string", description: "Start date of active window (YYYY-MM-DD)" },
            periodEnd: { type: "string", description: "End date of active window (YYYY-MM-DD)" },
            apiKey: { type: "string", description: "Optional: Your persistent API Key (fp_live_...) if not set in headers" }
          },
          required: ["action"]
        }
      },
      {
        name: "list_transactions",
        description: "Query transactions with structured filters (wallet, category, budget, date range, is_planned, pagination).",
        inputSchema: {
          type: "object",
          properties: {
            walletId: { type: "string", description: "Wallet UUID filter" },
            categoryId: { type: "string", description: "Category UUID filter" },
            budgetId: { type: "string", description: "Budget UUID filter" },
            type: { type: "string", enum: ["expense", "income"] },
            isPlanned: { type: "boolean" },
            startDate: { type: "string", description: "YYYY-MM-DD" },
            endDate: { type: "string", description: "YYYY-MM-DD" },
            limit: { type: "integer", default: 50, maximum: 200 },
            offset: { type: "integer", default: 0, minimum: 0 },
            apiKey: { type: "string", description: "Optional: Your persistent API Key (fp_live_...) if not set in headers" }
          }
        }
      },
      {
        name: "financial_summary",
        description: "Generate a complete financial report grouped by currency (net worth by currency, income, expenses, category breakdown).",
        inputSchema: {
          type: "object",
          properties: {
            startDate: { type: "string", description: "Start date filter (YYYY-MM-DD)" },
            endDate: { type: "string", description: "End date filter (YYYY-MM-DD)" },
            apiKey: { type: "string", description: "Optional: Your persistent API Key (fp_live_...) if not set in headers" }
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
      const { firstName, lastName, email, whatsappNumber } = (args || {}) as any;

      if (!firstName || typeof firstName !== "string" || firstName.trim().length === 0 || firstName.trim().length > 100) {
        throw new Error("Validation Error: 'firstName' is required and must be between 1 and 100 characters");
      }
      if (!lastName || typeof lastName !== "string" || lastName.trim().length === 0 || lastName.trim().length > 100) {
        throw new Error("Validation Error: 'lastName' is required and must be between 1 and 100 characters");
      }
      if (!isValidEmail(email) || (typeof email === "string" && email.length > 255)) {
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

      // Secure server-side user ID (UUID V4 based)
      const newUserId = generateUserId();
      const apiKey = generateApiKey();
      const apiKeyHash = await hashApiKey(apiKey);
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
        apiKeyHash
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
      const apiKeyHash = await hashApiKey(cleanKey);
      const user = await db.select().from(schema.users).where(eq(schema.users.apiKeyHash, apiKeyHash)).get();
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
    const effectiveUserId = await resolveEffectiveUserId(args);
    if (!effectiveUserId) {
      throw new Error("Unauthorized: Please provide your 'apiKey' in tool arguments (e.g. apiKey: 'fp_live_...'), or set 'Authorization: Bearer <apiKey>' in your MCP client headers, or call 'register_user' to create an account.");
    }

    // --- Tool: manage_wallet ---
    if (name === "manage_wallet") {
      const { action, name: walletName, type, balance, currency, walletId } = (args || {}) as any;
      
      if (action === "list") {
        const result = await db.select().from(schema.wallets).where(eq(schema.wallets.userId, effectiveUserId));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      
      if (action === "create") {
        if (!walletName || typeof walletName !== "string" || walletName.trim().length === 0 || walletName.trim().length > 100) {
          throw new Error("Validation Error: Wallet 'name' is required (1-100 characters)");
        }
        const allowedTypes = ["bank", "cash", "e-wallet", "credit"];
        const cleanType = type && allowedTypes.includes(type) ? type : "bank";
        const cleanBalance = isValidFiniteNumber(balance) ? balance : 0;
        const cleanCurrency = currency && typeof currency === "string" && currency.trim().length > 0 && currency.trim().length <= 10
          ? currency.trim().toUpperCase()
          : "IDR";

        const newWalletId = crypto.randomUUID();
        const result = await db.insert(schema.wallets).values({
          id: newWalletId,
          userId: effectiveUserId,
          name: walletName.trim(),
          type: cleanType,
          balance: cleanBalance,
          currency: cleanCurrency
        }).returning();
        return { content: [{ type: "text", text: JSON.stringify(result[0], null, 2) }] };
      }
      
      if (action === "update") {
        if (!isValidUUID(walletId)) {
          throw new Error("Validation Error: Valid string 'walletId' (UUID) is required for update action");
        }
        const cleanWalletId = walletId.trim();
        const existing = await db.select().from(schema.wallets).where(and(eq(schema.wallets.id, cleanWalletId), eq(schema.wallets.userId, effectiveUserId))).get();
        if (!existing) {
          throw new Error(`Wallet ID ${cleanWalletId} not found or unauthorized`);
        }

        const updates: any = {};
        if (walletName && typeof walletName === "string" && walletName.trim().length > 0 && walletName.trim().length <= 100) {
          updates.name = walletName.trim();
        }
        if (balance !== undefined) {
          if (!isValidFiniteNumber(balance)) {
            throw new Error("Validation Error: 'balance' must be a valid finite number");
          }
          updates.balance = balance;
        }
        if (type && ["bank", "cash", "e-wallet", "credit"].includes(type)) {
          updates.type = type;
        }
        if (currency && typeof currency === "string" && currency.trim().length > 0 && currency.trim().length <= 10) {
          updates.currency = currency.trim().toUpperCase();
        }

        const result = await db.update(schema.wallets)
          .set(updates)
          .where(and(eq(schema.wallets.id, cleanWalletId), eq(schema.wallets.userId, effectiveUserId)))
          .returning();
        return { content: [{ type: "text", text: JSON.stringify(result[0], null, 2) }] };
      }

      throw new Error(`Invalid action '${action}' for manage_wallet. Valid actions: list, create, update`);
    }

    // --- Tool: manage_category ---
    if (name === "manage_category") {
      const { action, name: catName, type, icon } = (args || {}) as any;
      
      if (action === "list") {
        const result = await db.select().from(schema.categories).where(eq(schema.categories.userId, effectiveUserId));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      
      if (action === "create") {
        if (!catName || typeof catName !== "string" || catName.trim().length === 0 || catName.trim().length > 100) {
          throw new Error("Validation Error: Category 'name' is required (1-100 characters)");
        }
        const cleanIcon = icon && typeof icon === "string" && icon.trim().length <= 10 ? icon.trim() : null;
        const newCategoryId = crypto.randomUUID();

        const result = await db.insert(schema.categories).values({
          id: newCategoryId,
          userId: effectiveUserId,
          name: catName.trim(),
          type: type === "income" ? "income" : "expense",
          icon: cleanIcon
        }).returning();
        return { content: [{ type: "text", text: JSON.stringify(result[0], null, 2) }] };
      }

      throw new Error(`Invalid action '${action}' for manage_category. Valid actions: list, create`);
    }

    // --- Tool: manage_budget ---
    if (name === "manage_budget") {
      const { action, name: budgetName, categoryId, amount, periodStart, periodEnd } = (args || {}) as any;
      
      if (action === "list") {
        const result = await db.select().from(schema.budgets).where(eq(schema.budgets.userId, effectiveUserId));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      
      if (action === "create") {
        if (!budgetName || typeof budgetName !== "string" || budgetName.trim().length === 0 || budgetName.trim().length > 100) {
          throw new Error("Validation Error: Budget 'name' is required (1-100 characters)");
        }
        if (!isValidPositiveNumber(amount)) {
          throw new Error("Validation Error: Budget 'amount' must be a positive finite number");
        }
        if (!isValidDate(periodStart) || !isValidDate(periodEnd)) {
          throw new Error("Validation Error: 'periodStart' and 'periodEnd' must be valid ISO dates (YYYY-MM-DD)");
        }
        if (periodStart > periodEnd) {
          throw new Error("Validation Error: 'periodStart' cannot be after 'periodEnd'");
        }

        let cleanCategoryId: string | null = null;
        if (categoryId) {
          if (!isValidUUID(categoryId)) {
            throw new Error("Validation Error: 'categoryId' must be a valid string (UUID)");
          }
          const targetCatId = (categoryId as string).trim();
          const category = await db.select().from(schema.categories).where(and(eq(schema.categories.id, targetCatId), eq(schema.categories.userId, effectiveUserId))).get();
          if (!category) {
            throw new Error(`Category ID ${targetCatId} not found or unauthorized`);
          }
          cleanCategoryId = targetCatId;
        }

        const newBudgetId = crypto.randomUUID();
        const result = await db.insert(schema.budgets).values({
          id: newBudgetId,
          userId: effectiveUserId,
          name: budgetName.trim(),
          categoryId: cleanCategoryId,
          amount,
          periodStart,
          periodEnd
        }).returning();
        return { content: [{ type: "text", text: JSON.stringify(result[0], null, 2) }] };
      }
      
      if (action === "status") {
        const budgets = await db.select().from(schema.budgets).where(eq(schema.budgets.userId, effectiveUserId));
        const statusList = [];
        for (const b of budgets) {
          const conditions = [
            eq(schema.transactions.userId, effectiveUserId),
            eq(schema.transactions.isPlanned, 0),
            eq(schema.transactions.type, "expense"),
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
            spent: Number(spent.toFixed(2)),
            remaining: Number((b.amount - spent).toFixed(2)),
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
      
      if (!isValidPositiveNumber(amount)) {
        throw new Error("Validation Error: Transaction 'amount' must be a positive finite number greater than 0");
      }
      if (!isValidUUID(walletId)) {
        throw new Error("Validation Error: Valid string 'walletId' (UUID) is required");
      }
      if (!isValidUUID(categoryId)) {
        throw new Error("Validation Error: Valid string 'categoryId' (UUID) is required");
      }
      if (transactionDate && !isValidDate(transactionDate)) {
        throw new Error("Validation Error: 'transactionDate' must be in ISO format (YYYY-MM-DD)");
      }
      if (description && (typeof description !== "string" || description.length > 500)) {
        throw new Error("Validation Error: 'description' cannot exceed 500 characters");
      }

      const cleanWalletId = walletId.trim();
      const cleanCategoryId = categoryId.trim();
      const txType = type === "income" ? "income" : "expense";

      const wallet = await db.select().from(schema.wallets).where(and(eq(schema.wallets.id, cleanWalletId), eq(schema.wallets.userId, effectiveUserId))).get();
      if (!wallet) throw new Error(`Wallet ID ${cleanWalletId} not found or unauthorized`);

      const category = await db.select().from(schema.categories).where(and(eq(schema.categories.id, cleanCategoryId), eq(schema.categories.userId, effectiveUserId))).get();
      if (!category) throw new Error(`Category ID ${cleanCategoryId} not found or unauthorized`);

      let cleanBudgetId: string | null = null;
      if (budgetId) {
        if (!isValidUUID(budgetId)) {
          throw new Error("Validation Error: 'budgetId' must be a valid string (UUID)");
        }
        const targetBudgetId = (budgetId as string).trim();
        const budget = await db.select().from(schema.budgets).where(and(eq(schema.budgets.id, targetBudgetId), eq(schema.budgets.userId, effectiveUserId))).get();
        if (!budget) throw new Error(`Budget ID ${targetBudgetId} not found or unauthorized`);
        cleanBudgetId = targetBudgetId;
      }

      const dateStr = transactionDate || new Date().toISOString().split("T")[0];
      const isPlannedInt = isPlanned ? 1 : 0;
      const newTransactionId = crypto.randomUUID();

      const tx = await db.insert(schema.transactions).values({
        id: newTransactionId,
        userId: effectiveUserId,
        walletId: cleanWalletId,
        categoryId: cleanCategoryId,
        budgetId: cleanBudgetId,
        amount,
        type: txType,
        description: description ? description.trim() : null,
        isPlanned: isPlannedInt,
        transactionDate: dateStr
      }).returning();

      // Atomic wallet balance update for actual transactions (isPlanned == 0)
      if (!isPlannedInt) {
        const balanceDelta = txType === "expense" ? -amount : amount;
        await db.update(schema.wallets)
          .set({ balance: sql`balance + ${balanceDelta}` })
          .where(and(eq(schema.wallets.id, cleanWalletId), eq(schema.wallets.userId, effectiveUserId)));
      }

      return { content: [{ type: "text", text: JSON.stringify(tx[0], null, 2) }] };
    }

    // --- Tool: list_transactions ---
    if (name === "list_transactions") {
      const { walletId, categoryId, budgetId, type, isPlanned, startDate, endDate, limit = 50, offset = 0 } = (args || {}) as any;
      const conditions = [eq(schema.transactions.userId, effectiveUserId)];
      
      if (walletId !== undefined && typeof walletId === "string" && walletId.trim() !== "") {
        conditions.push(eq(schema.transactions.walletId, walletId.trim()));
      }
      if (categoryId !== undefined && typeof categoryId === "string" && categoryId.trim() !== "") {
        conditions.push(eq(schema.transactions.categoryId, categoryId.trim()));
      }
      if (budgetId !== undefined && typeof budgetId === "string" && budgetId.trim() !== "") {
        conditions.push(eq(schema.transactions.budgetId, budgetId.trim()));
      }
      if (type !== undefined && (type === "expense" || type === "income")) {
        conditions.push(eq(schema.transactions.type, type));
      }
      if (isPlanned !== undefined) {
        conditions.push(eq(schema.transactions.isPlanned, isPlanned ? 1 : 0));
      }
      if (startDate !== undefined) {
        if (!isValidDate(startDate)) throw new Error("Validation Error: 'startDate' must be YYYY-MM-DD");
        conditions.push(gte(schema.transactions.transactionDate, startDate));
      }
      if (endDate !== undefined) {
        if (!isValidDate(endDate)) throw new Error("Validation Error: 'endDate' must be YYYY-MM-DD");
        conditions.push(lte(schema.transactions.transactionDate, endDate));
      }

      const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 200);
      const safeOffset = Math.max(0, Number(offset) || 0);

      const txs = await db.select()
        .from(schema.transactions)
        .where(and(...conditions))
        .orderBy(desc(schema.transactions.transactionDate), desc(schema.transactions.createdAt))
        .limit(safeLimit)
        .offset(safeOffset);

      return { content: [{ type: "text", text: JSON.stringify(txs, null, 2) }] };
    }

    // --- Tool: financial_summary ---
    if (name === "financial_summary") {
      const { startDate, endDate } = (args || {}) as any;
      
      if (startDate !== undefined && !isValidDate(startDate)) throw new Error("Validation Error: 'startDate' must be YYYY-MM-DD");
      if (endDate !== undefined && !isValidDate(endDate)) throw new Error("Validation Error: 'endDate' must be YYYY-MM-DD");

      // 1. Group net worth by currency across all user wallets
      const walletsData = await db.select().from(schema.wallets).where(eq(schema.wallets.userId, effectiveUserId));
      const netWorthByCurrency: Record<string, number> = {};
      for (const w of walletsData) {
        netWorthByCurrency[w.currency] = Number(((netWorthByCurrency[w.currency] || 0) + w.balance).toFixed(2));
      }

      // 2. Query non-planned transactions
      const conditions = [
        eq(schema.transactions.userId, effectiveUserId),
        eq(schema.transactions.isPlanned, 0)
      ];
      if (startDate !== undefined) conditions.push(gte(schema.transactions.transactionDate, startDate));
      if (endDate !== undefined) conditions.push(lte(schema.transactions.transactionDate, endDate));

      const txs = await db.select().from(schema.transactions).where(and(...conditions));
      
      // 3. Map categories for human-readable breakdown
      const categoriesData = await db.select().from(schema.categories).where(eq(schema.categories.userId, effectiveUserId));
      const categoryMap = new Map(categoriesData.map(c => [c.id, c.name]));

      let totalIncome = 0;
      let totalExpense = 0;
      const categoryBreakdown: Record<string, number> = {};

      for (const tx of txs) {
        if (tx.type === "income") totalIncome += tx.amount;
        if (tx.type === "expense") {
          totalExpense += tx.amount;
          const catName = categoryMap.get(tx.categoryId) || `Category #${tx.categoryId}`;
          categoryBreakdown[catName] = Number(((categoryBreakdown[catName] || 0) + tx.amount).toFixed(2));
        }
      }

      const summary = {
        netWorthByCurrency,
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
