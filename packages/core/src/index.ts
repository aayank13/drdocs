import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMdx from 'remark-mdx';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';

export interface DrDocsConfig {
  name: string;
  description?: string;
  theme?: {
    primaryColor?: string;
  };
  navigation?: Array<{
    group: string;
    pages: string[];
  }>;
}

interface PageMeta {
  sourcePath: string;
  slug: string;
  title: string;
  description: string;
}

interface BuiltPage extends PageMeta {
  html: string;
}

const parseMarkdownToHtml = async (content: string): Promise<string> => {
  const file = await unified()
    .use(remarkParse)
    .use(remarkMdx)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeStringify)
    .process(content);

  return String(file);
};

const walkDocs = async (dirPath: string): Promise<string[]> => {
  const items = await readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const item of items) {
    const fullPath = path.join(dirPath, item.name);
    if (item.isDirectory()) {
      files.push(...(await walkDocs(fullPath)));
      continue;
    }

    if (item.name.endsWith('.md') || item.name.endsWith('.mdx')) {
      files.push(fullPath);
    }
  }

  return files;
};

const readConfig = async (projectRoot: string): Promise<DrDocsConfig> => {
  const configPath = path.join(projectRoot, 'drdocs.config.json');
  return JSON.parse(await readFile(configPath, 'utf8')) as DrDocsConfig;
};

const collectPageMeta = async (docsDir: string, config: DrDocsConfig): Promise<PageMeta[]> => {
  const docFiles = await walkDocs(docsDir);
  const pages: PageMeta[] = [];

  for (const filePath of docFiles) {
    const raw = await readFile(filePath, 'utf8');
    const parsed = matter(raw);
    const relative = path.relative(docsDir, filePath);
    const slug = relative.replace(/\.mdx?$/i, '').split(path.sep).join('/');
    const title = typeof parsed.data.title === 'string' ? parsed.data.title : path.basename(slug);
    const description =
      typeof parsed.data.description === 'string' ? parsed.data.description : config.description ?? '';

    pages.push({
      sourcePath: filePath,
      slug,
      title,
      description
    });
  }

  return pages;
};

const renderSidebar = (config: DrDocsConfig, pages: Array<{ slug: string; title: string }>): string => {
  const bySlug = new Map(pages.map((page) => [page.slug, page]));
  const nav = config.navigation ?? [];

  if (nav.length === 0) {
    return '<ul>' + pages.map((p) => `<li><a href="/${p.slug}.html">${p.title}</a></li>`).join('') + '</ul>';
  }

  return nav
    .map((group) => {
      const pageLinks = group.pages
        .map((slug) => {
          const page = bySlug.get(slug);
          if (!page) {
            return '';
          }

          return `<li><a href="/${page.slug}.html">${page.title}</a></li>`;
        })
        .join('');

      return `<section><h3>${group.group}</h3><ul>${pageLinks}</ul></section>`;
    })
    .join('');
};

const renderPage = (params: {
  config: DrDocsConfig;
  pageTitle: string;
  pageDescription: string;
  sidebar: string;
  content: string;
}): string => {
  return renderLayout({
    siteName: params.config.name,
    pageTitle: params.pageTitle,
    description: params.pageDescription,
    primaryColor: params.config.theme?.primaryColor ?? '#6366f1',
    sidebar: params.sidebar,
    content: params.content
  });
};

const writePageOutput = async (distDir: string, slug: string, html: string): Promise<void> => {
  const outputFile = path.join(distDir, `${slug}.html`);
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, html, 'utf8');
};

const renderLayout = (params: {
  siteName: string;
  pageTitle: string;
  description: string;
  primaryColor: string;
  sidebar: string;
  content: string;
}): string => {
  const { siteName, pageTitle, description, primaryColor, sidebar, content } = params;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${pageTitle} · ${siteName}</title>
    <meta name="description" content="${description}" />
    <style>
      :root {
        --dr-primary: ${primaryColor};
        --dr-border: #e5e7eb;
        --dr-text: #111827;
        --dr-bg: #ffffff;
        --dr-sidebar-bg: #f9fafb;
      }

      * { box-sizing: border-box; }
      body { margin: 0; font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: var(--dr-text); background: var(--dr-bg); }
      .layout { display: grid; grid-template-columns: 280px 1fr; min-height: 100vh; }
      aside { background: var(--dr-sidebar-bg); border-right: 1px solid var(--dr-border); padding: 20px; }
      main { padding: 32px; max-width: 900px; }
      h1, h2, h3 { color: var(--dr-text); }
      a { color: var(--dr-primary); text-decoration: none; }
      a:hover { text-decoration: underline; }
      code { background: #f3f4f6; padding: 2px 6px; border-radius: 6px; }
      pre { background: #111827; color: #f9fafb; padding: 16px; border-radius: 10px; overflow: auto; }
      pre code { background: transparent; color: inherit; padding: 0; }
      @media (max-width: 960px) {
        .layout { grid-template-columns: 1fr; }
        aside { border-right: none; border-bottom: 1px solid var(--dr-border); }
      }
    </style>
  </head>
  <body>
    <div class="layout">
      <aside>
        <h2>${siteName}</h2>
        ${sidebar}
      </aside>
      <main>
        ${content}
      </main>
    </div>
  </body>
</html>`;
};

export const buildSite = async (projectRoot = process.cwd()): Promise<void> => {
  const docsDir = path.join(projectRoot, 'docs');
  const distDir = path.join(projectRoot, 'dist');
  const publicDir = path.join(projectRoot, 'public');

  const config = await readConfig(projectRoot);

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  const pageMeta = await collectPageMeta(docsDir, config);
  const builtPages: BuiltPage[] = [];
  const sidebar = renderSidebar(config, pageMeta);

  for (const meta of pageMeta) {
    const raw = await readFile(meta.sourcePath, 'utf8');
    const parsed = matter(raw);
    const html = await parseMarkdownToHtml(parsed.content);

    builtPages.push({
      ...meta,
      html
    });

    const page = renderPage({
      config,
      pageTitle: meta.title,
      pageDescription: meta.description,
      sidebar,
      content: html
    });

    await writePageOutput(distDir, meta.slug, page);
  }

  if (builtPages.length > 0) {
    const redirect = `<!doctype html><meta http-equiv="refresh" content="0; url=/${builtPages[0].slug}.html" />`;
    await writeFile(path.join(distDir, 'index.html'), redirect, 'utf8');
  }

  const notFound = renderLayout({
    siteName: config.name,
    pageTitle: 'Not Found',
    description: config.description ?? '',
    primaryColor: config.theme?.primaryColor ?? '#6366f1',
    sidebar,
    content: '<h1>404</h1><p>The page you requested was not found.</p>'
  });
  await writeFile(path.join(distDir, '404.html'), notFound, 'utf8');

  try {
    const publicStat = await stat(publicDir);
    if (publicStat.isDirectory()) {
      await cp(publicDir, path.join(distDir, 'public'), { recursive: true });
    }
  } catch {
    // no-op
  }
};

export const buildSinglePage = async (
  projectRoot: string,
  changedFilePath: string
): Promise<{ slug: string }> => {
  const docsDir = path.join(projectRoot, 'docs');
  const distDir = path.join(projectRoot, 'dist');
  const resolvedChangedPath = path.resolve(changedFilePath);

  if (!resolvedChangedPath.startsWith(path.resolve(docsDir))) {
    throw new Error('Changed file is outside docs directory.');
  }

  const config = await readConfig(projectRoot);
  const pageMeta = await collectPageMeta(docsDir, config);
  const current = pageMeta.find((page) => path.resolve(page.sourcePath) === resolvedChangedPath);

  if (!current) {
    throw new Error(`Cannot rebuild page: ${resolvedChangedPath}`);
  }

  const raw = await readFile(resolvedChangedPath, 'utf8');
  const parsed = matter(raw);
  const html = await parseMarkdownToHtml(parsed.content);
  const sidebar = renderSidebar(config, pageMeta);
  const page = renderPage({
    config,
    pageTitle: current.title,
    pageDescription: current.description,
    sidebar,
    content: html
  });

  await mkdir(distDir, { recursive: true });
  await writePageOutput(distDir, current.slug, page);

  return { slug: current.slug };
};
