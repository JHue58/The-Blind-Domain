import { button, entryHref, installTermPreviews, link, node, renderMarkdown, termIndex } from './markup.mjs';
import { chapterBookmark, chapterHref, chapterTitle, lastChapter, mountReader } from './reading.mjs';

const main = document.querySelector('main');
const archiveCategories = new Map([
  ['all', '全部'], ['term', '术语'], ['character', '人物'], ['zone', '域区'],
  ['phenomenon', '域闻'], ['ability', '能力'], ['clue', '线索'], ['other', '其他'],
]);
const filters = { settings: '', archives: '', category: 'all' };

let route = readRoute();
let catalogCache;
let detailCache;
let activeSync;
let unmountReader;
let termsByName = new Map();
const closePreviews = installTermPreviews(main, document.querySelector('#term-popover'), (term) => termsByName.get(term));
history.scrollRestoration = 'manual';

function readRoute(fragment = location.hash) {
  if (!fragment || fragment === '#/') return { view: 'home' };
  const [path, search] = fragment.replace(/^#\//, '').split('?');
  const match = path.match(/^(read|settings|archives)(?:\/([a-z0-9-]+))?$/);
  if (!match) return { view: 'missing' };
  return { view: match[1], id: match[2], section: new URLSearchParams(search).get('section') };
}

function allowsRoute(href) {
  if (!href.startsWith('#/')) return false;
  const target = readRoute(href);
  if (target.view === 'missing' || !target.id) return target.view !== 'missing';
  const records = catalogCache.data[target.view === 'read' ? 'chapters' : target.view];
  return records.some((record) => record.id === target.id);
}

function icon(shape) {
  const mark = node('span', `line-icon icon-${shape}`);
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

function entryCard(entry) {
  const tag = entry.collection === 'archives' ? archiveCategories.get(entry.category) : null;
  const heading = node('h2', 'card-title', entry.title);
  return link([
    tag ? node('span', 'card-category', entry.code ? `${tag} / ${entry.code}` : tag) : null, heading,
    node('p', '', entry.summary),
  ], entryHref(entry.collection, entry.id), 'entry-card');
}

function emptyState(title, description, action, shape = 'book') {
  return node('section', 'empty-state', node('span', 'empty-symbol', icon(shape)),
    node('h2', '', title), node('p', '', description), action);
}

function home(catalog) {
  const recent = lastChapter(catalog.chapters);
  const first = catalog.chapters[0];
  const cover = node('img', 'hero-image');
  cover.src = '/assets/cover.png';
  cover.alt = '';
  cover.width = 1536;
  cover.height = 1024;
  const hero = node('section', 'hero', cover, node('div', 'hero-shade'), node('div', 'hero-copy',
    node('p', 'eyebrow hero-genre', '都市怪谈 · 规则探索'), node('h1', '', '盲域'),
    node('p', 'hero-deck', '日常秩序之外，存在一种无法定义的异常。\n进入之后，现实的时间就此停下。'),
    node('div', 'hero-actions',
      link(recent ? '继续阅读' : first ? '开始阅读' : '查看章节目录', recent || first ? chapterHref(recent || first) : '#/read', 'button primary'),
      link('浏览设定集', '#/settings', 'button hero-secondary'))));

  const gateways = node('div', 'gateways',
    link([node('span', 'gateway-icon', icon('book')),
      node('div', '', node('h2', '', '小说正文'), node('p', '', recent ? `上次读到 ${chapterTitle(recent)}`
        : first ? `共 ${catalog.chapters.length} 章` : '暂无章稿')),
      node('span', 'gateway-action', '章节目录')], '#/read', 'gateway'),
    link([node('span', 'gateway-icon', icon('archive')),
      node('div', '', node('h2', '', '档案室'), node('p', '', catalog.archives.length ? `${catalog.archives.length} 份档案可查阅` : '暂无可阅档案')),
      node('span', 'gateway-action', '查阅档案')], '#/archives', 'gateway'));

  const featured = node('section', 'featured', node('div', 'section-heading', node('h2', '', '世界设定'),
    link('全部设定', '#/settings', 'text-link')),
  node('div', 'card-grid', catalog.settings.slice(0, 3).map(entryCard)));
  return node('div', 'frame home-view', hero, gateways, featured);
}

function pageHeading(title, description, action) {
  return node('header', 'page-heading', node('div', '', node('h1', '', title), description ? node('p', '', description) : null), action);
}

function chapterDirectory(chapters) {
  const recent = lastChapter(chapters);
  const resume = recent ? link('继续阅读', chapterHref(recent), 'button primary') : null;
  const title = pageHeading('章节目录', chapters.length ? `共 ${chapters.length} 章` : '', resume);
  if (!chapters.length) return node('div', 'frame page-view', title,
    emptyState('暂无章稿', '新增章节会自动出现在目录中。', link('浏览设定集', '#/settings', 'button quiet')));

  const volumes = new Map();
  for (const chapter of chapters) {
    if (!volumes.has(chapter.volumeNumber)) volumes.set(chapter.volumeNumber, { name: chapter.volume, chapters: [] });
    volumes.get(chapter.volumeNumber).chapters.push(chapter);
  }
  const groups = [...volumes.values()].map((volume) => node('section', 'volume', node('h2', '', volume.name),
    node('ol', 'chapter-list', volume.chapters.map((chapter) => {
      const bookmark = chapterBookmark(chapter);
      const progress = bookmark?.progress > 0 ? `${Math.round(bookmark.progress * 100)}%` : null;
      const status = chapter.status !== '定稿' ? chapter.status : null;
      return node('li', '', link([
        node('span', 'chapter-number', chapter.label),
        chapter.title !== chapter.label ? node('span', 'chapter-list-title', chapter.title) : null,
        status || progress ? node('span', 'chapter-list-meta',
          status ? node('span', '', status) : null, progress ? node('span', '', `已读 ${progress}`) : null) : null,
      ], chapterHref(chapter), 'chapter-row'));
    }))));
  return node('div', 'frame page-view chapter-directory', title, groups);
}

function collectionPage(catalog, collection) {
  const isArchive = collection === 'archives';
  const title = isArchive ? '档案室' : '设定集';
  const description = isArchive ? '' : '查阅《盲域》的世界规则与术语。';
  const entries = catalog[collection];
  const search = node('input', 'catalog-input');
  search.type = 'search';
  search.value = filters[collection];
  search.placeholder = isArchive ? '搜索名称、术语或编号' : '搜索名称或术语';
  search.setAttribute('aria-label', search.placeholder);
  search.dataset.collectionSearch = collection;
  const tools = node('div', 'catalog-tools', node('label', 'catalog-search', icon('search'), search));
  const categories = node('div', 'category-tabs');
  categories.setAttribute('role', 'group');
  categories.setAttribute('aria-label', '档案类别');
  const results = node('div', 'catalog-results');

  if (isArchive) {
    for (const [id, name] of archiveCategories) {
      const tab = button(name, 'category-button');
      tab.dataset.category = id;
      tab.addEventListener('click', () => {
        filters.category = id;
        updateResults();
      });
      categories.append(tab);
    }
    tools.prepend(categories);
  }

  function updateResults() {
    const query = filters[collection].trim().toLocaleLowerCase('zh-CN');
    const relatedTerms = new Set(catalog.terms.filter((term) => term.entry && term.name.toLowerCase().includes(query)).map((term) => term.entry));
    const shown = entries.filter((entry) => (!isArchive || filters.category === 'all' || filters.category === entry.category)
      && (!query || `${entry.title} ${archiveCategories.get(entry.category)} ${entry.summary} ${entry.code}`.toLowerCase().includes(query)
        || relatedTerms.has(entry.id)));
    for (const tab of categories.children) tab.setAttribute('aria-pressed', String(filters.category === tab.dataset.category));
    if (shown.length) {
      results.replaceChildren(node('div', 'card-grid', shown.map(entryCard)));
    } else {
      const unfilled = entries.length === 0;
      results.replaceChildren(emptyState(
        unfilled ? (isArchive ? '暂无可阅档案' : '暂无可阅设定') : '未找到匹配条目',
        unfilled ? '新增条目会自动出现在目录中。' : '试试其他名称、编号或类别。',
        null, isArchive ? 'archive' : 'book'));
    }
  }

  search.addEventListener('input', () => {
    filters[collection] = search.value;
    updateResults();
  });
  updateResults();
  return node('div', 'frame page-view catalog-view', pageHeading(title, description), tools, results);
}

function entryPage(entry, source, catalog) {
  const isArchive = entry.collection === 'archives';
  const category = archiveCategories.get(entry.category);
  const page = node('article', 'reference-article',
    node('header', 'reference-heading', node('p', 'eyebrow', entry.code ? `${category} / ${entry.code}` : category), node('h1', '', entry.title)));
  const article = node('div', 'prose reference-body', renderMarkdown(source, termIndex(catalog.terms, entry.id), allowsRoute));
  page.append(article);

  const headings = [...article.querySelectorAll('[data-section]')];
  const contents = headings.length ? node('nav', 'reference-index', node('h2', '', '本页内容'),
    headings.map((heading) => link(heading.dataset.section, entryHref(entry.collection, entry.id, heading.dataset.section)))) : null;
  const neighbours = catalog[entry.collection].filter((other) => other.id !== entry.id).slice(0, 6);
  const related = neighbours.length ? node('nav', 'reference-index', node('h2', '', isArchive ? '其他档案' : '其他设定'),
    neighbours.map((other) => link(other.title, entryHref(other.collection, other.id)))) : null;
  contents?.setAttribute('aria-label', '本页内容');
  related?.setAttribute('aria-label', isArchive ? '其他档案' : '其他设定');
  return node('div', 'frame page-view reference-view',
    link(isArchive ? '返回档案室' : '返回设定集', `#/${entry.collection}`, 'text-link back-link'),
    node('div', 'reference-layout', page, contents || related ? node('aside', 'reference-aside', contents, related) : null));
}

function statusPage(title, description, action) {
  return node('div', 'frame page-view', pageHeading(title, description, action));
}

function requestedDetail(catalog, target) {
  if (!target.id || !['read', 'settings', 'archives'].includes(target.view)) return null;
  const records = target.view === 'read' ? catalog.chapters : catalog[target.view];
  const record = records.find((item) => item.id === target.id);
  return record ? { record, url: `/api/${target.view === 'read' ? 'chapters' : 'entries'}/${record.id}` } : null;
}

function jumpToSection() {
  if (!route.section) return;
  [...main.querySelectorAll('[data-section]')].find((heading) => heading.dataset.section === route.section)?.scrollIntoView();
}

function render({ navigation = false, revealSection = false } = {}) {
  const catalog = catalogCache?.data;
  if (!catalog) return;
  const scrollPosition = window.scrollY;
  const searchInFocus = main.contains(document.activeElement) && document.activeElement.dataset.collectionSearch;
  const searchSelection = searchInFocus ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  unmountReader?.();
  unmountReader = null;
  closePreviews();
  for (const navLink of document.querySelectorAll('.site-nav a')) {
    if (navLink.dataset.view === route.view) navLink.setAttribute('aria-current', 'page');
    else navLink.removeAttribute('aria-current');
  }

  const requested = requestedDetail(catalog, route);
  const data = requested?.url === detailCache?.url ? detailCache?.data : undefined;
  let view;
  let title;
  if (route.view === 'home') {
    view = home(catalog);
  } else if (route.id && requested && data) {
    title = data.title || requested.record.title;
    if (route.view === 'read') {
      unmountReader = mountReader(main, { chapter: requested.record, bodyTitle: data.title, chapters: catalog.chapters, closePreviews,
        markdown: renderMarkdown(data.markdown, termIndex(catalog.terms), allowsRoute) });
    } else {
      view = entryPage(requested.record, data.markdown, catalog);
    }
  } else if (route.id || route.view === 'missing') {
    const loading = requested && data === undefined;
    const target = ['read', 'settings', 'archives'].includes(route.view) ? `#/${route.view}` : '#/';
    view = loading ? statusPage('正在读取…')
      : statusPage('此内容当前不可阅读', '可返回目录查看当前可读内容。', link('返回目录', target, 'button quiet'));
  } else if (route.view === 'read') {
    title = '章节目录';
    view = chapterDirectory(catalog.chapters);
  } else {
    title = route.view === 'settings' ? '设定集' : '档案室';
    view = collectionPage(catalog, route.view);
  }

  document.title = title ? `${title} · 盲域` : '盲域 · 阅读站';
  if (view) {
    main.replaceChildren(view);
    window.scrollTo(0, navigation ? 0 : scrollPosition);
    if (navigation || revealSection) jumpToSection();
    if (searchInFocus && !navigation) {
      const search = main.querySelector(`[data-collection-search="${searchInFocus}"]`);
      search?.focus({ preventScroll: true });
      search?.setSelectionRange(...searchSelection);
    }
  }
  if (navigation) main.focus({ preventScroll: true });
}

async function getUpdate(url, cached, signal) {
  const headers = cached?.tag ? { 'If-None-Match': cached.tag } : {};
  const response = await fetch(url, { signal, headers, cache: 'no-store' });
  if (response.status === 304) return cached;
  if (response.status === 404) return cached?.data === null ? cached : { url, data: null };
  if (!response.ok) throw new Error('内容暂时无法读取');
  return { url, tag: response.headers.get('ETag'), data: await response.json() };
}

async function refresh(navigation = false) {
  if (activeSync && !navigation) return;
  activeSync?.abort();
  const task = new AbortController();
  activeSync = task;
  const { signal } = task;
  try {
    const nextCatalog = await getUpdate('/api/catalog', catalogCache, signal);
    if (!nextCatalog.data) throw new Error('找不到目录');
    const requested = requestedDetail(nextCatalog.data, route);
    const previousDetail = requested?.url === detailCache?.url ? detailCache : undefined;
    const nextDetail = requested ? await getUpdate(requested.url, previousDetail, signal) : undefined;
    if (signal.aborted) return;

    const changed = catalogCache !== nextCatalog || detailCache !== nextDetail;
    catalogCache = nextCatalog;
    detailCache = nextDetail;
    if (changed) {
      termsByName = new Map(catalogCache.data.terms.map((term) => [term.name, term]));
      render({ revealSection: !previousDetail?.data && Boolean(nextDetail?.data) });
    }
  } catch {
    if (signal.aborted) return;
    if (!catalogCache) main.replaceChildren(statusPage('暂时无法读取内容', '站点会自动重试。'));
  } finally {
    if (activeSync === task) activeSync = undefined;
  }
}

document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  main.focus();
});

window.addEventListener('hashchange', () => {
  const previous = route;
  route = readRoute();
  if (previous.view === route.view && previous.id === route.id && previous.section !== route.section && route.section) {
    jumpToSection();
    return;
  }
  render({ navigation: true });
  refresh(true);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
setInterval(() => { if (!document.hidden) refresh(); }, 2000);
refresh();
