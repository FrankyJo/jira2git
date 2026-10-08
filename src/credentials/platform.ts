import type { ProcessRunner } from '../core/process';
import { SpawnProcessRunner } from '../core/process';
import { SecretServiceStore } from './linux';
import { MacKeychainStore } from './macos';
import {
  CredentialStoreUnavailableError,
  type CredentialReference,
  type CredentialStore,
} from './types';
import { WindowsCredentialStore } from './windows';

/** Picks the OS-native store. Unsupported platforms get a store that always refuses. */
export function createPlatformCredentialStore(
  platform: NodeJS.Platform = process.platform,
  runner: ProcessRunner = new SpawnProcessRunner(),
): CredentialStore {
  switch (platform) {
    case 'darwin':
      return new MacKeychainStore(runner);
    case 'win32':
      return new WindowsCredentialStore(runner);
    case 'linux':
    case 'freebsd':
    case 'openbsd':
      return new SecretServiceStore(runner);
    default:
      return new UnsupportedCredentialStore(platform);
  }
}

class UnsupportedCredentialStore implements CredentialStore {
  readonly backend = 'secret-service' as const;
  constructor(private readonly platform: string) {}
  isAvailable(): Promise<boolean> {
    return Promise.resolve(false);
  }
  get(_reference: CredentialReference): Promise<string | undefined> {
    return Promise.reject(this.error());
  }
  set(_reference: CredentialReference, _secret: string): Promise<void> {
    return Promise.reject(this.error());
  }
  delete(_reference: CredentialReference): Promise<boolean> {
    return Promise.reject(this.error());
  }
  private error() {
    return new CredentialStoreUnavailableError(this.platform, 'platform not supported');
  }
}
