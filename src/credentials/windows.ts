import { SpawnProcessRunner, type ProcessRunner } from '../core/process';
import {
  CredentialStoreError,
  CredentialStoreUnavailableError,
  assertSecretFormat,
  type CredentialReference,
  type CredentialStore,
} from './types';

const POWERSHELL = 'powershell.exe';

/** Win32 Credential Manager (advapi32 CredRead/CredWrite/CredDelete) via P/Invoke. */
const NATIVE = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class G2JCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDelete(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr cred);
}
'@
`;

/**
 * Windows Credential Manager (generic credentials, persisted per user). The
 * script is passed with -EncodedCommand and contains only the target name;
 * the secret is written to stdin and read with [Console]::In, so it never
 * appears in the command line. Exit codes: 0 ok, 3 not found, other failure.
 */
export class WindowsCredentialStore implements CredentialStore {
  readonly backend = 'windows-credential-manager' as const;

  constructor(private readonly runner: ProcessRunner = new SpawnProcessRunner()) {}

  async isAvailable(): Promise<boolean> {
    const result = await this.runner.run(POWERSHELL, args('exit 0'), { timeoutMs: 30_000 });
    return result.exitCode === 0;
  }

  async get(reference: CredentialReference): Promise<string | undefined> {
    const script = `${NATIVE}
$p = [IntPtr]::Zero
if (-not [G2JCred]::CredRead('${target(reference)}', 1, 0, [ref]$p)) { exit 3 }
$c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][G2JCred+CREDENTIAL])
$bytes = New-Object byte[] $c.CredentialBlobSize
[Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $c.CredentialBlobSize)
[G2JCred]::CredFree($p)
[Console]::Out.Write([Convert]::ToBase64String($bytes))
exit 0`;
    const result = await this.powershell(script);
    if (result.exitCode === 3) return undefined;
    if (result.exitCode !== 0) throw this.failure('read', result.stderr);
    return Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
  }

  async set(reference: CredentialReference, secret: string): Promise<void> {
    assertSecretFormat(secret);
    const script = `${NATIVE}
$secret = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($secret)
$c = New-Object G2JCred+CREDENTIAL
$c.Type = 1
$c.TargetName = '${target(reference)}'
$c.UserName = '${reference.account}'
$c.Persist = 2
$c.CredentialBlobSize = $bytes.Length
$c.CredentialBlob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $c.CredentialBlob, $bytes.Length)
$ok = [G2JCred]::CredWrite([ref]$c, 0)
[Runtime.InteropServices.Marshal]::FreeHGlobal($c.CredentialBlob)
if (-not $ok) { exit 1 }
exit 0`;
    const result = await this.powershell(script, secret);
    if (result.exitCode !== 0) throw this.failure('store', result.stderr);
    if ((await this.get(reference)) !== secret) throw this.failure('verify', '');
  }

  async delete(reference: CredentialReference): Promise<boolean> {
    const script = `${NATIVE}
if ([G2JCred]::CredDelete('${target(reference)}', 1, 0)) { exit 0 }
if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 3 }
exit 1`;
    const result = await this.powershell(script);
    if (result.exitCode === 3) return false;
    if (result.exitCode !== 0) throw this.failure('delete', result.stderr);
    return true;
  }

  private async powershell(script: string, input?: string) {
    const result = await this.runner.run(POWERSHELL, args(script), {
      timeoutMs: 60_000,
      ...(input === undefined ? {} : { input }),
    });
    if (result.notFound) {
      throw new CredentialStoreUnavailableError(this.backend, 'powershell.exe not found');
    }
    return result;
  }

  private failure(action: string, stderr: string): CredentialStoreError {
    const detail = stderr.trim().split('\n')[0] ?? '';
    return new CredentialStoreError(
      `Could not ${action} the credential in Windows Credential Manager${detail ? ` (${detail})` : ''}.`,
    );
  }
}

/** Target names only contain ACCOUNT_PATTERN characters, so single quotes are safe. */
function target(reference: CredentialReference): string {
  return `${reference.service}:${reference.account}`;
}

export function args(script: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ];
}
