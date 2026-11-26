import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const archiveDirectory = '档案室';
const archiveCategories = new Set(['term', 'character', 'zone', 'phenomenon', 'ability', 'clue', 'other']);
const chapterStatuses = new Set(['草稿', '待审稿', '定稿']);
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const chapterPrefix = /^第\s*[\d一二两三四五六七八九十百千零〇]+\s*章[\s｜·：:、-]*/;

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
  const match = cell.match(new RegExp(`^(?:第\\s*)?(\\d+|[一二两三四五六七八九十百千零〇]+)\\s*${unit}?$`));
  return match ? numeral(match[1]) : NaN;
}

function chapterIdentity(volumeName, chapterName) {
  const volumeNumber = ordinal(volumeName, '卷');
  const chapterNumber = ordinal(chapterName, '章');
  if (!Number.isSafeInteger(volumeNumber) || !Number.isSafeInteger(chapterNumber)) return null;
  const digits = String(chapterNumber).padStart(3, '0');
  const volume = volumeName.endsWith('卷') ? volumeName : `第${volumeNumber}卷`;
  return { id: `v${volumeNumber}-c${digits}`, volume, volumeNumber, chapterNumber, label: `第${digits}章` };
}

function parseChapterIndex(markdown) {
  const chapters = new Map();
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

    const chapter = chapterIdentity(cells[0], cells[1]);
    if (!chapter) continue;
    const duplicate = chapters.has(chapter.id);
    chapters.set(chapter.id, null);
    const status = cells[3];
    if (duplicate || !chapterStatuses.has(status)) continue;
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
      || segments.some((segment) => !segment || segment.startsWith('.') || segment === '历史稿'
        || segment === archiveDirectory || /[:?#\0]/.test(segment))) continue;

    const title = chapterLink[1].trim().replace(chapterPrefix, '') || chapter.label;
    chapters.set(chapter.id, { ...chapter, title, status, segments });
  }
  return chapters;
}

async function listDirectory(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

async function discoverChapters(root, index) {
  const volumes = (await listDirectory(root)).filter((directory) => directory.isDirectory() && /^第.+卷$/.test(directory.name));
  const files = await Promise.all(volumes.map((volume) => listDirectory(path.join(root, volume.name))));
  const chapters = new Map(index);
  for (const [position, volume] of volumes.entries()) {
    for (const file of files[position]) {
      if (!file.isFile() || !/^第.+章\.md$/i.test(file.name)) continue;
      const chapter = chapterIdentity(volume.name, file.name.slice(0, -3));
      if (!chapter || index.has(chapter.id)) continue;
      const segments = [volume.name, file.name];
      chapters.set(chapter.id, chapters.has(chapter.id) ? null : { ...chapter, segments, status: '草稿', title: chapter.label });
    }
  }
  return chapters;
}

function readChapter(raw, fallbackTitle) {
  if (!raw?.trim()) return null;
  const heading = raw.match(/^\s*#[ \t]+(.+?)[ \t]*(?:\r?\n|$)/);
  const title = heading?.[1].replace(chapterPrefix, '').trim();
  const markdown = (heading ? raw.slice(heading[0].length) : raw).trim();
  return markdown ? { title: title || fallbackTitle, markdown } : null;
}

function archiveBlocks(markdown) {
  const blocks = [];
  let lines = [];
  let after;
  function save(unlock) {
    const body = lines.join('\n').trim();
    if (body) blocks.push({ after: unlock, markdown: body });
    lines = [];
  }
  for (const line of markdown.split(/\r?\n/)) {
    const opening = line.trim().match(/^<!--\s*after:\s*(\S+)\s*-->$/);
    if (opening) {
      save();
      after = opening[1];
    } else if (line.trim() === '<!-- /after -->') {
      save(after);
      after = undefined;
    } else {
      lines.push(line);
    }
  }
  save();
  return blocks;
}

function parseArchive(raw, id) {
  const header = raw?.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!header) return null;
  const fields = new Map();
  const definitions = [];
  const summaries = [];
  let field;
  for (const line of header[1].split(/\r?\n/)) {
    const pair = line.match(/^([a-z]+):[ \t]*(.*)$/);
    if (pair) {
      field = pair[1];
      fields.set(field, pair[2].trim());
    } else if (/^\s+-\s+/.test(line)) {
      const parts = line.replace(/^\s+-\s+/, '').split('|').map((value) => value.trim());
      if (field === 'terms') {
        const [name, definition, section = '', after] = parts;
        if (name && definition) definitions.push({ name, definition, section, after });
      } else if (field === 'summaries') {
        const [after, summary] = parts;
        if (after && summary) summaries.push({ after, summary });
      }
    }
  }

  const title = fields.get('title');
  const summary = fields.get('summary');
  const category = fields.get('category');
  const markdown = raw.slice(header[0].length).trim();
  if (!title || !summary || !archiveCategories.has(category) || !markdown) return null;

  const record = { id, title, summary, category, collection: 'archives', code: fields.get('code') ?? '' };
  return { record, after: fields.get('after'), blocks: archiveBlocks(markdown), summaries, definitions };
}

function archiveVisibility(chapters, { through, spoilers } = {}) {
  const order = new Map(chapters.map(({ id }, index) => [id, index]));
  const boundary = order.get(through) ?? -1;
  return (after) => spoilers || after === 'opening' || (order.get(after) ?? Infinity) <= boundary;
}

function visibleArchive(archive, canRead) {
  if (!canRead(archive.after)) return null;

  const blocks = archive.blocks.filter(({ after }) => canRead(after));
  const summaries = archive.summaries.filter(({ after }) => canRead(after));
  const definitions = archive.definitions.filter(({ after }) => canRead(after));
  const markdown = blocks.map(({ markdown }) => markdown).join('\n\n');
  const someBlocksHidden = blocks.length < archive.blocks.length;
  const headings = someBlocksHidden ? new Set([...markdown.matchAll(/^\s*#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/gm)]
    .map((heading) => heading[1])) : null;
  const record = { ...archive.record, summary: summaries.at(-1)?.summary ?? archive.record.summary };
  return {
    record,
    markdown,
    definitions: [{ name: record.title, definition: record.summary, section: '' },
      ...definitions.map(({ name, definition, section }) => ({ name, definition,
        section: headings && !headings.has(section) ? '' : section }))],
    hasSpoilers: someBlocksHidden || summaries.length < archive.summaries.length || definitions.length < archive.definitions.length,
  };
}

function markdownReader(root) {
  const cache = new Map();
  return async (segments) => {
    const key = path.join(...segments);
    try {
      const directory = await realpath(root);
      const file = await realpath(path.join(directory, key));
      const relative = path.relative(directory, file);
      const location = relative.split(path.sep);
      if (path.isAbsolute(relative) || location.some((segment) => segment.startsWith('.') || segment === '历史稿')
        || (segments[0] === archiveDirectory ? relative !== key : location.includes(archiveDirectory))) return null;

      const info = await stat(file);
      if (!info.isFile()) return null;
      const version = `${info.mtimeMs}/${info.ctimeMs}/${info.size}`;
      const cached = cache.get(key);
      if (cached?.file === file && cached.version === version) return cached.raw;
      const raw = await readFile(file, 'utf8');
      cache.set(key, { file, version, raw });
      return raw;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        cache.delete(key);
        return null;
      }
      throw error;
    }
  };
}

export function contentSource(projectRoot) {
  const chapterRoot = path.join(projectRoot, '正文');
  const readMarkdown = markdownReader(chapterRoot);
  let indexSource;
  let indexedChapters = new Map();

  async function chapterIndex() {
    const source = await readMarkdown(['README.md']);
    if (source !== indexSource) {
      indexedChapters = parseChapterIndex(source ?? '');
      indexSource = source;
    }
    return discoverChapters(chapterRoot, indexedChapters);
  }

  async function archive(id) {
    if (!slugPattern.test(id)) return null;
    return parseArchive(await readMarkdown([archiveDirectory, `${id}.md`]), id);
  }

  async function publicChapters() {
    const ordered = [...(await chapterIndex()).values()].filter(Boolean)
      .sort((first, second) => first.volumeNumber - second.volumeNumber || first.chapterNumber - second.chapterNumber);
    const chapters = await Promise.all(ordered.map(async ({ segments, chapterNumber, ...chapter }) => {
      const body = readChapter(await readMarkdown(segments), chapter.title);
      return body && { ...chapter, title: body.title };
    }));
    return chapters.filter(Boolean);
  }

  async function readArchives() {
    const files = await listDirectory(path.join(chapterRoot, archiveDirectory));
    const ids = files.filter((file) => file.isFile() && file.name.endsWith('.md')).map((file) => file.name.slice(0, -3)).sort();
    return (await Promise.all(ids.map(archive))).filter(Boolean);
  }

  return {
    async catalog(scope) {
      const [chapters, parsed] = await Promise.all([publicChapters(), readArchives()]);
      const canRead = archiveVisibility(chapters, scope);
      const archives = [];
      const settings = [];
      const terms = new Map();
      const hasSpoilers = { archives: false, settings: false };
      for (const source of parsed) {
        const entry = visibleArchive(source, canRead);
        const isSetting = source.record.category === 'term';
        if (!entry || entry.hasSpoilers) {
          hasSpoilers.archives = true;
          if (isSetting) hasSpoilers.settings = true;
        }
        if (!entry) continue;
        const { record, definitions } = entry;
        archives.push(record);
        if (isSetting) settings.push({ ...record, collection: 'settings' });
        const collection = isSetting ? 'settings' : 'archives';
        for (const definition of definitions) {
          if (!terms.has(definition.name)) terms.set(definition.name, { ...definition, entry: record.id, collection });
        }
      }
      return { chapters, archives, settings, terms: [...terms.values()], hasSpoilers };
    },

    async chapter(id) {
      const chapter = (await chapterIndex()).get(id);
      return chapter ? readChapter(await readMarkdown(chapter.segments), chapter.title) : null;
    },

    async entry(id, scope) {
      const [source, chapters] = await Promise.all([archive(id), scope?.through ? publicChapters() : []]);
      if (!source) return null;
      const entry = visibleArchive(source, archiveVisibility(chapters, scope));
      if (!entry) return { locked: true };
      const { markdown, hasSpoilers } = entry;
      return hasSpoilers ? { markdown, hasSpoilers } : { markdown };
    },
  };
}
