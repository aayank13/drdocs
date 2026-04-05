#!/usr/bin/env node
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import chokidar from 'chokidar';
import ora from 'ora';
import chalk from 'chalk';
import open from 'open';
import WebSocket, { WebSocketServer } from 'ws';
import { buildSinglePage, buildSite } from '@drdocs/core';

const program = new Command();

const contentTypeByExtension: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

const injectLiveReload = (html: string, wsPort: number): string => {
  const script = `<script>
(() => {
  const socket = new WebSocket('ws://localhost:${wsPort}');
  socket.addEventListener('message', (event) => {
    if (event.data === 'reload') {
      window.location.reload();
    }
  });
})();
</script>`;
  return html.includes('</body>') ? html.replace('</body>', `${script}</body>`) : `${html}${script}`;
};

const getNetworkUrl = (port: number): string | null => {
  const nets = networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) {
      continue;
    }

    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return `http://${entry.address}:${port}`;
      }
    }
  }

  return null;
};

const safeDistPath = (distDir: string, requestPath: string): string => {
  const normalizedPath = decodeURIComponent(requestPath.split('?')[0]);
  const rawRelative = normalizedPath === '/' ? '/index.html' : normalizedPath;
  const relative = rawRelative.startsWith('/') ? rawRelative.slice(1) : rawRelative;
  const withFallback = extname(relative) ? relative : `${relative}.html`;
  const resolved = path.resolve(distDir, withFallback);

  if (!resolved.startsWith(path.resolve(distDir))) {
    return path.join(distDir, '404.html');
  }

  return resolved;
};

const handleRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  distDir: string,
  wsPort: number
): Promise<void> => {
  const requestPath = req.url ?? '/';
  let filePath = safeDistPath(distDir, requestPath);

  try {
    let body = await readFile(filePath);
    let status = 200;

    if (extname(filePath) === '.html') {
      const html = injectLiveReload(body.toString('utf8'), wsPort);
      body = Buffer.from(html, 'utf8');
    }

    res.writeHead(status, {
      'Content-Type': contentTypeByExtension[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(body);
  } catch {
    try {
      filePath = path.join(distDir, '404.html');
      const notFound = await readFile(filePath);
      const html = injectLiveReload(notFound.toString('utf8'), wsPort);
      res.writeHead(404, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(Buffer.from(html, 'utf8'));
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  }
};

program
  .name('drdocs')
  .description('DrDocs CLI')
  .version('0.1.0');

program
  .command('build')
  .description('Build documentation site to dist/')
  .option('-r, --root <path>', 'Project root path', process.cwd())
  .action(async (options: { root: string }) => {
    const root = path.resolve(options.root);
    const spinner = ora(`Building DrDocs site in ${root}`).start();

    try {
      await buildSite(root);
      spinner.succeed(chalk.green('Build complete. Output written to dist/.'));
    } catch (error) {
      spinner.fail(chalk.red('Build failed.'));
      if (error instanceof Error) {
        console.error(error.message);
      } else {
        console.error(error);
      }
      process.exitCode = 1;
    }
  });

program
  .command('init')
  .description('Scaffold a new DrDocs project (coming soon)')
  .action(() => {
    console.log(chalk.yellow('init is not implemented yet in this MVP.'));
  });

program
  .command('dev')
  .description('Run local dev server with hot reload')
  .option('-r, --root <path>', 'Project root path', process.cwd())
  .option('-p, --port <number>', 'Port for local HTTP server', '3000')
  .option('--no-open', 'Disable automatic browser opening')
  .action(async (options: { root: string; port: string; open: boolean }) => {
    const root = path.resolve(options.root);
    const port = Number.parseInt(options.port, 10);
    const wsPort = port + 1;
    const distDir = path.join(root, 'dist');

    if (Number.isNaN(port) || port < 1) {
      console.error(chalk.red('Invalid --port value. Use a positive integer.'));
      process.exitCode = 1;
      return;
    }

    await mkdir(distDir, { recursive: true });

    const spinner = ora(`Building DrDocs site in ${root}`).start();
    try {
      await buildSite(root);
      spinner.succeed(chalk.green('Initial build complete.'));
    } catch (error) {
      spinner.fail(chalk.red('Initial build failed.'));
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
      return;
    }

    const server = createServer((req, res) => {
      void handleRequest(req, res, distDir, wsPort);
    });

    const wss = new WebSocketServer({ port: wsPort });
    const localUrl = `http://localhost:${port}`;
    const networkUrl = getNetworkUrl(port);

    server.listen(port, () => {
      console.log(chalk.cyan('\n🩺 DrDocs Dev Server'));
      console.log(chalk.green(`Local:   ${localUrl}`));
      if (networkUrl) {
        console.log(chalk.green(`Network: ${networkUrl}`));
      }
      console.log(chalk.gray('Watching docs/, public/, drdocs.config.json for changes...'));

      if (options.open) {
        void open(localUrl);
      }
    });

    const watcher = chokidar.watch(
      [path.join(root, 'docs'), path.join(root, 'public'), path.join(root, 'drdocs.config.json')],
      { ignoreInitial: true }
    );

    let rebuilding = false;
    let pending = false;
    let pendingEvent = '';
    let pendingPath = '';
    let debounceTimer: NodeJS.Timeout | undefined;
    let debouncedEvent = '';
    let debouncedPath = '';

    const runBuild = async (event: string, changedPath: string): Promise<void> => {
      if (rebuilding) {
        pending = true;
        pendingEvent = event;
        pendingPath = changedPath;
        return;
      }

      rebuilding = true;
      const start = Date.now();

      try {
        const relativePath = path.relative(root, changedPath);
        const isDocFile =
          changedPath.startsWith(path.join(root, 'docs')) &&
          (changedPath.endsWith('.md') || changedPath.endsWith('.mdx'));

        if (isDocFile && (event === 'change' || event === 'add')) {
          const rebuilt = await buildSinglePage(root, changedPath);
          const elapsed = Date.now() - start;
          console.log(
            chalk.blue(
              `Incremental rebuild in ${elapsed}ms: ${relativePath} -> /${rebuilt.slug}.html`
            )
          );
        } else {
          await buildSite(root);
          const elapsed = Date.now() - start;
          console.log(chalk.blue(`Full rebuild in ${elapsed}ms after ${event}: ${relativePath}`));
        }

        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send('reload');
          }
        });
      } catch (error) {
        console.error(chalk.red('Rebuild failed:'));
        console.error(error instanceof Error ? error.message : error);
      } finally {
        rebuilding = false;
        if (pending && pendingEvent && pendingPath) {
          pending = false;
          const nextEvent = pendingEvent;
          const nextPath = pendingPath;
          pendingEvent = '';
          pendingPath = '';
          await runBuild(nextEvent, nextPath);
        }
      }
    };

    watcher.on('all', (event, changedPath) => {
      debouncedEvent = event;
      debouncedPath = path.resolve(changedPath);

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        const nextEvent = debouncedEvent;
        const nextPath = debouncedPath;
        debouncedEvent = '';
        debouncedPath = '';
        void runBuild(nextEvent, nextPath);
      }, 120);
    });

    const shutdown = async (): Promise<void> => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      await watcher.close();
      wss.close();
      server.close(() => {
        process.exit(0);
      });
    };

    process.on('SIGINT', () => {
      void shutdown();
    });

    process.on('SIGTERM', () => {
      void shutdown();
    });
  });

program.parseAsync(process.argv);
