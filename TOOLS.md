# MCP Server Specification - Eve Finance Database Tools

This document specifies the **Model Context Protocol (MCP)** server architecture, tools, and resource definitions for interacting with the **Eve Finance SQLite Database**. 

If you are extending this project into a standalone MCP server (or integrating with Claude Desktop, Antigravity, OpenCode, or any MCP client), this document serves as the authoritative interface contract.

---

## 1. Architecture Overview

- **Protocol**: Model Context Protocol (MCP) over JSON-RPC 2.0 (Stdio or SSE transport).
- **Backend Database**: Local SQLite 3 (`storage/finance.db`) via `better-sqlite3` and `drizzle-orm`.
- **Media File Storage**: Local disk storage (`storage/uploads/<type>/YYYY-MM/`).
- **Human-in-the-Loop (HITL)**: All data-modifying tools require explicit client approval before execution (`approval: always()`).

```
┌─────────────────────────┐               ┌─────────────────────────────────┐
│       MCP Client        │               │           MCP Server            │
│ (Claude/Antigravity/Eve)│  JSON-RPC 2.0 │      (Eve Finance Tools)        │
│                         ├──────────────►│                                 │
│  - tools/list           │  Stdio / SSE  │  - execute_sql_query            │
│  - tools/call           │◄──────────────┤  - record_transaction           │
│  - resources/read       │               │  - manage_wallet / budget       │
└─────────────────────────┘               └────────────────┬────────────────┘
                                                           │
                                                           ▼
                                               ┌───────────────────────┐
                                               │ SQLite: finance.db    │
                                               │ Files:  storage/      │
                                               └───────────────────────┘
```

---

## 2. MCP Tools Registry

### 2.1. `execute_sql_query`
**Description**: Execute a read-only dynamic SQL query (`SELECT` or `WITH` statements) against the finance SQLite database for custom analytics, aggregations, time-series breakdown, or complex filtering.

- **Access Level**: Read-Only (Does not require HITL approval).
- **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Read-only SQL SELECT or WITH statement to execute against wallets, categories, budgets, and transactions tables."
      }
    },
    "required": ["query"]
  }
  ```
- **Example Usage**:
  ```sql
  SELECT c.name AS category, SUM(t.amount) AS total_spent
  FROM transactions t
  JOIN categories c ON t.category_id = c.id
  WHERE t.type = 'expense' AND t.is_planned = 0
  GROUP BY c.id
  ORDER BY total_spent DESC;
  ```

---

### 2.2. `record_transaction`
**Description**: Record a financial transaction (income, expense, or transfer). Auto-updates target wallet balance for actual transactions, supports planned transactions (`is_planned: true`), links to categories/budgets, and records local file paths.

- **Access Level**: Write (Gated by Explicit HITL Approval `approval: always()`).
- **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "walletId": { "type": "integer", "description": "Required: Target Wallet ID" },
      "categoryId": { "type": "integer", "description": "Required: Target Category ID" },
      "budgetId": { "type": "integer", "description": "Optional: Linked Budget ID (Auto-resolved if omitted)" },
      "amount": { "type": "number", "minimum": 0.01, "description": "Transaction amount in IDR" },
      "type": { "type": "string", "enum": ["expense", "income", "transfer"], "default": "expense" },
      "description": { "type": "string", "description": "Transaction note or description" },
      "filePath": { "type": "string", "description": "Local path to receipt image, PDF, audio, or CSV file" },
      "isPlanned": { "type": "boolean", "default": false, "description": "Set true for projected transactions without altering cash balance" },
      "transactionDate": { "type": "string", "description": "ISO date format (YYYY-MM-DD). Defaults to today." }
    },
    "required": ["walletId", "categoryId", "amount"]
  }
  ```

---

### 2.3. `manage_wallet`
**Description**: Create a new wallet, list all wallets, or update an existing wallet's balance or name.

- **Access Level**: Dynamic (`list` = Read-Only; `create` / `update` = Requires HITL Approval).
- **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["list", "create", "update"], "description": "Action to perform" },
      "name": { "type": "string", "description": "Wallet name (e.g. Cash, BCA, Mandiri)" },
      "type": { "type": "string", "enum": ["bank", "cash", "e-wallet", "credit"], "description": "Type of wallet" },
      "balance": { "type": "number", "description": "Initial balance or updated balance" },
      "currency": { "type": "string", "default": "IDR", "description": "ISO currency code" },
      "walletId": { "type": "integer", "description": "Required for update action" }
    },
    "required": ["action"]
  }
  ```

---

### 2.4. `manage_budget`
**Description**: Manage financial budgets with active date windows (`period_start` & `period_end`). Create, list, or check active budget utilization vs actual spending.

- **Access Level**: Dynamic (`list` & `status` = Read-Only; `create` = Requires HITL Approval).
- **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["list", "create", "status"], "description": "Action to perform" },
      "name": { "type": "string", "description": "Budget title (e.g. August Food Budget)" },
      "categoryId": { "type": "integer", "description": "Optional category filter ID" },
      "amount": { "type": "number", "description": "Budget target limit amount" },
      "periodStart": { "type": "string", "description": "Start date of active window (YYYY-MM-DD)" },
      "periodEnd": { "type": "string", "description": "End date of active window (YYYY-MM-DD)" }
    },
    "required": ["action"]
  }
  ```

---

### 2.5. `manage_category`
**Description**: Create a new expense/income category or list existing categories.

- **Access Level**: Read / Write.
- **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["list", "create"] },
      "name": { "type": "string", "description": "Category name (e.g. Utilities, Transportation)" },
      "type": { "type": "string", "enum": ["expense", "income"], "default": "expense" },
      "icon": { "type": "string", "description": "Emoji icon representation (e.g. 🍔, 🚗)" }
    },
    "required": ["action"]
  }
  ```

---

### 2.6. `list_transactions`
**Description**: Query transactions with structured filters (wallet, category, budget, date range, `is_planned`, or file attachments).

- **Access Level**: Read-Only.
- **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "walletId": { "type": "integer" },
      "categoryId": { "type": "integer" },
      "budgetId": { "type": "integer" },
      "type": { "type": "string", "enum": ["expense", "income", "transfer"] },
      "isPlanned": { "type": "boolean" },
      "startDate": { "type": "string", "description": "YYYY-MM-DD" },
      "endDate": { "type": "string", "description": "YYYY-MM-DD" },
      "hasFile": { "type": "boolean" },
      "limit": { "type": "integer", "default": 50 }
    }
  }
  ```

---

### 2.7. `financial_summary`
**Description**: Generate a complete financial report (net worth across wallets, actual vs planned income & expenses, category breakdown).

- **Access Level**: Read-Only.
- **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "startDate": { "type": "string", "description": "YYYY-MM-DD" },
      "endDate": { "type": "string", "description": "YYYY-MM-DD" }
    }
  }
  ```

---

### 2.8. `send_attachment`
**Description**: Retrieve and re-send a stored transaction receipt or document file attachment back to the user chat.

- **Access Level**: Read-Only.
- **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "transactionId": { "type": "integer" },
      "filePath": { "type": "string" }
    }
  }
  ```

---

## 3. MCP Resources Schema

An MCP server for this database exposes the following URI resources:

| Resource URI | MIME Type | Description |
|---|---|---|
| `finance://db/schema` | `application/json` | Returns database DDL schema and table structures |
| `finance://wallets/list` | `application/json` | Returns current list of active wallets & balances |
| `finance://budgets/active` | `application/json` | Returns currently active budgets and utilization |
| `finance://uploads/{type}/{filename}` | `image/*`, `application/pdf`, `text/csv` | Binary resource accessor for uploaded receipt files |

---

## 4. MCP Server Implementation Code Snippet (Node.js Stdio)

To run this as a standalone MCP server using the `@modelcontextprotocol/sdk`:

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { sqlite } from "./lib/db/index.js";

const server = new Server(
  { name: "eve-finance-mcp", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "execute_sql_query",
      description: "Execute read-only SQL queries against finance database",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    // Add other tool schemas here...
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "execute_sql_query") {
    const { query } = request.params.arguments as { query: string };
    const rows = sqlite.prepare(query).all();
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
  throw new Error(`Tool not found: ${request.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
```
