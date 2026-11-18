#!/usr/bin/env node

/**
 * Entry point for the memory MCP server.
 *
 * Without arguments: parses config from environment, initializes the engine,
 * starts the MCP server on stdio, and handles graceful shutdown.
 *
 * With `--prefetch-models` / `--verify-models`: fills or checks the verified
 * model store and exits (see models/cli.ts); the server modules (SQLite, the
 * MCP SDK) are not loaded.
 *
 * `memory-mcp-server backups|restore ...` runs a database maintenance command
 * instead (cli.ts).
 */

async function writeStdout(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function runCli(argv: readonly string[]): Promise<void> {
  // cli.ts loads the database module only when it runs a command.
  const { isAdminCommand, runAdminCommand } = await import('./cli.js');
  if (isAdminCommand(argv[0])) {
    process.exitCode = await runAdminCommand(argv, process.env, {
      out: (line) => {
        process.stdout.write(`${line}\n`);
      },
      err: (line) => {
        process.stderr.write(`${line}\n`);
      },
    });
    return;
  }

  const { runModelsCli } = await import('./models/cli.js');
  const code = await runModelsCli(argv, {
    env: process.env,
    stdout: writeStdout,
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
  });
  // Exit explicitly: an idle keep-alive connection from a download must not
  // hold the process open.
  process.exit(code);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    await runCli(argv);
    return;
  }

  const [{ StdioServerTransport }, { loadConfig }, { createMemoryEngineFromConfig, preloadModels }, { createServer }] =
    await Promise.all([
      import('@modelcontextprotocol/sdk/server/stdio.js'),
      import('./config.js'),
      import('./engine-impl.js'),
      import('./server.js'),
    ]);

  const config = loadConfig();

  const engine = createMemoryEngineFromConfig(config);

  // Load the models while the client connects, not inside the first tool call.
  void preloadModels(config);

  const server = createServer(engine);
  const transport = new StdioServerTransport();

  // Graceful shutdown
  const shutdown = (): void => {
    engine.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error('[memory-server] Fatal error:', err);
  process.exit(1);
});
