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

  return program;
}
