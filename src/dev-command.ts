import { spawn } from 'node:child_process';
import { startDevelopmentSync } from './development-sync.js';

/** Run only the command explicitly passed by the user, never discover or restart a hosted process. */
export async function runDevelopment(command: string[], cwd = process.cwd()): Promise<number> {
  if (!command.length || !command[0] || command[0].startsWith('-')) {
    console.error('Usage: patchstack-connect dev -- <development-server> [arguments]');
    return 1;
  }
  const coordinator = startDevelopmentSync(cwd);
  console.error('patchstack: development sync enabled; map-specific rules detect only during hot reload. Broad and hardening rules retain their configured modes.');
  try {
    return await new Promise<number>(resolve => {
      const child = spawn(command[0]!, command.slice(1), {
        cwd, stdio: 'inherit', shell: false,
        env: { ...process.env, PATCHSTACK_DEV_SYNC: '1' },
      });
      const interrupt = () => { child.kill('SIGINT'); };
      const terminate = () => { child.kill('SIGTERM'); };
      process.on('SIGINT', interrupt);
      process.on('SIGTERM', terminate);
      const finish = (code: number) => {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', terminate);
        resolve(code);
      };
      child.once('error', () => { console.error('patchstack: could not start the requested development command.'); finish(1); });
      child.once('exit', (code, signal) => finish(code ?? (signal === 'SIGINT' ? 130 : 143)));
    });
  } finally { coordinator.stop(); }
}
