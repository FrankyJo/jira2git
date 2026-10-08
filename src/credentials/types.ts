/**
 * OS-native secret storage: macOS Keychain, Windows Credential Manager, or the
 * Secret Service API (libsecret) on Linux. Secrets are never written to
 * configuration files, repositories, logs, or AI prompts. When no secure
 * backend is available the store reports itself unavailable; it never falls
 * back to plaintext files. Implemented in Phase 2.
 */
export type CredentialBackend = 'macos-keychain' | 'windows-credential-manager' | 'secret-service';

export const CREDENTIAL_SERVICE = 'git2jira-ai';

export interface CredentialReference {
  /** Always CREDENTIAL_SERVICE. */
  service: typeof CREDENTIAL_SERVICE;
  /** Identifies the secret, e.g. `api-token:example.atlassian.net:dev@example.com`. */
  account: string;
}

export interface CredentialStore {
  readonly backend: CredentialBackend;
  isAvailable(): Promise<boolean>;
  get(reference: CredentialReference): Promise<string | undefined>;
  set(reference: CredentialReference, secret: string): Promise<void>;
  delete(reference: CredentialReference): Promise<boolean>;
}
