#!/usr/bin/env node
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import chokidar from 'chokidar';
import ora from 'ora';
import chalk from 'chalk';
import open from 'open';
import inquirer from 'inquirer';
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

const defaultIntro = `---
title: Introduction
description: Start here
---

# Introduction

Welcome to your DrDocs project.
`;

const defaultGettingStarted = `---
title: Getting Started
description: Build and preview your docs
---

# Getting Started

Run the commands below:

\`\`\`bash
pnpm install
pnpm build
node packages/cli/dist/index.js dev
\`\`\`
`;

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

    if (extname(filePath) === '.html') {
      const html = injectLiveReload(body.toString('utf8'), wsPort);
      body = Buffer.from(html, 'utf8');
    }

    res.writeHead(200, {
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

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const ensureBuild = async (root: string, spinnerText: string): Promise<boolean> => {
  const spinner = ora(spinnerText).start();
  try {
    await buildSite(root);
    spinner.succeed(chalk.green('Build complete. Output written to dist/.'));
    return true;
  } catch (error) {
    spinner.fail(chalk.red('Build failed.'));
    console.error(error instanceof Error ? error.message : error);
    return false;
  }
};

program.name('drdocs').description('DrDocs CLI').version('0.1.0');

program
  .command('build')
  .description('Build documentation site to dist/')
  .option('-r, --root <path>', 'Project root path', process.cwd())
  .action(async (options: { root: string }) => {
    const root = path.resolve(options.root);
    const ok = await ensureBuild(root, `Building DrDocs site in ${root}`);
    if (!ok) {
      process.exitCode = 1;
    }
  });

program
  .command('init')
  .description('Scaffold a new DrDocs project')
  .option('-r, --root <path>', 'Target folder', process.cwd())
  .action(async (options: { root: string }) => {
    const root = path.resolve(options.root);

    const answers = await inquirer.prompt([
      { type: 'input', name: 'name', message: 'Project name:', default: 'My Project' },
      { type: 'input', name: 'description', message: 'Project description:', default: 'Project docs' },
      { type: 'input', name: 'primaryColor', message: 'Theme primary color:', default: '#6366f1' },
      { type: 'input', name: 'logo', message: 'Logo path (optional):', default: '/public/logo.png' },
      {
        type: 'list',
        name: 'aiProvider',
        message: 'AI provider:',
        choices: ['openai', 'anthropic', 'gemini', 'skip'],
        default: 'skip'
      },
      { type: 'password', name: 'apiKey', message: 'AI API key (optional):', mask: '*' },
      { type: 'input', name: 'analyticsId', message: 'Analytics ID (optional):', default: '' },
      {
        type: 'list',
        name: 'deployTarget',
        message: 'Deploy target:',
        choices: ['github', 'cloudflare', 'vercel', 'manual'],
        default: 'github'
      }
    ]);

    await mkdir(path.join(root, 'docs'), { recursive: true });
    await mkdir(path.join(root, 'public'), { recursive: true });
    await mkdir(path.join(root, 'openapi'), { recursive: true });

    await writeFile(path.join(root, 'docs', 'introduction.mdx'), defaultIntro, 'utf8');
    await writeFile(path.join(root, 'docs', 'getting-started.mdx'), defaultGettingStarted, 'utf8');
    await writeFile(path.join(root, 'openapi', 'openapi.yaml'), 'openapi: 3.1.0\ninfo:\n  title: API\n  version: 1.0.0\npaths: {}\n', 'utf8');

    const config = {
      name: answers.name,
      description: answers.description,
      theme: {
        primaryColor: answers.primaryColor,
        font: 'inter',
        mode: 'light'
      },
      navigation: [
        {
          group: 'Getting Started',
          pages: ['introduction', 'getting-started']
        }
      ],
      ai: {
        enabled: answers.aiProvider !== 'skip',
        provider: answers.aiProvider,
        model: answers.aiProvider === 'skip' ? '' : 'gpt-4o-mini'
      },
      analytics: answers.analyticsId
        ? {
            provider: 'google',
            id: answers.analyticsId
          }
        : undefined,
      search: true,
      versions: [],
      favicon: '/public/favicon.ico',
      logo: answers.logo,
      deploy: {
        target: answers.deployTarget
      }
    };

    await writeJson(path.join(root, 'drdocs.config.json'), config);

    const envLines = [
      `AI_PROVIDER=${answers.aiProvider}`,
      `AI_API_KEY=${answers.apiKey ?? ''}`,
      `ANALYTICS_ID=${answers.analyticsId ?? ''}`,
      `DEPLOY_TARGET=${answers.deployTarget}`
    ];
    await writeFile(path.join(root, '.env'), `${envLines.join('\n')}\n`, 'utf8');

    await writeFile(path.join(root, '.gitignore'), 'node_modules\ndist\n.env\n.DS_Store\n', 'utf8');

    console.log(chalk.green(`DrDocs project initialized at ${root}`));
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

const addCommand = program.command('add').description('Add docs resources');

addCommand
  .command('page <name>')
  .description('Create a new .mdx page')
  .option('-r, --root <path>', 'Project root path', process.cwd())
  .action(async (name: string, options: { root: string }) => {
    const root = path.resolve(options.root);
    const slug = slugify(name);
    const filePath = path.join(root, 'docs', `${slug}.mdx`);
    const content = `---\ntitle: ${name}\ndescription: ${name}\n---\n\n# ${name}\n`;
    await writeFile(filePath, content, 'utf8');
    console.log(chalk.green(`Created ${filePath}`));
  });

addCommand
  .command('group <name>')
  .description('Create a new docs group folder')
  .option('-r, --root <path>', 'Project root path', process.cwd())
  .action(async (name: string, options: { root: string }) => {
    const root = path.resolve(options.root);
    const folder = path.join(root, 'docs', slugify(name));
    await mkdir(folder, { recursive: true });
    console.log(chalk.green(`Created ${folder}`));
  });

addCommand
  .command('api-ref')
  .description('Create openapi/openapi.yaml scaffold')
  .option('-r, --root <path>', 'Project root path', process.cwd())
  .action(async (options: { root: string }) => {
    const root = path.resolve(options.root);
    await mkdir(path.join(root, 'openapi'), { recursive: true });
    await writeFile(path.join(root, 'openapi', 'openapi.yaml'), 'openapi: 3.1.0\ninfo:\n  title: API\n  version: 1.0.0\npaths: {}\n', 'utf8');
    console.log(chalk.green('Created openapi/openapi.yaml'));
  });

program
  .command('deploy')
  .description('Build docs for deployment (provider-specific adapters coming next)')
  .option('-r, --root <path>', 'Project root path', process.cwd())
  .option('--github', 'Prepare for GitHub Pages')
  .option('--cloudflare', 'Prepare for Cloudflare Pages')
  .option('--vercel', 'Prepare for Vercel')
  .option('--netlify', 'Prepare for Netlify')
  .action(async (options: { root: string }) => {
    const root = path.resolve(options.root);
    const ok = await ensureBuild(root, `Preparing deployment build in ${root}`);
    if (!ok) {
      process.exitCode = 1;
      return;
    }

    console.log(chalk.cyan('Build prepared. Publish dist/ on your selected platform.'));
  });

program
  .command('upgrade')
  .description('Show upgrade guidance for DrDocs CLI')
  .action(() => {
    console.log(chalk.cyan('Upgrade command is available. Use your package manager to update workspace dependencies.'));
  });

program.parseAsync(process.argv);
