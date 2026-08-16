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
        description: "Record a financial transaction (expense or income) with optional admin fee. Automatically and atomically updates wallet balance.",
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
            transactionDate: { type: "string", description: "ISO date format (YYYY-MM-DD). Defaults to today." },
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
            categoryId: { type: "string", description: "Optional Category UUID (e.g. Transfer / Admin category)" },
            description: { type: "string", description: "Transfer note or memo (max 500 characters)" },
            isPlanned: { type: "boolean", default: false, description: "Set true for projected transfers without altering balance" },
            transactionDate: { type: "string", description: "ISO date format (YYYY-MM-DD). Defaults to today." },
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
            transactionDate: { type: "string", description: "New ISO date format (YYYY-MM-DD)" },
            isPlanned: { type: "boolean", description: "New planned status" },
            apiKey: { type: "string", description: "Optional: Your persistent API Key (fp_live_...) if not set in headers" }
          },
          required: ["transactionId"]
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

    // --- Tool: submit_feedback ---
    if (name === "submit_feedback") {
      const { title, feedback, type = "feedback", name: submitterName, email: submitterEmail } = (args || {}) as any;

      if (!title || typeof title !== "string" || title.trim().length < 5 || title.trim().length > 200) {
        throw new Error("Validation Error: 'title' is required (5-200 characters)");
      }
      if (!feedback || typeof feedback !== "string" || feedback.trim().length < 10 || feedback.trim().length > 4000) {
        throw new Error("Validation Error: 'feedback' is required (10-4000 characters)");
      }

      // Resolve user profile: Check if user is authenticated via headers or in-tool apiKey
      let foundUserId: string | null = null;
      let userName = submitterName && typeof submitterName === "string" && submitterName.trim().length > 0 ? submitterName.trim() : null;
      let userEmail = submitterEmail && typeof submitterEmail === "string" && submitterEmail.trim().length > 0 ? submitterEmail.trim().toLowerCase() : null;

      const effectiveUserId = await resolveEffectiveUserId(args);
      if (effectiveUserId) {
        foundUserId = effectiveUserId;
        const user = await db.select().from(schema.users).where(eq(schema.users.id, effectiveUserId)).get();
        if (user) {
          if (!userName) {
            userName = `${user.firstName} ${user.lastName}`.trim();
          }
          if (!userEmail) {
            userEmail = user.email;
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
        `| **Submitted At** | ${new Date().toISOString()} |`
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
          .set({ balance: sql`balance + ${delta}` })
          .where(and(eq(schema.wallets.id, wId), eq(schema.wallets.userId, effectiveUserId)));
      } else if (txType === "income") {
        const delta = (amt - fee) * multiplier;
        await db.update(schema.wallets)
          .set({ balance: sql`balance + ${delta}` })
          .where(and(eq(schema.wallets.id, wId), eq(schema.wallets.userId, effectiveUserId)));
      } else if (txType === "transfer" && targetWId) {
        const sourceDelta = -(amt + fee) * multiplier;
        const targetDelta = amt * multiplier;
        await db.update(schema.wallets)
          .set({ balance: sql`balance + ${sourceDelta}` })
          .where(and(eq(schema.wallets.id, wId), eq(schema.wallets.userId, effectiveUserId)));
        await db.update(schema.wallets)
          .set({ balance: sql`balance + ${targetDelta}` })
          .where(and(eq(schema.wallets.id, targetWId), eq(schema.wallets.userId, effectiveUserId)));
      }
    };

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
      if (transactionDate && !isValidDate(transactionDate)) {
        throw new Error("Validation Error: 'transactionDate' must be in ISO format (YYYY-MM-DD)");
      }
      if (description && (typeof description !== "string" || description.length > 500)) {
        throw new Error("Validation Error: 'description' cannot exceed 500 characters");
      }

      const cleanWalletId = walletId.trim();
      const cleanCategoryId = categoryId.trim();
      const cleanAdminFee = isValidFiniteNumber(adminFee) && adminFee >= 0 ? adminFee : 0;
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
        adminFee: cleanAdminFee,
        type: txType,
        description: description ? description.trim() : null,
        isPlanned: isPlannedInt,
        transactionDate: dateStr
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
      if (transactionDate && !isValidDate(transactionDate)) {
        throw new Error("Validation Error: 'transactionDate' must be in ISO format (YYYY-MM-DD)");
      }
      if (description && (typeof description !== "string" || description.length > 500)) {
        throw new Error("Validation Error: 'description' cannot exceed 500 characters");
      }

      const cleanSourceWalletId = sourceWalletId.trim();
      const cleanTargetWalletId = targetWalletId.trim();
      const cleanAdminFee = isValidFiniteNumber(adminFee) && adminFee >= 0 ? adminFee : 0;

      const sourceWallet = await db.select().from(schema.wallets).where(and(eq(schema.wallets.id, cleanSourceWalletId), eq(schema.wallets.userId, effectiveUserId))).get();
      if (!sourceWallet) throw new Error(`Source Wallet ID ${cleanSourceWalletId} not found or unauthorized`);

      const targetWallet = await db.select().from(schema.wallets).where(and(eq(schema.wallets.id, cleanTargetWalletId), eq(schema.wallets.userId, effectiveUserId))).get();
      if (!targetWallet) throw new Error(`Target Wallet ID ${cleanTargetWalletId} not found or unauthorized`);

      let cleanCategoryId: string | null = null;
      if (categoryId && typeof categoryId === "string" && categoryId.trim().length > 0) {
        if (!isValidUUID(categoryId)) {
          throw new Error("Validation Error: 'categoryId' must be a valid string (UUID)");
        }
        const targetCatId = (categoryId as string).trim();
        const category = await db.select().from(schema.categories).where(and(eq(schema.categories.id, targetCatId), eq(schema.categories.userId, effectiveUserId))).get();
        if (!category) throw new Error(`Category ID ${targetCatId} not found or unauthorized`);
        cleanCategoryId = targetCatId;
      } else {
        let transferCat = await db.select().from(schema.categories).where(and(eq(schema.categories.userId, effectiveUserId), eq(schema.categories.name, "Transfer"))).get();
        if (!transferCat) {
          const newCatId = crypto.randomUUID();
          const created = await db.insert(schema.categories).values({
            id: newCatId,
            userId: effectiveUserId,
            name: "Transfer",
            type: "expense",
            icon: "🔄"
          }).returning();
          transferCat = created[0];
        }
        cleanCategoryId = transferCat.id;
      }

      const dateStr = transactionDate || new Date().toISOString().split("T")[0];
      const isPlannedInt = isPlanned ? 1 : 0;
      const newTransactionId = crypto.randomUUID();

      const tx = await db.insert(schema.transactions).values({
        id: newTransactionId,
        userId: effectiveUserId,
        walletId: cleanSourceWalletId,
        targetWalletId: cleanTargetWalletId,
        categoryId: cleanCategoryId,
        amount,
        adminFee: cleanAdminFee,
        type: "transfer",
        description: description ? description.trim() : null,
        isPlanned: isPlannedInt,
        transactionDate: dateStr
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
      const existingTx = await db.select().from(schema.transactions).where(and(eq(schema.transactions.id, cleanTxId), eq(schema.transactions.userId, effectiveUserId))).get();
      if (!existingTx) {
        throw new Error(`Transaction ID ${cleanTxId} not found or unauthorized`);
      }

      if (amount !== undefined && !isValidPositiveNumber(amount)) {
        throw new Error("Validation Error: 'amount' must be a positive finite number greater than 0");
      }
      if (adminFee !== undefined && (!isValidFiniteNumber(adminFee) || adminFee < 0)) {
        throw new Error("Validation Error: 'adminFee' must be a non-negative finite number");
      }
      if (transactionDate !== undefined && !isValidDate(transactionDate)) {
        throw new Error("Validation Error: 'transactionDate' must be in ISO format (YYYY-MM-DD)");
      }
      if (description !== undefined && (typeof description !== "string" || description.length > 500)) {
        throw new Error("Validation Error: 'description' cannot exceed 500 characters");
      }

      let newWalletId = existingTx.walletId;
      if (walletId !== undefined) {
        if (!isValidUUID(walletId)) throw new Error("Validation Error: 'walletId' must be a valid UUID");
        const cleanWId = (walletId as string).trim();
        const w = await db.select().from(schema.wallets).where(and(eq(schema.wallets.id, cleanWId), eq(schema.wallets.userId, effectiveUserId))).get();
        if (!w) throw new Error(`Wallet ID ${cleanWId} not found or unauthorized`);
        newWalletId = cleanWId;
      }

      let newTargetWalletId = existingTx.targetWalletId;
      if (targetWalletId !== undefined) {
        if (targetWalletId === null || targetWalletId === "") {
          newTargetWalletId = null;
        } else {
          if (!isValidUUID(targetWalletId)) throw new Error("Validation Error: 'targetWalletId' must be a valid UUID");
          const cleanTWId = (targetWalletId as string).trim();
          const tw = await db.select().from(schema.wallets).where(and(eq(schema.wallets.id, cleanTWId), eq(schema.wallets.userId, effectiveUserId))).get();
          if (!tw) throw new Error(`Target Wallet ID ${cleanTWId} not found or unauthorized`);
          newTargetWalletId = cleanTWId;
        }
      }

      let newCategoryId = existingTx.categoryId;
      if (categoryId !== undefined) {
        if (categoryId === null || categoryId === "") {
          newCategoryId = null;
        } else {
          if (!isValidUUID(categoryId)) throw new Error("Validation Error: 'categoryId' must be a valid UUID");
          const cleanCatId = (categoryId as string).trim();
          const cat = await db.select().from(schema.categories).where(and(eq(schema.categories.id, cleanCatId), eq(schema.categories.userId, effectiveUserId))).get();
          if (!cat) throw new Error(`Category ID ${cleanCatId} not found or unauthorized`);
          newCategoryId = cleanCatId;
        }
      }

      let newBudgetId = existingTx.budgetId;
      if (budgetId !== undefined) {
        if (budgetId === null || budgetId === "") {
          newBudgetId = null;
        } else {
          if (!isValidUUID(budgetId)) throw new Error("Validation Error: 'budgetId' must be a valid UUID");
          const cleanBId = (budgetId as string).trim();
          const b = await db.select().from(schema.budgets).where(and(eq(schema.budgets.id, cleanBId), eq(schema.budgets.userId, effectiveUserId))).get();
          if (!b) throw new Error(`Budget ID ${cleanBId} not found or unauthorized`);
          newBudgetId = cleanBId;
        }
      }

      const newAmount = amount !== undefined ? amount : existingTx.amount;
      const newAdminFee = adminFee !== undefined ? adminFee : existingTx.adminFee;
      const newIsPlannedInt = isPlanned !== undefined ? (isPlanned ? 1 : 0) : existingTx.isPlanned;

      // -----------------------------------------------------------------------
      // Atomic Balance Reconciliation
      // -----------------------------------------------------------------------
      // 1. Revert previous transaction impact if it was an actual transaction
      if (existingTx.isPlanned === 0) {
        await applyBalanceDelta(existingTx.type, existingTx.walletId, existingTx.targetWalletId, existingTx.amount, existingTx.adminFee, -1);
      }

      // 2. Apply new transaction impact if the updated transaction is an actual transaction
      if (newIsPlannedInt === 0) {
        await applyBalanceDelta(existingTx.type, newWalletId, newTargetWalletId, newAmount, newAdminFee, 1);
      }

      const updates: any = {
        amount: newAmount,
        adminFee: newAdminFee,
        walletId: newWalletId,
        targetWalletId: newTargetWalletId,
        categoryId: newCategoryId,
        budgetId: newBudgetId,
        isPlanned: newIsPlannedInt
      };

      if (description !== undefined) updates.description = description ? description.trim() : null;
      if (transactionDate !== undefined) updates.transactionDate = transactionDate;

      const updated = await db.update(schema.transactions)
        .set(updates)
        .where(and(eq(schema.transactions.id, cleanTxId), eq(schema.transactions.userId, effectiveUserId)))
        .returning();

      return { content: [{ type: "text", text: JSON.stringify(updated[0], null, 2) }] };
    }

    // --- Tool: list_transactions ---
    if (name === "list_transactions") {
      const { walletId, targetWalletId, categoryId, budgetId, type, isPlanned, startDate, endDate, limit = 50, offset = 0 } = (args || {}) as any;
      const conditions = [eq(schema.transactions.userId, effectiveUserId)];
      
      if (walletId !== undefined && typeof walletId === "string" && walletId.trim() !== "") {
        conditions.push(eq(schema.transactions.walletId, walletId.trim()));
      }
      if (targetWalletId !== undefined && typeof targetWalletId === "string" && targetWalletId.trim() !== "") {
        conditions.push(eq(schema.transactions.targetWalletId, targetWalletId.trim()));
      }
      if (categoryId !== undefined && typeof categoryId === "string" && categoryId.trim() !== "") {
        conditions.push(eq(schema.transactions.categoryId, categoryId.trim()));
      }
      if (budgetId !== undefined && typeof budgetId === "string" && budgetId.trim() !== "") {
        conditions.push(eq(schema.transactions.budgetId, budgetId.trim()));
      }
      if (type !== undefined && (type === "expense" || type === "income" || type === "transfer")) {
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
      let totalAdminFees = 0;
      let transfersCount = 0;
      const categoryBreakdown: Record<string, number> = {};

      for (const tx of txs) {
        const fee = tx.adminFee || 0;
        totalAdminFees += fee;

        if (tx.type === "income") {
          totalIncome += (tx.amount - fee);
        } else if (tx.type === "expense") {
          const totalCost = tx.amount + fee;
          totalExpense += totalCost;
          const catName = tx.categoryId ? (categoryMap.get(tx.categoryId) || `Category #${tx.categoryId}`) : "Uncategorized";
          categoryBreakdown[catName] = Number(((categoryBreakdown[catName] || 0) + totalCost).toFixed(2));
        } else if (tx.type === "transfer") {
          transfersCount += 1;
          if (fee > 0) {
            totalExpense += fee;
            const catName = tx.categoryId ? (categoryMap.get(tx.categoryId) || `Category #${tx.categoryId}`) : "Transfer Fees";
            categoryBreakdown[catName] = Number(((categoryBreakdown[catName] || 0) + fee).toFixed(2));
          }
        }
      }

      const summary = {
        netWorthByCurrency,
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
