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
import {
  isValidIsoDateOrTimestamp,
  normalizeToIsoTimestamp,
  currentIsoTimestamp,
} from "./utils/date";

// Helper validators
function isValidPositiveNumber(val: any): boolean {
  return typeof val === "number" && Number.isFinite(val) && val > 0;
}

function isValidFiniteNumber(val: any): boolean {
  return typeof val === "number" && Number.isFinite(val);
}

function isValidUUID(id: any): boolean {
  return typeof id === "string" && id.trim().length > 0;
}

export type MCPOptions = {
  githubToken?: string;
  githubRepo?: string;
  fetchFn?: typeof fetch;
};

async function createGithubIssue(opts: {
  token: string;
  repo: string;
  title: string;
  body: string;
  labels?: string[];
  fetchFn?: typeof fetch;
}): Promise<{ issueUrl: string; issueNumber: number }> {
  const fetchImpl = opts.fetchFn || fetch;
  const url = `https://api.github.com/repos/${opts.repo}/issues`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${opts.token}`,
      "User-Agent": "Eve-Finance-MCP-Server",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title: opts.title,
      body: opts.body,
      labels: opts.labels || ["feedback", "user-submitted"]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as any;
  return {
    issueUrl: data.html_url || `https://github.com/${opts.repo}/issues/${data.number}`,
    issueNumber: data.number
  };
}

export function createMCPServer(
  db: DrizzleD1Database<typeof schema>,
  userId: string | null,
  jwtSecret: string,
  options?: MCPOptions
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
        const user = await db.select({ userId: schema.users.userId }).from(schema.users).where(eq(schema.users.userApiKeyHash, hash)).get();
        return user ? user.userId : null;
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
      const user = await db.select({ userId: schema.users.userId }).from(schema.users).where(eq(schema.users.userApiKeyHash, hash)).get();
      return user ? user.userId : null;
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
          users: [
            "user_id (PK UUID)", "user_first_name", "user_last_name", "user_email (UNIQUE)",
            "user_whatsapp_number", "user_api_key_hash (UNIQUE)", "user_created_at"
          ],
          wallets: [
            "wallet_id (PK UUID)", "wallet_user_id (FK CASCADE)", "wallet_name", "wallet_institution",
            "wallet_type", "wallet_balance", "wallet_currency", "wallet_created_at"
          ],
          categories: [
            "category_id (PK UUID)", "category_user_id (FK CASCADE)", "category_name", "category_type",
            "category_icon", "category_created_at"
          ],
          budgets: [
            "budget_id (PK UUID)", "budget_user_id (FK CASCADE)", "budget_name", "budget_category_id (FK SET NULL)",
            "budget_amount", "budget_period_start", "budget_period_end", "budget_created_at"
          ],
          transactions: [
            "transaction_id (PK UUID)", "transaction_user_id (FK CASCADE)", "transaction_wallet_id (FK CASCADE)",
            "transaction_target_wallet_id (FK SET NULL)", "transaction_category_id (FK SET NULL)", "transaction_budget_id (FK SET NULL)",
            "transaction_amount", "transaction_admin_fee", "transaction_type", "transaction_description",
            "transaction_is_planned", "transaction_date (ISO-8601 TZ)", "transaction_created_at"
          ]
        },
        indexes: {
          users: ["users_email_idx", "users_api_key_hash_idx"],
          wallets: ["wallets_user_id_idx", "wallets_institution_idx"],
          categories: ["categories_user_id_idx"],
          budgets: ["budgets_user_period_idx", "budgets_category_id_idx"],
          transactions: [
            "transactions_user_date_idx", "transactions_wallet_id_idx", "transactions_target_wallet_id_idx",
            "transactions_category_id_idx", "transactions_budget_id_idx"
          ]
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
      const userWallets = await db.select().from(schema.wallets).where(eq(schema.wallets.walletUserId, effectiveUserId));
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
      const nowIso = currentIsoTimestamp();
      const activeBudgets = await db.select()
        .from(schema.budgets)
        .where(
          and(
            eq(schema.budgets.budgetUserId, effectiveUserId),
            lte(schema.budgets.budgetPeriodStart, nowIso),
            gte(schema.budgets.budgetPeriodEnd, nowIso)
          )
        );

      const statusList = [];
      for (const b of activeBudgets) {
        const conditions = [
          eq(schema.transactions.transactionUserId, effectiveUserId),
          eq(schema.transactions.transactionIsPlanned, 0),
          eq(schema.transactions.transactionType, "expense"),
          gte(schema.transactions.transactionDate, b.budgetPeriodStart),
          lte(schema.transactions.transactionDate, b.budgetPeriodEnd)
        ];
        if (b.budgetCategoryId) {
          conditions.push(eq(schema.transactions.transactionCategoryId, b.budgetCategoryId));
        } else {
          conditions.push(eq(schema.transactions.transactionBudgetId, b.budgetId));
        }

        const txs = await db.select().from(schema.transactions).where(and(...conditions));
        const spent = txs.reduce((sum, tx) => sum + tx.transactionAmount, 0);
        statusList.push({
          budget: b,
          spent: Number(spent.toFixed(2)),
          remaining: Number((b.budgetAmount - spent).toFixed(2)),
          percentUsed: b.budgetAmount > 0 ? Number(((spent / b.budgetAmount) * 100).toFixed(2)) : 0
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
      // Authentication Tools
      {
        name: "register_user",
        description: "Register a new user account with first name, last name, email, and WhatsApp number. Returns a persistent API Key (fp_live_...) and 15-minute JWT.",
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
      // Feedback & Support Tool
      {
        name: "submit_feedback",
        description: "Submit user feedback, feature request, question, or bug report. Automatically creates a GitHub issue in the repository and logs the submitter's name, email, and timestamp.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short summary of feedback or issue (5-200 characters)" },
            feedback: { type: "string", description: "Detailed feedback, bug description, or feature request (10-4000 characters)" },
            type: {
              type: "string",
              enum: ["feedback", "bug", "feature_request", "question"],
              default: "feedback",
              description: "Category of feedback: feedback, bug, feature_request, or question"
            },
            name: { type: "string", description: "Optional: Submitter's full name (auto-resolved from profile if authenticated)" },
            email: { type: "string", description: "Optional: Submitter's email address (auto-resolved from profile if authenticated)" },
            apiKey: { type: "string", description: "Optional: Your persistent API Key (fp_live_...) if not set in headers" }
          },
          required: ["title", "feedback"]
        }
      },
      // Finance Tools (Authenticated with Persistent API Key or JWT)
      {
        name: "record_transaction",
        description: "Record a financial transaction (expense or income) with optional admin fee and ISO timezone timestamp. Automatically and atomically updates wallet balance.",
        inputSchema: {
          type: "object",
          properties: {
            walletId: { type: "string", description: "Target Wallet UUID" },
            categoryId: { type: "string", description: "Target Category UUID" },
            budgetId: { type: "string", description: "Optional: Linked Budget UUID" },
            amount: { type: "number", minimum: 0.01, description: "Transaction amount (positive finite number)" },
            adminFee: { type: "number", minimum: 0, default: 0, description: "Optional administrative or transaction fee" },
            type: { type: "string", enum: ["expense", "income"], default: "expense" },
            description: { type: "string", description: "Transaction note or description (max 500 characters)" },
            isPlanned: { type: "boolean", default: false, description: "Set true for projected transactions without altering balance" },
            transactionDate: { type: "string", description: "ISO-8601 timestamp with timezone (e.g. 2026-08-17T10:31:42+07:00 or YYYY-MM-DD). Defaults to now." },
            apiKey: { type: "string", description: "Optional: Your persistent API Key (fp_live_...) if not set in headers" }
          },
          required: ["walletId", "categoryId", "amount"]
        }
      },
      {
        name: "transfer_funds",
        description: "Transfer funds between two wallets with optional admin fee. Atomically debits source wallet (amount + adminFee) and credits target wallet (amount).",
        inputSchema: {
          type: "object",
          properties: {
            sourceWalletId: { type: "string", description: "Source / Sender Wallet UUID" },
            targetWalletId: { type: "string", description: "Destination / Receiver Wallet UUID" },
            amount: { type: "number", minimum: 0.01, description: "Transfer amount (positive finite number)" },
            adminFee: { type: "number", minimum: 0, default: 0, description: "Optional administrative / transfer fee (e.g. 2500, 6500)" },
            categoryId: { type: "string", description: "Optional Category UUID" },
            description: { type: "string", description: "Transfer note or memo (max 500 characters)" },
            isPlanned: { type: "boolean", default: false, description: "Set true for projected transfers without altering balance" },
            transactionDate: { type: "string", description: "ISO-8601 timestamp with timezone (e.g. 2026-08-17T10:31:42+07:00 or YYYY-MM-DD). Defaults to now." },
            apiKey: { type: "string", description: "Optional: Your persistent API Key (fp_live_...) if not set in headers" }
          },
          required: ["sourceWalletId", "targetWalletId", "amount"]
        }
      },
      {
        name: "update_transaction",
        description: "Update an existing transaction (amount, admin fee, wallet, category, budget, date, note, or planned status) with automatic atomic balance reconciliation.",
        inputSchema: {
          type: "object",
          properties: {
            transactionId: { type: "string", description: "Transaction UUID to update" },
            amount: { type: "number", minimum: 0.01, description: "New transaction amount" },
            adminFee: { type: "number", minimum: 0, description: "New admin fee" },
            walletId: { type: "string", description: "New Source Wallet UUID" },
            targetWalletId: { type: "string", description: "New Target Wallet UUID (for transfers)" },
            categoryId: { type: "string", description: "New Category UUID" },
            budgetId: { type: "string", description: "New Budget UUID (or empty string/null to unlink)" },
            description: { type: "string", description: "New description (max 500 characters)" },
            transactionDate: { type: "string", description: "New ISO-8601 timestamp with timezone (e.g. 2026-08-17T10:31:42+07:00)" },
            isPlanned: { type: "boolean", description: "New planned status" },
            apiKey: { type: "string", description: "Optional: Your persistent API Key (fp_live_...) if not set in headers" }
          },
          required: ["transactionId"]
        }
      },
      {
        name: "manage_wallet",
        description: "Manage wallets and pockets: list all wallets, create a new wallet/pocket (with institution grouping like BCA, Bank Jago, Bitget), or update an existing wallet.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "create", "update"], description: "Action to perform" },
            name: { type: "string", description: "Wallet / Pocket name (1-100 characters)" },
            institution: { type: "string", description: "Bank or Platform institution (e.g. 'BCA', 'Bank Jago', 'Bitget', 'OCBC', 'Cash')" },
            type: { type: "string", enum: ["bank", "cash", "e-wallet", "credit", "crypto", "investment"], description: "Wallet type" },
            balance: { type: "number", description: "Initial balance or updated balance (finite number)" },
            currency: { type: "string", default: "IDR", description: "Currency code (e.g. IDR, USD, USDT)" },
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
            periodStart: { type: "string", description: "Start ISO-8601 date or timestamp with timezone" },
            periodEnd: { type: "string", description: "End ISO-8601 date or timestamp with timezone" },
            apiKey: { type: "string", description: "Optional: Your persistent API Key (fp_live_...) if not set in headers" }
          },
          required: ["action"]
        }
      },
      {
        name: "list_transactions",
        description: "Query transactions with structured filters (wallet, target wallet, category, budget, type, date range, is_planned, pagination).",
        inputSchema: {
          type: "object",
          properties: {
            walletId: { type: "string", description: "Wallet UUID filter" },
            targetWalletId: { type: "string", description: "Target Wallet UUID filter (for transfers)" },
            categoryId: { type: "string", description: "Category UUID filter" },
            budgetId: { type: "string", description: "Budget UUID filter" },
            type: { type: "string", enum: ["expense", "income", "transfer"] },
            isPlanned: { type: "boolean" },
            startDate: { type: "string", description: "Start ISO-8601 date/timestamp filter" },
            endDate: { type: "string", description: "End ISO-8601 date/timestamp filter" },
            limit: { type: "integer", default: 50, maximum: 200 },
            offset: { type: "integer", default: 0, minimum: 0 },
            apiKey: { type: "string", description: "Optional: Your persistent API Key (fp_live_...) if not set in headers" }
          }
        }
      },
      {
        name: "financial_summary",
        description: "Generate a complete financial report grouped by currency and institution (net worth, income, expenses, admin fees, category breakdown).",
        inputSchema: {
          type: "object",
          properties: {
            startDate: { type: "string", description: "Start date filter" },
            endDate: { type: "string", description: "End date filter" },
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
      const existing = await db.select().from(schema.users).where(eq(schema.users.userEmail, normalizedEmail)).get();
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
      const nowIso = currentIsoTimestamp();

      await db.insert(schema.users).values({
        userId: newUserId,
        userFirstName: cleanFirstName,
        userLastName: cleanLastName,
        userEmail: normalizedEmail,
        userWhatsappNumber: cleanWhatsApp,
        userApiKeyHash: apiKeyHash,
        userCreatedAt: nowIso
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
      const user = await db.select().from(schema.users).where(eq(schema.users.userApiKeyHash, apiKeyHash)).get();
      if (!user) {
        throw new Error("Authentication Error: Invalid API Key. User not found. Please verify your API Key or register via 'register_user'.");
      }

      const fullName = `${user.userFirstName} ${user.userLastName}`.trim();
      const token = await generateUserToken({
        userId: user.userId,
        name: fullName,
        email: user.userEmail,
        expiresInSeconds: DEFAULT_TOKEN_EXPIRY_SECONDS
      }, jwtSecret);

      const responsePayload = {
        userId: user.userId,
        name: fullName,
        email: user.userEmail,
        token,
        tokenType: "Bearer",
        expiresIn: DEFAULT_TOKEN_EXPIRY_SECONDS,
        message: "Login successful! Please update 'Authorization: Bearer <token>' in your MCP client headers for subsequent tool calls."
      };

      return { content: [{ type: "text", text: JSON.stringify(responsePayload, null, 2) }] };
    }

    // --- Tool: submit_feedback ---
    if (name === "submit_feedback") {
      const { title, feedback, type = "feedback", name: submitterName, email: submitterEmail } = (args || {}) as any;

      if (!title || typeof title !== "string" || title.trim().length < 5 || title.trim().length > 200) {
        throw new Error("Validation Error: 'title' is required (5-200 characters)");
      }
      if (!feedback || typeof feedback !== "string" || feedback.trim().length < 10 || feedback.trim().length > 4000) {
        throw new Error("Validation Error: 'feedback' is required (10-4000 characters)");
      }

      let foundUserId: string | null = null;
      let userName = submitterName && typeof submitterName === "string" && submitterName.trim().length > 0 ? submitterName.trim() : null;
      let userEmail = submitterEmail && typeof submitterEmail === "string" && submitterEmail.trim().length > 0 ? submitterEmail.trim().toLowerCase() : null;

      const effectiveUserId = await resolveEffectiveUserId(args);
      if (effectiveUserId) {
        foundUserId = effectiveUserId;
        const user = await db.select().from(schema.users).where(eq(schema.users.userId, effectiveUserId)).get();
        if (user) {
          if (!userName) {
            userName = `${user.userFirstName} ${user.userLastName}`.trim();
          }
          if (!userEmail) {
            userEmail = user.userEmail;
          }
        }
      }

      if (!userName) {
        throw new Error("Validation Error: Submitter 'name' is required when unauthenticated. Please provide 'name' in arguments or authenticate with your API key.");
      }
      if (!userEmail || !isValidEmail(userEmail)) {
        throw new Error(`Validation Error: A valid 'email' is required. Received: '${userEmail || ""}'. Please provide a valid email or authenticate with your API key.`);
      }

      const githubToken = options?.githubToken;
      const githubRepo = options?.githubRepo || "lutfi-zain/finnplan-mcp";

      if (!githubToken) {
        throw new Error("Server Error: GitHub integration is not configured. Missing GITHUB_TOKEN environment secret.");
      }

      const validTypes = ["feedback", "bug", "feature_request", "question"];
      const feedbackType = validTypes.includes(type) ? type : "feedback";
      const typeLabel = feedbackType.replace("_", " ").toUpperCase();
      const issueTitle = `[${typeLabel}] ${title.trim()}`;

      const issueBody = [
        `### 📝 Feedback Description`,
        ``,
        feedback.trim(),
        ``,
        `---`,
        `### 👤 Submitter Details`,
        `| Field | Value |`,
        `| :--- | :--- |`,
        `| **Name** | ${userName} |`,
        `| **Email** | \`${userEmail}\` |`,
        `| **User ID** | ${foundUserId ? `\`${foundUserId}\`` : "_Unauthenticated Guest_"} |`,
        `| **Type** | \`${feedbackType}\` |`,
        `| **Submitted At** | ${currentIsoTimestamp()} |`
      ].join("\n");

      const labels = ["user-feedback", feedbackType];
      const issueResult = await createGithubIssue({
        token: githubToken,
        repo: githubRepo,
        title: issueTitle,
        body: issueBody,
        labels,
        fetchFn: options?.fetchFn
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Feedback submitted successfully and created as a GitHub issue!",
              issueUrl: issueResult.issueUrl,
              issueNumber: issueResult.issueNumber,
              type: feedbackType,
              submitter: {
                name: userName,
                email: userEmail,
                userId: foundUserId
              }
            }, null, 2)
          }
        ]
      };
    }

    // -------------------------------------------------------------------------
    // Guard: Require Authentication for All Finance Tools Below
    // -------------------------------------------------------------------------
    const effectiveUserId = await resolveEffectiveUserId(args);
    if (!effectiveUserId) {
      throw new Error("Unauthorized: Please provide your 'apiKey' in tool arguments (e.g. apiKey: 'fp_live_...'), or set 'Authorization: Bearer <apiKey>' in your MCP client headers, or call 'register_user' to create an account.");
    }

    // Helper for atomic wallet balance updates & reconciliations
    const applyBalanceDelta = async (
      txType: string,
      wId: string,
      targetWId: string | null,
      amt: number,
      fee: number,
      multiplier: 1 | -1
    ) => {
      if (txType === "expense") {
        const delta = -(amt + fee) * multiplier;
        await db.update(schema.wallets)
          .set({ walletBalance: sql`wallet_balance + ${delta}` })
          .where(and(eq(schema.wallets.walletId, wId), eq(schema.wallets.walletUserId, effectiveUserId)));
      } else if (txType === "income") {
        const delta = (amt - fee) * multiplier;
        await db.update(schema.wallets)
          .set({ walletBalance: sql`wallet_balance + ${delta}` })
          .where(and(eq(schema.wallets.walletId, wId), eq(schema.wallets.walletUserId, effectiveUserId)));
      } else if (txType === "transfer" && targetWId) {
        const sourceDelta = -(amt + fee) * multiplier;
        const targetDelta = amt * multiplier;
        await db.update(schema.wallets)
          .set({ walletBalance: sql`wallet_balance + ${sourceDelta}` })
          .where(and(eq(schema.wallets.walletId, wId), eq(schema.wallets.walletUserId, effectiveUserId)));
        await db.update(schema.wallets)
          .set({ walletBalance: sql`wallet_balance + ${targetDelta}` })
          .where(and(eq(schema.wallets.walletId, targetWId), eq(schema.wallets.walletUserId, effectiveUserId)));
      }
    };

    // --- Tool: manage_wallet ---
    if (name === "manage_wallet") {
      const { action, name: walletName, institution, type, balance, currency, walletId } = (args || {}) as any;
      
      if (action === "list") {
        const result = await db.select().from(schema.wallets).where(eq(schema.wallets.walletUserId, effectiveUserId));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      
      if (action === "create") {
        if (!walletName || typeof walletName !== "string" || walletName.trim().length === 0 || walletName.trim().length > 100) {
          throw new Error("Validation Error: Wallet 'name' is required (1-100 characters)");
        }
        const allowedTypes = ["bank", "cash", "e-wallet", "credit", "crypto", "investment"];
        const cleanType = type && allowedTypes.includes(type) ? type : "bank";
        const cleanBalance = isValidFiniteNumber(balance) ? balance : 0;
        const cleanCurrency = currency && typeof currency === "string" && currency.trim().length > 0 && currency.trim().length <= 10
          ? currency.trim().toUpperCase()
          : "IDR";
        const cleanInstitution = institution && typeof institution === "string" && institution.trim().length > 0
          ? institution.trim()
          : "General";

        const newWalletId = crypto.randomUUID();
        const nowIso = currentIsoTimestamp();
        const result = await db.insert(schema.wallets).values({
          walletId: newWalletId,
          walletUserId: effectiveUserId,
          walletName: walletName.trim(),
          walletInstitution: cleanInstitution,
          walletType: cleanType,
          walletBalance: cleanBalance,
          walletCurrency: cleanCurrency,
          walletCreatedAt: nowIso
        }).returning();
        return { content: [{ type: "text", text: JSON.stringify(result[0], null, 2) }] };
      }
      
      if (action === "update") {
        if (!isValidUUID(walletId)) {
          throw new Error("Validation Error: Valid string 'walletId' (UUID) is required for update action");
        }
        const cleanWalletId = walletId.trim();
        const existing = await db.select().from(schema.wallets).where(and(eq(schema.wallets.walletId, cleanWalletId), eq(schema.wallets.walletUserId, effectiveUserId))).get();
        if (!existing) {
          throw new Error(`Wallet ID ${cleanWalletId} not found or unauthorized`);
        }

        const updates: any = {};
        if (walletName && typeof walletName === "string" && walletName.trim().length > 0 && walletName.trim().length <= 100) {
          updates.walletName = walletName.trim();
        }
        if (institution && typeof institution === "string" && institution.trim().length > 0) {
          updates.walletInstitution = institution.trim();
        }
        if (balance !== undefined) {
          if (!isValidFiniteNumber(balance)) {
            throw new Error("Validation Error: 'balance' must be a valid finite number");
          }
          updates.walletBalance = balance;
        }
        if (type && ["bank", "cash", "e-wallet", "credit", "crypto", "investment"].includes(type)) {
          updates.walletType = type;
        }
        if (currency && typeof currency === "string" && currency.trim().length > 0 && currency.trim().length <= 10) {
          updates.walletCurrency = currency.trim().toUpperCase();
        }

        const result = await db.update(schema.wallets)
          .set(updates)
          .where(and(eq(schema.wallets.walletId, cleanWalletId), eq(schema.wallets.walletUserId, effectiveUserId)))
          .returning();
        return { content: [{ type: "text", text: JSON.stringify(result[0], null, 2) }] };
      }

      throw new Error(`Invalid action '${action}' for manage_wallet. Valid actions: list, create, update`);
    }

    // --- Tool: manage_category ---
    if (name === "manage_category") {
      const { action, name: catName, type, icon } = (args || {}) as any;
      
      if (action === "list") {
        const result = await db.select().from(schema.categories).where(eq(schema.categories.categoryUserId, effectiveUserId));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      
      if (action === "create") {
        if (!catName || typeof catName !== "string" || catName.trim().length === 0 || catName.trim().length > 100) {
          throw new Error("Validation Error: Category 'name' is required (1-100 characters)");
        }
        const cleanIcon = icon && typeof icon === "string" && icon.trim().length <= 10 ? icon.trim() : null;
        const newCategoryId = crypto.randomUUID();
        const nowIso = currentIsoTimestamp();

        const result = await db.insert(schema.categories).values({
          categoryId: newCategoryId,
          categoryUserId: effectiveUserId,
          categoryName: catName.trim(),
          categoryType: type === "income" ? "income" : "expense",
          categoryIcon: cleanIcon,
          categoryCreatedAt: nowIso
        }).returning();
        return { content: [{ type: "text", text: JSON.stringify(result[0], null, 2) }] };
      }

      throw new Error(`Invalid action '${action}' for manage_category. Valid actions: list, create`);
    }

    // --- Tool: manage_budget ---
    if (name === "manage_budget") {
      const { action, name: budgetName, categoryId, amount, periodStart, periodEnd } = (args || {}) as any;
      
      if (action === "list") {
        const result = await db.select().from(schema.budgets).where(eq(schema.budgets.budgetUserId, effectiveUserId));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      
      if (action === "create") {
        if (!budgetName || typeof budgetName !== "string" || budgetName.trim().length === 0 || budgetName.trim().length > 100) {
          throw new Error("Validation Error: Budget 'name' is required (1-100 characters)");
        }
        if (!isValidPositiveNumber(amount)) {
          throw new Error("Validation Error: Budget 'amount' must be a positive finite number");
        }
        if (!isValidIsoDateOrTimestamp(periodStart) || !isValidIsoDateOrTimestamp(periodEnd)) {
          throw new Error("Validation Error: 'periodStart' and 'periodEnd' must be valid ISO dates or timestamps (e.g. YYYY-MM-DD or YYYY-MM-DDTHH:mm:ssZ)");
        }
        const cleanStart = normalizeToIsoTimestamp(periodStart);
        const cleanEnd = normalizeToIsoTimestamp(periodEnd);
        if (cleanStart > cleanEnd) {
          throw new Error("Validation Error: 'periodStart' cannot be after 'periodEnd'");
        }

        let cleanCategoryId: string | null = null;
        if (categoryId) {
          if (!isValidUUID(categoryId)) {
            throw new Error("Validation Error: 'categoryId' must be a valid string (UUID)");
          }
          const targetCatId = (categoryId as string).trim();
          const category = await db.select().from(schema.categories).where(and(eq(schema.categories.categoryId, targetCatId), eq(schema.categories.categoryUserId, effectiveUserId))).get();
          if (!category) {
            throw new Error(`Category ID ${targetCatId} not found or unauthorized`);
          }
          cleanCategoryId = targetCatId;
        }

        const newBudgetId = crypto.randomUUID();
        const nowIso = currentIsoTimestamp();
        const result = await db.insert(schema.budgets).values({
          budgetId: newBudgetId,
          budgetUserId: effectiveUserId,
          budgetName: budgetName.trim(),
          budgetCategoryId: cleanCategoryId,
          budgetAmount: amount,
          budgetPeriodStart: cleanStart,
          budgetPeriodEnd: cleanEnd,
          budgetCreatedAt: nowIso
        }).returning();
        return { content: [{ type: "text", text: JSON.stringify(result[0], null, 2) }] };
      }
      
      if (action === "status") {
        const budgets = await db.select().from(schema.budgets).where(eq(schema.budgets.budgetUserId, effectiveUserId));
        const statusList = [];
        for (const b of budgets) {
          const conditions = [
            eq(schema.transactions.transactionUserId, effectiveUserId),
            eq(schema.transactions.transactionIsPlanned, 0),
            eq(schema.transactions.transactionType, "expense"),
            gte(schema.transactions.transactionDate, b.budgetPeriodStart),
            lte(schema.transactions.transactionDate, b.budgetPeriodEnd)
          ];
          if (b.budgetCategoryId) {
            conditions.push(eq(schema.transactions.transactionCategoryId, b.budgetCategoryId));
          } else {
            conditions.push(eq(schema.transactions.transactionBudgetId, b.budgetId));
          }

          const txs = await db.select().from(schema.transactions).where(and(...conditions));
          const spent = txs.reduce((sum, tx) => sum + tx.transactionAmount, 0);
          statusList.push({
            budget: b,
            spent: Number(spent.toFixed(2)),
            remaining: Number((b.budgetAmount - spent).toFixed(2)),
            percentUsed: b.budgetAmount > 0 ? Number(((spent / b.budgetAmount) * 100).toFixed(2)) : 0
          });
        }
        return { content: [{ type: "text", text: JSON.stringify(statusList, null, 2) }] };
      }

      throw new Error(`Invalid action '${action}' for manage_budget. Valid actions: list, create, status`);
    }

    // --- Tool: record_transaction ---
    if (name === "record_transaction") {
      const { walletId, categoryId, budgetId, amount, adminFee, type, description, isPlanned, transactionDate } = (args || {}) as any;
      
      if (!isValidPositiveNumber(amount)) {
        throw new Error("Validation Error: Transaction 'amount' must be a positive finite number greater than 0");
      }
      if (!isValidUUID(walletId)) {
        throw new Error("Validation Error: Valid string 'walletId' (UUID) is required");
      }
      if (!isValidUUID(categoryId)) {
        throw new Error("Validation Error: Valid string 'categoryId' (UUID) is required");
      }
      if (adminFee !== undefined && (!isValidFiniteNumber(adminFee) || adminFee < 0)) {
        throw new Error("Validation Error: 'adminFee' must be a non-negative finite number");
      }
      if (transactionDate && !isValidIsoDateOrTimestamp(transactionDate)) {
        throw new Error("Validation Error: 'transactionDate' must be in valid ISO format (e.g. YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss+07:00)");
      }
      if (description && (typeof description !== "string" || description.length > 500)) {
        throw new Error("Validation Error: 'description' cannot exceed 500 characters");
      }

      const cleanWalletId = walletId.trim();
      const cleanCategoryId = categoryId.trim();
      const cleanAdminFee = isValidFiniteNumber(adminFee) && adminFee >= 0 ? adminFee : 0;
      const txType = type === "income" ? "income" : "expense";

      const wallet = await db.select().from(schema.wallets).where(and(eq(schema.wallets.walletId, cleanWalletId), eq(schema.wallets.walletUserId, effectiveUserId))).get();
      if (!wallet) throw new Error(`Wallet ID ${cleanWalletId} not found or unauthorized`);

      const category = await db.select().from(schema.categories).where(and(eq(schema.categories.categoryId, cleanCategoryId), eq(schema.categories.categoryUserId, effectiveUserId))).get();
      if (!category) throw new Error(`Category ID ${cleanCategoryId} not found or unauthorized`);

      let cleanBudgetId: string | null = null;
      if (budgetId) {
        if (!isValidUUID(budgetId)) {
          throw new Error("Validation Error: 'budgetId' must be a valid string (UUID)");
        }
        const targetBudgetId = (budgetId as string).trim();
        const budget = await db.select().from(schema.budgets).where(and(eq(schema.budgets.budgetId, targetBudgetId), eq(schema.budgets.budgetUserId, effectiveUserId))).get();
        if (!budget) throw new Error(`Budget ID ${targetBudgetId} not found or unauthorized`);
        cleanBudgetId = targetBudgetId;
      }

      const dateStr = normalizeToIsoTimestamp(transactionDate);
      const isPlannedInt = isPlanned ? 1 : 0;
      const newTransactionId = crypto.randomUUID();
      const nowIso = currentIsoTimestamp();

      const tx = await db.insert(schema.transactions).values({
        transactionId: newTransactionId,
        transactionUserId: effectiveUserId,
        transactionWalletId: cleanWalletId,
        transactionCategoryId: cleanCategoryId,
        transactionBudgetId: cleanBudgetId,
        transactionAmount: amount,
        transactionAdminFee: cleanAdminFee,
        transactionType: txType,
        transactionDescription: description ? description.trim() : null,
        transactionIsPlanned: isPlannedInt,
        transactionDate: dateStr,
        transactionCreatedAt: nowIso
      }).returning();

      // Atomic wallet balance update for actual transactions (isPlanned == 0)
      if (!isPlannedInt) {
        await applyBalanceDelta(txType, cleanWalletId, null, amount, cleanAdminFee, 1);
      }

      return { content: [{ type: "text", text: JSON.stringify(tx[0], null, 2) }] };
    }

    // --- Tool: transfer_funds ---
    if (name === "transfer_funds") {
      const { sourceWalletId, targetWalletId, amount, adminFee, categoryId, description, isPlanned, transactionDate } = (args || {}) as any;

      if (!isValidPositiveNumber(amount)) {
        throw new Error("Validation Error: Transfer 'amount' must be a positive finite number greater than 0");
      }
      if (!isValidUUID(sourceWalletId)) {
        throw new Error("Validation Error: Valid string 'sourceWalletId' (UUID) is required");
      }
      if (!isValidUUID(targetWalletId)) {
        throw new Error("Validation Error: Valid string 'targetWalletId' (UUID) is required");
      }
      if (sourceWalletId.trim() === targetWalletId.trim()) {
        throw new Error("Validation Error: 'sourceWalletId' and 'targetWalletId' cannot be the same wallet");
      }
      if (adminFee !== undefined && (!isValidFiniteNumber(adminFee) || adminFee < 0)) {
        throw new Error("Validation Error: 'adminFee' must be a non-negative finite number");
      }
      if (transactionDate && !isValidIsoDateOrTimestamp(transactionDate)) {
        throw new Error("Validation Error: 'transactionDate' must be in valid ISO format (e.g. YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss+07:00)");
      }
      if (description && (typeof description !== "string" || description.length > 500)) {
        throw new Error("Validation Error: 'description' cannot exceed 500 characters");
      }

      const cleanSourceWalletId = sourceWalletId.trim();
      const cleanTargetWalletId = targetWalletId.trim();
      const cleanAdminFee = isValidFiniteNumber(adminFee) && adminFee >= 0 ? adminFee : 0;

      const sourceWallet = await db.select().from(schema.wallets).where(and(eq(schema.wallets.walletId, cleanSourceWalletId), eq(schema.wallets.walletUserId, effectiveUserId))).get();
      if (!sourceWallet) throw new Error(`Source Wallet ID ${cleanSourceWalletId} not found or unauthorized`);

      const targetWallet = await db.select().from(schema.wallets).where(and(eq(schema.wallets.walletId, cleanTargetWalletId), eq(schema.wallets.walletUserId, effectiveUserId))).get();
      if (!targetWallet) throw new Error(`Target Wallet ID ${cleanTargetWalletId} not found or unauthorized`);

      let cleanCategoryId: string | null = null;
      if (categoryId && typeof categoryId === "string" && categoryId.trim().length > 0) {
        if (!isValidUUID(categoryId)) {
          throw new Error("Validation Error: 'categoryId' must be a valid string (UUID)");
        }
        const targetCatId = (categoryId as string).trim();
        const category = await db.select().from(schema.categories).where(and(eq(schema.categories.categoryId, targetCatId), eq(schema.categories.categoryUserId, effectiveUserId))).get();
        if (!category) throw new Error(`Category ID ${targetCatId} not found or unauthorized`);
        cleanCategoryId = targetCatId;
      } else {
        let transferCat = await db.select().from(schema.categories).where(and(eq(schema.categories.categoryUserId, effectiveUserId), eq(schema.categories.categoryName, "Transfer"))).get();
        if (!transferCat) {
          const newCatId = crypto.randomUUID();
          const created = await db.insert(schema.categories).values({
            categoryId: newCatId,
            categoryUserId: effectiveUserId,
            categoryName: "Transfer",
            categoryType: "expense",
            categoryIcon: "🔄",
            categoryCreatedAt: currentIsoTimestamp()
          }).returning();
          transferCat = created[0];
        }
        cleanCategoryId = transferCat.categoryId;
      }

      const dateStr = normalizeToIsoTimestamp(transactionDate);
      const isPlannedInt = isPlanned ? 1 : 0;
      const newTransactionId = crypto.randomUUID();
      const nowIso = currentIsoTimestamp();

      const tx = await db.insert(schema.transactions).values({
        transactionId: newTransactionId,
        transactionUserId: effectiveUserId,
        transactionWalletId: cleanSourceWalletId,
        transactionTargetWalletId: cleanTargetWalletId,
        transactionCategoryId: cleanCategoryId,
        transactionAmount: amount,
        transactionAdminFee: cleanAdminFee,
        transactionType: "transfer",
        transactionDescription: description ? description.trim() : null,
        transactionIsPlanned: isPlannedInt,
        transactionDate: dateStr,
        transactionCreatedAt: nowIso
      }).returning();

      // Atomic wallet balance update for actual transfer (isPlanned == 0)
      if (!isPlannedInt) {
        await applyBalanceDelta("transfer", cleanSourceWalletId, cleanTargetWalletId, amount, cleanAdminFee, 1);
      }

      return { content: [{ type: "text", text: JSON.stringify(tx[0], null, 2) }] };
    }

    // --- Tool: update_transaction ---
    if (name === "update_transaction") {
      const { transactionId, amount, adminFee, walletId, targetWalletId, categoryId, budgetId, description, transactionDate, isPlanned } = (args || {}) as any;

      if (!isValidUUID(transactionId)) {
        throw new Error("Validation Error: Valid string 'transactionId' (UUID) is required");
      }
      const cleanTxId = transactionId.trim();
      const existingTx = await db.select().from(schema.transactions).where(and(eq(schema.transactions.transactionId, cleanTxId), eq(schema.transactions.transactionUserId, effectiveUserId))).get();
      if (!existingTx) {
        throw new Error(`Transaction ID ${cleanTxId} not found or unauthorized`);
      }

      if (amount !== undefined && !isValidPositiveNumber(amount)) {
        throw new Error("Validation Error: 'amount' must be a positive finite number greater than 0");
      }
      if (adminFee !== undefined && (!isValidFiniteNumber(adminFee) || adminFee < 0)) {
        throw new Error("Validation Error: 'adminFee' must be a non-negative finite number");
      }
      if (transactionDate !== undefined && !isValidIsoDateOrTimestamp(transactionDate)) {
        throw new Error("Validation Error: 'transactionDate' must be in valid ISO format (e.g. YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss+07:00)");
      }
      if (description !== undefined && (typeof description !== "string" || description.length > 500)) {
        throw new Error("Validation Error: 'description' cannot exceed 500 characters");
      }

      let newWalletId = existingTx.transactionWalletId;
      if (walletId !== undefined) {
        if (!isValidUUID(walletId)) throw new Error("Validation Error: 'walletId' must be a valid UUID");
        const cleanWId = (walletId as string).trim();
        const w = await db.select().from(schema.wallets).where(and(eq(schema.wallets.walletId, cleanWId), eq(schema.wallets.walletUserId, effectiveUserId))).get();
        if (!w) throw new Error(`Wallet ID ${cleanWId} not found or unauthorized`);
        newWalletId = cleanWId;
      }

      let newTargetWalletId = existingTx.transactionTargetWalletId;
      if (targetWalletId !== undefined) {
        if (targetWalletId === null || targetWalletId === "") {
          newTargetWalletId = null;
        } else {
          if (!isValidUUID(targetWalletId)) throw new Error("Validation Error: 'targetWalletId' must be a valid UUID");
          const cleanTWId = (targetWalletId as string).trim();
          const tw = await db.select().from(schema.wallets).where(and(eq(schema.wallets.walletId, cleanTWId), eq(schema.wallets.walletUserId, effectiveUserId))).get();
          if (!tw) throw new Error(`Target Wallet ID ${cleanTWId} not found or unauthorized`);
          newTargetWalletId = cleanTWId;
        }
      }

      let newCategoryId = existingTx.transactionCategoryId;
      if (categoryId !== undefined) {
        if (categoryId === null || categoryId === "") {
          newCategoryId = null;
        } else {
          if (!isValidUUID(categoryId)) throw new Error("Validation Error: 'categoryId' must be a valid UUID");
          const cleanCatId = (categoryId as string).trim();
          const cat = await db.select().from(schema.categories).where(and(eq(schema.categories.categoryId, cleanCatId), eq(schema.categories.categoryUserId, effectiveUserId))).get();
          if (!cat) throw new Error(`Category ID ${cleanCatId} not found or unauthorized`);
          newCategoryId = cleanCatId;
        }
      }

      let newBudgetId = existingTx.transactionBudgetId;
      if (budgetId !== undefined) {
        if (budgetId === null || budgetId === "") {
          newBudgetId = null;
        } else {
          if (!isValidUUID(budgetId)) throw new Error("Validation Error: 'budgetId' must be a valid UUID");
          const cleanBId = (budgetId as string).trim();
          const b = await db.select().from(schema.budgets).where(and(eq(schema.budgets.budgetId, cleanBId), eq(schema.budgets.budgetUserId, effectiveUserId))).get();
          if (!b) throw new Error(`Budget ID ${cleanBId} not found or unauthorized`);
          newBudgetId = cleanBId;
        }
      }

      const newAmount = amount !== undefined ? amount : existingTx.transactionAmount;
      const newAdminFee = adminFee !== undefined ? adminFee : existingTx.transactionAdminFee;
      const newIsPlannedInt = isPlanned !== undefined ? (isPlanned ? 1 : 0) : existingTx.transactionIsPlanned;

      // -----------------------------------------------------------------------
      // Atomic Balance Reconciliation
      // -----------------------------------------------------------------------
      // 1. Revert previous transaction impact if it was an actual transaction
      if (existingTx.transactionIsPlanned === 0) {
        await applyBalanceDelta(existingTx.transactionType, existingTx.transactionWalletId, existingTx.transactionTargetWalletId, existingTx.transactionAmount, existingTx.transactionAdminFee, -1);
      }

      // 2. Apply new transaction impact if the updated transaction is an actual transaction
      if (newIsPlannedInt === 0) {
        await applyBalanceDelta(existingTx.transactionType, newWalletId, newTargetWalletId, newAmount, newAdminFee, 1);
      }

      const updates: any = {
        transactionAmount: newAmount,
        transactionAdminFee: newAdminFee,
        transactionWalletId: newWalletId,
        transactionTargetWalletId: newTargetWalletId,
        transactionCategoryId: newCategoryId,
        transactionBudgetId: newBudgetId,
        transactionIsPlanned: newIsPlannedInt
      };

      if (description !== undefined) updates.transactionDescription = description ? description.trim() : null;
      if (transactionDate !== undefined) updates.transactionDate = normalizeToIsoTimestamp(transactionDate);

      const updated = await db.update(schema.transactions)
        .set(updates)
        .where(and(eq(schema.transactions.transactionId, cleanTxId), eq(schema.transactions.transactionUserId, effectiveUserId)))
        .returning();

      return { content: [{ type: "text", text: JSON.stringify(updated[0], null, 2) }] };
    }

    // --- Tool: list_transactions ---
    if (name === "list_transactions") {
      const { walletId, targetWalletId, categoryId, budgetId, type, isPlanned, startDate, endDate, limit = 50, offset = 0 } = (args || {}) as any;
      const conditions = [eq(schema.transactions.transactionUserId, effectiveUserId)];
      
      if (walletId !== undefined && typeof walletId === "string" && walletId.trim() !== "") {
        conditions.push(eq(schema.transactions.transactionWalletId, walletId.trim()));
      }
      if (targetWalletId !== undefined && typeof targetWalletId === "string" && targetWalletId.trim() !== "") {
        conditions.push(eq(schema.transactions.transactionTargetWalletId, targetWalletId.trim()));
      }
      if (categoryId !== undefined && typeof categoryId === "string" && categoryId.trim() !== "") {
        conditions.push(eq(schema.transactions.transactionCategoryId, categoryId.trim()));
      }
      if (budgetId !== undefined && typeof budgetId === "string" && budgetId.trim() !== "") {
        conditions.push(eq(schema.transactions.transactionBudgetId, budgetId.trim()));
      }
      if (type !== undefined && (type === "expense" || type === "income" || type === "transfer")) {
        conditions.push(eq(schema.transactions.transactionType, type));
      }
      if (isPlanned !== undefined) {
        conditions.push(eq(schema.transactions.transactionIsPlanned, isPlanned ? 1 : 0));
      }
      if (startDate !== undefined) {
        if (!isValidIsoDateOrTimestamp(startDate)) throw new Error("Validation Error: 'startDate' must be a valid ISO date or timestamp");
        conditions.push(gte(schema.transactions.transactionDate, normalizeToIsoTimestamp(startDate)));
      }
      if (endDate !== undefined) {
        if (!isValidIsoDateOrTimestamp(endDate)) throw new Error("Validation Error: 'endDate' must be a valid ISO date or timestamp");
        // If end date is YYYY-MM-DD, allow up to end of the day YYYY-MM-DDT23:59:59.999Z
        const cleanEndDate = /^\d{4}-\d{2}-\d{2}$/.test(endDate.trim())
          ? `${endDate.trim()}T23:59:59.999Z`
          : normalizeToIsoTimestamp(endDate);
        conditions.push(lte(schema.transactions.transactionDate, cleanEndDate));
      }

      const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 200);
      const safeOffset = Math.max(0, Number(offset) || 0);

      const txs = await db.select()
        .from(schema.transactions)
        .where(and(...conditions))
        .orderBy(desc(schema.transactions.transactionDate), desc(schema.transactions.transactionCreatedAt))
        .limit(safeLimit)
        .offset(safeOffset);

      return { content: [{ type: "text", text: JSON.stringify(txs, null, 2) }] };
    }

    // --- Tool: financial_summary ---
    if (name === "financial_summary") {
      const { startDate, endDate } = (args || {}) as any;
      
      if (startDate !== undefined && !isValidIsoDateOrTimestamp(startDate)) throw new Error("Validation Error: 'startDate' must be a valid ISO date or timestamp");
      if (endDate !== undefined && !isValidIsoDateOrTimestamp(endDate)) throw new Error("Validation Error: 'endDate' must be a valid ISO date or timestamp");

      // 1. Group net worth by currency and institution across all user wallets
      const walletsData = await db.select().from(schema.wallets).where(eq(schema.wallets.walletUserId, effectiveUserId));
      const netWorthByCurrency: Record<string, number> = {};
      const netWorthByInstitution: Record<string, number> = {};
      for (const w of walletsData) {
        netWorthByCurrency[w.walletCurrency] = Number(((netWorthByCurrency[w.walletCurrency] || 0) + w.walletBalance).toFixed(2));
        netWorthByInstitution[w.walletInstitution] = Number(((netWorthByInstitution[w.walletInstitution] || 0) + w.walletBalance).toFixed(2));
      }

      // 2. Query non-planned transactions
      const conditions = [
        eq(schema.transactions.transactionUserId, effectiveUserId),
        eq(schema.transactions.transactionIsPlanned, 0)
      ];
      if (startDate !== undefined) conditions.push(gte(schema.transactions.transactionDate, normalizeToIsoTimestamp(startDate)));
      if (endDate !== undefined) {
        const cleanEndDate = /^\d{4}-\d{2}-\d{2}$/.test(endDate.trim())
          ? `${endDate.trim()}T23:59:59.999Z`
          : normalizeToIsoTimestamp(endDate);
        conditions.push(lte(schema.transactions.transactionDate, cleanEndDate));
      }

      const txs = await db.select().from(schema.transactions).where(and(...conditions));
      
      // 3. Map categories for human-readable breakdown
      const categoriesData = await db.select().from(schema.categories).where(eq(schema.categories.categoryUserId, effectiveUserId));
      const categoryMap = new Map(categoriesData.map(c => [c.categoryId, c.categoryName]));

      let totalIncome = 0;
      let totalExpense = 0;
      let totalAdminFees = 0;
      let transfersCount = 0;
      const categoryBreakdown: Record<string, number> = {};

      for (const tx of txs) {
        const fee = tx.transactionAdminFee || 0;
        totalAdminFees += fee;

        if (tx.transactionType === "income") {
          totalIncome += (tx.transactionAmount - fee);
        } else if (tx.transactionType === "expense") {
          const totalCost = tx.transactionAmount + fee;
          totalExpense += totalCost;
          const catName = tx.transactionCategoryId ? (categoryMap.get(tx.transactionCategoryId) || `Category #${tx.transactionCategoryId}`) : "Uncategorized";
          categoryBreakdown[catName] = Number(((categoryBreakdown[catName] || 0) + totalCost).toFixed(2));
        } else if (tx.transactionType === "transfer") {
          transfersCount += 1;
          if (fee > 0) {
            totalExpense += fee;
            const catName = tx.transactionCategoryId ? (categoryMap.get(tx.transactionCategoryId) || `Category #${tx.transactionCategoryId}`) : "Transfer Fees";
            categoryBreakdown[catName] = Number(((categoryBreakdown[catName] || 0) + fee).toFixed(2));
          }
        }
      }

      const summary = {
        netWorthByCurrency,
        netWorthByInstitution,
        totalIncome: Number(totalIncome.toFixed(2)),
        totalExpense: Number(totalExpense.toFixed(2)),
        totalAdminFees: Number(totalAdminFees.toFixed(2)),
        netSavings: Number((totalIncome - totalExpense).toFixed(2)),
        walletsCount: walletsData.length,
        transactionsCount: txs.length,
        transfersCount,
        categoryBreakdown
      };

      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }

    throw new Error(`Tool not found: ${name}`);
  });

  return server;
}
