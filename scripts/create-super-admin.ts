import { input, password } from '@inquirer/prompts';
import { isAppError } from '../src/common/errors/AppError';
import { normalizeEmail, normalizePhone } from '../src/common/utils/identifier';
import { checkPasswordPolicy } from '../src/common/utils/passwordPolicy';
import { ROLES } from '../src/config/constants';
import { connectMongo, disconnectMongo } from '../src/config/db';
import { createAuditService } from '../src/modules/audit/audit.service';
import { passwordService } from '../src/modules/auth/password.service';
import { UserModel } from '../src/modules/users/user.model';
import { userRepository } from '../src/modules/users/user.repository';

const say = (text = ''): void => {
  process.stdout.write(`${text}\n`);
};

async function main(): Promise<void> {
  if (!process.stdin.isTTY) {
    say('This script needs an interactive terminal (PowerShell, Command Prompt or the VS Code terminal).');
    process.exitCode = 1;
    return;
  }

  try {
    await connectMongo();
    await UserModel.init(); // make sure the unique email and phone indexes exist

    if ((await userRepository.countByRole(ROLES.SUPER_ADMIN)) > 0) {
      say('A super admin already exists. Nothing was changed.');
      process.exitCode = 1;
      return;
    }

    say('Create the super admin (the proprietor account).');
    say();

    const email = normalizeEmail(
      await input({
        message: 'Email:',
        validate: (value) => normalizeEmail(value) !== null || 'That is not a valid email address.',
      }),
    );
    const phone = normalizePhone(
      await input({
        message: 'Phone number:',
        validate: (value) =>
          normalizePhone(value) !== null || 'That is not a valid phone number (for example 0906 456 0957).',
      }),
    );
    if (!email || !phone) throw new Error('Email or phone was not valid.');

    const chosen = await password({
      message: 'Password (at least 10 characters):',
      mask: '*',
      validate: (value) => {
        const issues = checkPasswordPolicy(value, { email, phone });
        return issues.length === 0 || issues.join('. ');
      },
    });
    await password({
      message: 'Repeat password:',
      mask: '*',
      validate: (value) => value === chosen || 'The two passwords do not match.',
    });

    const user = await userRepository.create({
      email,
      phone,
      passwordHash: await passwordService.hashPassword(chosen),
      role: ROLES.SUPER_ADMIN,
      mustChangePassword: false,
    });

    await createAuditService().record({
      action: 'SUPER_ADMIN_CREATED',
      actorId: null,
      entityType: 'user',
      entityId: user.id,
      metadata: { via: 'create-super-admin script' },
    });

    say();
    say(`Super admin created (id ${user.id}).`);
    say('Log in with the email or the phone number plus your password.');
    say('Email and phone are saved but not verified yet: verification arrives with the mailer.');
  } catch (err) {
    if (err instanceof Error && err.name === 'ExitPromptError') {
      say('Cancelled. Nothing was changed.');
    } else if (isAppError(err)) {
      say(`Could not create the account: ${err.message}`);
      for (const detail of err.details ?? []) say(`  - ${detail.field}: ${detail.issue}`);
    } else {
      say(`Failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
    process.exitCode = 1;
  } finally {
    await disconnectMongo();
  }
}

void main();