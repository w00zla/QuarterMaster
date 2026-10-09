import type { MessageKey, MessageVars } from './i18n.ts';

/**
 * An error the user caused or can fix (wrong input, missing permission, ...).
 * Shown as a friendly ephemeral message in the user's language; not logged as a failure.
 * Anything else that is thrown counts as a bug: generic message to the user, details to the log.
 */
export class UserError extends Error {
  readonly key: MessageKey;
  readonly vars: MessageVars;
  // The message offers the user web app (it also works without an org)
  readonly webApp: boolean;

  constructor(key: MessageKey, vars: MessageVars = {}, options: { webApp?: boolean } = {}) {
    super(key);
    this.name = 'UserError';
    this.key = key;
    this.vars = vars;
    this.webApp = options.webApp ?? false;
  }
}
