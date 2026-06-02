import { Command } from 'commander';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('agentos')
    .description('Project-level intelligent coordination system')
    .version('0.1.0');

  program
    .command('init')
    .description('Initialize AgentOS in the current project')
    .option('--target <dir>', 'Target directory (defaults to cwd)')
    .option(
      '--mode <modes>',
      'Comma-separated CLAUDE.md template modes: documentation,parallel,event-sourcing,multi-provider,all',
      'documentation',
    )
    .action(async (opts) => {
      const { initProject } = await import('./commands/init.js');
      const { parseModes } = await import('./commands/scaffold-docs.js');
      const modes = parseModes(opts.mode);
      await initProject(opts.target || process.cwd(), { modes });
    });

  program
    .command('start')
    .description('Start the AgentOS daemon')
    .option('--port <port>', 'HTTP/WebSocket port', '3382')
    .action(async (opts) => {
      const { startDaemon } = await import('./commands/start.js');
      await startDaemon(opts.port);
    });

  program
    .command('stop')
    .description('Stop the AgentOS daemon')
    .action(async () => {
      const { stopDaemon } = await import('./commands/stop.js');
      await stopDaemon();
    });

  program
    .command('status')
    .description('Show AgentOS daemon status')
    .action(async () => {
      const { showStatus } = await import('./commands/status.js');
      await showStatus();
    });

  program
    .command('open')
    .description('Open the AgentOS web console in browser')
    .action(async () => {
      const { openConsole } = await import('./commands/open.js');
      await openConsole();
    });

  program
    .command('list')
    .description('List all registered AgentOS projects')
    .action(async () => {
      const { listProjects } = await import('./commands/list.js');
      await listProjects();
    });

  program
    .command('pending')
    .description('Print session-start bundle: active tasks, project-memory pointers, git ahead/dirty, CHANGELOG state')
    .option('--json', 'Emit raw JSON (for piping into other tools)')
    .action(async (opts) => {
      const { showPending } = await import('./commands/pending.js');
      await showPending({ json: !!opts.json });
    });

  program
    .command('install-hooks')
    .description('Install (or update) AgentOS-managed git hooks: pre-commit CHANGELOG reminder')
    .option('--force', 'Overwrite an existing non-agentos hook')
    .action(async (opts) => {
      const { installHooksCommand } = await import('./commands/install-hooks.js');
      await installHooksCommand({ force: !!opts.force });
    });

  program
    .command('gating <file>')
    .description('Print "read first" decision-doc rules that apply to <file> (from .agentos/gating.json)')
    .option('--json', 'Emit raw JSON')
    .action(async (file, opts) => {
      const { gatingCommand } = await import('./commands/gating.js');
      await gatingCommand(file, { json: !!opts.json });
    });

  program
    .command('next-task-id')
    .description('Reserve the next TASK-NNN id (writes .agentos/task-counter.json; does not create a file)')
    .option('--json', 'Emit raw JSON')
    .action(async (opts) => {
      const { nextTaskIdCommand } = await import('./commands/next-task-id.js');
      await nextTaskIdCommand({ json: !!opts.json });
    });

  return program;
}
