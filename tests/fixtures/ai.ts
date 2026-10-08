import type { ProcessOptions, ProcessResult, ProcessRunner } from '../../src/core/process';
import type { ReportPrompt } from '../../src/ai/prompt';
import type { AIReportProvider } from '../../src/ai/types';
import {
  PromptCancelledError,
  type Prompter,
  type SelectOption,
} from '../../src/installer/prompter';

interface DecodedPrompt {
  task: { issueKey: string; language: 'en' | 'uk'; testStatus: string; part?: number };
  files: { status: string; path: string; previousPath?: string }[];
  data: {
    diffs?: { path: string; diff: string }[];
    partialResults?: Record<string, unknown>[];
    issue?: unknown;
    tests?: unknown[];
  };
  nonce: string;
}

/** Reads the prompt the way a model would see it: tagged JSON blocks. */
export function decodePrompt(prompt: ReportPrompt): DecodedPrompt {
  const tag = (name: string) => {
    const match = new RegExp(`<${name}>(.*?)</${name}>`, 's').exec(prompt.user);
    if (!match?.[1]) throw new Error(`prompt has no <${name}>`);
    return JSON.parse(match[1]) as unknown;
  };
  const fence = /<repository-data id="([0-9a-f]+)">\n([\s\S]*)\n<\/repository-data id="\1">/.exec(
    prompt.user,
  );
  if (!fence?.[1] || !fence[2]) throw new Error('prompt has no data block');
  return {
    task: tag('task') as DecodedPrompt['task'],
    files: tag('changed-files') as DecodedPrompt['files'],
    data: JSON.parse(fence[2]) as DecodedPrompt['data'],
    nonce: fence[1],
  };
}

/**
 * A deterministic stand-in for the model: describes each file whose diff it was
 * given, in the requested language, with the fixed testing status. Records prompts.
 * `override` can replace or tamper with the output per call.
 */
export class FakeModel implements AIReportProvider {
  readonly mode = 'headless' as const;
  readonly prompts: ReportPrompt[] = [];
  available: Error | undefined;
  override: ((output: Record<string, unknown>, call: number) => unknown) | undefined;

  describe(): string {
    return 'fake model';
  }

  ensureAvailable(): Promise<void> {
    return this.available ? Promise.reject(this.available) : Promise.resolve();
  }

  complete(prompt: ReportPrompt): Promise<unknown> {
    this.prompts.push(prompt);
    const decoded = decodePrompt(prompt);
    const output = decoded.data.partialResults ? merged(decoded) : describeDiffs(decoded);
    return Promise.resolve(this.override ? this.override(output, this.prompts.length) : output);
  }
}

function describeDiffs({ task, files, data }: DecodedPrompt): Record<string, unknown> {
  const uk = task.language === 'uk';
  const diffs = data.diffs ?? [];
  const seen = new Set(diffs.map((d) => d.path));
  const status = new Map(files.map((f) => [f.path, f]));
  const work = diffs.map((d) => {
    const added = d.diff
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    return {
      kind: status.get(d.path)?.status === 'deleted' ? 'removed' : 'modified',
      category: 'feature',
      subject: d.path,
      description: uk
        ? `Оновлено ${d.path}: додано рядків ${String(added)}.`
        : `Updated ${d.path}: ${String(added)} line(s) added.`,
      files: [d.path],
    };
  });
  const section = (statuses: string[]) =>
    files
      .filter((f) => seen.has(f.path) && statuses.includes(f.status))
      .map((f) => ({ path: f.path, note: uk ? 'Оновлено.' : 'Updated.' }));
  return {
    issueKey: task.issueKey,
    language: task.language,
    summary: uk
      ? `Реалізовано зміни у ${String(diffs.length)} файлах.`
      : `Implemented changes in ${String(diffs.length)} file(s).`,
    completedWork:
      work.length > 0
        ? work
        : [
            {
              kind: 'modified',
              category: 'other',
              subject: 'Repository',
              description: uk ? 'Оновлено метадані файлів.' : 'Updated file metadata.',
              files: [],
            },
          ],
    createdFiles: section(['added', 'copied']),
    modifiedFiles: section(['modified', 'type-changed']),
    deletedFiles: section(['deleted']),
    renamedFiles: files
      .filter((f) => seen.has(f.path) && f.status === 'renamed')
      .map((f) => ({ from: f.previousPath, to: f.path })),
    testing: {
      status: task.testStatus,
      notes:
        task.testStatus === 'not-run' ? [] : [uk ? 'Див. запуски тестів.' : 'See the test runs.'],
    },
    limitations: [],
    uncertainties: [],
  };
}

function merged({ task, data }: DecodedPrompt): Record<string, unknown> {
  const partials = data.partialResults ?? [];
  const first = partials[0] ?? {};
  return {
    ...first,
    summary: task.language === 'uk' ? 'Зведений підсумок.' : 'Consolidated summary.',
    completedWork: partials.flatMap((p) => p.completedWork as unknown[]),
    createdFiles: partials.flatMap((p) => p.createdFiles as unknown[]),
    modifiedFiles: partials.flatMap((p) => p.modifiedFiles as unknown[]),
    deletedFiles: partials.flatMap((p) => p.deletedFiles as unknown[]),
    renamedFiles: partials.flatMap((p) => p.renamedFiles as unknown[]),
  };
}

/** Answers prompts from a script; fails the test when the script runs out. */
export class ScriptedPrompter implements Prompter {
  readonly asked: string[] = [];
  constructor(private readonly answers: (string | boolean)[]) {}

  private next(message: string): string | boolean {
    this.asked.push(message);
    if (this.answers.length === 0) throw new PromptCancelledError();
    return this.answers.shift() as string | boolean;
  }
  intro(message: string): void {
    this.asked.push(message);
  }
  outro(message: string): void {
    this.asked.push(message);
  }
  note(message: string): void {
    this.asked.push(message);
  }
  select<T extends string>(message: string, options: readonly SelectOption<T>[]): Promise<T> {
    const answer = this.next(message);
    if (!options.some((o) => o.value === answer))
      throw new Error(`unexpected answer ${String(answer)}`);
    return Promise.resolve(answer as T);
  }
  text(message: string): Promise<string> {
    return Promise.resolve(String(this.next(message)));
  }
  password(message: string): Promise<string> {
    return Promise.resolve(String(this.next(message)));
  }
  confirm(message: string): Promise<boolean> {
    return Promise.resolve(this.next(message) === true);
  }
}

/** Records every external program call; programs succeed unless `exitCodes` says otherwise. */
export class RecordingRunner implements ProcessRunner {
  readonly calls: { file: string; args: readonly string[]; options: ProcessOptions }[] = [];
  constructor(
    private readonly respond: (
      file: string,
      args: readonly string[],
    ) => Partial<ProcessResult> = () => ({}),
  ) {}
  run(file: string, args: readonly string[], options: ProcessOptions = {}): Promise<ProcessResult> {
    this.calls.push({ file, args, options });
    return Promise.resolve({
      stdout: '',
      stderr: '',
      exitCode: 0,
      notFound: false,
      timedOut: false,
      ...this.respond(file, args),
    });
  }
}
