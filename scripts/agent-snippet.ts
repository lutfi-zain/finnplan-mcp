/**
 * CLI Snippet Generator for Coding Agent Integrations
 * Run via: npm run agent:snippet [claude|opencode|pi|omp|all]
 */

const WORKER_URL = process.env.WORKER_URL || "https://finnplan-mcp.lutfidmz.workers.dev/mcp";

const target = (process.argv[2] || "all").toLowerCase();

console.log("\n========================================================");
console.log("  🤖 Eve Finance MCP — Coding Agent Setup Snippets");
console.log(`  🌐 Server URL: ${WORKER_URL}`);
console.log("========================================================\n");

function showClaudeCode() {
  console.log("--------------------------------------------------------");
  console.log("  1️⃣  CLAUDE CODE (https://code.claude.com/docs/en/agent-sdk/mcp)");
  console.log("--------------------------------------------------------");
  console.log("👉 CLI Command (One-liner):");
  console.log(`   claude mcp add --transport http eve-finance ${WORKER_URL}\n`);
  console.log("👉 Or Config File (.claude/mcp.json or .mcp.json):");
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          "eve-finance": {
            type: "http",
            url: WORKER_URL,
            headers: {
              Authorization: "Bearer <YOUR_JWT_TOKEN_OR_API_KEY>",
            },
          },
        },
      },
      null,
      2
    )
  );
  console.log();
}

function showOpenCode() {
  console.log("--------------------------------------------------------");
  console.log("  2️⃣  OPENCODE (https://opencode.ai/docs/mcp-servers/)");
  console.log("--------------------------------------------------------");
  console.log("👉 Interactive CLI:");
  console.log("   opencode mcp add\n");
  console.log("👉 Or Config File (opencode.json):");
  console.log(
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          "eve-finance": {
            type: "remote",
            url: WORKER_URL,
            headers: {
              Authorization: "Bearer <YOUR_JWT_TOKEN_OR_API_KEY>",
            },
          },
        },
      },
      null,
      2
    )
  );
  console.log();
}

function showPi() {
  console.log("--------------------------------------------------------");
  console.log("  3️⃣  PI (https://pi.dev/packages/pi-mcp-adapter)");
  console.log("--------------------------------------------------------");
  console.log("👉 Install Adapter:");
  console.log("   pi install npm:pi-mcp-adapter\n");
  console.log("👉 Config File (.mcp.json or ~/.config/mcp/mcp.json):");
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          "eve-finance": {
            url: WORKER_URL,
            headers: {
              Authorization: "Bearer <YOUR_JWT_TOKEN_OR_API_KEY>",
            },
          },
        },
      },
      null,
      2
    )
  );
  console.log("\n👉 Inside Pi terminal, run:");
  console.log("   /mcp setup");
  console.log();
}

function showOMP() {
  console.log("--------------------------------------------------------");
  console.log("  4️⃣  OMP - OH MY PI (https://omp.sh/docs/mcp)");
  console.log("--------------------------------------------------------");
  console.log("👉 Config File (.omp/mcp.json or .mcp.json):");
  console.log(
    JSON.stringify(
      {
        $schema: "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
        mcpServers: {
          "eve-finance": {
            url: WORKER_URL,
            headers: {
              Authorization: "Bearer <YOUR_JWT_TOKEN_OR_API_KEY>",
            },
          },
        },
      },
      null,
      2
    )
  );
  console.log("\n👉 Or Inside OMP session:");
  console.log("   /mcp add");
  console.log();
}

switch (target) {
  case "claude":
  case "claudecode":
    showClaudeCode();
    break;
  case "opencode":
    showOpenCode();
    break;
  case "pi":
    showPi();
    break;
  case "omp":
    showOMP();
    break;
  case "all":
  default:
    showClaudeCode();
    showOpenCode();
    showPi();
    showOMP();
    break;
}

console.log("========================================================");
console.log("📚 Full guide available at: docs/CODING_AGENTS.md");
console.log("========================================================\n");
