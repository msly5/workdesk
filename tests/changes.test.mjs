import test from 'node:test';
import assert from 'node:assert/strict';
import { createChanges, applyChanges } from '../public/changes.js';
import { seedState } from '../seed.mjs';

const copy = value => structuredClone(value);
const titlePath = ['tasks', {id:'task-welcome'}, 'title'];
const change = (path, before, after) => ({op:'set', path, before, after});

test('8 MiB 工作区改标题只传变化，JSON 往返保留版本和正文', () => {
  const base = seedState();
  base.tasks[0].nodes[0].content = 'x'.repeat(8 * 1024 * 1024);
  const local = copy(base); local.tasks[0].title = '新标题'; local.revision++;
  const changes = createChanges(base, local);
  const payload = JSON.stringify(changes);
  assert.ok(Buffer.byteLength(payload) < 300, payload.length);
  const merged = applyChanges(base, JSON.parse(payload));
  assert.equal(merged.revision, base.revision);
  assert.equal(merged.tasks[0].title, '新标题');
  assert.equal(merged.tasks[0].nodes[0].content.length, 8 * 1024 * 1024);
});

test('独立字段和不同待办项合并，普通对象逐字段更新', () => {
  const base = seedState(), local = copy(base), remote = copy(base);
  local.tasks[0].title = '本地标题'; remote.tasks[0].goal = '远端目标';
  local.tasks[0].nodes[1].items[0].done = true;
  remote.tasks[0].nodes[1].items[1].text = '远端行动'; remote.revision = 10;
  const merged = applyChanges(remote, createChanges(base, local));
  assert.equal(merged.tasks[0].title, '本地标题'); assert.equal(merged.tasks[0].goal, '远端目标');
  assert.equal(merged.tasks[0].nodes[1].items[0].done, true);
  assert.equal(merged.tasks[0].nodes[1].items[1].text, '远端行动'); assert.equal(merged.revision, 10);
  assert.deepEqual(remote.tasks[0].title, base.tasks[0].title);
});

test('同字段不同值冲突，同值并发和重试成功；失败不修改 current', () => {
  const base = seedState(), local = copy(base), remote = copy(base);
  local.tasks[0].title = '本地标题'; local.tasks[0].goal = '随后冲突';
  remote.tasks[0].goal = '远端目标'; const before = copy(remote);
  const changes = createChanges(base, local);
  assert.throws(() => applyChanges(remote, changes), {status:409}); assert.deepEqual(remote, before);
  remote.tasks[0].goal = local.tasks[0].goal;
  const merged = applyChanges(remote, changes);
  assert.deepEqual(applyChanges(merged, changes), merged);
});

test('删除对象与远端编辑冲突；双方相同删除可以重试', () => {
  const base = seedState(), local = copy(base), remote = copy(base);
  const id = base.tasks[0].nodes[0].id;
  local.tasks[0].nodes = local.tasks[0].nodes.filter(node => node.id !== id);
  local.tasks[0].edges = local.tasks[0].edges.filter(edge => edge.source !== id && edge.target !== id);
  remote.tasks[0].nodes[0].content = '必须保留的远端修改';
  const changes = createChanges(base, local);
  assert.throws(() => applyChanges(remote, changes), {status:409});
  assert.deepEqual(applyChanges(local, changes), local);
  const edited = copy(base); edited.tasks[0].nodes[0].content = '本地输入';
  assert.throws(() => applyChanges(local, createChanges(base, edited)), {status:409});
});

test('任务、卡片、连线独立增删与顺序调整保留远端新增实体', () => {
  const base = seedState(), local = copy(base), remote = copy(base);
  const newTask = {...copy(base.tasks[1]), id:'new-task'};
  local.tasks.unshift(newTask);
  remote.tasks.push({...copy(base.tasks[1]), id:'remote-task'});
  local.tasks[1].nodes.unshift({id:'local-node', title:'本地', type:'note', content:'', x:0, y:0, width:270});
  remote.tasks[0].nodes.unshift({id:'remote-node', title:'远端', type:'note', content:'', x:0, y:0, width:270});
  local.tasks[1].edges.push({id:'local-edge', source:'local-node', target:'welcome-note', label:''});
  remote.tasks[0].edges.push({id:'remote-edge', source:'remote-node', target:'welcome-note', label:''});
  const merged = applyChanges(remote, createChanges(base, local));
  assert.equal(merged.tasks[0].id, 'new-task');
  assert.ok(merged.tasks.some(task => task.id === 'remote-task'));
  const task = merged.tasks.find(task => task.id === 'task-welcome');
  assert.equal(task.nodes[0].id, 'local-node'); assert.ok(task.nodes.some(node => node.id === 'remote-node'));
  assert.ok(task.edges.some(edge => edge.id === 'local-edge')); assert.ok(task.edges.some(edge => edge.id === 'remote-edge'));
  assert.deepEqual(applyChanges(base, createChanges(base, local)), local);
});

test('并发纯改序按本地顺序排列共同实体，并保留远端新增', () => {
  const base = seedState(), local = copy(base), remote = copy(base);
  local.tasks.reverse(); remote.tasks.reverse();
  remote.tasks.unshift({...copy(base.tasks[1]), id:'remote-task'});
  const merged = applyChanges(remote, createChanges(base, local));
  assert.deepEqual(merged.tasks.map(task => task.id), [...local.tasks.map(task => task.id), 'remote-task']);
});

test('双方删除不同实体并各自新增，合并不复活已删除实体', () => {
  const base = seedState(), local = copy(base), remote = copy(base);
  local.tasks = local.tasks.filter(task => task.id !== 'task-weekly');
  remote.tasks = remote.tasks.filter(task => task.id !== 'task-inbox');
  local.tasks.push({...copy(base.tasks[1]), id:'local-added'});
  remote.tasks.push({...copy(base.tasks[1]), id:'remote-added'});
  const merged = applyChanges(remote, createChanges(base, local));
  assert.deepEqual(merged.tasks.map(task => task.id), ['task-welcome','task-done','local-added','remote-added']);
  const deleted = copy(base); deleted.tasks = deleted.tasks.filter(task => task.id !== 'task-weekly');
  const editedParent = copy(base); editedParent.tasks[1].nodes.push({id:'remote-new-child', title:'保留子项'});
  assert.throws(() => applyChanges(editedParent, createChanges(base, deleted)), {status:409});
});

test('并发新增相同 ID 必须内容相同，不能覆盖已有实体', () => {
  const base = seedState(), local = copy(base), remote = copy(base);
  local.tasks[0].nodes.push({id:'shared-new', title:'本地', type:'note', content:'', x:0, y:0, width:270});
  remote.tasks[0].nodes.push({id:'shared-new', title:'远端', type:'note', content:'', x:0, y:0, width:270});
  const changes = createChanges(base, local);
  assert.throws(() => applyChanges(remote, changes), {status:409});
  remote.tasks[0].nodes.at(-1).title = '本地';
  const merged = applyChanges(remote, changes);
  assert.equal(merged.tasks[0].nodes.filter(node => node.id === 'shared-new').length, 1);
});

test('本地删卡片与远端新增关联产生悬空连线时返回409，保留原数据', () => {
  const base = seedState(), local = copy(base), remote = copy(base);
  const removedId = 'welcome-note';
  local.tasks[0].nodes = local.tasks[0].nodes.filter(node => node.id !== removedId);
  local.tasks[0].edges = local.tasks[0].edges.filter(edge => edge.source !== removedId && edge.target !== removedId);
  remote.tasks[0].edges.push({id:'remote-new-edge', source:'welcome-file', target:removedId, label:'新关联'});
  const before = copy(remote);
  assert.throws(() => applyChanges(remote, createChanges(base, local)), {status:409});
  assert.deepEqual(remote, before);
});

test('activity 是按 ID 合并的历史：本地截断不删除远端事件，最多150条且降序', () => {
  const base = seedState();
  base.tasks[0].activity = Array.from({length:150}, (_, index) => ({id:'event-'+index, text:'记录 '+index, at:new Date(Date.UTC(2026,0,1,0,0,index)).toISOString()})).reverse();
  const local = copy(base), remote = copy(base);
  local.tasks[0].activity.unshift({id:'local-event', text:'本地事件', at:'2026-10-11T00:00:01.000Z'});
  local.tasks[0].activity.pop();
  remote.tasks[0].activity.unshift({id:'remote-event', text:'远端事件', at:'2026-10-11T00:00:02.000Z'});
  remote.tasks[0].activity.pop();
  // An old event excluded by the local snapshot was independently updated.
  remote.tasks[0].activity.push({...base.tasks[0].activity.at(-1), text:'远端保留', at:'2026-10-11T00:00:03.000Z'});
  const changes = createChanges(base, local);
  assert.ok(changes.every(entry => Object.hasOwn(entry, 'after')));
  const activity = applyChanges(remote, changes).tasks[0].activity;
  assert.equal(activity.length, 150);
  assert.deepEqual(activity.slice(0,3).map(event => event.id), ['event-0','remote-event','local-event']);
});

test('选中任务与整个 viewport 本地优先，updatedAt 保留较新时间', () => {
  const base = seedState(), local = copy(base), remote = copy(base);
  local.activeTaskId = 'task-weekly'; remote.activeTaskId = 'task-inbox';
  local.tasks[0].viewport.x = 123; remote.tasks[0].viewport = {x:456, y:70, zoom:.5};
  local.tasks[0].updatedAt = '2026-10-11T00:00:01.000Z'; remote.tasks[0].updatedAt = '2026-10-11T00:00:02.000Z';
  const merged = applyChanges(remote, createChanges(base, local));
  assert.equal(merged.activeTaskId, local.activeTaskId);
  assert.deepEqual(merged.tasks[0].viewport, local.tasks[0].viewport);
  assert.equal(merged.tasks[0].updatedAt, remote.tasks[0].updatedAt);
});

test('远端删除正在选择的任务时冲突，不修改原数据', () => {
  const base = seedState(), local = copy(base), remote = copy(base);
  local.activeTaskId = 'task-weekly'; remote.tasks = remote.tasks.filter(task => task.id !== 'task-weekly');
  const before = copy(remote);
  assert.throws(() => applyChanges(remote, createChanges(base, local)), {status:409});
  assert.deepEqual(remote, before);
});

test('新增/删除普通对象字段、null 和父实体不依赖操作顺序', () => {
  const base = seedState(), local = copy(base);
  local.tasks[0].nodes[0].extra = {nested:{value:null}};
  delete local.tasks[0].nodes[1].content;
  const changes = createChanges(base, local);
  assert.deepEqual(applyChanges(base, changes), local);
  assert.deepEqual(applyChanges(base, [...changes].reverse()), local);
});

test('拒绝原型污染、非法路径、修改 ID/revision、重复或相交写入', () => {
  const base = seedState(); const before = copy(base);
  const invalid = [
    [{op:'set',path:[],after:{}}],
    [change(['revision'],0,1)],
    [change(['other'],null,1)],
    [change(['tasks',0,'title'],'old','new')],
    [change(['tasks','constructor','prototype'],'old','new')],
    [change(['tasks',{id:'task-welcome'},'id'],'task-welcome','changed')],
    [{op:'set',path:['tasks',{id:'new-task'}],after:{id:'different'}}],
    [change(titlePath,'old','new'), change(titlePath,'old','newer')],
    [{op:'set',path:['tasks',{id:'task-welcome'}],before:base.tasks[0]},change(titlePath,'old','new')],
    [{op:'order',path:['tasks'],ids:['task-welcome','task-welcome']}],
    [{op:'set',path:['tasks',{id:'task-welcome'},'extra'],after:JSON.parse('{"__proto__":{"polluted":true}}')}],
    [{op:'set',path:['tasks',{id:'task-welcome'},'extra'],after:[{id:'duplicate'},{id:'duplicate'}]}],
    [{op:'set',path:titlePath,after:'new',unexpected:true}],
    [{op:'set',path:['tasks',{id:'task-welcome'},'activity',{id:'a-welcome'}],before:base.tasks[0].activity[0]}]
  ];
  for (const changes of invalid) assert.throws(() => applyChanges(base, changes), {status:400});
  assert.deepEqual(base, before); assert.equal({}.polluted, undefined);
});

test('拒绝超大、过深、循环、访问器和重复实体的数据', () => {
  const base = seedState();
  assert.throws(() => applyChanges(base, Array.from({length:10001}, () => change(titlePath,'old','new'))), {status:400});
  assert.throws(() => applyChanges(base, [change(titlePath,'old','x'.repeat(16*1024*1024))]), {status:400});
  let nested = {}; for (let index=0; index<40; index++) nested = {child:nested};
  assert.throws(() => applyChanges(base, [change(titlePath,'old',nested)]), {status:400});
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => applyChanges(base, [change(titlePath,'old',cyclic)]), {status:400});
  let getterRan = false; const accessor = {};
  Object.defineProperty(accessor,'value',{enumerable:true,get(){getterRan=true; return 'unsafe';}});
  assert.throws(() => applyChanges(base, [change(titlePath,'old',accessor)]), {status:400});
  assert.equal(getterRan,false);
  const duplicate = copy(base); duplicate.tasks.push(copy(duplicate.tasks[0]));
  assert.throws(() => createChanges(base, duplicate), {status:400});
});
