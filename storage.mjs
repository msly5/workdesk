import { mkdir, readFile, writeFile, rename, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { seedState, demoGuide, demoSvg } from './seed.mjs';
import { mergeStates } from './public/model.js';

const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const TYPES = new Set(['todo', 'markdown', 'note', 'link', 'file', 'image']);
const STATUSES = new Set(['active', 'inbox', 'waiting', 'done', 'archived']);
export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function validId(id) { if (typeof id !== 'string' || !ID.test(id)) throw new AppError('无效的标识'); return id; }
function text(value, max = 200000) { if (typeof value !== 'string' || value.length > max) throw new AppError('内容格式无效或过长'); }
export function validateState(state) {
  if (!state || !Array.isArray(state.tasks) || state.tasks.length > 1000 || !Number.isInteger(state.revision) || state.revision < 0) throw new AppError('工作区数据格式无效');
  const ids = new Set();
  for (const task of state.tasks) {
    validId(task.id); if (ids.has(task.id)) throw new AppError('任务标识重复'); ids.add(task.id);
    text(task.title, 300); text(task.goal ?? '', 5000); text(task.nextAction ?? '', 5000);
    if (!STATUSES.has(task.status) || !Array.isArray(task.nodes) || !Array.isArray(task.edges) || task.nodes.length > 2000 || task.edges.length > 5000) throw new AppError('任务格式无效');
    const nodes = new Set();
    for (const node of task.nodes) {
      validId(node.id); if (nodes.has(node.id)) throw new AppError('卡片标识重复'); nodes.add(node.id);
      if (!TYPES.has(node.type) || !Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(node.width) || node.width < 180 || node.width > 1500) throw new AppError('卡片格式无效');
      text(node.title, 500); text(node.content ?? '');
      if (node.localFolder !== undefined && (node.type !== 'link' || typeof node.localFolder !== 'boolean')) throw new AppError('文件夹标记格式无效');
      if (node.folderPath !== undefined) {
        if (node.type !== 'link') throw new AppError('文件夹路径仅适用于链接卡片');
        text(node.folderPath, 32767);
      }
      if (node.assetId) validId(node.assetId);
      if (node.type === 'todo' && (!Array.isArray(node.items) || node.items.length > 500 || node.items.some(i => typeof i.text !== 'string' || i.text.length > 5000 || typeof i.done !== 'boolean' || !ID.test(i.id)))) throw new AppError('待办格式无效');
    }
    const edges = new Set();
    for (const edge of task.edges) {
      validId(edge.id); if (edges.has(edge.id) || !nodes.has(edge.source) || !nodes.has(edge.target) || edge.source === edge.target) throw new AppError('连线格式无效'); edges.add(edge.id);
    }
    const viewport = task.viewport;
    if (!viewport || ![viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) || viewport.zoom < .2 || viewport.zoom > 2) throw new AppError('画布视图无效');
  }
  if (state.activeTaskId !== null && !ids.has(state.activeTaskId)) throw new AppError('选中任务不存在');
}

export class Store {
  constructor(dir) { this.dir = path.resolve(dir); this.queue = Promise.resolve(); }
  async atomic(file, data) {
    const temp = file + '.tmp-' + randomUUID();
    await writeFile(temp, data);
    await rename(temp, file);
  }
  async init() {
    await mkdir(this.dir, { recursive: true });
    await mkdir(path.join(this.dir, 'files'), { recursive: true });
    try { this.state = JSON.parse(await readFile(path.join(this.dir, 'state.json'), 'utf8')); validateState(this.state); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new AppError('无法读取本地数据，请保留 data 文件夹并检查 state.json', 500);
      this.state = seedState();
      await this.atomic(path.join(this.dir, 'state.json'), JSON.stringify(this.state, null, 2));
    }
    try { this.files = JSON.parse(await readFile(path.join(this.dir, 'files.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.files = {}; }
    for (const [id, name, bytes, mime] of [['demo-workflow', '工作流示意.svg', Buffer.from(demoSvg), 'image/svg+xml'], ['demo-guide', '工作台使用指南.md', Buffer.from(demoGuide), 'text/markdown']]) {
      if (!this.files[id]) {
        await writeFile(path.join(this.dir, 'files', id), bytes);
        this.files[id] = { id, taskId: 'task-welcome', name, mime, size: bytes.length };
      }
    }
    await this.atomic(path.join(this.dir, 'files.json'), JSON.stringify(this.files, null, 2));
    await this.syncDocs(this.state);
  }
  async read() { return structuredClone(this.state); }
  enqueue(fn) {
    const job = this.queue.then(fn);
    this.queue = job.catch(() => {});
    return job;
  }
  async syncDocs(state) {
    for (const task of state.tasks) {
      const dir = path.join(this.dir, 'tasks', task.id, 'docs');
      await mkdir(dir, { recursive: true });
      for (const node of task.nodes.filter(n => n.type === 'markdown')) await this.atomic(path.join(dir, node.id + '.md'), node.content ?? '');
    }
  }
  async commit(next) {
    validateState(next);
    next.revision = this.state.revision + 1;
    await copyFile(path.join(this.dir, 'state.json'), path.join(this.dir, 'state.backup.json'));
    await this.syncDocs(next);
    await this.atomic(path.join(this.dir, 'state.json'), JSON.stringify(next, null, 2));
    this.state = next;
    return structuredClone(next);
  }
  save(input, { base } = {}) {
    return this.enqueue(async () => {
      validateState(input);
      let next = structuredClone(input);
      if (input.revision !== this.state.revision) {
        if (!base || base.revision !== input.revision) throw new AppError('数据版本已更新，请导出当前内容后刷新页面，避免覆盖其他窗口的修改。', 409);
        validateState(base);
        next = mergeStates(base,input,this.state);
      }
      return this.commit(next);
    });
  }
  mutate(fn, expectedRevision) {
    return this.enqueue(async () => {
      if (expectedRevision !== undefined && expectedRevision !== this.state.revision) throw new AppError('版本已更新，请重新读取任务后再修改。',409);
      const next = structuredClone(this.state);
      const result = await fn(next);
      const saved = await this.commit(next);
      return {revision:saved.revision,...result};
    });
  }
  upload(taskId, name, bytes, mime) {
    return this.enqueue(async () => {
      validId(taskId);
      if (!this.state.tasks.some(t => t.id === taskId)) throw new AppError('请先保存任务再上传附件');
      if (!name || name.length > 500 || bytes.length > 25 * 1024 * 1024) throw new AppError('文件名无效或文件超过 25 MB');
      const id = randomUUID();
      const file = { id, taskId, name: path.basename(name.replaceAll('\\', '/')), size: bytes.length, mime: String(mime || 'application/octet-stream').replace(/[\r\n]/g, '').slice(0, 100) };
      await this.atomic(path.join(this.dir, 'files', id), bytes);
      this.files[id] = file;
      await this.atomic(path.join(this.dir, 'files.json'), JSON.stringify(this.files, null, 2));
      return structuredClone(file);
    });
  }
  async file(id) {
    validId(id);
    if (!this.files[id]) throw new AppError('附件不存在', 404);
    return readFile(path.join(this.dir, 'files', id));
  }
  export() {
    return this.enqueue(async () => {
      const files = {};
      for (const [id, file] of Object.entries(this.files)) files[id] = { ...file, base64: (await this.file(id)).toString('base64') };
      return { format: 'workdesk-backup-v1', exportedAt: new Date().toISOString(), state: await this.read(), files };
    });
  }
}
