import test from 'node:test';
import assert from 'node:assert/strict';
import { markdown, safeURL } from '../public/markdown.js';

const cells = html => [...html.matchAll(/<(?:th|td)(?: class="[^"]+")?>(.*?)<\/(?:th|td)>/g)].map(match => match[1]);

test('Markdown pipe 表格渲染表头、内容和三种对齐方式', () => {
  const html = markdown('| 名称 | 进度 | 数量 | 默认 |\n| :--- | :---: | ---: | --- |\n| **Mac** | `ready` | 2 | [官网](https://example.com/?a=1&b=2) |');
  assert.match(html, /<div class="md-table-scroll"[^>]+><table><thead>/);
  assert.match(html, /<th class="md-align-left">名称<\/th><th class="md-align-center">进度<\/th><th class="md-align-right">数量<\/th><th>默认<\/th>/);
  assert.match(html, /<td class="md-align-left"><strong>Mac<\/strong><\/td>/);
  assert.match(html, /<td class="md-align-center"><code>ready<\/code><\/td>/);
  assert.match(html, /href="https:\/\/example.com\/\?a=1&amp;b=2"/);
  assert.deepEqual(cells(html).slice(0, 4), ['名称', '进度', '数量', '默认']);
});

test('支持无外围管道的表格，并按表头补齐缺列、忽略多列', () => {
  const html = markdown('名称 | 说明\n--- | ---\n| 一项 |\n二项 | 正常 | 多余列\n三项\n\n表格之后');
  assert.deepEqual(cells(html), ['名称', '说明', '一项', '', '二项', '正常', '三项', '']);
  assert.ok(html.endsWith('</table></div><p>表格之后</p>'));
});

test('转义管道和多反引号代码中的管道不会拆列', () => {
  const html = markdown('值 | 代码\n--- | ---\na\\|b | `x|y`\n\\|首尾\\| | `` `a|b` ``\n结尾\\\\ | `x\\|y`');
  assert.deepEqual(cells(html), ['值', '代码', 'a|b', '<code>x|y</code>', '|首尾|', '<code>`a|b`</code>', '结尾\\', '<code>x|y</code>']);
});

test('未闭合反引号不会吞掉后续列，转义反引号保持文字', () => {
  const html = markdown('A | B\n--- | ---\n`未闭合 | 第二列\n\\`字面量 | 内容');
  assert.deepEqual(cells(html), ['A', 'B', '`未闭合', '第二列', '`字面量', '内容']);
});

test('仅合法且列数匹配的分隔行能开始表格', () => {
  for (const source of ['A | B\n--- | nope', 'A | B\n---', 'A | B\n--- | --- | ---', '文字\n---', 'A | B\n-- | --']) {
    assert.doesNotMatch(markdown(source), /<table>/, source);
  }
  assert.match(markdown('| 单列 |\n| --- |\n| 值 |'), /<table>/);
});

test('代码围栏中不解析表格或 HTML，关闭围栏需要相同字符及足够长度', () => {
  const source = '````md\nA | B\n--- | ---\n```\n<script>alert(1)</script>\n````\n\nA | B\n--- | ---\n1 | 2';
  const html = markdown(source);
  assert.equal((html.match(/<table>/g) || []).length, 1);
  assert.match(html, /<pre><code>A \| B\n--- \| ---\n```\n&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code><\/pre>/);
  assert.doesNotMatch(markdown('~~~md\nA | B\n--- | ---\n```\n~~~'), /<table>/);
  assert.doesNotMatch(markdown('```\nA | B\n--- | ---'), /<table>/);
  assert.doesNotMatch(markdown('    A | B\n    --- | ---'), /<table>/);
});

test('表格在空行或后续块级内容前结束，不吞掉标题、列表与代码', () => {
  const html = markdown('A | B\n--- | ---\n1 | 2\n# 后续 | 标题\n- 后续 | 列表\n```\n代码 | 保留\n```');
  assert.deepEqual(cells(html), ['A', 'B', '1', '2']);
  assert.match(html, /<\/table><\/div><h1>后续 \| 标题<\/h1><ul><li>后续 \| 列表<\/li><\/ul><pre><code>代码 \| 保留<\/code><\/pre>/);
});

test('表格保留 HTML 转义、安全 URL 白名单和安全链接属性', () => {
  const html = markdown('字段 | 值\n--- | ---\n<img src=x onerror=alert(1)> | [危险](javascript:alert)\n`<script>` | [危险](data:text/html,boom)\n正常 | [安全](https://example.com/\"onmouseover=\"boom)');
  assert.doesNotMatch(html, /<img|<script|href="javascript:|href="data:| onmouseover="/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<code>&lt;script&gt;<\/code>/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.equal(safeURL('javascript:alert(1)'), '');
  assert.equal(safeURL('data:text/html,boom'), '');
  assert.equal(safeURL('mailto:hello@example.com'), 'mailto:hello@example.com');
});

test('保留现有 Markdown 功能，代码链接标签与转义不会泄漏内部占位符', () => {
  const html = markdown('# 标题\n\n**粗体** 和 *斜体* 与 ~~删除~~\n\n> 引用\n\n- [x] 完成\n- 普通\n\n[查看 `code`](https://example.com) 与 \\*字面量\\* 与 \u00000\u0000');
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /<del>删除<\/del>/);
  assert.match(html, /<blockquote>引用<\/blockquote>/);
  assert.match(html, /<li class="md-check"><span>☑<\/span> 完成<\/li>/);
  assert.match(html, />查看 <code>code<\/code><\/a>/);
  assert.match(html, /\*字面量\*/);
  assert.doesNotMatch(html, /\u0000|undefined/);
  assert.equal(markdown('首行\n`x\\|y`'), '<p>首行<br><code>x\\|y</code></p>');
});

test('接受 Windows 与经典 Mac 换行', () => {
  for (const newline of ['\r\n', '\r']) assert.match(markdown(['A | B', '--- | ---', '1 | 2'].join(newline)), /<table>/);
});
