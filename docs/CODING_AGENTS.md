# Connecting Eve Finance MCP to AI Coding Agents

This guide explains how to connect and configure the **Eve Finance MCP Server** with modern terminal and editor AI coding agents:
- [1. Claude Code](#1-claude-code)
- [2. OpenCode](#2-opencode)
- [3. Pi (pi-mcp-adapter)](#3-pi-pi-mcp-adapter)
- [4. OMP (Oh My Pi)](#4-omp-oh-my-pi)
- [5. Cursor & VS Code / Windsurf](#5-cursor--vs-code--windsurf)
- [6. Claude Desktop](#6-claude-desktop)
- [7. How to Authenticate & Example Prompts](#7-how-to-authenticate--example-prompts)

---

## 🌐 Server Endpoints

| Environment | MCP Endpoint URL |
| :--- | :--- |
| **Cloudflare Production (Remote)** | `https://finnplan-mcp.lutfidmz.workers.dev/mcp` |
| **Local Development** | `http://localhost:8787/mcp` |

---

## ⚡ Instant Setup: Mint a User & Config Snippets

Run this command once to register a user on Local or Remote D1 and generate instant ready-to-copy configurations for all coding agents:

```bash
# For Remote Cloudflare D1 (Production)
npm run user:create -- --remote --name "Your Name" --email "you@example.com" --phone "+6281234567890"

# For Local Development D1
npm run user:create -- --name "Your Name" --email "you@example.com" --phone "+6281234567890"
```

---

## 🔐 Zero-Friction Authentication Methods

Eve Finance MCP supports 3 flexible authorization methods tailored for AI coding agents:

1. **Persistent API Key in Headers (Recommended)**: Set `"Authorization": "Bearer fp_live_..."` or `"X-API-Key": "fp_live_..."` in your `mcp.json`. **Never expires**, no re-login needed!
2. **In-Tool Parameter Fallback**: If connected without headers, the agent can simply pass `apiKey: "fp_live_..."` directly in any tool call argument.
3. **Self-Contained JWT Token**: Set `"Authorization": "Bearer <jwt>"` for ephemeral (15-minute) web client sessions.

---

## 1. Claude Code

[Claude Code](https://code.claude.com/docs/en/agent-sdk/mcp#mcp-json) supports Streamable HTTP MCP transports natively.

### Option A: One-Liner CLI Command (Recommended)

Run in your project root or terminal:

```bash
# Add with persistent API Key (Zero Expiration):
claude mcp add --transport http --header "Authorization: Bearer fp_live_YOUR_API_KEY" eve-finance https://finnplan-mcp.lutfidmz.workers.dev/mcp

# OR Add unauthenticated (agent passes apiKey in tool calls):
claude mcp add --transport http eve-finance https://finnplan-mcp.lutfidmz.workers.dev/mcp
```

### Option B: Project Config File (`.claude/mcp.json` or `.mcp.json`)

Create `.claude/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "eve-finance": {
      "type": "http",
      "url": "https://finnplan-mcp.lutfidmz.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer fp_live_YOUR_API_KEY"
      }
    }
  }
}
```

*Note: For local development, change the URL to `http://localhost:8787/mcp`.*

---

## 2. OpenCode

[OpenCode](https://opencode.ai/docs/mcp-servers/) connects to remote MCP servers via `opencode.json`.

### Option A: Configuration File (`opencode.json`)

Create `opencode.json` in your project root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "eve-finance": {
      "type": "remote",
      "url": "https://finnplan-mcp.lutfidmz.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_15_MIN_JWT_OR_API_KEY"
      }
    }
  }
}
```

### Option B: Interactive CLI

Run inside OpenCode TUI or terminal:

```bash
opencode mcp add
```
When prompted:
1. Server Name: `eve-finance`
2. Server Type: `remote`
3. Server URL: `https://finnplan-mcp.lutfidmz.workers.dev/mcp`

---

## 3. Pi (`pi-mcp-adapter`)

[Pi Coding Agent](https://pi.dev/packages/pi-mcp-adapter) uses the lightweight, on-demand `pi-mcp-adapter` extension.

### Step 1: Install Adapter in Pi

```bash
pi install npm:pi-mcp-adapter
```
*(Restart Pi after installation)*

### Step 2: Configure Server (`.mcp.json` or `~/.config/mcp/mcp.json`)

Create `.mcp.json` in your project root (or `~/.config/mcp/mcp.json` for global access):

```json
{
  "mcpServers": {
    "eve-finance": {
      "url": "https://finnplan-mcp.lutfidmz.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_15_MIN_JWT_OR_API_KEY"
      }
    }
  }
}
```

### Step 3: Verify / Interactive Setup

Inside Pi terminal, run:
```bash
/mcp setup
```
Select `eve-finance` to confirm tools and active connection.

---

## 4. OMP (Oh My Pi)

[OMP](https://omp.sh/docs/mcp) is a terminal coding agent with native Rust-powered MCP support.

### Option A: Project Config (`.omp/mcp.json` or `.mcp.json`)

Create `.omp/mcp.json` (or `.mcp.json` in root):

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "eve-finance": {
      "url": "https://finnplan-mcp.lutfidmz.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_15_MIN_JWT_OR_API_KEY"
      }
    }
  }
}
```

### Option B: Built-in OMP Command

Inside your OMP session:
```bash
/mcp add
```
- Select **Remote HTTP** transport.
- Enter URL: `https://finnplan-mcp.lutfidmz.workers.dev/mcp`.
- Enter Name: `eve-finance`.

---

## 5. Cursor & VS Code / Windsurf

### Cursor (`.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "eve-finance": {
      "url": "https://finnplan-mcp.lutfidmz.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_15_MIN_JWT_OR_API_KEY"
      }
    }
  }
}
```

### VS Code / Windsurf (`.vscode/mcp.json`)
```json
{
  "mcpServers": {
    "eve-finance": {
      "type": "http",
      "url": "https://finnplan-mcp.lutfidmz.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_15_MIN_JWT_OR_API_KEY"
      }
    }
  }
}
```

---

## 6. Claude Desktop

In `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "eve-finance": {
      "url": "https://finnplan-mcp.lutfidmz.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_15_MIN_JWT_OR_API_KEY"
      }
    }
  }
}
```

---

## 7. How to Authenticate & Example Prompts

Eve Finance MCP is designed with **Pure Native MCP Authentication**. You don't need any web dashboard or REST API to manage accounts.

### Workflow A: Let the Coding Agent Register / Login Directly

If you connect without an `Authorization` header, the agent can call `register_user` or `login_user` directly:

#### 1. Registration Prompt:
> *"Register me on Eve Finance with name John Doe, email john@example.com, and WhatsApp number +6281234567890. Save the returned API key safely."*

#### 2. Login Prompt:
> *"Login to Eve Finance using my API key `fp_live_...` and use the resulting token for future queries."*

---

### Workflow B: Managing Finances with Prompts

Once authenticated, prompt your coding agent with natural language:

#### 💼 Wallets & Balances
- *"Show all my wallets and total balances."*
- *"Create a new wallet called 'BCA Main' with initial balance IDR 15,000,000 in IDR currency."*
- *"Update my GoPay wallet balance to IDR 750,000."*

#### 📊 Budgets & Categories
- *"Create an expense category called 'Groceries' and an income category called 'Freelance'."*
- *"Create a monthly budget of IDR 3,000,000 for the Groceries category for August 2026."*
- *"Check the current utilization and remaining limit of my active budgets."*

#### 💳 Transactions & Planning
- *"Record an expense of IDR 250,000 from BCA Main for Groceries note 'Supermarket run'."*
- *"Record an income of IDR 12,000,000 to BCA Main for Freelance."*
- *"Add a planned expense of IDR 1,500,000 for Flight tickets scheduled next week."*
- *"List all my transactions for this month sorted by date."*

#### 📈 Financial Summaries & Net Worth
- *"Give me a complete financial summary: my net worth across all currencies, total savings, and breakdown by expense category."*

---

## ⚡ CLI Snippet Helper

Generate copy-paste configuration snippets anytime from your terminal:

```bash
# Print configs for all agents
npm run agent:snippet

# Or print for a specific agent
npm run agent:snippet claude
npm run agent:snippet opencode
npm run agent:snippet pi
npm run agent:snippet omp
```
