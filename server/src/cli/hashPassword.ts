/**
 * Generates admin credentials for the environment / SSM Parameter Store:
 *
 *   npm run admin:hash-password -w server
 *
 * Prompts for the password without echoing it (or reads ADMIN_PASSWORD from the
 * environment for scripted use) and prints ADMIN_PASSWORD_HASH plus a fresh
 * random ADMIN_SESSION_SECRET. The password itself is never written anywhere.
 */
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { hashPassword, PASSWORD_MIN_LENGTH } from '../services/adminAuth.js';

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const rlInternal = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let prompted = false;
    rlInternal._writeToOutput = (s: string) => {
      // Show the prompt once, then mask every keystroke.
      if (!prompted) {
        rlInternal.output.write(s);
        prompted = true;
      } else if (s.includes('\n') || s.includes('\r')) {
        rlInternal.output.write('\n');
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    if (!process.stdin.isTTY) throw new Error('Run in an interactive terminal, or set ADMIN_PASSWORD.');
    password = await promptHidden(`Admin password (min ${PASSWORD_MIN_LENGTH} characters): `);
    const confirm = await promptHidden('Repeat password: ');
    if (password !== confirm) throw new Error('Passwords do not match.');
  }
  const hash = await hashPassword(password);
  const secret = randomBytes(32).toString('base64url');
  console.log('\nStore these two values (SSM Parameter Store as SecureString in production, server/.env locally):\n');
  console.log(`ADMIN_PASSWORD_HASH=${hash}`);
  console.log(`ADMIN_SESSION_SECRET=${secret}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
