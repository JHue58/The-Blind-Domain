import { button, entryHref, installTermPreviews, link, node, renderIllustration, renderMarkdown, termIndex } from './markup.mjs';
import { chapterBookmark, chapterHref, chapterTitle, completedThrough, lastChapter, mountReader } from './reading.mjs';

const main = document.querySelector('main');
const spoilerDialog = document.querySelector('#spoiler-dialog');
const archiveCategories = new Map([
  ['all', '全部档案'], ['phenomenon', '域闻'], ['zone', '域区'], ['ability', '能力'],
  ['clue', '线索'], ['character', '人物'], ['term', '术语'], ['other', '其他'],
]);
const caseCategories = new Set(['phenomenon', 'zone', 'ability', 'clue']);
const filters = { settings: '', archives: '', category: 'all', chapter: '' };

let route = readRoute();
let catalogCache;
let detailCache;
let activeSync;
let unmountReader;
let showSpoilers = false;
let termsByName = new Map();
const closePreviews = installTermPreviews(main, document.querySelector('#term-popover'), (term) => termsByName.get(term));
history.scrollRestoration = 'manual';

function readRoute(fragment = location.hash) {
  if (!fragment || fragment === '#/') return { view: 'home' };
  const [path, search] = fragment.replace(/^#\//, '').split('?');
  const match = path.match(/^(read|settings|archives)(?:\/([a-z0-9-]+))?$/);
  if (!match) return { view: 'missing' };
  const query = new URLSearchParams(search);
  return { view: match[1], id: match[2], section: query.get('section'), from: query.get('from') };
}

function isReference({ view }) {
  return view === 'settings' || view === 'archives';
}

function archiveOrigin() {
  return route.view === 'read' ? route.id : route.from;
}

function archiveSearch(chapters) {
  if (showSpoilers && isReference(route)) return '?spoilers=1';
  const through = completedThrough(chapters, archiveOrigin());
  return through ? `?through=${through}` : '';
}

function resolveRoute(catalog, href) {
  if (!href.startsWith('#/')) return null;
  const target = readRoute(href);
  if (target.view === 'missing') return null;
  if (target.id) {
    const records = catalog[target.view === 'read' ? 'chapters' : target.view];
    if (!records.some((record) => record.id === target.id)) return null;
  }
  return isReference(target) ? entryHref(target.view, target.id, target.section, archiveOrigin()) : href;
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
  ], entryHref(entry.collection, entry.id, '', archiveOrigin()), 'entry-card');
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
    node('p', 'eyebrow hero-genre', '都市怪谈 · 超自然'), node('h1', '', '盲域'),
    node('p', 'hero-deck', '录像里，一个人沿着天桥往下走，脚下始终还剩三级台阶。\n封桥后，附近的人改从地铁站过街。'),
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

  const featured = catalog.settings.length ? node('section', 'featured', node('div', 'section-heading', node('h2', '', '世界设定'),
    link('全部设定', '#/settings', 'text-link')),
  node('div', 'card-grid', catalog.settings.slice(0, 3).map(entryCard))) : null;
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

function setSpoilers(visible) {
  showSpoilers = visible;
  render({ navigation: true });
  refresh(true);
}

function spoilerControl(hasSpoilers) {
  if (!showSpoilers && !hasSpoilers) return null;
  const action = button(showSpoilers ? '恢复按进度查看' : '查看后续内容', 'button quiet');
  action.addEventListener('click', () => {
    if (showSpoilers) setSpoilers(false);
    else spoilerDialog.showModal();
  });
  return action;
}

function searchControl(collection, placeholder, update) {
  const search = node('input', 'catalog-input');
  search.type = 'search';
  search.value = filters[collection];
  search.placeholder = placeholder;
  search.setAttribute('aria-label', placeholder);
  search.dataset.collectionSearch = collection;
  search.addEventListener('input', () => {
    filters[collection] = search.value;
    update();
  });
  return node('label', 'catalog-search', icon('search'), search);
}

function searchable(entries, terms, query) {
  const normalize = (value) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const text = normalize(query);
  if (!text) return entries;
  const aliases = new Set(terms.filter(({ name }) => normalize(name).includes(text)).map(({ entry }) => entry));
  return entries.filter(({ id, title, category, summary, code }) => aliases.has(id)
    || [title, archiveCategories.get(category), summary, code].some((value) => normalize(value).includes(text)));
}

function settingDirectory(catalog) {
  const results = node('div', 'catalog-results');
  function updateResults() {
    const shown = searchable(catalog.settings, catalog.terms, filters.settings);
    results.replaceChildren(shown.length ? node('div', 'card-grid', shown.map(entryCard)) : emptyState(
      catalog.settings.length ? '未找到匹配条目' : '暂无可阅设定',
      catalog.settings.length ? '试试其他名称或术语。' : '术语随阅读进度开放。'));
  }
  const search = searchControl('settings', '搜索名称或术语', updateResults);
  updateResults();
  return node('div', 'frame page-view catalog-view',
    pageHeading('设定集', showSpoilers ? '剧透模式已开启' : '查阅《盲域》的世界规则与术语。',
      spoilerControl(catalog.hasSpoilers.settings)), node('div', 'catalog-tools', search), results);
}

function chapterReference(chapter) {
  return `${chapter.volume} · ${chapter.label}`;
}

function archiveRow(entry) {
  const category = archiveCategories.get(entry.category);
  return node('li', '', link([
    node('span', 'archive-row-category', category, entry.code ? node('code', 'archive-code', entry.code) : null),
    node('span', 'archive-row-copy', node('span', 'archive-row-title', entry.title), node('span', 'archive-row-summary', entry.summary)),
  ], entryHref('archives', entry.id, '', archiveOrigin()), 'archive-row'));
}

function archiveDirectory(catalog) {
  const chapters = new Map(catalog.chapters.map((chapter) => [chapter.id, chapter]));
  const order = new Map(catalog.chapters.map(({ id }, index) => [id, index]));
  const latest = (entry) => entry.chapters?.at(-1);
  const entries = [...catalog.archives].sort((first, second) => (order.get(latest(second)) ?? -1) - (order.get(latest(first)) ?? -1)
    || first.title.localeCompare(second.title, 'zh-CN'));
  const counts = new Map([['all', entries.length]]);
  const chapterIds = new Set();
  for (const entry of entries) {
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
    for (const chapter of entry.chapters ?? []) chapterIds.add(chapter);
  }
  if (!counts.has(filters.category)) filters.category = 'all';
  if (!chapterIds.has(filters.chapter)) filters.chapter = '';

  const scope = chapters.get(completedThrough(catalog.chapters, archiveOrigin()));
  const description = showSpoilers ? '剧透模式已开启' : scope ? `已开放至 ${chapterReference(scope)}` : '档案随读完的章节开放。';
  const categories = node('div', 'category-tabs');
  categories.setAttribute('role', 'group');
  categories.setAttribute('aria-label', '档案类别');
  const select = node('select', 'archive-chapter-select', node('option', '', '全部章节'));
  select.firstElementChild.value = '';
  select.setAttribute('aria-label', '按章节筛选档案');
  for (const chapter of [...catalog.chapters].reverse()) {
    if (!chapterIds.has(chapter.id)) continue;
    const option = node('option', '', chapterReference(chapter));
    option.value = chapter.id;
    select.append(option);
  }
  select.value = filters.chapter;
  const results = node('div', 'catalog-results');
  const count = node('p', 'archive-count');
  count.setAttribute('aria-live', 'polite');

  function updateResults() {
    const filtered = entries.filter((entry) => (filters.category === 'all' || filters.category === entry.category)
      && (!filters.chapter || entry.chapters?.includes(filters.chapter)));
    const shown = searchable(filtered, catalog.terms, filters.archives);
    for (const tab of categories.children) tab.setAttribute('aria-pressed', String(filters.category === tab.dataset.category));
    count.textContent = `${shown.length} 份档案`;
    results.replaceChildren(shown.length ? node('ul', 'archive-register', shown.map(archiveRow)) : emptyState(
      entries.length ? '未找到匹配档案' : '暂无可阅档案',
      entries.length ? '试试其他名称、编号、类别或章节。' : '读完正文后可回到这里查阅。',
      entries.length ? null : link('查看章节目录', '#/read', 'button quiet'), 'archive'));
  }

  for (const [id, name] of archiveCategories) {
    if (!counts.has(id)) continue;
    const tab = button([name, node('span', 'category-count', String(counts.get(id)))], 'category-button');
    tab.dataset.category = id;
    tab.addEventListener('click', () => {
      filters.category = id;
      updateResults();
    });
    categories.append(tab);
  }
  select.addEventListener('change', () => {
    filters.chapter = select.value;
    updateResults();
  });
  const search = searchControl('archives', '搜索名称、别名或编号', updateResults);
  updateResults();

  return node('div', 'frame page-view archive-view',
    pageHeading('档案室', description, spoilerControl(catalog.hasSpoilers.archives)),
    node('div', 'archive-layout', node('aside', 'archive-sidebar archive-categories', node('h2', '', '档案分类'), categories),
      node('section', 'archive-sheet archive-directory', node('div', 'catalog-tools', search, chapterIds.size ? select : null), count, results)));
}

function chapterArchiveUpdates(catalog, chapter) {
  if (completedThrough(catalog.chapters, chapter.id) !== chapter.id) return null;
  const updates = catalog.archives.filter((entry) => entry.openedIn === chapter.id
    || (caseCategories.has(entry.category) && entry.chapters?.includes(chapter.id)))
    .sort((first, second) => Number(second.openedIn === chapter.id) - Number(first.openedIn === chapter.id));
  if (!updates.length) return null;
  return node('section', 'chapter-archives',
    node('div', 'chapter-archives-heading', node('h2', '', '本章档案'),
      link('查阅档案室', entryHref('archives', '', '', chapter.id), 'text-link')),
    node('ul', '', updates.map((entry) => node('li', '',
      node('span', '', entry.openedIn === chapter.id ? '新增' : '更新'),
      link(entry.title, entryHref(entry.collection, entry.id, '', chapter.id), 'text-link')))));
}

function referenceToolbar(entry, catalog, hasSpoilers) {
  const archive = entry.collection === 'archives';
  const from = archiveOrigin();
  const origin = catalog.chapters.find(({ id }) => id === from);
  return node('div', 'reference-toolbar',
    node('div', 'reference-crumbs', link(archive ? '返回档案室' : '返回设定集', entryHref(entry.collection, '', '', from), 'text-link'),
      origin ? link(`回到${origin.label}`, chapterHref(origin), 'text-link') : null),
    showSpoilers ? node('span', 'spoiler-status', '剧透模式') : null, spoilerControl(hasSpoilers));
}

function referenceIndex(title, links) {
  if (!links.length) return null;
  const index = node('nav', 'reference-index', node('h2', '', title), links);
  index.setAttribute('aria-label', title);
  return index;
}

function archiveBody(records, terms, catalog) {
  const body = node('div', 'prose archive-body');
  for (const { after, markdown } of records) {
    const section = node('section', 'archive-record');
    if (after) section.dataset.section = after;
    const content = renderMarkdown(markdown, terms, (href) => resolveRoute(catalog, href));
    let target = section;
    for (const element of [...content.children]) {
      if (element.matches('h2')) {
        target = section;
        if (element.textContent.startsWith('附录｜')) {
          target = node('div', 'archive-appendix-body');
          const appendix = node('details', 'archive-appendix', node('summary', '', element.textContent), target);
          appendix.dataset.section = element.dataset.section;
          section.append(appendix);
          continue;
        }
      }
      if (element.matches('p') && element.firstChild?.nodeName === 'STRONG' && element.firstChild.textContent === '出处') {
        element.classList.add('archive-source');
      }
      target.append(element);
    }
    body.append(section);
  }
  return body;
}

function archiveEntryPage(entry, { markdown, hasSpoilers, illustrations = [], facts = [], records = [], related = [] }, catalog, terms) {
  const from = archiveOrigin();
  const category = archiveCategories.get(entry.category);
  const title = node('header', 'archive-entry-heading',
    node('p', 'archive-classification', category, entry.code ? node('code', 'archive-code', entry.code) : null),
    node('h1', '', entry.title));
  const fields = facts.length ? node('dl', 'archive-facts', facts.map(({ label, value }) =>
    node('div', label === '已见风险' ? 'archive-risk' : '', node('dt', '', label), node('dd', '', value)))) : null;
  const images = illustrations.map((drawing) => renderIllustration({ ...drawing,
    caption: drawing.caption.replace(/^第\d+章插图\s*·\s*/, '现场示意 · '),
  }));
  const evidence = images.length ? node('div', 'archive-evidence', images[0],
    images.length > 1 ? node('details', 'archive-appendix', node('summary', '', '其余配图'),
      node('div', 'archive-appendix-body', images.slice(1))) : null) : null;
  const overview = fields || evidence ? node('div', fields && evidence ? 'archive-overview with-evidence' : 'archive-overview', fields, evidence) : null;
  const body = archiveBody(records.length ? records : [{ markdown: markdown || entry.summary }], termIndex(terms, entry.id, from), catalog);
  const contents = referenceIndex('本页目录', [...body.querySelectorAll('h2[data-section], details[data-section]')].map(({ dataset: { section } }) =>
    link(section, entryHref('archives', entry.id, section, from))));
  const links = referenceIndex('关联档案', related.map((id) => catalog.archives.find((other) => other.id === id)).filter(Boolean)
    .map((other) => link(other.title, entryHref('archives', other.id, '', from))));
  const navigation = contents || links ? node('aside', 'archive-sidebar archive-entry-sidebar', contents, links) : null;
  return node('div', 'frame page-view archive-view archive-entry-view', referenceToolbar(entry, catalog, hasSpoilers),
    node('div', navigation ? 'archive-layout archive-entry-layout' : 'archive-entry-layout',
      node('article', 'archive-sheet archive-entry', title, overview, body), navigation));
}

function settingEntryPage(entry, { markdown, hasSpoilers, illustrations = [] }, catalog, terms) {
  const from = archiveOrigin();
  const title = node('header', 'reference-heading', node('p', 'eyebrow', archiveCategories.get(entry.category)), node('h1', '', entry.title));
  const source = renderMarkdown(markdown || entry.summary, termIndex(terms, entry.id, from), (href) => resolveRoute(catalog, href));
  const body = node('div', 'prose reference-body', source, illustrations.map(renderIllustration));
  const page = node('article', 'reference-article', title, body);
  const contents = referenceIndex('本页内容', [...body.querySelectorAll('[data-section]')].map(({ dataset: { section } }) =>
    link(section, entryHref('settings', entry.id, section, from))));
  const links = referenceIndex('其他设定', catalog.settings.filter((other) => other.id !== entry.id).slice(0, 6)
    .map((other) => link(other.title, entryHref('settings', other.id, '', from))));
  return node('div', 'frame page-view reference-view', referenceToolbar(entry, catalog, hasSpoilers),
    node('div', contents || links ? 'reference-layout' : 'reference-layout reference-layout-single', page,
      contents || links ? node('aside', 'reference-aside', contents, links) : null));
}

function statusPage(title, description, action) {
  return node('div', 'frame page-view', pageHeading(title, description, action));
}

function requestedDetail(catalog, target, search) {
  if (!target.id) return null;
  const records = target.view === 'read' ? catalog.chapters : catalog[target.view];
  const record = records.find((item) => item.id === target.id);
  if (isReference(target)) return { record, url: `/api/entries/${target.id}${search}` };
  return record ? { record, url: `/api/chapters/${record.id}` } : null;
}

function jumpToSection() {
  if (!route.section) return;
  const target = [...main.querySelectorAll('[data-section]')].find((heading) => heading.dataset.section === route.section);
  const appendix = target?.closest('details');
  if (appendix) appendix.open = true;
  target?.scrollIntoView();
}

function render({ navigation = false, revealSection = false } = {}) {
  const scrollPosition = window.scrollY;
  const searchInFocus = main.contains(document.activeElement) && document.activeElement.dataset.collectionSearch;
  const searchSelection = searchInFocus ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  unmountReader?.();
  unmountReader = null;
  closePreviews();
  const archive = document.body.classList.toggle('archive-mode', route.view === 'archives');
  document.querySelector('.site-footer-context').textContent = archive ? '档案室' : '小说阅读站';
  for (const navLink of document.querySelectorAll('.site-nav a')) {
    if (navLink.dataset.view === route.view) navLink.setAttribute('aria-current', 'page');
    else navLink.removeAttribute('aria-current');
  }

  const search = archiveSearch(catalogCache?.data.chapters ?? []);
  const catalog = catalogCache?.url === `/api/catalog${search}` ? catalogCache.data : null;
  const terms = catalog?.terms.map((term) => archive && term.collection === 'settings' ? { ...term, collection: 'archives' } : term);
  termsByName = new Map(terms?.map((term) => [term.name, term]));
  const requested = catalog && requestedDetail(catalog, route, search);
  const data = requested?.url === detailCache?.url ? detailCache?.data : undefined;
  let view;
  let title;
  if (!catalog) {
    view = statusPage('正在读取…');
  } else if (route.view === 'home') {
    view = home(catalog);
  } else if (data?.locked) {
    view = statusPage('这条记录涉及后续内容', '条目随阅读进度开放。', spoilerControl(true));
  } else if (requested?.record && data) {
    title = data.title || requested.record.title;
    if (route.view === 'read') {
      unmountReader = mountReader(main, { chapter: requested.record, bodyTitle: data.title, chapters: catalog.chapters, closePreviews,
        markdown: renderMarkdown(data.markdown, termIndex(catalog.terms, undefined, route.id),
          (href) => resolveRoute(catalog, href), data.illustrations),
        archiveUpdates: chapterArchiveUpdates(catalog, requested.record),
        onChapterComplete: () => queueMicrotask(() => {
          if (route.view === 'read' && route.id === requested.record.id) refresh(true);
        }) });
    } else {
      view = (archive ? archiveEntryPage : settingEntryPage)(requested.record, data, catalog, terms);
    }
  } else if (route.id || route.view === 'missing') {
    const loading = requested && data === undefined;
    const target = isReference(route) ? entryHref(route.view, '', '', route.from) : route.view === 'read' ? '#/read' : '#/';
    view = loading ? statusPage('正在读取…')
      : statusPage('此内容当前不可阅读', '可返回目录查看当前可读内容。', link('返回目录', target, 'button quiet'));
  } else if (route.view === 'read') {
    title = '章节目录';
    view = chapterDirectory(catalog.chapters);
  } else {
    title = route.view === 'settings' ? '设定集' : '档案室';
    view = route.view === 'archives' ? archiveDirectory(catalog) : settingDirectory(catalog);
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
  if (cached?.url !== url) cached = undefined;
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
    const search = archiveSearch(catalogCache?.data.chapters ?? []);
    let nextCatalog = await getUpdate(`/api/catalog${search}`, catalogCache, signal);
    if (signal.aborted) return;
    if (!nextCatalog.data) throw new Error('找不到目录');
    const currentSearch = archiveSearch(nextCatalog.data.chapters);
    if (currentSearch !== search) nextCatalog = await getUpdate(`/api/catalog${currentSearch}`, catalogCache, signal);
    if (signal.aborted) return;
    if (!nextCatalog.data) throw new Error('找不到目录');
    const requested = requestedDetail(nextCatalog.data, route, currentSearch);
    const previousDetail = requested?.url === detailCache?.url ? detailCache : undefined;
    const nextDetail = requested ? await getUpdate(requested.url, previousDetail, signal) : undefined;
    if (signal.aborted) return;

    const changed = catalogCache !== nextCatalog || detailCache !== nextDetail;
    catalogCache = nextCatalog;
    detailCache = nextDetail;
    if (changed) render({ revealSection: !previousDetail?.data && Boolean(nextDetail?.data) });
  } catch {
    if (signal.aborted) return;
    if (!catalogCache || catalogCache.url !== `/api/catalog${archiveSearch(catalogCache.data.chapters)}`) {
      main.replaceChildren(statusPage('暂时无法读取内容', '站点会自动重试。'));
    }
  } finally {
    if (activeSync === task) activeSync = undefined;
  }
}

document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  main.focus();
});

spoilerDialog.querySelector('[data-cancel]').addEventListener('click', () => spoilerDialog.close());
spoilerDialog.querySelector('[data-confirm]').addEventListener('click', () => {
  spoilerDialog.close();
  setSpoilers(true);
});

window.addEventListener('hashchange', () => {
  const previous = route;
  route = readRoute();
  if (spoilerDialog.open) spoilerDialog.close();
  if (!isReference(previous) || !isReference(route) || previous.from !== route.from) showSpoilers = false;
  if (previous.view === route.view && previous.id === route.id && previous.from === route.from
    && previous.section !== route.section && route.section) {
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
