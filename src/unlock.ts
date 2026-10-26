import { password } from '@inquirer/prompts';
import { spawn } from 'node:child_process';
import { setSessionPassphrase } from './session.js';

export async function promptSessionPassphrase(confirmNew = false): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Passphrase entry requires your own interactive terminal. Use npm run unlock -- <agent command>; never pass the secret in command-line arguments or .env.');
  const value = await password({ message: confirmNew ? 'Choose a session passphrase (12+ characters, not saved):' : 'Session passphrase (not saved):', mask: '*', validate: value => {
    try { setSessionPassphrase(value); return true; } catch { return 'Use 12–1024 characters without line breaks.'; }
  } });
  if (confirmNew) {
    const again = await password({ message: 'Confirm the session passphrase:', mask: '*' });
    if (value !== again) throw new Error('Passphrases did not match. No session was saved.');
  }
  setSessionPassphrase(value);
  return value;
}

/** Launch an agent with a one-run credential; never persist it or use a shell. */
export async function launchUnlocked(command: string, args: string[], passphrase: string): Promise<number> {
  setSessionPassphrase(passphrase);
  const child = spawn(command, args, { stdio: 'inherit', shell: false,
    env: { ...process.env, BRIGHTSPACE_SESSION_PASSPHRASE: passphrase } });
  return await new Promise<number>((resolve, reject) => {
    const forward = (signal: NodeJS.Signals) => { child.kill(signal); };
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.once('error', () => { cleanup(); reject(new Error('Could not start the agent command. Check that it is installed and on PATH.')); });
    child.once('exit', (code, signal) => { cleanup(); resolve(code ?? (signal === 'SIGINT' ? 130 : 1)); });
  });
}

export async function runUnlock(args: string[]) {
  if (args[0] === '--') args = args.slice(1);
  if (!args.length) throw new Error('Usage: npm run unlock -- <agent command> [arguments]. Example: npm run unlock -- codex');
  const passphrase = await promptSessionPassphrase();
  console.log('Starting your agent. Forward BRIGHTSPACE_SESSION_PASSPHRASE to the Brightspace MCP in its configuration. The passphrase is kept in process memory/environment only and is not saved.');
  process.exitCode = await launchUnlocked(args[0], args.slice(1), passphrase);
}
