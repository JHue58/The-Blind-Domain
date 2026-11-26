import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createReaderServer } from '../server.mjs';

async function publicationFixture(context) {
  const prefix = path.join(await realpath(tmpdir()), 'mang-yu-publication-');
  const project = await mkdtemp(prefix);
  const server = createReaderServer(project);
  context.after(async () => {
    if (server.listening) {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections?.();
      await closed;
    }
    assert.equal(path.dirname(project), path.dirname(prefix));
    assert.ok(project.startsWith(prefix));
    await rm(project, { recursive: true, force: true });
  });

  async function write(relative, content) {
    const file = path.join(project, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  }

  async function start() {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return (route, tag) => fetch(`http://127.0.0.1:${server.address().port}${route}`,
      { headers: tag ? { 'If-None-Match': tag } : {} });
  }

  return { project, write, start };
}

test('章稿和档案在服务运行中发现、修订和撤下', async (context) => {
  const { project, write, start } = await publicationFixture(context);
  const index = `# 正文索引

| 卷 | 章 | 标题与正文 | 状态 | 版本 | 章末变化或待处理项 |
| --- | --- | --- | --- | --- | --- |
| 第一卷 | 第001章 | [第一章 测试标题](<第一卷/第001章.md>) | **定稿** | v2 | 内部批注 |
| 第一卷 | 第002章 | [待审测试](第一卷/第002章.md) | 待审稿 | v1 | |
| 第一卷 | 第003章 | [草稿测试](第一卷/第003章.md) | 草稿 | v1 | |
| 第一卷 | 第004章 | [历史测试](第一卷/历史稿/第004章.md) | 定稿 | v1 | |
| 第一卷 | 第005章 | [外部测试](%2E%2E/策划/未定.md) | 定稿 | v1 | |
| 第一卷 | 第006章 | [重复测试](第一卷/第006章.md) | 定稿 | v1 | |
| 第一卷 | 第006章 | [重复测试](第一卷/第006章.md) | 待审稿 | v2 | |
| 第一卷 | 第008章 | [缺少文件](第一卷/第008章.md) | 草稿 | v1 | |
`;
  const settingSource = `---
title: 已确认设定
category: term
summary: 测试用释义
after: opening
terms:
  - 术语别名 | 测试用术语 | 细节 | opening
---

<!-- after: opening -->
## 细节

初版公开设定。
<!-- /after -->`;
  await Promise.all([
    write('正文/README.md', index),
    write('正文/第一卷/第001章.md', '# 第001章 测试标题\n\n第一段。'),
    write('正文/第一卷/第002章.md', '待审测试内容'),
    write('正文/第一卷/第003章.md', '草稿测试内容'),
    write('正文/第一卷/历史稿/第004章.md', '历史测试内容'),
    write('正文/第一卷/第006章.md', '重复状态测试内容'),
    write('正文/第一卷/第009章.md', '# 空章稿\n'),
    write('正文/第一卷/备注.md', '卷内备注'),
    write('策划/未定.md', '未公开测试内容'),
    write('正文/档案室/setting.md', settingSource),
    write('正文/档案室/draft.md', '# 缺少档案字段\n\n未登记测试内容。'),
    write('正文/档案室/内部/secret.md', settingSource),
  ]);

  const get = await start();
  const catalog = await get('/api/catalog');
  const publicData = await catalog.json();
  assert.deepEqual(publicData.chapters[0], {
    id: 'v1-c001', volume: '第一卷', volumeNumber: 1, label: '第001章', title: '测试标题', status: '定稿',
  });
  assert.deepEqual(publicData.chapters.map(({ id, status }) => [id, status]), [
    ['v1-c001', '定稿'], ['v1-c002', '待审稿'], ['v1-c003', '草稿'],
  ]);
  assert.deepEqual(publicData.archives.map(({ id }) => id), ['setting']);
  assert.deepEqual(publicData.settings.map(({ id }) => id), ['setting']);
  assert.deepEqual(publicData.terms.find(({ name }) => name === '术语别名'), {
    name: '术语别名', definition: '测试用术语', section: '细节', entry: 'setting', collection: 'settings',
  });
  assert.equal((await get('/api/catalog', catalog.headers.get('etag'))).status, 304);
  for (const route of ['/api/chapters/v1-c004', '/api/chapters/v1-c005', '/api/chapters/v1-c006',
    '/api/chapters/v1-c008', '/api/chapters/v1-c009', '/api/entries/draft', '/api/entries/secret',
    `/${encodeURI('正文/档案室/setting.md')}`, `/${encodeURI('策划/未定.md')}`]) {
    assert.equal((await get(route)).status, 404, route);
  }

  const chapterUrl = '/api/chapters/v1-c001';
  const chapter = await get(chapterUrl);
  assert.deepEqual(await chapter.json(), { title: '测试标题', markdown: '第一段。' });
  assert.equal((await get(chapterUrl, chapter.headers.get('etag'))).status, 304);
  await write('正文/第一卷/第001章.md', '# 第001章 修订测试\n\n第二段。');
  assert.deepEqual(await (await get(chapterUrl, chapter.headers.get('etag'))).json(), { title: '修订测试', markdown: '第二段。' });

  const setting = await get('/api/entries/setting');
  assert.equal((await setting.json()).markdown, '## 细节\n\n初版公开设定。');
  await write('正文/档案室/setting.md', settingSource.replace('初版公开', '新版公开'));
  assert.equal((await (await get('/api/entries/setting', setting.headers.get('etag'))).json()).markdown, '## 细节\n\n新版公开设定。');

  const archiveFile = '正文/档案室/archive.md';
  const archiveSource = `---
title: 测试域闻
category: phenomenon
summary: 档案摘要
code: D-X
after: opening
---

<!-- after: opening -->
档案内容。
<!-- /after -->`;
  await Promise.all([
    write(archiveFile, archiveSource),
    write('正文/第一卷/第007章.md', '# 第七章 新增章\n\n自动发现。'),
    write('正文/第2卷/第十章.md', '# 跨卷章\n\n新增卷。'),
  ]);
  const updated = await (await get('/api/catalog', catalog.headers.get('etag'))).json();
  assert.deepEqual(updated.chapters.map(({ id }) => id), ['v1-c001', 'v1-c002', 'v1-c003', 'v1-c007', 'v2-c010']);
  assert.equal(updated.chapters[0].title, '修订测试');
  assert.equal(updated.chapters[3].status, '草稿');
  assert.equal(updated.chapters[3].title, '新增章');
  assert.equal(updated.archives.find(({ id }) => id === 'archive').code, 'D-X');
  assert.equal(updated.terms.find(({ name }) => name === '测试域闻').collection, 'archives');
  assert.deepEqual(await (await get('/api/chapters/v1-c007')).json(), { title: '新增章', markdown: '自动发现。' });
  assert.equal((await (await get('/api/entries/archive')).json()).markdown, '档案内容。');

  await write('正文/README.md', index.replace('**定稿**', '待审稿'));
  await write(archiveFile, archiveSource.replace('档案摘要', '更新摘要'));
  const revised = await (await get('/api/catalog')).json();
  assert.equal(revised.chapters[0].status, '待审稿');
  assert.equal(revised.terms.find(({ name }) => name === '测试域闻').definition, '更新摘要');

  await rename(path.join(project, '正文/第一卷/第001章.md'), path.join(project, '正文/第一卷/历史稿/第001章.md'));
  await unlink(path.join(project, archiveFile));
  const withdrawn = await (await get('/api/catalog')).json();
  assert.ok(!withdrawn.chapters.some(({ id }) => id === 'v1-c001'));
  assert.ok(!withdrawn.archives.some(({ id }) => id === 'archive'));
  assert.equal((await get(chapterUrl)).status, 404);
  assert.equal((await get('/api/entries/archive')).status, 404);
});

test('档案的标题、摘要、别名和正文随已读章开放，确认剧透后可全部读取', async (context) => {
  const { write, start } = await publicationFixture(context);
  const personFile = '正文/档案室/person.md';
  const person = `---
title: 段舟
category: character
summary: 开篇身份。
after: opening
summaries:
  - v1-c002 | 真正的身份。
  - v2-c001 | 第二卷的身份。
terms:
  - 熟人 | 开篇称呼。 | 后续小节 | opening
  - 另一个名字 | 后续称呼。 | 后续小节 | v1-c002
  - 旧格式别名 | 旧格式释义。
---

<!-- after: v1-c001 -->
第一章记录。
<!-- /after -->

<!-- after: v1-c002 -->
## 后续小节

第二章记录。
<!-- /after -->

没标章节的记录。

<!-- after: opening -->
还没写完公开标记的记录。
`;
  await Promise.all([
    write('正文/第一卷/第001章.md', '# 第一章\n\n段舟是熟人。'),
    write('正文/第一卷/第002章.md', '# 第二章\n\n另一个名字。'),
    write('正文/第二卷/第001章.md', '# 新一卷\n\n第二卷的身份。'),
    write(personFile, person),
    write('正文/档案室/setting.md', `---
title: 后来的设定
category: term
summary: 设定的剧透摘要。
after: v1-c002
---

<!-- after: v1-c002 -->
后来的设定正文。
<!-- /after -->`),
    write('正文/档案室/legacy.md', '---\ntitle: 旧格式档案\ncategory: clue\nsummary: 旧格式摘要\n---\n\n旧格式正文。'),
  ]);
  const get = await start();
  const catalogPath = '/api/catalog';
  const personPath = '/api/entries/person';
  const opening = await (await get(catalogPath)).json();
  assert.deepEqual(opening.archives.map(({ title }) => title), ['段舟']);
  assert.deepEqual(opening.settings, []);
  assert.deepEqual(opening.terms.map(({ name, section }) => [name, section]), [['段舟', ''], ['熟人', '']]);
  assert.equal(opening.terms[0].definition, '开篇身份。');
  assert.deepEqual(await (await get(personPath)).json(), { markdown: '', hasSpoilers: true });
  assert.deepEqual(await (await get('/api/entries/setting')).json(), { locked: true });
  assert.deepEqual(await (await get('/api/entries/legacy')).json(), { locked: true });

  const firstChapter = '?through=v1-c001';
  const first = await get(personPath + firstChapter);
  assert.deepEqual(await first.json(), { markdown: '第一章记录。', hasSpoilers: true });

  await write(personFile, `${person}
<!-- after: v2-c001 -->
第二卷追加记录。
<!-- /after -->`);
  assert.equal((await get(personPath + firstChapter, first.headers.get('ETag'))).status, 304);

  const secondChapter = '?through=v1-c002';
  const second = await (await get(catalogPath + secondChapter)).json();
  assert.equal(second.archives[0].summary, '真正的身份。');
  assert.equal(second.settings[0].title, '后来的设定');
  assert.equal(second.terms.find(({ name }) => name === '另一个名字').section, '后续小节');
  const secondBody = (await (await get(personPath + secondChapter)).json()).markdown;
  assert.match(secondBody, /第一章记录。.*第二章记录。/s);
  assert.doesNotMatch(secondBody, /没标|还没写完|第二卷/);

  const nextVolume = '?through=v2-c001';
  const next = await (await get(catalogPath + nextVolume)).json();
  assert.equal(next.archives[0].summary, '第二卷的身份。');
  assert.match((await (await get(personPath + nextVolume)).json()).markdown, /第二卷追加记录/);
  assert.deepEqual(await (await get(catalogPath + '?through=v3-c009')).json(), opening);

  const full = await (await get(catalogPath + '?spoilers=1')).json();
  assert.deepEqual(full.hasSpoilers, { archives: false, settings: false });
  assert.ok(full.terms.some(({ name }) => name === '旧格式别名'));
  assert.deepEqual(await (await get('/api/entries/legacy?spoilers=1')).json(), { markdown: '旧格式正文。' });
  assert.match((await (await get(personPath + '?spoilers=1')).json()).markdown, /没标章节.*还没写完/s);
});

test('插图跟随原文段落和档案解锁，撤审、改稿或图片替换时停止显示', async (context) => {
  const { write, start } = await publicationFixture(context);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=', 'base64');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const chapterFile = '正文/第一卷/第002章.md';
  const drawingFile = '正文/插图/发布/example-v1.png';
  const registryFile = '正文/插图/索引.json';
  const chapterUrl = '/api/chapters/v1-c002';
  const entryUrl = '/api/entries/place';
  const chapter = '# 第002章 测试图\n\n前一段。\n\n两个人看见一只闸机。\n\n后一段。';
  const registry = {
    'example-v1': {
      status: 'approved', file: 'example-v1.png', sha256, width: 1, height: 1, alt: '闸机的样子', caption: '闸机插图',
      chapter: 'v1-c002', anchor: '两个人看见一只闸机。', inline: true, archives: { place: 'v1-c003' },
    },
    'draft-v1': {
      status: 'draft', file: 'draft-v1.png', sha256, width: 1, height: 1, alt: '草稿的内容', caption: '草稿插图',
      chapter: 'v1-c002', anchor: '两个人看见一只闸机。', inline: true, archives: { place: 'v1-c001' },
    },
  };
  await Promise.all([
    write('正文/第一卷/第001章.md', '# 第001章\n\n第一章内容。'),
    write(chapterFile, chapter),
    write('正文/第一卷/第003章.md', '# 第003章\n\n第三章内容。'),
    write('正文/档案室/place.md', '---\ntitle: 站厅\ncategory: zone\nsummary: 站厅的记录。\nafter: opening\n---\n\n<!-- after: opening -->\n档案正文。\n<!-- /after -->'),
    write(drawingFile, bytes),
    write('正文/插图/发布/draft-v1.png', bytes),
  ]);
  const get = await start();
  const withoutRegistry = await get(chapterUrl);
  const manuscript = await withoutRegistry.json();
  assert.equal(manuscript.illustrations, undefined);
  await write(registryFile, JSON.stringify(registry));

  const added = await get(chapterUrl, withoutRegistry.headers.get('etag'));
  const body = await added.json();
  const chapterImage = `${chapterUrl}/illustrations/example-v1?v=${sha256}`;
  const archiveImage = `${entryUrl}/illustrations/example-v1?v=${sha256}`;
  assert.equal(body.markdown, manuscript.markdown);
  assert.deepEqual(body.illustrations, [{ url: chapterImage, width: 1, height: 1, alt: '闸机的样子',
    caption: '闸机插图', anchor: '两个人看见一只闸机。' }]);
  assert.equal((await get(chapterUrl, added.headers.get('etag'))).status, 304);
  const image = await get(chapterImage);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  assert.equal((await get(chapterImage, image.headers.get('etag'))).status, 304);

  for (const search of ['', '?through=v1-c001', '?through=v1-c002']) {
    assert.deepEqual(await (await get(entryUrl + search)).json(), { markdown: '档案正文。', hasSpoilers: true });
    const scope = search.replace('?', '&');
    assert.equal((await get(archiveImage + scope)).status, 404);
  }
  for (const scope of ['through=v1-c003', 'spoilers=1']) {
    const entry = await (await get(`${entryUrl}?${scope}`)).json();
    assert.deepEqual(entry.illustrations, [{ url: `${archiveImage}&${scope}`, width: 1, height: 1,
      alt: '闸机的样子', caption: '闸机插图' }]);
    assert.equal((await get(entry.illustrations[0].url)).status, 200);
    assert.equal(entry.hasSpoilers, undefined);
  }
  assert.doesNotMatch(await (await get('/api/catalog?spoilers=1')).text(), /闸机插图|example-v1/);
  for (const route of [`${chapterUrl}/illustrations/draft-v1?v=${sha256}`, `${entryUrl}/illustrations/draft-v1?v=${sha256}&spoilers=1`,
    `/api/chapters/v1-c001/illustrations/example-v1?v=${sha256}`, `/${encodeURI(drawingFile)}`, '/assets/example-v1.png']) {
    assert.equal((await get(route)).status, 404, route);
  }

  for (const changedChapter of [chapter.replace('一只闸机', '一扇门'), `${chapter}\n\n两个人看见一只闸机。`]) {
    await write(chapterFile, changedChapter);
    assert.equal((await (await get(chapterUrl)).json()).illustrations, undefined);
    assert.equal((await get(`${archiveImage}&spoilers=1`)).status, 404);
  }
  await write(chapterFile, chapter);
  await write(drawingFile, Buffer.concat([bytes, Buffer.from([0])]));
  assert.deepEqual(await (await get(chapterUrl)).json(), manuscript);
  assert.equal((await get(chapterImage)).status, 404);
  await write(drawingFile, bytes);
  assert.equal((await get(chapterImage)).status, 200);
  for (const state of ['{', JSON.stringify({ 'example-v1': { ...registry['example-v1'], status: 'withdrawn' } })]) {
    await write(registryFile, state);
    assert.deepEqual(await (await get(chapterUrl)).json(), manuscript);
    assert.equal((await get(chapterImage)).status, 404);
  }
});
