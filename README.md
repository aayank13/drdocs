# DrDocs

Open-source documentation generator and CLI inspired by Mintlify/FumaDocs.

DrDocs builds docs from `docs/*.mdx` into static HTML, provides a live-reload dev server, and ships with a polished default UI (dark mode, sidebar, TOC, search modal, syntax highlighting, copy-code buttons).

## Current Status

This repository currently includes a working MVP for plan phases 1–5:

- Monorepo scaffold (`pnpm` workspaces)
- CLI commands (`init`, `build`, `dev`, `add`, `deploy`, `upgrade`)
- MD/MDX static build pipeline
- Themed documentation UI
- Offline search index + search modal

## Project Structure

```text
drdocs/
├── packages/
│   ├── cli/       # CLI entrypoint and commands
│   ├── core/      # Build pipeline, rendering, theme output
│   ├── theme/     # Theme package scaffold
│   └── search/    # Search package scaffold
├── docs/          # Source documentation pages (.md/.mdx)
├── public/        # Static assets copied to dist/public
├── dist/          # Generated static site output
└── drdocs.config.json
```

## Requirements

- Node.js 20+
- pnpm 9+

If `pnpm` is missing, enable it with Corepack:

```bash
corepack enable
corepack prepare pnpm@9.15.0 --activate
```

## Quick Start

```bash
pnpm install
pnpm build
node packages/cli/dist/index.js build
node packages/cli/dist/index.js dev --port 3000
```

Then open `http://localhost:3000`.

## Scripts

At the repo root (`package.json`):

- `pnpm build` — Build all workspace packages
- `pnpm dev` — Run DrDocs dev server (compiled CLI)
- `pnpm drdocs -- <args>` — Run CLI entrypoint with args
- `pnpm lint` — Lint workspace
- `pnpm format` — Format files with Prettier

## CLI Usage

Use compiled CLI directly:

```bash
node packages/cli/dist/index.js <command>
```

### Commands

- `build` — Build docs site to `dist/`
- `dev` — Start local dev server with hot reload
- `init` — Scaffold a new DrDocs project (interactive)
- `add page <name>` — Create a docs page in `docs/`
- `add group <name>` — Create a docs group folder
- `add api-ref` — Scaffold `openapi/openapi.yaml`
- `deploy` — Build for deployment output
- `upgrade` — Show upgrade guidance

Examples:

```bash
node packages/cli/dist/index.js build
node packages/cli/dist/index.js dev --port 3000 --no-open
node packages/cli/dist/index.js add page "Authentication"
```

## Configuration

Project configuration lives in `drdocs.config.json`.

Common fields currently used by the builder/UI include:

- `name`
- `description`
- `theme.primaryColor`
- `theme.font`
- `theme.mode`
- `navigation`
- `search`
- `logo`
- `favicon`
- `analytics`

## What the Build Produces

`drdocs build` generates:

- HTML page per docs file (e.g. `docs/introduction.mdx` → `dist/introduction.html`)
- `dist/index.html` redirect to first page
- `dist/404.html`
- `dist/search-index.json`
- `dist/public/**` static assets
- `dist/public/drdocs/client.js` client runtime (search/theme/copy-code)

## Development Notes

- The dev server watches `docs/`, `public/`, and `drdocs.config.json`.
- `.md/.mdx` changes trigger incremental rebuild when possible.
- Other changes trigger full rebuild.

## Roadmap

Remaining phases (AI assistant, OpenAPI pages, deploy adapters, versioning, i18n, plugins, migrations) are planned.