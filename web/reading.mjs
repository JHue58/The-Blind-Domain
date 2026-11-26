import { button, link, node } from './markup.mjs';

const storageKey = 'mang-yu-reading-v1';
const emptyBookmark = { block: 0, offset: 0, excerpt: '', progress: 0 };

function loadReadingState() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    return {
      mode: saved?.mode === 'pages' ? 'pages' : 'scroll',
      last: typeof saved?.last === 'string' ? saved.last : null,
      bookmarks: saved?.bookmarks && typeof saved.bookmarks === 'object' ? saved.bookmarks : {},
    };
  } catch {
    return { mode: 'scroll', last: null, bookmarks: {} };
  }
}

const reading = loadReadingState();

function saveReadingState() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(reading));
  } catch {
    // Reading continues with the current position when browser storage is unavailable.
  }
}

export function lastChapter(chapters) {
  return chapters.find((chapter) => chapter.id === reading.last);
}

export function chapterBookmark(chapter) {
  return reading.bookmarks[chapter.id];
}

export function chapterHref(chapter) {
  return `#/read/${chapter.id}`;
}

export function chapterTitle(chapter) {
  return chapter.title === chapter.label ? chapter.label : `${chapter.label}　${chapter.title}`;
}

function textBlocks(article) {
  let length = 0;
  const blocks = [];
  for (const element of article.querySelectorAll('p, h2, h3, h4, h5, h6, li, td')) {
    const cursor = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const pieces = [];
    let end = 0;
    for (let part = cursor.nextNode(); part; part = cursor.nextNode()) {
      if (!part.length) continue;
      pieces.push({ part, start: end });
      end += part.length;
    }
    if (end > 0) {
      blocks.push({ pieces, size: end, start: length, excerpt: element.textContent.slice(0, 44) });
      length += end;
    }
  }
  return { blocks, length };
}

function lowerBound(length, matches) {
  let start = 0;
  let end = length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (matches(middle)) end = middle;
    else start = middle + 1;
  }
  return start;
}

function clamp(value, lowest, highest) {
  return Math.min(highest, Math.max(lowest, value));
}

export function mountReader(main, { chapter, markdown, bodyTitle, chapters, closePreviews }) {
  const title = bodyTitle || chapter.title;
  const scroll = button('滚动', 'mode-button');
  const pages = button('翻页', 'mode-button');
  const modes = node('div', 'mode-switch', scroll, pages);
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', '阅读方式');
  const percentage = node('span', 'reader-percent');
  const meter = node('progress', 'reader-meter');
  meter.max = 1;
  meter.setAttribute('aria-label', '本章阅读进度');
  const toolbar = node('div', 'reader-toolbar', node('div', 'reader-actions',
    link('章节目录', '#/read', 'text-link reader-directory'), node('div', 'reader-options', percentage, modes)), meter);

  const article = node('article', 'chapter-body prose', markdown);
  const viewport = node('div', 'page-window', article);
  const chapterLabel = title === chapter.label ? chapter.volume : `${chapter.volume} / ${chapter.label}`;
  const heading = node('header', 'chapter-heading', node('p', 'eyebrow', chapterLabel), node('h1', '', title));
  const previousPage = button('上一页', 'button quiet');
  const nextPage = button('下一页', 'button quiet');
  const pageLabel = node('span', 'page-label');
  pageLabel.setAttribute('aria-live', 'polite');
  const pagination = node('div', 'page-controls', previousPage, pageLabel, nextPage);

  const book = node('div', 'reader-book', heading, viewport, pagination);
  const index = chapters.findIndex((item) => item.id === chapter.id);
  const previous = chapters[index - 1];
  const next = chapters[index + 1];
  const chapterNav = node('nav', 'chapter-nav',
    previous ? link(`上一章 · ${chapterTitle(previous)}`, chapterHref(previous), 'text-link') : null,
    next ? link(`下一章 · ${chapterTitle(next)}`, chapterHref(next), 'text-link next-chapter') : null);
  chapterNav.setAttribute('aria-label', '相邻章节');
  if (previous || next) book.append(chapterNav);
  main.replaceChildren(node('div', 'reader frame', toolbar, book));

  const { blocks, length } = textBlocks(article);
  const range = document.createRange();
  const events = new AbortController();
  const { signal } = events;
  let mode = reading.mode;
  let place = chapterBookmark(chapter) ?? emptyBookmark;
  let page = 0;
  let pageCount = 1;
  let stride = 0;
  let scrollTimer;
  let resizeFrame;
  let restoredScroll = null;

  function measure(block, offset) {
    const index = clamp(offset, 0, block.size - 1);
    const piece = block.pieces[lowerBound(block.pieces.length, (i) => block.pieces[i].start > index) - 1];
    const localOffset = index - piece.start;
    range.setStart(piece.part, localOffset);
    range.setEnd(piece.part, localOffset + 1);
    return range.getBoundingClientRect();
  }

  function findPlace(predicate) {
    if (!length) return { ...emptyBookmark };
    const index = lowerBound(blocks.length, (i) => predicate(measure(blocks[i], blocks[i].size - 1)));
    const block = blocks[Math.min(index, blocks.length - 1)];
    const offset = index < blocks.length ? lowerBound(block.size, (i) => predicate(measure(block, i))) : block.size;
    return {
      block: Math.min(index, blocks.length - 1), offset, excerpt: block.excerpt,
      progress: (block.start + offset) / length,
    };
  }

  function rectForPlace() {
    if (!length) return null;
    const index = clamp(Number.isInteger(place.block) ? place.block : 0, 0, blocks.length - 1);
    let matched = index;
    if (place.excerpt && blocks[index].excerpt !== place.excerpt) {
      let closest = Infinity;
      for (const [candidate, block] of blocks.entries()) {
        const distance = Math.abs(candidate - index);
        if (block.excerpt === place.excerpt && distance < closest) {
          matched = candidate;
          closest = distance;
        }
      }
    }
    return measure(blocks[matched], Number.isInteger(place.offset) ? place.offset : 0);
  }

  function record() {
    reading.last = chapter.id;
    reading.bookmarks[chapter.id] = place;
    saveReadingState();
  }

  function showProgress(value) {
    const ratio = clamp(value, 0, 1);
    meter.value = ratio;
    percentage.textContent = `${Math.round(ratio * 100)}%`;
  }

  function recordScroll() {
    if (mode !== 'scroll') return;
    if (restoredScroll !== null && Math.abs(window.scrollY - restoredScroll) < 2) return;
    restoredScroll = null;
    const readingLine = toolbar.getBoundingClientRect().bottom + 8;
    place = findPlace((rect) => rect.bottom > readingLine);
    const endVisible = article.getBoundingClientRect().bottom <= window.innerHeight;
    if (endVisible && window.scrollY > 0) place.progress = 1;
    showProgress(place.progress);
    record();
  }

  function pageForRect(rect) {
    return Math.floor((rect.left - viewport.getBoundingClientRect().left + viewport.scrollLeft + 1) / stride);
  }

  function showPage(index) {
    page = clamp(index, 0, pageCount - 1);
    viewport.scrollLeft = page * stride;
    previousPage.disabled = page === 0;
    nextPage.disabled = page === pageCount - 1;
    pageLabel.textContent = `${page + 1} / ${pageCount} 页`;
    showProgress((page + 1) / pageCount);

    const visible = viewport.getBoundingClientRect();
    for (const trigger of article.querySelectorAll('a, button')) {
      const onPage = Array.from(trigger.getClientRects()).some((rect) => rect.right > visible.left + 1 && rect.left < visible.right - 1);
      trigger.tabIndex = onPage ? 0 : -1;
    }
  }

  function paginate() {
    const width = viewport.clientWidth;
    const gap = parseFloat(getComputedStyle(article).columnGap);
    const top = viewport.getBoundingClientRect().top + window.scrollY;
    const height = Math.max(192, window.innerHeight - top - pagination.getBoundingClientRect().height - 30);
    article.style.setProperty('--page-width', `${width}px`);
    article.style.setProperty('--page-height', `${Math.floor(height)}px`);
    stride = width + gap;
    pageCount = Math.max(1, Math.ceil((article.scrollWidth - width - 1) / stride) + 1);
    const rect = rectForPlace();
    showPage(rect ? pageForRect(rect) : 0);
  }

  function turn(direction) {
    if (mode !== 'pages' || page + direction < 0 || page + direction >= pageCount) return;
    closePreviews();
    showPage(page + direction);
    place = findPlace((rect) => pageForRect(rect) >= page);
    if (page === pageCount - 1) place.progress = 1;
    const pageTop = viewport.getBoundingClientRect().top;
    const toolbarBottom = toolbar.getBoundingClientRect().bottom;
    if (pageTop < toolbarBottom + 8) window.scrollBy(0, pageTop - toolbarBottom - 8);
    record();
  }

  function restoreMode() {
    book.dataset.mode = mode;
    pagination.hidden = mode !== 'pages';
    scroll.setAttribute('aria-pressed', String(mode === 'scroll'));
    pages.setAttribute('aria-pressed', String(mode === 'pages'));
    window.scrollTo(0, 0);
    if (mode === 'pages') {
      paginate();
    } else {
      for (const trigger of article.querySelectorAll('a, button')) trigger.removeAttribute('tabindex');
      viewport.scrollLeft = 0;
      const rect = rectForPlace();
      if (rect && (place.block > 0 || place.offset > 0)) {
        window.scrollBy(0, rect.top - toolbar.getBoundingClientRect().bottom - 14);
      }
      restoredScroll = window.scrollY;
      showProgress(place.progress || 0);
    }
    record();
  }

  function switchMode(newMode) {
    if (mode === newMode) return;
    clearTimeout(scrollTimer);
    scrollTimer = undefined;
    recordScroll();
    closePreviews();
    reading.mode = mode = newMode;
    restoreMode();
  }

  scroll.addEventListener('click', () => switchMode('scroll'));
  pages.addEventListener('click', () => switchMode('pages'));
  previousPage.addEventListener('click', () => turn(-1));
  nextPage.addEventListener('click', () => turn(1));
  document.addEventListener('keydown', (event) => {
    if (mode !== 'pages' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented
      || event.target.closest('input, select, textarea, [contenteditable]') || window.getSelection()?.toString()) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      turn(event.key === 'ArrowLeft' ? -1 : 1);
    }
  }, { signal });
  window.addEventListener('resize', () => {
    if (mode !== 'pages') return;
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(paginate);
  }, { signal });
  restoreMode();
  window.addEventListener('scroll', () => {
    if (mode !== 'scroll' || scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = undefined;
      recordScroll();
    }, 90);
  }, { passive: true, signal });
  window.addEventListener('pagehide', recordScroll, { signal });

  return () => {
    recordScroll();
    clearTimeout(scrollTimer);
    cancelAnimationFrame(resizeFrame);
    events.abort();
  };
}
