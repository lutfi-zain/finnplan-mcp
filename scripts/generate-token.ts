import { generateUserToken, DEFAULT_TOKEN_EXPIRY_SECONDS } from '../src/utils/token';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function loadDevVars(): Record<string, string> {
  const devVarsPath = join(__dirname, '../.dev.vars');
  const result: Record<string, string> = {};
  if (existsSync(devVarsPath)) {
    const content = readFileSync(devVarsPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [k, ...v] = trimmed.split('=');
        result[k.trim()] = v.join('=').trim();
      }
    }
  }
  return result;
}

function parseArgs(args: string[]) {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        result[key] = next;
        i++;
      } else {
        result[key] = 'true';
      }
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const devVars = loadDevVars();

  const userId = args.userId || args.u || `usr_${Date.now().toString(36)}`;
  const name = args.name || args.n || 'Eve User';
  const email = args.email || args.e || 'user@example.com';
  const secret = args.secret || process.env.JWT_SECRET || devVars.JWT_SECRET;
  const expiresInSeconds = args.expiresIn ? parseInt(args.expiresIn, 10) : DEFAULT_TOKEN_EXPIRY_SECONDS;

  if (!secret) {
    console.error('Error: JWT_SECRET not found. Please provide --secret <key> or set JWT_SECRET in .dev.vars / process.env');
    process.exit(1);
  }

  const token = await generateUserToken(
    {
      userId,
      name,
      email,
      expiresInSeconds,
    },
    secret
  );

  console.log('\n✨ Self-Contained JWT Generated Successfully!\n');
  console.log(`User ID : ${userId}`);
  console.log(`Name    : ${name}`);
  console.log(`Email   : ${email}`);
  console.log(`Expires : ${expiresInSeconds} seconds (${Math.round(expiresInSeconds / 60)} minutes)`);
  console.log(`Secret  : *** (Length: ${secret.length})`);
  console.log('\n--- BEARER TOKEN ---');
  console.log(token);
  console.log('--------------------\n');
  console.log('Example Authorization Header:');
  console.log(`Authorization: Bearer ${token}\n`);
}

main().catch((err) => {
  console.error('Error generating token:', err);
  process.exit(1);
});
