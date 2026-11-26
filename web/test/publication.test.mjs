import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createReaderServer } from '../server.mjs';

test('只发布当前定稿与公开目录中的条目，运行中可更新和撤回', async (context) => {
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
`;
  const manifest = {
    settings: [{ id: 'setting', title: '已确认设定', summary: '测试用释义', category: '世界' }],
    archives: [],
    terms: [{ name: '术语', definition: '测试用术语', entry: 'setting' }],
  };
  await Promise.all([
    write('正文/README.md', index),
    write('正文/第一卷/第001章.md', '# 第001章 测试标题\n\n第一段。'),
    write('正文/第一卷/第002章.md', '待审测试内容'),
    write('正文/第一卷/第003章.md', '草稿测试内容'),
    write('正文/第一卷/历史稿/第004章.md', '历史测试内容'),
    write('正文/第一卷/第006章.md', '重复状态测试内容'),
    write('策划/未定.md', '未公开测试内容'),
    write('web/content/catalog.json', JSON.stringify(manifest)),
    write('web/content/entries/setting.md', '初版公开设定。'),
    write('web/content/entries/draft.md', '未登记测试内容。'),
  ]);

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const get = (route, tag) => fetch(`http://127.0.0.1:${server.address().port}${route}`,
    { headers: tag ? { 'If-None-Match': tag } : {} });
  const catalog = await get('/api/catalog');
  const publicData = await catalog.json();
  assert.deepEqual(publicData.chapters, [{ id: 'v1-c001', volume: '第一卷', volumeNumber: 1, label: '第001章', title: '测试标题' }]);
  assert.deepEqual(publicData.archives, []);
  assert.equal(publicData.terms[0].collection, 'settings');
  assert.equal((await get('/api/catalog', catalog.headers.get('etag'))).status, 304);
  for (const route of ['/api/chapters/v1-c002', '/api/chapters/v1-c003', '/api/chapters/v1-c004',
    '/api/chapters/v1-c005', '/api/chapters/v1-c006', '/api/entries/draft', '/web/content/catalog.json', `/${encodeURIComponent('策划/未定.md')}`]) {
    assert.equal((await get(route)).status, 404, route);
  }

  const chapterUrl = '/api/chapters/v1-c001';
  const chapter = await get(chapterUrl);
  assert.deepEqual(await chapter.json(), { title: '测试标题', markdown: '第一段。' });
  assert.equal((await get(chapterUrl, chapter.headers.get('etag'))).status, 304);
  await write('正文/第一卷/第001章.md', '# 修订测试\n\n已修改的正文。');
  assert.deepEqual(await (await get(chapterUrl, chapter.headers.get('etag'))).json(), { title: '修订测试', markdown: '已修改的正文。' });

  const setting = await get('/api/entries/setting');
  assert.equal((await setting.json()).markdown, '初版公开设定。');
  await write('web/content/entries/setting.md', '修订公开设定。');
  assert.equal((await (await get('/api/entries/setting', setting.headers.get('etag'))).json()).markdown, '修订公开设定。');

  manifest.archives.push({ id: 'archive', title: '正式测试档案', summary: '档案摘要', category: 'phenomenon', code: 'D-X' });
  await write('web/content/entries/archive.md', '档案内容。');
  await write('web/content/catalog.json', JSON.stringify(manifest));
  await write('正文/README.md', index.replace('**定稿**', '待审稿'));
  const updated = await (await get('/api/catalog', catalog.headers.get('etag'))).json();
  assert.deepEqual(updated.chapters, []);
  assert.equal(updated.archives[0].code, 'D-X');
  assert.equal((await get(chapterUrl)).status, 404);
  assert.equal((await (await get('/api/entries/archive')).json()).markdown, '档案内容。');
});
