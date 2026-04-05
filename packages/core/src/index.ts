import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { createHighlighter, type HighlighterGeneric } from 'shiki';
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
    font?: string;
    mode?: 'light' | 'dark';
  };
  navigation?: Array<{
    group: string;
    pages: string[];
  }>;
  search?: boolean;
  logo?: string;
  favicon?: string;
  analytics?: {
    provider?: 'google' | 'plausible' | 'fathom' | 'custom';
    id?: string;
    script?: string;
  };
}

interface HeadingItem {
  id: string;
  text: string;
  level: number;
}

interface PageMeta {
  sourcePath: string;
  slug: string;
  title: string;
  description: string;
  icon?: string;
  sidebarTitle?: string;
  tag?: string;
}

interface BuiltPage extends PageMeta {
  html: string;
  headings: HeadingItem[];
}

interface SearchIndexEntry {
  title: string;
  description: string;
  headings: string[];
  body: string;
  url: string;
}

let highlighterPromise: Promise<HighlighterGeneric<any, any>> | undefined;

const getHighlighterInstance = async (): Promise<HighlighterGeneric<any, any>> => {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-light', 'github-dark'],
      langs: ['bash', 'sh', 'javascript', 'typescript', 'json', 'yaml', 'tsx', 'jsx', 'html', 'css', 'md']
    });
  }

  return highlighterPromise;
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

const stripHtml = (value: string): string => value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const preprocessCallouts = (content: string): string => {
  const callouts: Array<{ tag: string; className: string; label: string }> = [
    { tag: 'Note', className: 'note', label: 'Note' },
    { tag: 'Warning', className: 'warning', label: 'Warning' },
    { tag: 'Danger', className: 'danger', label: 'Danger' },
    { tag: 'Tip', className: 'tip', label: 'Tip' },
    { tag: 'Info', className: 'info', label: 'Info' },
    { tag: 'Check', className: 'check', label: 'Check' }
  ];

  let output = content;
  for (const callout of callouts) {
    const regex = new RegExp(`<${callout.tag}>([\\s\\S]*?)<\\/${callout.tag}>`, 'g');
    output = output.replace(
      regex,
      `<div class="dr-callout ${callout.className}"><strong>${callout.label}:</strong> $1</div>`
    );
  }

  return output;
};

const preprocessCodeBlocks = async (content: string): Promise<string> => {
  const highlighter = await getHighlighterInstance();

  return content.replace(/```([\w-]+)?(?:\s+filename="([^"]+)")?(?:\s+\{([^}]+)\})?\n([\s\S]*?)```/g, (_match, lang, filename, _lineHighlights, code) => {
    const language = typeof lang === 'string' && lang.length > 0 ? lang : 'text';

    const highlighted = highlighter.codeToHtml(code.trimEnd(), {
      lang: language,
      themes: {
        light: 'github-light',
        dark: 'github-dark'
      }
    });

    const filenameHtml = filename
      ? `<div class="dr-code-filename">${escapeHtml(String(filename))}</div>`
      : '';

    return `\n<div class="dr-codeblock">${filenameHtml}${highlighted}<button class="dr-copy-btn" type="button">Copy</button></div>\n`;
  });
};

const parseMarkdownToHtml = async (content: string): Promise<string> => {
  const withCallouts = preprocessCallouts(content);
  const withHighlightedCode = await preprocessCodeBlocks(withCallouts);

  const file = await unified()
    .use(remarkParse)
    .use(remarkMdx)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeStringify, { allowDangerousHtml: true })
    .process(withHighlightedCode);

  return String(file);
};

const extractHeadings = (html: string): { html: string; headings: HeadingItem[] } => {
  const seen = new Map<string, number>();
  const headings: HeadingItem[] = [];

  const nextHtml = html.replace(/<h([1-3])>([\s\S]*?)<\/h\1>/g, (match, levelRaw, inner) => {
    const level = Number.parseInt(String(levelRaw), 10);
    const text = stripHtml(inner);

    if (!text) {
      return match;
    }

    const baseId = slugify(text);
    const count = seen.get(baseId) ?? 0;
    seen.set(baseId, count + 1);
    const id = count === 0 ? baseId : `${baseId}-${count}`;
    headings.push({ id, text, level });

    return `<h${level} id="${id}"><a class="dr-anchor" href="#${id}">#</a>${inner}</h${level}>`;
  });

  return { html: nextHtml, headings };
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
      description,
      icon: typeof parsed.data.icon === 'string' ? parsed.data.icon : undefined,
      sidebarTitle: typeof parsed.data.sidebarTitle === 'string' ? parsed.data.sidebarTitle : undefined,
      tag: typeof parsed.data.tag === 'string' ? parsed.data.tag : undefined
    });
  }

  return pages;
};

const applyNavigationOrder = (pages: PageMeta[], config: DrDocsConfig): PageMeta[] => {
  const nav = config.navigation ?? [];
  if (nav.length === 0) {
    return [...pages].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  const bySlug = new Map(pages.map((page) => [page.slug, page]));
  const ordered: PageMeta[] = [];
  const included = new Set<string>();

  for (const group of nav) {
    for (const slug of group.pages) {
      const found = bySlug.get(slug);
      if (found) {
        ordered.push(found);
        included.add(found.slug);
      }
    }
  }

  const leftovers = pages.filter((page) => !included.has(page.slug)).sort((a, b) => a.slug.localeCompare(b.slug));
  return [...ordered, ...leftovers];
};

const getPrevNext = (orderedPages: PageMeta[], slug: string): { prev?: PageMeta; next?: PageMeta } => {
  const index = orderedPages.findIndex((page) => page.slug === slug);
  if (index < 0) {
    return {};
  }

  return {
    prev: index > 0 ? orderedPages[index - 1] : undefined,
    next: index < orderedPages.length - 1 ? orderedPages[index + 1] : undefined
  };
};

const renderSidebar = (
  config: DrDocsConfig,
  pages: Array<{ slug: string; title: string; sidebarTitle?: string; tag?: string }>,
  activeSlug: string
): string => {
  const bySlug = new Map(pages.map((page) => [page.slug, page]));
  const nav = config.navigation ?? [];

  const renderLink = (page: { slug: string; title: string; sidebarTitle?: string; tag?: string }): string => {
    const active = page.slug === activeSlug ? 'active' : '';
    const title = page.sidebarTitle ?? page.title;
    const tag = page.tag ? `<span class="dr-tag">${escapeHtml(page.tag)}</span>` : '';
    return `<li><a class="${active}" href="/${page.slug}.html">${escapeHtml(title)}${tag}</a></li>`;
  };

  if (nav.length === 0) {
    return '<ul>' + pages.map((p) => renderLink(p)).join('') + '</ul>';
  }

  return nav
    .map((group) => {
      const pageLinks = group.pages
        .map((slug) => {
          const page = bySlug.get(slug);
          if (!page) {
            return '';
          }

          return renderLink(page);
        })
        .join('');

      return `<section><h3>${escapeHtml(group.group)}</h3><ul>${pageLinks}</ul></section>`;
    })
    .join('');
};

const renderToc = (headings: HeadingItem[]): string => {
  if (headings.length === 0) {
    return '<p class="dr-empty">No headings</p>';
  }

  return `<ul>${headings
    .filter((item) => item.level >= 2)
    .map(
      (item) =>
        `<li class="lv-${item.level}"><a href="#${item.id}">${escapeHtml(item.text)}</a></li>`
    )
    .join('')}</ul>`;
};

const renderBreadcrumbs = (slug: string): string => {
  const segments = slug.split('/');
  if (segments.length <= 1) {
    return '<nav class="dr-breadcrumbs"><a href="/index.html">Docs</a></nav>';
  }

  const crumbLinks = segments.map((segment, index) => {
    const text = segment.charAt(0).toUpperCase() + segment.slice(1);
    if (index === segments.length - 1) {
      return `<span>${escapeHtml(text)}</span>`;
    }

    const target = segments.slice(0, index + 1).join('/');
    return `<a href="/${target}.html">${escapeHtml(text)}</a>`;
  });

  return `<nav class="dr-breadcrumbs"><a href="/index.html">Docs</a> / ${crumbLinks.join(' / ')}</nav>`;
};

const analyticsSnippet = (config: DrDocsConfig): string => {
  if (!config.analytics?.provider) {
    return '';
  }

  if (config.analytics.provider === 'google' && config.analytics.id) {
    return `<script async src="https://www.googletagmanager.com/gtag/js?id=${config.analytics.id}"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);} // eslint-disable-line

gtag('js', new Date());
gtag('config', '${config.analytics.id}');
</script>`;
  }

  if (config.analytics.provider === 'custom' && config.analytics.script) {
    return config.analytics.script;
  }

  return '';
};

const renderLayout = (params: {
  config: DrDocsConfig;
  pageTitle: string;
  pageDescription: string;
  sidebar: string;
  content: string;
  toc: string;
  breadcrumbs: string;
  prevNext: { prev?: PageMeta; next?: PageMeta };
}): string => {
  const { config, pageTitle, pageDescription, sidebar, content, toc, breadcrumbs, prevNext } = params;
  const primaryColor = config.theme?.primaryColor ?? '#6366f1';
  const fontFamily = config.theme?.font ?? 'Inter';
  const defaultMode = config.theme?.mode ?? 'light';
  const logo = config.logo ? `<img class="dr-logo" src="${config.logo}" alt="${escapeHtml(config.name)}" />` : '';

  const prevLink = prevNext.prev
    ? `<a class="dr-prev" href="/${prevNext.prev.slug}.html">← ${escapeHtml(prevNext.prev.title)}</a>`
    : '<span></span>';

  const nextLink = prevNext.next
    ? `<a class="dr-next" href="/${prevNext.next.slug}.html">${escapeHtml(prevNext.next.title)} →</a>`
    : '<span></span>';

  return `<!doctype html>
<html lang="en" data-default-theme="${defaultMode}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(pageTitle)} · ${escapeHtml(config.name)}</title>
    <meta name="description" content="${escapeHtml(pageDescription)}" />
    <meta property="og:title" content="${escapeHtml(pageTitle)} · ${escapeHtml(config.name)}" />
    <meta property="og:description" content="${escapeHtml(pageDescription)}" />
    ${config.favicon ? `<link rel="icon" href="${config.favicon}" />` : ''}
    ${analyticsSnippet(config)}
    <style>
      :root {
        --dr-primary: ${primaryColor};
        --dr-border: #e6e8ec;
        --dr-text: #111827;
        --dr-text-soft: #4b5563;
        --dr-muted: #6b7280;
        --dr-bg: #ffffff;
        --dr-bg-elevated: #ffffff;
        --dr-sidebar-bg: #fbfcfe;
        --dr-topbar: rgba(255, 255, 255, 0.88);
        --dr-shadow: 0 1px 2px rgba(16, 24, 40, 0.05), 0 10px 24px rgba(16, 24, 40, 0.06);
      }

      :root.dark {
        --dr-border: #1f2937;
        --dr-text: #e5e7eb;
        --dr-text-soft: #9ca3af;
        --dr-muted: #6b7280;
        --dr-bg: #0b0f1a;
        --dr-bg-elevated: #111827;
        --dr-sidebar-bg: #0f172a;
        --dr-topbar: rgba(11, 15, 26, 0.86);
        --dr-shadow: 0 1px 2px rgba(0, 0, 0, 0.28), 0 12px 24px rgba(0, 0, 0, 0.25);
      }

      * { box-sizing: border-box; }
      html { scroll-behavior: smooth; }
      body { margin: 0; font-family: ${fontFamily}, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: var(--dr-text); background: var(--dr-bg); line-height: 1.75; }
      a { color: color-mix(in srgb, var(--dr-primary) 82%, #2563eb 18%); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .dr-topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; position: sticky; top: 0; z-index: 30; background: var(--dr-topbar); border-bottom: 1px solid var(--dr-border); padding: 10px 18px; backdrop-filter: blur(12px); }
      .dr-brand { display: flex; align-items: center; gap: 10px; font-weight: 700; color: var(--dr-text); letter-spacing: -0.01em; }
      .dr-logo { width: 24px; height: 24px; border-radius: 8px; object-fit: cover; }
      .dr-top-actions { display: flex; gap: 10px; align-items: center; }
      .dr-btn { border: 1px solid var(--dr-border); background: var(--dr-bg-elevated); color: var(--dr-text); border-radius: 10px; padding: 8px 11px; cursor: pointer; font-weight: 600; transition: all 0.15s ease; }
      .dr-btn:hover { box-shadow: var(--dr-shadow); text-decoration: none; }
      .dr-search-trigger { display: inline-flex; align-items: center; gap: 8px; min-width: 220px; justify-content: space-between; color: var(--dr-muted); font-weight: 500; }
      .dr-kbd { border: 1px solid var(--dr-border); border-bottom-width: 2px; border-radius: 6px; padding: 1px 6px; font-size: 0.78rem; color: var(--dr-muted); }
      .dr-layout { display: grid; grid-template-columns: 262px minmax(0, 1fr) 238px; gap: 0; min-height: calc(100vh - 58px); max-width: 1460px; margin: 0 auto; }
      .dr-sidebar { background: var(--dr-sidebar-bg); border-right: 1px solid var(--dr-border); padding: 14px 14px 26px 16px; overflow: auto; position: sticky; top: 58px; max-height: calc(100vh - 58px); }
      .dr-sidebar ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
      .dr-sidebar h3 { margin: 14px 0 8px; font-size: 0.71rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--dr-muted); }
      .dr-sidebar a { display: flex; justify-content: space-between; align-items: center; gap: 10px; border-radius: 8px; padding: 6px 10px 6px 11px; color: var(--dr-text-soft); font-size: 0.94rem; font-weight: 500; transition: all 0.12s ease; }
      .dr-sidebar a:hover { background: color-mix(in srgb, var(--dr-primary) 8%, transparent); color: var(--dr-text); text-decoration: none; }
      .dr-sidebar a.active { background: color-mix(in srgb, var(--dr-primary) 13%, transparent); color: color-mix(in srgb, var(--dr-primary) 84%, #1e3a8a 16%); font-weight: 700; }
      .dr-tag { font-size: 0.66rem; opacity: 0.85; padding: 2px 6px; border-radius: 999px; background: color-mix(in srgb, var(--dr-primary) 16%, transparent); }
      .dr-main { padding: 30px 38px 48px; }
      .dr-content { max-width: 820px; margin: 0 auto; }
      .dr-content h1 { font-size: clamp(2.08rem, 3.2vw, 2.82rem); line-height: 1.14; letter-spacing: -0.024em; margin-top: 0.1rem; margin-bottom: 0.8rem; color: var(--dr-text); }
      .dr-content h2 { font-size: clamp(1.42rem, 2.3vw, 1.9rem); line-height: 1.28; margin-top: 2.45rem; color: var(--dr-text); }
      .dr-content h3 { font-size: 1.18rem; margin-top: 1.72rem; color: var(--dr-text); }
      .dr-content p, .dr-content li { color: var(--dr-text-soft); font-size: 1rem; }
      .dr-content ul, .dr-content ol { padding-left: 1.2rem; }
      .dr-content blockquote { margin: 1.2rem 0; padding: 0.35rem 0 0.35rem 0.9rem; border-left: 3px solid var(--dr-border); color: var(--dr-muted); }
      .dr-content hr { border: 0; border-top: 1px solid var(--dr-border); margin: 1.8rem 0; }
      .dr-content table { width: 100%; border-collapse: collapse; overflow: hidden; border-radius: 10px; border: 1px solid var(--dr-border); }
      .dr-content th, .dr-content td { border-bottom: 1px solid var(--dr-border); padding: 10px 12px; text-align: left; }
      .dr-content th { background: color-mix(in srgb, var(--dr-primary) 7%, transparent); color: var(--dr-text); }
      .dr-content pre { border: 1px solid var(--dr-border); border-radius: 12px; overflow: auto; margin: 0; box-shadow: var(--dr-shadow); }
      .dr-content code { background: color-mix(in srgb, var(--dr-primary) 10%, transparent); padding: 2px 6px; border-radius: 6px; font-size: 0.88em; }
      .dr-content pre code { background: transparent; padding: 0; }
      .dr-toc { border-left: 1px solid var(--dr-border); padding: 18px 14px; position: sticky; top: 58px; max-height: calc(100vh - 58px); overflow: auto; }
      .dr-toc strong { display: inline-block; margin-bottom: 8px; letter-spacing: 0.02em; font-size: 0.86rem; color: var(--dr-muted); text-transform: uppercase; }
      .dr-toc ul { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 6px; }
      .dr-toc a { color: var(--dr-text-soft); font-size: 0.83rem; line-height: 1.4; border-left: 1px solid transparent; padding-left: 10px; margin-left: -10px; }
      .dr-toc a.active { color: var(--dr-primary); font-weight: 600; border-left-color: color-mix(in srgb, var(--dr-primary) 80%, transparent); }
      .dr-toc .lv-3 { margin-left: 10px; font-size: 0.78rem; }
      .dr-empty { opacity: 0.65; font-size: 0.9rem; }
      .dr-breadcrumbs { margin-bottom: 14px; font-size: 0.8rem; color: var(--dr-muted); text-transform: uppercase; letter-spacing: 0.04em; }
      .dr-pagination { display: flex; justify-content: space-between; gap: 8px; margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--dr-border); }
      .dr-prev, .dr-next { border: 1px solid var(--dr-border); border-radius: 10px; padding: 8px 12px; background: var(--dr-bg-elevated); }
      .dr-footer { margin-top: 28px; font-size: 0.82rem; color: var(--dr-muted); }
      .dr-anchor { opacity: 0; margin-right: 8px; }
      h1:hover .dr-anchor, h2:hover .dr-anchor, h3:hover .dr-anchor { opacity: 1; }
      .dr-callout { margin: 14px 0; border: 1px solid var(--dr-border); border-left-width: 4px; border-radius: 10px; padding: 12px 14px; }
      .dr-callout.note, .dr-callout.info { border-left-color: #2563eb; background: rgba(37, 99, 235, 0.08); }
      .dr-callout.warning { border-left-color: #d97706; background: rgba(217, 119, 6, 0.08); }
      .dr-callout.danger { border-left-color: #dc2626; background: rgba(220, 38, 38, 0.08); }
      .dr-callout.tip, .dr-callout.check { border-left-color: #16a34a; background: rgba(22, 163, 74, 0.08); }
      .dr-codeblock { position: relative; margin: 18px 0; }
      .dr-code-filename { font-size: 0.74rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dr-muted); border: 1px solid var(--dr-border); border-bottom: 0; padding: 8px 12px; border-radius: 10px 10px 0 0; }
      .dr-copy-btn { position: absolute; right: 10px; top: 10px; border: 1px solid var(--dr-border); background: color-mix(in srgb, var(--dr-bg-elevated) 90%, transparent); color: var(--dr-text); border-radius: 8px; padding: 4px 8px; cursor: pointer; font-size: 0.78rem; font-weight: 600; opacity: 0; transition: opacity 0.15s ease; }
      .dr-codeblock:hover .dr-copy-btn { opacity: 1; }
      #dr-search-modal { position: fixed; inset: 0; background: rgba(2, 6, 23, 0.55); display: none; align-items: flex-start; justify-content: center; padding-top: 10vh; z-index: 50; }
      #dr-search-box { width: min(760px, 92vw); background: var(--dr-bg-elevated); border: 1px solid var(--dr-border); border-radius: 12px; overflow: hidden; box-shadow: var(--dr-shadow); }
      #dr-search-input { width: 100%; border: 0; border-bottom: 1px solid var(--dr-border); padding: 14px; font-size: 1rem; background: transparent; color: var(--dr-text); }
      #dr-search-results { max-height: 60vh; overflow: auto; }
      .dr-result { display: block; padding: 10px 14px; border-bottom: 1px solid var(--dr-border); color: var(--dr-text); }
      .dr-result:last-child { border-bottom: 0; }
      .dr-result small { display: block; opacity: 0.75; }
      .dr-result.active { background: color-mix(in srgb, var(--dr-primary) 11%, transparent); }
      .dr-sidebar-toggle { display: none; }
      @media (max-width: 1160px) {
        .dr-layout { grid-template-columns: 235px 1fr; }
        .dr-toc { display: none; }
      }
      @media (max-width: 860px) {
        .dr-layout { grid-template-columns: 1fr; }
        .dr-sidebar-toggle { display: inline-flex; }
        .dr-search-trigger { min-width: 0; }
        .dr-search-trigger span:first-child { display: none; }
        .dr-sidebar { position: fixed; left: -320px; top: 58px; width: 300px; height: calc(100vh - 58px); border-right: 1px solid var(--dr-border); border-bottom: none; z-index: 25; transition: left 0.2s ease; background: var(--dr-bg-elevated); }
        body.dr-sidebar-open .dr-sidebar { left: 0; }
        .dr-main { padding: 18px; }
      }
    </style>
  </head>
  <body>
    <header class="dr-topbar">
      <a class="dr-brand" href="/index.html">${logo}<span>${escapeHtml(config.name)}</span></a>
      <div class="dr-top-actions">
        <button class="dr-btn dr-sidebar-toggle" id="dr-sidebar-toggle">Menu</button>
        <button class="dr-btn dr-search-trigger" id="dr-search-open"><span>Search docs...</span><span class="dr-kbd">⌘K</span></button>
        <button class="dr-btn" id="dr-theme-toggle">Theme</button>
      </div>
    </header>
    <div class="dr-layout">
      <aside class="dr-sidebar">${sidebar}</aside>
      <main class="dr-main">
        <article class="dr-content">
          ${breadcrumbs}
          ${content}
          <nav class="dr-pagination">${prevLink}${nextLink}</nav>
          <footer class="dr-footer">Built with DrDocs.</footer>
        </article>
      </main>
      <aside class="dr-toc">
        <strong>On this page</strong>
        ${toc}
      </aside>
    </div>

    <div id="dr-search-modal">
      <div id="dr-search-box">
        <input id="dr-search-input" type="text" placeholder="Search docs..." />
        <div id="dr-search-results"></div>
      </div>
    </div>

    <script src="/public/drdocs/client.js"></script>
  </body>
</html>`;
};

const buildClientScript = (): string => `(() => {
  const root = document.documentElement;
  const body = document.body;
  const defaultTheme = root.getAttribute('data-default-theme') || 'light';
  const savedTheme = localStorage.getItem('drdocs-theme');
  const activeTheme = savedTheme || defaultTheme;
  if (activeTheme === 'dark') {
    root.classList.add('dark');
  }

  const themeButton = document.getElementById('dr-theme-toggle');
  const syncThemeButton = () => {
    if (!themeButton) return;
    const dark = root.classList.contains('dark');
    themeButton.textContent = dark ? 'Light' : 'Dark';
  };

  syncThemeButton();

  if (themeButton) {
    themeButton.addEventListener('click', () => {
      const dark = root.classList.toggle('dark');
      localStorage.setItem('drdocs-theme', dark ? 'dark' : 'light');
      syncThemeButton();
    });
  }

  const sidebarToggle = document.getElementById('dr-sidebar-toggle');
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      body.classList.toggle('dr-sidebar-open');
    });
  }

  document.querySelectorAll('.dr-copy-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const container = button.closest('.dr-codeblock');
      if (!container) return;
      const code = container.querySelector('pre code');
      if (!code) return;
      await navigator.clipboard.writeText(code.textContent || '');
      button.textContent = 'Copied';
      setTimeout(() => {
        button.textContent = 'Copy';
      }, 1200);
    });
  });

  const modal = document.getElementById('dr-search-modal');
  const openSearch = document.getElementById('dr-search-open');
  const input = document.getElementById('dr-search-input');
  const resultBox = document.getElementById('dr-search-results');
  let index = [];
  let selectedIndex = 0;

  const renderResults = (query) => {
    if (!resultBox) return;
    const q = query.trim().toLowerCase();
    const fromStorage = localStorage.getItem('drdocs-recent-searches');
    const recents = fromStorage ? JSON.parse(fromStorage) : [];

    if (!q) {
      const recentHtml = recents.length
        ? recents.map((item) => '<div class="dr-result"><small>Recent</small>' + item + '</div>').join('')
        : '<div class="dr-result"><small>Type to search your docs.</small></div>';
      resultBox.innerHTML = recentHtml;
      selectedIndex = 0;
      return;
    }

    const scored = index
      .map((entry) => {
        const haystack = [entry.title, entry.description, entry.body, ...(entry.headings || [])].join(' ').toLowerCase();
        const score = haystack.includes(q) ? 1 : 0;
        return { entry, score };
      })
      .filter((item) => item.score > 0)
      .slice(0, 12);

    if (scored.length === 0) {
      resultBox.innerHTML = '<div class="dr-result"><small>No results found.</small></div>';
      selectedIndex = 0;
      return;
    }

    resultBox.innerHTML = scored
      .map(({ entry }, indexValue) =>
        '<a class="dr-result" data-result-index="' + indexValue + '" href="' + entry.url + '"><strong>' + entry.title + '</strong><small>' + entry.description + '</small></a>'
      )
      .join('');
    selectedIndex = 0;
    const firstResult = resultBox.querySelector('.dr-result[data-result-index="0"]');
    if (firstResult) firstResult.classList.add('active');
  };

  const openModal = () => {
    if (!modal || !input) return;
    modal.style.display = 'flex';
    input.focus();
    renderResults('');
  };

  const closeModal = () => {
    if (!modal) return;
    modal.style.display = 'none';
  };

  const moveSelection = (direction) => {
    if (!resultBox) return;
    const results = Array.from(resultBox.querySelectorAll('.dr-result[data-result-index]'));
    if (results.length === 0) return;

    selectedIndex = (selectedIndex + direction + results.length) % results.length;
    results.forEach((item) => item.classList.remove('active'));
    const selected = results[selectedIndex];
    if (selected) {
      selected.classList.add('active');
      selected.scrollIntoView({ block: 'nearest' });
    }
  };

  if (openSearch) {
    openSearch.addEventListener('click', openModal);
  }

  if (modal) {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeModal();
    });
  }

  if (input) {
    input.addEventListener('input', () => {
      renderResults(input.value);
      const current = input.value.trim();
      if (current.length > 1) {
        const fromStorage = localStorage.getItem('drdocs-recent-searches');
        const recents = fromStorage ? JSON.parse(fromStorage) : [];
        const next = [current, ...recents.filter((item) => item !== current)].slice(0, 6);
        localStorage.setItem('drdocs-recent-searches', JSON.stringify(next));
      }
    });
  }

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openModal();
      return;
    }

    if (modal && modal.style.display === 'flex' && event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1);
      return;
    }

    if (modal && modal.style.display === 'flex' && event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1);
      return;
    }

    if (modal && modal.style.display === 'flex' && event.key === 'Enter') {
      const selected = resultBox ? resultBox.querySelector('.dr-result.active') : null;
      if (selected && selected instanceof HTMLAnchorElement) {
        window.location.href = selected.href;
        return;
      }
    }

    if (event.key === 'Escape') {
      closeModal();
      body.classList.remove('dr-sidebar-open');
    }
  });

  fetch('/search-index.json')
    .then((response) => response.json())
    .then((data) => {
      index = Array.isArray(data) ? data : [];
    })
    .catch(() => {
      index = [];
    });

  const tocLinks = Array.from(document.querySelectorAll('.dr-toc a[href^="#"]'));
  const headingTargets = tocLinks
    .map((link) => {
      if (!(link instanceof HTMLAnchorElement)) return null;
      const id = link.getAttribute('href')?.slice(1);
      if (!id) return null;
      const target = document.getElementById(id);
      if (!target) return null;
      return { link, target };
    })
    .filter(Boolean);

  if (headingTargets.length > 0) {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);

        if (visible.length === 0) return;

        const activeId = visible[0].target.getAttribute('id');
        tocLinks.forEach((link) => link.classList.remove('active'));
        const activeLink = tocLinks.find((link) => link.getAttribute('href') === '#' + activeId);
        if (activeLink) activeLink.classList.add('active');
      },
      { rootMargin: '-15% 0px -75% 0px', threshold: [0, 1] }
    );

    headingTargets.forEach((item) => {
      if (item) observer.observe(item.target);
    });
  }
})();
`;

const writePageOutput = async (distDir: string, slug: string, html: string): Promise<void> => {
  const outputFile = path.join(distDir, `${slug}.html`);
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, html, 'utf8');
};

const buildSinglePageInternal = async (
  projectRoot: string,
  changedFilePath: string,
  writeSearchIndex: boolean
): Promise<{ slug: string }> => {
  const docsDir = path.join(projectRoot, 'docs');
  const distDir = path.join(projectRoot, 'dist');
  const resolvedChangedPath = path.resolve(changedFilePath);

  if (!resolvedChangedPath.startsWith(path.resolve(docsDir))) {
    throw new Error('Changed file is outside docs directory.');
  }

  const config = await readConfig(projectRoot);
  const allPageMeta = applyNavigationOrder(await collectPageMeta(docsDir, config), config);
  const current = allPageMeta.find((page) => path.resolve(page.sourcePath) === resolvedChangedPath);

  if (!current) {
    throw new Error(`Cannot rebuild page: ${resolvedChangedPath}`);
  }

  const raw = await readFile(resolvedChangedPath, 'utf8');
  const parsed = matter(raw);
  const html = await parseMarkdownToHtml(parsed.content);
  const withHeadings = extractHeadings(html);
  const sidebar = renderSidebar(config, allPageMeta, current.slug);
  const prevNext = getPrevNext(allPageMeta, current.slug);

  const page = renderLayout({
    config,
    pageTitle: current.title,
    pageDescription: current.description,
    sidebar,
    content: withHeadings.html,
    toc: renderToc(withHeadings.headings),
    breadcrumbs: renderBreadcrumbs(current.slug),
    prevNext
  });

  await mkdir(distDir, { recursive: true });
  await writePageOutput(distDir, current.slug, page);

  if (writeSearchIndex && config.search !== false) {
    const searchEntry: SearchIndexEntry = {
      title: current.title,
      description: current.description,
      headings: withHeadings.headings.map((h) => h.text),
      body: stripHtml(withHeadings.html),
      url: `/${current.slug}.html`
    };

    const indexPath = path.join(distDir, 'search-index.json');
    let existing: SearchIndexEntry[] = [];
    try {
      existing = JSON.parse(await readFile(indexPath, 'utf8')) as SearchIndexEntry[];
    } catch {
      existing = [];
    }

    const merged = [...existing.filter((entry) => entry.url !== searchEntry.url), searchEntry];
    await writeFile(indexPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  }

  return { slug: current.slug };
};

export const buildSite = async (projectRoot = process.cwd()): Promise<void> => {
  const docsDir = path.join(projectRoot, 'docs');
  const distDir = path.join(projectRoot, 'dist');
  const publicDir = path.join(projectRoot, 'public');

  const config = await readConfig(projectRoot);

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  const pageMeta = applyNavigationOrder(await collectPageMeta(docsDir, config), config);
  const builtPages: BuiltPage[] = [];

  for (const meta of pageMeta) {
    const raw = await readFile(meta.sourcePath, 'utf8');
    const parsed = matter(raw);
    const html = await parseMarkdownToHtml(parsed.content);
    const withHeadings = extractHeadings(html);

    builtPages.push({
      ...meta,
      html: withHeadings.html,
      headings: withHeadings.headings
    });
  }

  const searchEntries: SearchIndexEntry[] = [];

  for (const page of builtPages) {
    const sidebar = renderSidebar(config, builtPages, page.slug);
    const prevNext = getPrevNext(pageMeta, page.slug);
    const pageHtml = renderLayout({
      config,
      pageTitle: page.title,
      pageDescription: page.description,
      sidebar,
      content: page.html,
      toc: renderToc(page.headings),
      breadcrumbs: renderBreadcrumbs(page.slug),
      prevNext
    });

    await writePageOutput(distDir, page.slug, pageHtml);

    if (config.search !== false) {
      searchEntries.push({
        title: page.title,
        description: page.description,
        headings: page.headings.map((h) => h.text),
        body: stripHtml(page.html),
        url: `/${page.slug}.html`
      });
    }
  }

  if (builtPages.length > 0) {
    const redirect = `<!doctype html><meta http-equiv="refresh" content="0; url=/${builtPages[0].slug}.html" />`;
    await writeFile(path.join(distDir, 'index.html'), redirect, 'utf8');
  }

  const notFound = renderLayout({
    config,
    pageTitle: 'Not Found',
    pageDescription: config.description ?? '',
    sidebar: renderSidebar(config, builtPages, ''),
    content: '<h1>404</h1><p>The page you requested was not found.</p>',
    toc: renderToc([]),
    breadcrumbs: '<nav class="dr-breadcrumbs"><a href="/index.html">Docs</a> / <span>404</span></nav>',
    prevNext: {}
  });
  await writeFile(path.join(distDir, '404.html'), notFound, 'utf8');

  if (config.search !== false) {
    await writeFile(path.join(distDir, 'search-index.json'), `${JSON.stringify(searchEntries, null, 2)}\n`, 'utf8');
  }

  const drdocsPublicDir = path.join(distDir, 'public', 'drdocs');
  await mkdir(drdocsPublicDir, { recursive: true });
  await writeFile(path.join(drdocsPublicDir, 'client.js'), buildClientScript(), 'utf8');

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
): Promise<{ slug: string }> => buildSinglePageInternal(projectRoot, changedFilePath, true);
