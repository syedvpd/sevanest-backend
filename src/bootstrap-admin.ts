import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AuditModule } from './common/audit/audit.module';
import { weakPasswordProblems } from './common/security/password-strength';
import { AppConfigModule } from './config/config.module';
import { AppConfigService } from './config/app-config.service';
import { DatabaseModule } from './infrastructure/database/database.module';
import { RbacSeedService } from './modules/users/rbac-seed.service';
import { UsersModule } from './modules/users/users.module';

@Module({ imports: [AppConfigModule, DatabaseModule, AuditModule, UsersModule] })
class BootstrapAdminModule {}

/** In production the operator must also type this exact phrase, so a stray environment variable cannot create a privileged user. */
export const PRODUCTION_CONFIRMATION = 'create-first-super-admin';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Reads a line from the terminal without echoing it, so the password never reaches the screen, shell history or process list. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(
        new Error('No terminal to ask for the password: use BOOTSTRAP_SUPER_ADMIN_PASSWORD_FILE'),
      );
      return;
    }
    process.stdout.write(question);
    let typed = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          reject(new Error('Cancelled'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(typed);
          return;
        }
        typed = ch === '\u007f' || ch === '\b' ? typed.slice(0, -1) : typed + ch;
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * Where the password comes from, in order: a file (BOOTSTRAP_SUPER_ADMIN_PASSWORD_FILE, e.g. a Render secret file or a mounted
 * Docker/Kubernetes secret), the environment variable (kept for compatibility; set it only for this one run and remove it
 * afterwards), or a hidden prompt on an interactive terminal (preferred: nothing is stored anywhere).
 */
async function readPassword(): Promise<string> {
  const file = process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD_FILE;
  if (file) return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  if (process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD) return process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD;
  return promptHidden('Super Admin password (input hidden): ');
}

/**
 * `npm run bootstrap:admin` (after `npm run build`): the ONE supported way to create the first Super Admin in production.
 * The email comes from BOOTSTRAP_SUPER_ADMIN_EMAIL; the password from a secret file, the environment or a hidden prompt (see
 * readPassword). Neither is ever printed, logged, audited or stored, and there is no default. Weak passwords are refused. Production additionally requires BOOTSTRAP_SUPER_ADMIN_CONFIRM=create-first-super-admin.
 * It is one-time: it refuses (exit 1, audited as `admin.bootstrap_rejected`) once any Super Admin exists. Normal application
 * start-up never creates a user. Remove the variables from the environment after the run and rotate the password on first use.
 */
async function main(): Promise<void> {
  const email = process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error('Set BOOTSTRAP_SUPER_ADMIN_EMAIL');
  if (!EMAIL.test(email)) {
    throw new Error('BOOTSTRAP_SUPER_ADMIN_EMAIL is not a valid email address');
  }
  const app = await NestFactory.createApplicationContext(BootstrapAdminModule, {
    logger: ['error', 'warn'],
  });
  try {
    if (
      app.get(AppConfigService).isProduction &&
      process.env.BOOTSTRAP_SUPER_ADMIN_CONFIRM !== PRODUCTION_CONFIRMATION
    ) {
      throw new Error(
        `In production set BOOTSTRAP_SUPER_ADMIN_CONFIRM=${PRODUCTION_CONFIRMATION} to confirm`,
      );
    }
    // Checked before the password is even requested, so a refused run never asks for (or reads) a secret.
    const password = await readPassword();
    if (!password) throw new Error('No password was provided');
    const weak = weakPasswordProblems(
      password,
      email,
      app.get(AppConfigService).adminLogin.passwordMinLength,
    );
    if (weak.length > 0) throw new Error(`The password is too weak: ${weak.join('; ')}`);
    const rbac = app.get(RbacSeedService);
    await rbac.ensureReferenceData();
    const created = await rbac.bootstrapSuperAdmin(email, password);
    if (!created) {
      throw new Error('A Super Admin already exists; bootstrap refused (audited)');
    }
    console.log('First Super Admin created. Remove the bootstrap variables from the environment.');
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('Bootstrap failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
