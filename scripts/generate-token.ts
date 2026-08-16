import { generateUserToken, DEFAULT_DEV_JWT_SECRET, DEFAULT_TOKEN_EXPIRY_SECONDS } from '../src/utils/token';

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

  const userId = args.userId || args.u || `usr_${Date.now().toString(36)}`;
  const name = args.name || args.n || 'Eve User';
  const email = args.email || args.e || 'user@example.com';
  const secret = args.secret || process.env.JWT_SECRET || DEFAULT_DEV_JWT_SECRET;
  const expiresInSeconds = args.expiresIn ? parseInt(args.expiresIn, 10) : DEFAULT_TOKEN_EXPIRY_SECONDS;

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
  console.log(`Secret  : ${secret === DEFAULT_DEV_JWT_SECRET ? '(Default Dev Secret)' : '***'}`);
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
