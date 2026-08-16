#!/usr/bin/env tsx
import { execSync } from 'node:child_process';
import { generateApiKey, generateUserId, hashApiKey, isValidEmail, isValidWhatsApp } from '../src/utils/token';

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--remote') {
      parsed.remote = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextVal = args[i + 1];
      if (nextVal && !nextVal.startsWith('--')) {
        parsed[key] = nextVal;
        i++;
      } else {
        parsed[key] = true;
      }
    }
  }
  return parsed;
}

async function main() {
  const args = parseArgs();
  const isRemote = Boolean(args.remote);

  const fullName = (args.name as string) || 'Demo User';
  const nameParts = fullName.trim().split(/\s+/);
  const firstName = nameParts[0] || 'Demo';
  const lastName = nameParts.slice(1).join(' ') || 'User';
  const email = ((args.email as string) || `user_${Date.now().toString(36)}@example.com`).trim().toLowerCase();
  const phone = ((args.phone as string) || '+6281234567890').trim();

  if (!isValidEmail(email)) {
    console.error(`❌ Invalid email format: "${email}"`);
    process.exit(1);
  }

  if (!isValidWhatsApp(phone)) {
    console.error(`❌ Invalid phone format: "${phone}". Must be E.164 (e.g. +6281234567890)`);
    process.exit(1);
  }

  const userId = generateUserId();
  const apiKey = generateApiKey();
  const apiKeyHash = await hashApiKey(apiKey);
  const targetEnv = isRemote ? 'remote' : 'local';

  console.log(`\n════════════════════════════════════════════════════════════`);
  console.log(`  Eve Finance MCP — Zero-Friction User Minting (${targetEnv.toUpperCase()} D1)`);
  console.log(`════════════════════════════════════════════════════════════\n`);

  console.log(`👤 Name:     ${firstName} ${lastName}`);
  console.log(`📧 Email:    ${email}`);
  console.log(`📱 Phone:    ${phone}`);
  console.log(`🆔 User ID:  ${userId}`);
  console.log(`🔑 API Key:  ${apiKey}\n`);

  // Insert into SQLite D1 database
  const insertSql = `INSERT INTO users (id, first_name, last_name, email, whatsapp_number, api_key_hash) VALUES ('${userId}', '${firstName}', '${lastName}', '${email}', '${phone}', '${apiKeyHash}');`;
  const remoteFlag = isRemote ? '--remote' : '--local';

  console.log(`⏳ Inserting user into ${targetEnv} D1 database...`);
  try {
    execSync(`npx wrangler d1 execute finance_db ${remoteFlag} --command="${insertSql}"`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    console.log(`✅ User registered successfully in ${targetEnv} D1 database!\n`);
  } catch (err: any) {
    console.error(`❌ Failed to execute D1 insert:\n`, err?.stderr || err?.message);
    process.exit(1);
  }

  const serverUrl = isRemote
    ? 'https://finnplan-mcp.lutfidmz.workers.dev/mcp'
    : 'http://localhost:8787/mcp';

  console.log(`────────────────────────────────────────────────────────────`);
  console.log(`  📋 Ready-to-Copy Coding Agent Configurations`);
  console.log(`────────────────────────────────────────────────────────────\n`);

  console.log(`▶ 1. OMP (Oh My Pi) [.omp/mcp.json or ~/.omp/agent/mcp.json]:`);
  console.log(JSON.stringify({
    "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
    "mcpServers": {
      "eve-finance": {
        "type": "http",
        "url": serverUrl,
        "headers": {
          "Authorization": `Bearer ${apiKey}`
        }
      }
    }
  }, null, 2));
  console.log();

  console.log(`▶ 2. Claude Code CLI:`);
  console.log(`claude mcp add --transport http --header "Authorization: Bearer ${apiKey}" eve-finance ${serverUrl}\n`);

  console.log(`▶ 3. OpenCode [opencode.json]:`);
  console.log(JSON.stringify({
    "mcp": {
      "eve-finance": {
        "type": "http",
        "url": serverUrl,
        "headers": {
          "Authorization": `Bearer ${apiKey}`
        }
      }
    }
  }, null, 2));
  console.log();

  console.log(`▶ 4. Cursor / VS Code [.cursor/mcp.json]:`);
  console.log(JSON.stringify({
    "mcpServers": {
      "eve-finance": {
        "url": serverUrl,
        "headers": {
          "Authorization": `Bearer ${apiKey}`
        }
      }
    }
  }, null, 2));
  console.log();

  console.log(`💡 Note: This API Key (${apiKey}) is persistent and never expires.`);
  console.log(`Coding agents will authenticate automatically on every tool call.\n`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
