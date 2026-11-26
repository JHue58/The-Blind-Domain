import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const illustrationDirectory = '插图';
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const chapterId = /^v\d+-c\d{3,}$/;
const types = new Map([['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp']]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function parseRegistry(raw) {
  let index;
  try {
    index = JSON.parse(raw ?? 'null');
  } catch {
    return [];
  }
  if (!object(index)) return [];

  const drawings = [];
  for (const [id, row] of Object.entries(index)) {
    if (!slug.test(id) || !object(row) || row.status !== 'approved') continue;
    const { file, sha256, width, height, alt, caption, chapter, anchor, inline, archives } = row;
    const extension = typeof file === 'string' ? path.extname(file) : '';
    const type = types.get(extension);
    if (!type || file !== `${id}${extension}` || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)
      || ![width, height].every((size) => Number.isSafeInteger(size) && size > 0)
      || ![alt, caption, anchor].every((value) => typeof value === 'string' && value.trim())
      || typeof chapter !== 'string' || !chapterId.test(chapter)) continue;
    const entries = new Map(Object.entries(object(archives) ? archives : {}).filter(([entry, after]) =>
      slug.test(entry) && typeof after === 'string' && (after === 'opening' || after === 'spoiler' || chapterId.test(after))));
    drawings.push({ id, file, sha256, width, height, alt, caption, chapter, anchor, inline: inline === true, entries, type });
  }
  return drawings;
}

export function manuscriptParagraphs(markdown) {
  return (markdown ?? '').split(/\r?\n(?:[^\S\r\n]*\r?\n)+/)
    .map((paragraph) => paragraph.split(/\r?\n/).map((line) => line.trim()).join('\n'));
}

export function containsAnchor(paragraphs, anchor) {
  const first = paragraphs.indexOf(anchor);
  return first !== -1 && first === paragraphs.lastIndexOf(anchor);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function missing(error) {
  return ['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(error.code);
}

export function illustrationSource(chapterRoot, readRegistry) {
  let previous;
  let drawings = [];
  const checksums = new Map();

  async function checkedFile(drawing) {
    try {
      const file = path.join(await realpath(chapterRoot), illustrationDirectory, '发布', drawing.file);
      if (await realpath(file) !== file) return null;
      const info = await stat(file);
      if (!info.isFile()) return null;
      const revision = `${info.dev}/${info.ino}/${info.mtimeMs}/${info.ctimeMs}/${info.size}`;
      let check = checksums.get(file);
      if (check?.revision !== revision) {
        check = { revision, sha256: digest(await readFile(file)) };
        checksums.set(file, check);
      }
      return check.sha256 === drawing.sha256 ? { ...drawing, file } : null;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  return {
    async registry() {
      const source = await readRegistry();
      if (source !== previous) {
        drawings = parseRegistry(source);
        previous = source;
        checksums.clear();
      }
      return drawings;
    },

    async files(selected) {
      return (await Promise.all(selected.map(checkedFile))).filter(Boolean);
    },

    async file(drawing) {
      try {
        const bytes = await readFile(drawing.file);
        return digest(bytes) === drawing.sha256 ? { bytes, type: drawing.type } : null;
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
  };
}

export function illustratedDetail(data, drawings, route, scope) {
  const files = new Map(drawings.map((drawing) => [drawing.id, drawing]));
  if (!drawings.length) return { data, files };

  const illustrations = drawings.map(({ id, sha256, width, height, alt, caption, anchor }) => {
    const query = new URLSearchParams({ v: sha256 });
    if (scope?.spoilers) query.set('spoilers', '1');
    else if (scope?.through) query.set('through', scope.through);
    return {
      url: `/api/${route}/illustrations/${id}?${query}`, width, height, alt, caption,
      ...(scope ? {} : { anchor }),
    };
  });
  return { data: { ...data, illustrations }, files };
}
