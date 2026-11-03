import { mkdir, readFile, writeFile, rename, copyFile, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { seedState, demoAssets } from './seed.mjs';
import { mergeStates } from './public/model.js';
import { applyChanges } from './public/changes.js';

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
  if (state.groups !== undefined && (!Array.isArray(state.groups) || state.groups.length > 200)) throw new AppError('分组格式无效');
  const groups = new Set(), names = new Set();
  for (const group of state.groups || []) {
    validId(group?.id); text(group.name, 80);
    const name = group.name.trim().toLowerCase();
    if (!name || group.name !== group.name.trim() || groups.has(group.id) || names.has(name)) throw new AppError('分组名称为空或重复');
    groups.add(group.id); names.add(name);
  }
  const ids = new Set();
  for (const task of state.tasks) {
    validId(task.id); if (ids.has(task.id)) throw new AppError('任务标识重复'); ids.add(task.id);
    if (task.groupId != null && !groups.has(task.groupId)) throw new AppError('任务分组不存在');
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
      if (node.localFile !== undefined && (node.type !== 'file' || typeof node.localFile !== 'boolean')) throw new AppError('本地文件标记格式无效');
      if (node.filePath !== undefined) {
        if (node.type !== 'file' || node.localFile !== true) throw new AppError('本地文件路径仅适用于文件引用');
        text(node.filePath, 32767);
      }
      if (node.localFile && node.assetId) throw new AppError('本地文件引用不能同时使用附件副本');
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
    try {
      await writeFile(temp, data);
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }
  async init() {
    let created = false;
    this.initialSeed = null;
    await mkdir(this.dir, { recursive: true });
    await mkdir(path.join(this.dir, 'files'), { recursive: true });
    try { this.state = JSON.parse(await readFile(path.join(this.dir, 'state.json'), 'utf8')); validateState(this.state); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new AppError('无法读取本地数据，请保留 data 文件夹并检查 state.json', 500);
      this.state = seedState();
      await this.atomic(path.join(this.dir, 'state.json'), JSON.stringify(this.state, null, 2));
      created = true;
    }
    this.state.groups ??= [];
    try { this.files = JSON.parse(await readFile(path.join(this.dir, 'files.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.files = {}; }
    for (const {id, name, content, mime} of demoAssets()) {
      if (!this.files[id]) {
        const bytes = Buffer.from(content);
        await writeFile(path.join(this.dir, 'files', id), bytes);
        this.files[id] = { id, taskId: 'task-welcome', name, mime, size: bytes.length };
      }
    }
    await this.atomic(path.join(this.dir, 'files.json'), JSON.stringify(this.files, null, 2));
    await this.syncDocs(this.state);
    if (created) this.initialSeed = {state:structuredClone(this.state), files:structuredClone(this.files)};
  }
  async read() { this.initialSeed = null; return structuredClone(this.state); }
  enqueue(fn, {preserveInitialSeed = false} = {}) {
    const job = this.queue.then(() => {
      if (!preserveInitialSeed) this.initialSeed = null;
      return fn();
    });
    this.queue = job.catch(() => {});
    return job;
  }
  selectInitialLocale(locale) {
    return this.enqueue(async () => {
      const initial = this.initialSeed;
      this.initialSeed = null;
      // Existing state files and previously exposed/changed samples never enter
      // this path. Language switching must not rewrite editable user content.
      if (!initial || locale !== 'en') return;
      if (JSON.stringify(this.state) !== JSON.stringify(initial.state) || JSON.stringify(this.files) !== JSON.stringify(initial.files)) return;
      const stateFile = path.join(this.dir, 'state.json'), indexFile = path.join(this.dir, 'files.json');
      if (JSON.stringify(JSON.parse(await readFile(stateFile, 'utf8'))) !== JSON.stringify(initial.state) ||
          JSON.stringify(JSON.parse(await readFile(indexFile, 'utf8'))) !== JSON.stringify(initial.files)) return;
      const originals = [];
      for (const asset of demoAssets()) {
        const file = path.join(this.dir, 'files', asset.id), bytes = await readFile(file);
        // A user may have edited an attachment outside the app before opening
        // the browser. Such bytes also make the initial sample ineligible.
        if (!bytes.equals(Buffer.from(asset.content))) return;
        originals.push({file, bytes});
      }
      const next = seedState('en');
      const oldTasks = new Map(initial.state.tasks.map(task => [task.id, task]));
      for (const task of next.tasks) {
        const old = oldTasks.get(task.id);
        task.createdAt = old.createdAt; task.updatedAt = old.updatedAt;
        for (const event of task.activity) event.at = old.activity.find(item => item.id === event.id)?.at ?? event.at;
      }
      const previousFiles = this.files, nextFiles = structuredClone(this.files);
      try {
        for (const asset of demoAssets('en')) {
          const bytes = Buffer.from(asset.content);
          await this.atomic(path.join(this.dir, 'files', asset.id), bytes);
          nextFiles[asset.id] = {...nextFiles[asset.id], name:asset.name, size:bytes.length, mime:asset.mime};
        }
        await this.atomic(indexFile, JSON.stringify(nextFiles, null, 2));
        this.files = nextFiles;
        await this.commit(next);
      } catch (error) {
        this.files = previousFiles;
        try {
          for (const {file, bytes} of originals) await this.atomic(file, bytes);
          await this.atomic(indexFile, JSON.stringify(previousFiles, null, 2));
        } catch {
          throw new AppError('示例语言初始化失败，无法完整还原示例附件。请保留 data 文件夹并检查磁盘空间或权限。', 500);
        }
        this.initialSeed = initial;
        throw error;
      }
    }, {preserveInitialSeed:true});
  }
  async syncDocs(state, previous, journal) {
    const oldTasks = new Map(previous?.tasks.map(task => [task.id, task]) ?? []);
    for (const task of state.tasks) {
      const oldNodes = new Map(oldTasks.get(task.id)?.nodes.map(node => [node.id, node]) ?? []);
      const changed = task.nodes.filter(node => node.type === 'markdown' &&
        (oldNodes.get(node.id)?.type !== 'markdown' || (oldNodes.get(node.id)?.content ?? '') !== (node.content ?? '')));
      if (!changed.length) continue;
      const dir = path.join(this.dir, 'tasks', task.id, 'docs');
      await mkdir(dir, { recursive: true });
      for (const node of changed) {
        const file = path.join(dir, node.id + '.md');
        if (journal) {
          let bytes;
          try { bytes = await readFile(file); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          journal.push({ file, bytes });
        }
        await this.atomic(file, node.content ?? '');
      }
    }
  }
  async commit(next) {
    validateState(next);
    next.revision = this.state.revision + 1;
    await copyFile(path.join(this.dir, 'state.json'), path.join(this.dir, 'state.backup.json'));
    const docs = [];
    try {
      await this.syncDocs(next, this.state, docs);
      await this.atomic(path.join(this.dir, 'state.json'), JSON.stringify(next, null, 2));
    } catch (error) {
      try {
        for (const { file, bytes } of docs.reverse()) {
          if (bytes === undefined) await rm(file, { force: true });
          else await this.atomic(file, bytes);
        }
      } catch {
        throw new AppError('保存失败，部分 Markdown 导出副本无法还原。请保留 data 文件夹并检查磁盘空间或权限。', 500);
      }
      throw error;
    }
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
  patch(changes) {
    return this.enqueue(async () => {
      const next = applyChanges(this.state, changes);
      validateState(next);
      if (!changes.length) return this.read();
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
    return this.enqueue(() => this.writeAttachment(taskId, name, bytes, mime));
  }
  attach(taskId, name, bytes, mime, fn, expectedRevision) {
    return this.enqueue(async () => {
      if (expectedRevision !== undefined && expectedRevision !== this.state.revision) throw new AppError('版本已更新，请重新读取任务后再修改。', 409);
      const next = structuredClone(this.state);
      return this.writeAttachment(taskId, name, bytes, mime, async file => {
        const result = await fn(next, file);
        validateState(next);
        return async () => {
          const saved = await this.commit(next);
          return { revision: saved.revision, ...result };
        };
      });
    });
  }
  // Caller holds the queue. Validate the card before touching disk, then roll
  // back both the index and the bytes if any part of its save fails.
  async writeAttachment(taskId, name, bytes, mime, prepare) {
    validId(taskId);
    if (!this.state.tasks.some(t => t.id === taskId)) throw new AppError('请先保存任务再上传附件');
    if (typeof name !== 'string' || !name || name.length > 500 || !(bytes instanceof Uint8Array) || bytes.length > 25 * 1024 * 1024) throw new AppError('文件名无效或文件超过 25 MB');
    const id = randomUUID();
    const file = { id, taskId, name: path.basename(name.replaceAll('\\', '/')), size: bytes.length, mime: String(mime || 'application/octet-stream').replace(/[\r\n]/g, '').slice(0, 100) };
    this.files[id] = file;
    const target = this.namedFile(id);
    let indexed = false;
    try {
      const finish = await prepare?.(structuredClone(file));
      await this.atomic(target, bytes);
      await this.atomic(path.join(this.dir, 'files.json'), JSON.stringify(this.files, null, 2));
      indexed = true;
      return finish ? await finish() : structuredClone(file);
    } catch (error) {
      delete this.files[id];
      try {
        if (indexed) await this.atomic(path.join(this.dir, 'files.json'), JSON.stringify(this.files, null, 2));
        await rm(target, { force: true });
      } catch {
        throw new AppError('附件保存失败且无法完整清理，请保留 data 文件夹并检查磁盘空间或权限。', 500);
      }
      throw error;
    }
  }
  async file(id) {
    return readFile(await this.filePath(id));
  }
  namedFile(id) {
    validId(id); const file=this.files[id];
    if (!file) throw new AppError('附件不存在',404);
    // The ID isolates equal names; retain the extension for Windows associations.
    let name=path.basename(file.name.replaceAll('\\','/')).replace(/[\u0000-\u001f<>:"/\\|?*]/g,'_').replace(/[. ]+$/g,'') || '附件';
    if(name.length>160) {const ext=path.extname(name).slice(0,20); name=name.slice(0,160-ext.length)+ext;}
    return path.join(this.dir,'files',id+'--'+name);
  }
  async filePath(id) {
    this.initialSeed = null;
    const named=this.namedFile(id);
    try {await access(named); return named;}
    catch(error) {if(error.code!=='ENOENT')throw error; return path.join(this.dir,'files',id);}
  }
  openableFile(id) {
    return this.enqueue(async()=>{
      const named=this.namedFile(id);
      const current=await this.filePath(id);
      if(current!==named) {
        try {await copyFile(current,named,constants.COPYFILE_EXCL);}
        catch(error) {if(error.code!=='EEXIST')throw error;}
      }
      return named;
    });
  }
  export() {
    return this.enqueue(async () => {
      const files = {};
      for (const [id, file] of Object.entries(this.files)) {
        const bytes=await this.file(id); files[id]={...file,size:bytes.length,base64:bytes.toString('base64')};
      }
      return { format: 'workdesk-backup-v1', exportedAt: new Date().toISOString(), state: await this.read(), files };
    });
  }
}
