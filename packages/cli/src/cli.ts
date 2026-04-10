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
    .action(async (opts) => {
      const { initProject } = await import('./commands/init.js');
      await initProject(opts.target || process.cwd());
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

  return program;
}
