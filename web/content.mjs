import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const archiveCategories = new Set(['character', 'zone', 'phenomenon', 'other']);
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function numeral(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = '零一二三四五六七八九';
  const units = { 十: 10, 百: 100, 千: 1000 };
  const normalized = value.replaceAll('〇', '零').replaceAll('两', '二');
  if (!/[十百千]/.test(normalized)) {
    return Number(Array.from(normalized, (digit) => digits.indexOf(digit)).join(''));
  }
  let result = 0;
  let digit = 0;
  for (const character of normalized) {
    if (units[character]) {
      result += (digit || 1) * units[character];
      digit = 0;
    } else {
      digit = digits.indexOf(character);
    }
  }
  return result + digit;
}

function ordinal(cell, unit) {
  const match = cell.match(new RegExp(`^(?:第\\s*)?([\\d一二两三四五六七八九十百千零〇]+)\\s*${unit}?$`));
  return match ? numeral(match[1]) : NaN;
}

function parseChapterIndex(markdown) {
  const chapters = new Map();
  const seen = new Set();
  let inIndex = false;
  for (const line of markdown.split(/\r?\n/)) {
    const row = line.trim();
    if (!row.startsWith('|')) {
      if (inIndex) break;
      continue;
    }
    const cells = row.slice(1).replace(/\|$/, '').split(/(?<!\\)\|/)
      .map((cell) => cell.trim().replace(/^\*\*(.+)\*\*$/, '$1').replace(/\\\|/g, '|'));
    if (cells[0] === '卷' && cells[1] === '章' && cells[3] === '状态') {
      inIndex = true;
      continue;
    }
    if (!inIndex || cells.length < 4) continue;

    const volumeNumber = ordinal(cells[0], '卷');
    const chapterNumber = ordinal(cells[1], '章');
    if (!Number.isSafeInteger(volumeNumber) || !Number.isSafeInteger(chapterNumber)) continue;
    const chapterDigits = String(chapterNumber).padStart(3, '0');
    const id = `v${volumeNumber}-c${chapterDigits}`;
    if (seen.has(id)) {
      chapters.delete(id);
      continue;
    }
    seen.add(id);
    if (cells[3] !== '定稿') continue;
    const chapterLink = cells[2].match(/\[([^\]]+)\]\(\s*(?:<([^>]+)>|([^)]*?))\s*\)/);
    if (!chapterLink) continue;

    let file;
    try {
      file = decodeURIComponent(chapterLink[2] ?? chapterLink[3]).replaceAll('\\', '/');
    } catch {
      continue;
    }
    const segments = file.replace(/^\.\//, '').split('/');
    const fileName = segments.at(-1);
    if (!fileName.toLowerCase().endsWith('.md') || fileName.toLowerCase() === 'readme.md'
      || segments.some((segment) => !segment || segment.startsWith('.') || segment === '历史稿' || /[:?#\0]/.test(segment))) continue;

    const label = `第${chapterDigits}章`;
    const volume = /卷$/.test(cells[0]) ? cells[0] : `第${volumeNumber}卷`;
    const title = chapterLink[1].trim().replace(/^第\s*[\d一二两三四五六七八九十百千零〇]+\s*章[\s｜·：:、-]*/, '') || label;
    chapters.set(id, { id, volume, volumeNumber, label, title, segments });
  }
  return chapters;
}

function parseManifest(raw) {
  const manifest = JSON.parse(raw.replace(/^\uFEFF/, ''));
  const entries = new Map();
  const subjects = ['settings', 'archives'];
  for (const collection of subjects) {
    for (const record of manifest[collection]) {
      const { id } = record;
      const title = text(record.title);
      const summary = text(record.summary);
      const category = text(record.category);
      if (!slugPattern.test(id) || typeof id !== 'string' || entries.has(id) || !title || !summary
        || (collection === 'archives' && !archiveCategories.has(category))) {
        throw new Error('条目目录包含无效或重复的记录');
      }
      entries.set(id, { id, title, summary, category, collection, code: text(record.code) });
    }
  }

  const terms = new Map();
  for (const record of manifest.terms) {
    const name = text(record.name);
    const definition = text(record.definition);
    const entry = record.entry ? entries.get(record.entry) : null;
    if (!name || !definition || terms.has(name) || (record.entry && !entry)) {
      throw new Error('术语目录包含无效或重复的记录');
    }
    terms.set(name, { name, definition, entry: entry?.id, collection: entry?.collection, section: text(record.section) });
  }
  return { entries, terms: [...terms.values()] };
}

async function readMarkdownWithin(root, segments) {
  try {
    const directory = await realpath(root);
    const file = await realpath(path.join(directory, ...segments));
    const relative = path.relative(directory, file);
    if (path.isAbsolute(relative) || relative.split(path.sep).some((segment) => segment === '..' || segment === '历史稿')
      || !(await stat(file)).isFile()) return null;
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

export function contentSource(projectRoot) {
  const chapterRoot = path.join(projectRoot, '正文');
  const contentRoot = path.join(projectRoot, 'web', 'content');
  let lastIndex;
  let chapters;
  let lastManifest;
  let publication;

  async function chapterIndex() {
    const source = await readFile(path.join(chapterRoot, 'README.md'), 'utf8');
    if (source !== lastIndex) {
      chapters = parseChapterIndex(source);
      lastIndex = source;
    }
    return chapters;
  }

  async function publicEntries() {
    const source = await readFile(path.join(contentRoot, 'catalog.json'), 'utf8');
    if (source !== lastManifest) {
      publication = parseManifest(source);
      lastManifest = source;
    }
    return publication;
  }

  return {
    async catalog() {
      const [index, { entries, terms }] = await Promise.all([chapterIndex(), publicEntries()]);
      const records = [...entries.values()];
      return {
        chapters: [...index.values()].map(({ segments, ...chapter }) => chapter),
        settings: records.filter((entry) => entry.collection === 'settings'),
        archives: records.filter((entry) => entry.collection === 'archives'),
        terms,
      };
    },

    async chapter(id) {
      const chapter = (await chapterIndex()).get(id);
      if (!chapter) return null;
      const raw = await readMarkdownWithin(chapterRoot, chapter.segments);
      if (!raw?.trim()) return null;

      const heading = raw.match(/^\s*#\s+(.+?)[ \t]*(?:\r?\n|$)/);
      const title = heading?.[1].replace(/^第\s*[\d一二两三四五六七八九十百千零〇]+\s*章[\s｜·：:、-]*/, '').trim();
      const markdown = (heading ? raw.slice(heading[0].length) : raw).trim();
      return markdown ? { title: title || chapter.title, markdown } : null;
    },

    async entry(id) {
      const { entries } = await publicEntries();
      if (!entries.has(id)) return null;
      const markdown = await readMarkdownWithin(path.join(contentRoot, 'entries'), [`${id}.md`]);
      return markdown?.trim() ? { markdown } : null;
    },
  };
}
