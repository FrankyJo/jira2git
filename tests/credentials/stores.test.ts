import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProcessOptions, ProcessResult, ProcessRunner } from '../../src/core/process';
import { SpawnProcessRunner } from '../../src/core/process';
import { SecretServiceStore } from '../../src/credentials/linux';
import { MacKeychainStore } from '../../src/credentials/macos';
import { createPlatformCredentialStore } from '../../src/credentials/platform';
import { CredentialStoreUnavailableError, credentialReference } from '../../src/credentials/types';
import { WindowsCredentialStore } from '../../src/credentials/windows';

const SECRET = 'ATATT3xFfGF0-very/secret+token=';
const REF = credentialReference('jira-api-token:work');

interface Call {
  file: string;
  args: readonly string[];
  options: ProcessOptions;
}

/** Scripted runner that records every invocation. */
class FakeRunner implements ProcessRunner {
  readonly calls: Call[] = [];
  constructor(private readonly respond: (call: Call) => Partial<ProcessResult>) {}
  run(file: string, args: readonly string[], options: ProcessOptions = {}): Promise<ProcessResult> {
    const call = { file, args, options };
    this.calls.push(call);
    return Promise.resolve({
      stdout: '',
      stderr: '',
      exitCode: 0,
      notFound: false,
      timedOut: false,
      ...this.respond(call),
    });
  }
}

function assertSecretNeverInArgv(runner: FakeRunner) {
  for (const call of runner.calls) {
    expect(call.args.join(' ')).not.toContain(SECRET);
    expect(call.args.join(' ')).not.toContain(Buffer.from(SECRET).toString('hex'));
  }
}

describe('MacKeychainStore', () => {
  it('writes the secret as hex over stdin and reads it back', async () => {
    let stored: string | undefined;
    const runner = new FakeRunner((call) => {
      if (call.args[0] === '-i') {
        const hex = /-X ([0-9a-f]+)/.exec(call.options.input ?? '')?.[1] ?? '';
        stored = Buffer.from(hex, 'hex').toString('utf8');
        return {};
      }
      if (call.args[0] === 'find-generic-password')
        return stored === undefined ? { exitCode: 44 } : { stdout: `${stored}\n` };
      if (call.args[0] === 'delete-generic-password') {
        const had = stored !== undefined;
        stored = undefined;
        return { exitCode: had ? 0 : 44 };
      }
      return {};
    });
    const store = new MacKeychainStore(runner);
    expect(await store.get(REF)).toBeUndefined();
    await store.set(REF, SECRET);
    expect(await store.get(REF)).toBe(SECRET);
    expect(runner.calls[1]?.options.input).toContain('-s "git2jira-ai" -a "jira-api-token:work"');
    expect(await store.delete(REF)).toBe(true);
    expect(await store.delete(REF)).toBe(false);
    assertSecretNeverInArgv(runner);
    expect(runner.calls.every((c) => c.file === '/usr/bin/security')).toBe(true);
  });

  it('detects a write that did not take effect', async () => {
    const runner = new FakeRunner((call) =>
      call.args[0] === 'find-generic-password' ? { exitCode: 44 } : {},
    );
    await expect(new MacKeychainStore(runner).set(REF, SECRET)).rejects.toThrow(/Could not store/);
  });

  it('rejects secrets with whitespace or non-ASCII characters', async () => {
    const store = new MacKeychainStore(new FakeRunner(() => ({})));
    await expect(store.set(REF, 'two words')).rejects.toThrow(/pasted correctly/);
    await expect(store.set(REF, 'tökén')).rejects.toThrow(/pasted correctly/);
  });

  it('refuses unsafe account names', () => {
    expect(() => credentialReference('a" -w "x')).toThrow();
    expect(() => credentialReference("a'b")).toThrow();
  });
});

describe('SecretServiceStore', () => {
  it('passes the secret on stdin only', async () => {
    let stored: string | undefined;
    const runner = new FakeRunner((call) => {
      if (call.args[0] === 'store') {
        stored = call.options.input;
        return {};
      }
      if (call.args[0] === 'lookup')
        return stored === undefined ? { exitCode: 1 } : { stdout: stored };
      if (call.args[0] === 'clear') stored = undefined;
      return {};
    });
    const store = new SecretServiceStore(runner, { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' });
    await store.set(REF, SECRET);
    expect(await store.get(REF)).toBe(SECRET);
    expect(runner.calls[0]?.args).toEqual([
      'store',
      '--label=Git2Jira (jira-api-token:work)',
      'service',
      'git2jira-ai',
      'account',
      'jira-api-token:work',
    ]);
    expect(await store.delete(REF)).toBe(true);
    expect(await store.delete(REF)).toBe(false);
    assertSecretNeverInArgv(runner);
  });

  it('is unavailable without a D-Bus session or secret-tool, with no plaintext fallback', async () => {
    const noBus = new SecretServiceStore(new FakeRunner(() => ({})), {});
    expect(await noBus.isAvailable()).toBe(false);
    await expect(noBus.get(REF)).rejects.toThrow(CredentialStoreUnavailableError);
    const noTool = new SecretServiceStore(
      new FakeRunner(() => ({ notFound: true, exitCode: null })),
      {
        DBUS_SESSION_BUS_ADDRESS: 'x',
      },
    );
    expect(await noTool.isAvailable()).toBe(false);
    await expect(noTool.set(REF, SECRET)).rejects.toThrow(/libsecret-tools/);
  });
});

describe('WindowsCredentialStore', () => {
  it('sends the script encoded and the secret on stdin', async () => {
    let stored: string | undefined;
    const runner = new FakeRunner((call) => {
      const script = Buffer.from(call.args.at(-1) ?? '', 'base64').toString('utf16le');
      if (script.includes('[G2JCred]::CredWrite(')) {
        if (!script.includes('[Console]::In.ReadToEnd()'))
          throw new Error('secret must come from stdin');
        stored = call.options.input;
        return {};
      }
      if (script.includes('[G2JCred]::CredRead(')) {
        return stored === undefined
          ? { exitCode: 3 }
          : { stdout: Buffer.from(stored).toString('base64') };
      }
      if (script.includes('[G2JCred]::CredDelete(')) {
        const had = stored !== undefined;
        stored = undefined;
        return { exitCode: had ? 0 : 3 };
      }
      return {};
    });
    const store = new WindowsCredentialStore(runner);
    await store.set(REF, SECRET);
    expect(await store.get(REF)).toBe(SECRET);
    expect(await store.delete(REF)).toBe(true);
    expect(await store.delete(REF)).toBe(false);
    assertSecretNeverInArgv(runner);
    for (const call of runner.calls) {
      expect(Buffer.from(call.args.at(-1) ?? '', 'base64').toString('utf16le')).not.toContain(
        SECRET,
      );
      expect(call.args.slice(0, 5)).toEqual([
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
      ]);
    }
  });
});

describe('createPlatformCredentialStore', () => {
  it('picks the native backend and refuses unknown platforms', async () => {
    expect(createPlatformCredentialStore('darwin').backend).toBe('macos-keychain');
    expect(createPlatformCredentialStore('win32').backend).toBe('windows-credential-manager');
    expect(createPlatformCredentialStore('linux').backend).toBe('secret-service');
    const other = createPlatformCredentialStore('aix');
    expect(await other.isAvailable()).toBe(false);
    await expect(other.get(REF)).rejects.toThrow(CredentialStoreUnavailableError);
  });
});

// Uses a throwaway keychain file; opt-in because it runs the real `security` tool.
describe.runIf(process.platform === 'darwin' && process.env.GIT2JIRA_TEST_KEYCHAIN === '1')(
  'MacKeychainStore (real keychain file)',
  () => {
    it('round-trips a secret', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'git2jira-keychain-'));
      const keychain = path.join(dir, 'test.keychain-db');
      const runner = new SpawnProcessRunner();
      await runner.run('/usr/bin/security', ['create-keychain', '-p', 'test', keychain]);
      try {
        const store = new MacKeychainStore(runner, keychain);
        await store.set(REF, SECRET);
        expect(await store.get(REF)).toBe(SECRET);
        await store.set(REF, `${SECRET}2`);
        expect(await store.get(REF)).toBe(`${SECRET}2`);
        expect(await store.delete(REF)).toBe(true);
        expect(await store.get(REF)).toBeUndefined();
      } finally {
        await runner.run('/usr/bin/security', ['delete-keychain', keychain]);
        await rm(dir, { recursive: true, force: true });
      }
    });
  },
);
