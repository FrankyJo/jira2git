import type { ProcessRunner } from '../core/process';

/**
 * Opens an https URL in the default browser with the platform's own opener, without a
 * shell. Only URLs Git2Jira built itself (the Jira site of a draft) are passed here.
 */
const OPENERS: Readonly<Record<string, readonly [string, readonly string[]]>> = {
  darwin: ['open', []],
  // `start` is a cmd built-in and would need a shell; this handler takes the URL as one argument.
  win32: ['rundll32', ['url.dll,FileProtocolHandler']],
  linux: ['xdg-open', []],
  freebsd: ['xdg-open', []],
  openbsd: ['xdg-open', []],
};

export async function openInBrowser(
  runner: ProcessRunner,
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (new URL(url).protocol !== 'https:') return false;
  const opener = OPENERS[platform];
  if (!opener) return false;
  const [file, args] = opener;
  const result = await runner.run(file, [...args, url], { timeoutMs: 15_000 });
  return result.exitCode === 0;
}
