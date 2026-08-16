# Eve Finance Stateless MCP Server (Cloudflare Workers + D1)

Stateless Model Context Protocol (MCP) server for personal finance management deployed on **Cloudflare Workers** with **Cloudflare D1** (SQLite) and **Drizzle ORM**.

---

## 🚀 Features

- **Stateless HTTP Transport**: Implements Web Standard Streamable HTTP & SSE (`/mcp` and `/sse`) via `@modelcontextprotocol/sdk`.
- **Pure MCP-Native Authentication**: Register and login directly using MCP tools (`register_user` & `login_user`) without external REST endpoints.
- **15-Minute Self-Contained JWT**: Cryptographic token verification with **zero database queries** required for auth on finance tool calls.
- **Multi-Tenant Row-Level Security (RLS)**: Automatically isolates user data via `userId` extracted directly from JWT token payload.
- **9 MCP Tools**:
  - `register_user`: Register with `firstName`, `lastName`, `email`, and `whatsappNumber` (with country code `+...`) → returns persistent `apiKey` & 15-minute JWT.
  - `login_user`: Authenticate with `apiKey` → returns fresh 15-minute JWT.
  - `submit_feedback`: Submit user feedback, bug reports, or feature requests → automatically creates a formatted GitHub Issue with the user's name and email.
  - `manage_wallet`: Create, list, update wallets.
  - `manage_category`: Create, list expense and income categories.
  - `manage_budget`: Create, list, and compute real-time budget utilization status.
  - `record_transaction`: Record income/expenses with automatic wallet balance sync (and support for planned transactions).
  - `list_transactions`: Dynamic filtering across date ranges, wallets, categories, budgets, and planning status.
  - `financial_summary`: Aggregate net worth, income, expense, savings, and category breakdowns.
- **3 MCP Resources**:
  - `finance://db/schema`
  - `finance://wallets/list`
  - `finance://budgets/active`

---

## 🔄 Authentication Workflow via MCP

1. **Register User via MCP Tool**:
   Call tool `register_user`:
   ```json
   {
     "firstName": "Budi",
     "lastName": "Setiawan",
     "email": "budi@example.com",
     "whatsappNumber": "+6281234567890"
   }
   ```
   **Response:**
   ```json
   {
     "userId": "usr_k8f9a2...",
     "name": "Budi Setiawan",
     "email": "budi@example.com",
     "whatsappNumber": "+6281234567890",
     "apiKey": "fp_live_8f3d9b2c...",
     "token": "eyJhbGciOi...",
     "tokenType": "Bearer",
     "expiresIn": 900
   }
   ```

2. **Call Finance Tools**:
   Set `Authorization: Bearer <token>` in your MCP client headers to execute `manage_wallet`, `record_transaction`, etc.

3. **Re-Login when Token Expires (after 15 minutes)**:
   When a token expires, call tool `login_user`:
   ```json
   {
     "apiKey": "fp_live_8f3d9b2c..."
   }
   ```
   **Response:** Fresh 15-minute JWT token.

---

## 🛠️ Project Setup & Local Development

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Tests
Runs the complete test suite covering all 8 tools, 3 resources, RLS tenant isolation, input validations, and pure MCP lifecycle:
```bash
npm test
```

### 3. Type Checking & Build Dry-Run
```bash
npm run typecheck
npm run build
```

---

## 🤖 Coding Agents Quick Start (Claude Code, OpenCode, Pi, OMP)

Connect Eve Finance MCP to your AI coding agents in seconds. For comprehensive configuration and example prompts, see the **[Coding Agents Setup Guide](docs/CODING_AGENTS.md)**.

### 1. Claude Code
```bash
claude mcp add --transport http eve-finance https://finnplan-mcp.lutfidmz.workers.dev/mcp
```

### 2. OpenCode
In `opencode.json`:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "eve-finance": {
      "type": "remote",
      "url": "https://finnplan-mcp.lutfidmz.workers.dev/mcp"
    }
  }
}
```

### 3. Pi (`pi-mcp-adapter`)
```bash
# 1. Install adapter
pi install npm:pi-mcp-adapter

# 2. Add to .mcp.json
{
  "mcpServers": {
    "eve-finance": {
      "url": "https://finnplan-mcp.lutfidmz.workers.dev/mcp"
    }
  }
}
```

### 4. OMP (Oh My Pi)
In `.omp/mcp.json` or `.mcp.json`:
```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "eve-finance": {
      "url": "https://finnplan-mcp.lutfidmz.workers.dev/mcp"
    }
  }
}
```

### ⚡ Print Agent Snippets via CLI
```bash
npm run agent:snippet [claude|opencode|pi|omp|all]
```

---

## 💾 Local D1 Setup & Migrations

Apply migrations to your local D1 database:

```bash
# 1. Execute database migrations locally
npx wrangler d1 execute finance_db --local --file=./drizzle/0000_nice_marvel_boy.sql
npx wrangler d1 execute finance_db --local --file=./drizzle/0001_low_stingray.sql

# 2. Start local development server
npm run dev
```

---

## 🔌 Connecting with MCP Clients

- **Endpoint**: `http://localhost:8787/mcp` (or your deployed `https://finnplan-mcp.lutfidmz.workers.dev/mcp`)
- **Initial Connection**: No headers required to call `register_user` or `login_user`.
- **Authenticated Calls**:
  ```json
  {
    "Authorization": "Bearer <YOUR_15_MIN_JWT_TOKEN>"
  }
  ```

---

## 🚢 Production Deployment

```bash
# 1. Create remote D1 database (if not created yet)
npx wrangler d1 create finance_db

# 2. Set your production JWT secret
npx wrangler secret put JWT_SECRET

# 3. Apply migrations to remote D1 database
npx wrangler d1 execute finance_db --remote --file=./drizzle/0000_nice_marvel_boy.sql
npx wrangler d1 execute finance_db --remote --file=./drizzle/0001_low_stingray.sql

# 4. Deploy worker
npm run deploy
```

