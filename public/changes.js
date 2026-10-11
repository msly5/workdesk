import { MergeConflict } from './model.js';

// JSON wire format: set(path, before?, after?), plus ID-only array ordering.
// A missing before/after means add/remove; null remains an ordinary value.
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const ROOT_FIELDS = new Set(['tasks', 'activeTaskId']);
const MAX_CHANGES = 10000, MAX_DEPTH = 32, MAX_BYTES = 16 * 1024 * 1024;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const selector = value => object(value) && own(value, 'id');
const fail = message => { const error = new Error('增量数据无效：' + message); error.status = 400; throw error; };
const pathText = path => path.map(part => typeof part === 'string' ? part : part.id).join('.');
const conflict = path => { throw new MergeConflict(pathText(path)); };
const taskField = (path, field) => path.length === 3 && path[0] === 'tasks' && selector(path[1]) && path[2] === field;
const activityPath = path => path.length >= 3 && path[0] === 'tasks' && selector(path[1]) && path[2] === 'activity';

function equal(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  if (!object(a) || !object(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => own(b, key) && equal(a[key], b[key]));
}

function idArray(value) {
  return Array.isArray(value) && value.every(item => object(item) && own(item, 'id'));
}

// Validate before cloning/stringifying: getters, cycles and custom prototypes must
// never get to execute as part of applying a patch. The workspace has no size cap
// here; only the transmitted changes have one.
function validateJSON(value, limit = 1000000, checkIds = true) {
  const ancestors = new Set(); let count = 0;
  function visit(item, depth) {
    if (++count > limit) fail('数据项过多');
    if (depth > MAX_DEPTH) fail('数据嵌套过深');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail('数字必须有限'); return; }
    if (typeof item !== 'object') fail('只支持 JSON 值');
    if (ancestors.has(item)) fail('不支持循环引用');
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail('只支持普通对象');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(item).some(key => typeof key !== 'string')) fail('不支持 Symbol 字段');
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (Object.keys(descriptors).some(key => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) fail('数组包含额外字段');
      if (item.length > limit) fail('数组过大');
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[index];
        if (!descriptor || !own(descriptor, 'value')) fail('数组不允许空位或访问器');
        visit(descriptor.value, depth + 1);
      }
      if (checkIds && item.some(entry => object(entry) && own(entry, 'id'))) {
        if (!idArray(item)) fail('ID 数组不能混合其他值');
        const ids = new Set();
        for (const entry of item) {
          if (typeof entry.id !== 'string' || !ID.test(entry.id) || ids.has(entry.id)) fail('ID 无效或重复');
          ids.add(entry.id);
        }
      }
    } else {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (FORBIDDEN.has(key)) fail('禁止的对象字段');
        if (!descriptor.enumerable || !own(descriptor, 'value')) fail('对象不允许隐藏字段或访问器');
        visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
  }
  visit(value, 0);
}

function validateWorkspace(value) {
  validateJSON(value);
  if (!object(value) || !idArray(value.tasks) || !own(value, 'activeTaskId') ||
      !Number.isInteger(value.revision) || value.revision < 0 ||
      Object.keys(value).some(key => key !== 'revision' && !ROOT_FIELDS.has(key))) fail('工作区根字段无效');
}

function validatePath(path) {
  if (!Array.isArray(path) || !path.length || path.length > MAX_DEPTH || !ROOT_FIELDS.has(path[0])) fail('路径无效');
  for (let index = 0; index < path.length; index++) {
    const part = path[index];
    if (typeof part === 'string') {
      if (!part || part.length > 100 || FORBIDDEN.has(part) || /^\d+$/.test(part)) fail('路径字段无效');
      if (part === 'id' && index && selector(path[index - 1])) fail('不能直接修改实体 ID');
    } else if (!selector(part) || Object.keys(part).length !== 1 || typeof part.id !== 'string' || !ID.test(part.id)) fail('ID 路径无效');
  }
  if (path[0] === 'activeTaskId' && path.length !== 1) fail('activeTaskId 不能有子路径');
  if (path[0] === 'tasks' && path.length > 1 && !selector(path[1])) fail('任务必须按 ID 寻址');
}

function validateChanges(changes) {
  if (!Array.isArray(changes) || changes.length > MAX_CHANGES) fail('操作数量无效');
  validateJSON(changes, 250000, false);
  if (new TextEncoder().encode(JSON.stringify(changes)).byteLength > MAX_BYTES) fail('更改超过 16 MiB');
  const paths = [], setPaths = new Set(), orderPaths = new Set();
  for (const change of changes) {
    if (!object(change) || !['set', 'order'].includes(change.op)) fail('未知操作');
    validatePath(change.path);
    const key = JSON.stringify(change.path);
    if (change.op === 'set') {
      if (Object.keys(change).some(name => !['op', 'path', 'before', 'after'].includes(name)) || (!own(change, 'before') && !own(change, 'after'))) fail('set 操作字段无效');
      if (change.path.length === 1 && change.path[0] === 'tasks') fail('任务集合必须按 ID 修改');
      if (setPaths.has(key)) fail('重复写入同一路径');
      for (const field of ['before', 'after']) if (own(change, field)) validateJSON(change[field], 250000);
      setPaths.add(key);
      const last = change.path.at(-1);
      if (selector(last)) {
        for (const field of ['before', 'after']) if (own(change, field) && (!object(change[field]) || change[field].id !== last.id)) fail('实体值必须匹配路径 ID');
      }
      if (activityPath(change.path) && !own(change, 'after')) fail('活动记录不能通过增量删除');
    } else {
      if (Object.keys(change).some(name => !['op', 'path', 'ids'].includes(name)) || !Array.isArray(change.ids) || change.ids.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(change.ids).size !== change.ids.length) fail('排序操作无效');
      if (orderPaths.has(key) || activityPath(change.path)) fail('重复或无效的排序路径');
      orderPaths.add(key);
    }
    paths.push(change.path);
  }
  // A parent replacement and a child write in one payload is ambiguous. Orders
  // may be parents of item edits, but cannot target a replaced parent/child.
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    for (let length = 1; length < path.length; length++) if (setPaths.has(JSON.stringify(path.slice(0, length)))) fail('父子写入路径相交');
    if (changes[index].op === 'order' && setPaths.has(JSON.stringify(path))) fail('排序与替换路径相交');
  }
}

export function createChanges(base, local) {
  validateWorkspace(base); validateWorkspace(local);
  const changes = [];
  function set(path, before, after, hadBefore, hasAfter) {
    changes.push({op:'set', path, ...(hadBefore ? {before:structuredClone(before)} : {}), ...(hasAfter ? {after:structuredClone(after)} : {})});
    if (changes.length > MAX_CHANGES) fail('操作数量过多');
  }
  function diff(before, after, path, hadBefore = true, hasAfter = true) {
    if (hadBefore === hasAfter && equal(before, after)) return;
    if (!hadBefore || !hasAfter || taskField(path, 'viewport')) return set(path, before, after, hadBefore, hasAfter);
    if (object(before) && object(after)) {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) diff(before[key], after[key], [...path, key], own(before, key), own(after, key));
    } else if (idArray(before) && idArray(after)) {
      const previous = new Map(before.map(item => [item.id, item])), next = new Map(after.map(item => [item.id, item]));
      for (const item of before) if (!next.has(item.id) && !activityPath(path)) diff(item, undefined, [...path, {id:item.id}], true, false);
      for (const item of after) diff(previous.get(item.id), item, [...path, {id:item.id}], previous.has(item.id), true);
      if (!activityPath(path) && !equal(before.map(item => item.id), after.map(item => item.id))) changes.push({op:'order', path, ids:after.map(item => item.id)});
    } else set(path, before, after, true, true);
  }
  for (const key of ROOT_FIELDS) diff(base[key], local[key], [key], own(base, key), own(local, key));
  validateChanges(changes);
  return changes;
}

function locate(root, path) {
  let parent = root;
  for (let index = 0; index < path.length; index++) {
    const part = path[index]; let key, present;
    if (typeof part === 'string') {
      if (!object(parent)) fail('字段路径不能用于数组或标量');
      key = part; present = own(parent, key);
    } else {
      if (!idArray(parent)) fail('ID 路径必须用于实体数组');
      key = parent.findIndex(item => item.id === part.id); present = key !== -1;
    }
    if (index === path.length - 1) return {parent, key, present, value:present ? parent[key] : undefined};
    if (!present) conflict(path);
    parent = parent[key];
  }
}

export function applyChanges(current, changes) {
  validateWorkspace(current); validateChanges(changes);
  const result = structuredClone(current);
  for (const change of changes.filter(change => change.op === 'set')) {
    const {path} = change, target = locate(result, path);
    const hadBefore = own(change, 'before'), hasAfter = own(change, 'after');
    const sameBefore = target.present === hadBefore && (!hadBefore || equal(target.value, change.before));
    const sameAfter = target.present === hasAfter && (!hasAfter || equal(target.value, change.after));
    let next = change.after;
    if (path.length === 1 && path[0] === 'activeTaskId' || taskField(path, 'viewport')) {
      if (!hasAfter) fail('不能删除选中任务或画布视图');
    } else if (taskField(path, 'updatedAt') && hasAfter && target.present) {
      if (typeof target.value !== 'string' || typeof next !== 'string') fail('更新时间必须是字符串');
      next = target.value > next ? target.value : next;
    } else if (!sameBefore && !sameAfter) conflict(path);
    if (hasAfter) {
      const value = structuredClone(next);
      if (Array.isArray(target.parent) && !target.present) target.parent.push(value);
      else target.parent[target.key] = value;
    } else if (target.present) {
      if (Array.isArray(target.parent)) target.parent.splice(target.key, 1);
      else delete target.parent[target.key];
    }
  }
  for (const change of changes.filter(change => change.op === 'order')) {
    const target = locate(result, change.path);
    if (!target.present) conflict(change.path);
    if (!idArray(target.value)) fail('只能对实体数组排序');
    const values = new Map(target.value.map(item => [item.id, item]));
    const ordered = change.ids.filter(id => values.has(id)).map(id => values.get(id));
    const localIds = new Set(change.ids);
    target.parent[target.key] = [...ordered, ...target.value.filter(item => !localIds.has(item.id))];
  }
  const touchedTasks = new Set(changes.filter(change => change.path[0] === 'tasks' && selector(change.path[1])).map(change => change.path[1].id));
  for (const task of result.tasks) if (touchedTasks.has(task.id) && Array.isArray(task.activity)) {
    if (task.activity.some(event => typeof event.at !== 'string')) fail('活动记录缺少时间');
    task.activity.sort((a, b) => b.at.localeCompare(a.at)); task.activity = task.activity.slice(0, 150);
  }
  validateWorkspace(result);
  // Independent card/edge edits can each be valid yet create a dangling edge
  // after merging. Surface this as a collaboration conflict, not invalid input.
  for (const task of result.tasks) if (Array.isArray(task.nodes) && Array.isArray(task.edges)) {
    const nodes = new Set(task.nodes.map(node => node.id));
    if (task.edges.some(edge => !nodes.has(edge.source) || !nodes.has(edge.target))) conflict(['tasks', {id:task.id}, 'edges']);
  }
  if (result.activeTaskId !== null && !result.tasks.some(task => task.id === result.activeTaskId)) conflict(['activeTaskId']);
  return result;
}
