import type { ProcessRunner } from '../core/process';

/**
 * Copies text to the system clipboard with the platform's own tool, passing the text
 * on stdin. Only macOS (`pbcopy`) has been exercised; the Windows and Linux commands
 * are untested. When no tool works, callers fall back to `report export`.
 */
const COMMANDS: Readonly<Record<string, readonly (readonly [string, readonly string[]])[]>> = {
  darwin: [['pbcopy', []]],
  win32: [
    [
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())',
      ],
    ],
  ],
  linux: [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ],
};

export async function copyToClipboard(
  runner: ProcessRunner,
  text: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ copied: boolean; tool?: string }> {
  for (const [file, args] of COMMANDS[platform] ?? []) {
    const result = await runner.run(file, args, { input: text, timeoutMs: 10_000 });
    if (result.exitCode === 0) return { copied: true, tool: file };
  }
  return { copied: false };
}
