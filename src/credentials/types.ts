import { Git2JiraError } from '../core/errors';

/**
 * OS-native secret storage: macOS Keychain, Windows Credential Manager, or the
 * Secret Service API (libsecret) on Linux. Secrets are never written to
 * configuration files, repositories, logs, or AI prompts. When no secure
 * backend is available the store reports itself unavailable; it never falls
 * back to plaintext files.
 */
export type CredentialBackend = 'macos-keychain' | 'windows-credential-manager' | 'secret-service';

export const CREDENTIAL_SERVICE = 'git2jira-ai';

export interface CredentialReference {
  /** Always CREDENTIAL_SERVICE. */
  service: typeof CREDENTIAL_SERVICE;
  /** Identifies the secret, e.g. `jira-api-token:work`. Restricted to safe characters. */
  account: string;
}

export interface CredentialStore {
  readonly backend: CredentialBackend;
  isAvailable(): Promise<boolean>;
  get(reference: CredentialReference): Promise<string | undefined>;
  set(reference: CredentialReference, secret: string): Promise<void>;
  delete(reference: CredentialReference): Promise<boolean>;
}

/**
 * Account names are passed to OS tools (as arguments, or embedded in a script
 * on Windows), so they are limited to characters that need no quoting.
 */
export const ACCOUNT_PATTERN = /^[A-Za-z0-9._:@+-]{1,128}$/;

/** Secrets must be printable ASCII without whitespace (Atlassian tokens are). */
export const SECRET_PATTERN = /^[\x21-\x7e]{1,4096}$/;

export function credentialReference(account: string): CredentialReference {
  if (!ACCOUNT_PATTERN.test(account)) throw new Error(`Invalid credential account "${account}".`);
  return { service: CREDENTIAL_SERVICE, account };
}

export function assertSecretFormat(secret: string): void {
  if (!SECRET_PATTERN.test(secret)) {
    throw new CredentialStoreError(
      'The secret contains whitespace or non-ASCII characters; check that it was pasted correctly.',
    );
  }
}

export class CredentialStoreError extends Git2JiraError {}

export class CredentialStoreUnavailableError extends Git2JiraError {
  constructor(backend: string, detail: string) {
    super(
      `No secure credential store is available (${backend}: ${detail}). ` +
        'Git2Jira never stores credentials in plaintext; see docs/authentication.md.',
    );
  }
}
