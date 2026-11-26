import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createReaderServer } from '../server.mjs';

test('章稿和档案在服务运行中发现、修订和撤下', async (context) => {
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
terms:
  - 术语别名 | 测试用术语 | 细节
---

## 细节

初版公开设定。`;
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

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const get = (route, tag) => fetch(`http://127.0.0.1:${server.address().port}${route}`,
    { headers: tag ? { 'If-None-Match': tag } : {} });
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
  const archiveSource = '---\ntitle: 测试域闻\ncategory: phenomenon\nsummary: 档案摘要\ncode: D-X\n---\n\n档案内容。';
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
