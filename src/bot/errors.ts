import type { MessageKey, MessageVars } from './i18n.ts';

/**
 * An error the user caused or can fix (wrong input, missing permission, ...).
 * Shown as a friendly ephemeral message in the user's language; not logged as a failure.
 * Anything else that is thrown counts as a bug: generic message to the user, details to the log.
 */
export class UserError extends Error {
  readonly key: MessageKey;
  readonly vars: MessageVars;

  constructor(key: MessageKey, vars: MessageVars = {}) {
    super(key);
    this.name = 'UserError';
    this.key = key;
    this.vars = vars;
  }
}
