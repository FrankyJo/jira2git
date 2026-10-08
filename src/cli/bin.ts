import { createDefaultContainer } from '../app/bootstrap';
import { runCli } from './run';

const exitCode = await runCli(process.argv.slice(2), {
  container: createDefaultContainer(),
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  interactive: process.stdin.isTTY && process.stdout.isTTY,
});
process.exitCode = exitCode;
