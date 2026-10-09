import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../seed.mjs';
import { validateState } from '../storage.mjs';
import { mergeStates, updateInPlace, applyFormChanges } from '../public/model.js';

test('连续移除相连卡片后，单独撤销一张也能保存', async () => {
  const { restoreCard } = await import('../public/model.js');
  const state=seedState(),task=state.tasks[0];
  const a=task.nodes[0],b=task.nodes[1];
  const edges=task.edges.filter(e=>e.source===a.id||e.target===a.id);
  task.nodes=task.nodes.filter(n=>n.id!==a.id&&n.id!==b.id);
  task.edges=task.edges.filter(e=>![a.id,b.id].includes(e.source)&&![a.id,b.id].includes(e.target));
  restoreCard(task,0,a,edges);
  assert.doesNotThrow(()=>validateState(state));
  assert.ok(task.nodes.some(n=>n.id===a.id));
  assert.ok(task.edges.every(e=>e.target!==b.id&&e.source!==b.id));
});

test('普通撤销恢复卡片和有效连线，不产生重复连线', async () => {
  const { restoreCard } = await import('../public/model.js');
  const state=seedState(),task=state.tasks[0],node=task.nodes.shift();
  const edges=task.edges.filter(e=>e.source===node.id||e.target===node.id);
  task.edges=task.edges.filter(e=>!edges.includes(e));
  restoreCard(task,0,node,edges);
  assert.doesNotThrow(()=>validateState(state));
  assert.equal(task.edges.length,3);
  restoreCard(task,0,node,edges);
  assert.doesNotThrow(()=>validateState(state));
  assert.equal(task.edges.length,3);
  assert.equal(task.nodes.length,6);
});

test('同一清单的不同待办项、活动记录与新卡片能合并', () => {
  const base=seedState(),local=structuredClone(base),remote=structuredClone(base);
  const todo=local.tasks[0].nodes.find(n=>n.type==='todo');
  const other=remote.tasks[0].nodes.find(n=>n.id===todo.id);
  todo.items[0].done=true;other.items[1].text='AI 调整的行动';
  local.tasks[0].activity.unshift({id:'local-activity',text:'网页修改',at:'2026-10-09T11:00:00Z'});
  remote.tasks[0].activity.unshift({id:'remote-activity',text:'AI 修改',at:'2026-10-09T11:00:01Z'});
  remote.tasks[0].nodes.push({id:'remote-note',title:'新便签',type:'note',content:'',x:500,y:900,width:270});
  remote.revision++;
  const merged=mergeStates(base,local,remote),result=merged.tasks[0].nodes.find(n=>n.id===todo.id);
  assert.equal(result.items[0].done,true);assert.equal(result.items[1].text,'AI 调整的行动');
  assert.ok(merged.tasks[0].nodes.some(n=>n.id==='remote-note'));
  assert.ok(merged.tasks[0].activity.some(n=>n.id==='local-activity'));
  assert.ok(merged.tasks[0].activity.some(n=>n.id==='remote-activity'));
  assert.doesNotThrow(()=>validateState(merged));
});

test('编辑与删除同一卡片冲突时拒绝，不丢弃修改', () => {
  const base=seedState(),local=structuredClone(base),remote=structuredClone(base);
  const id=base.tasks[0].nodes[0].id;
  local.tasks[0].nodes[0].content='尚未保存的新内容';
  remote.tasks[0].nodes=remote.tasks[0].nodes.filter(n=>n.id!==id);
  remote.tasks[0].edges=remote.tasks[0].edges.filter(e=>e.source!==id&&e.target!==id);
  assert.throws(()=>mergeStates(base,local,remote),{status:409});
  assert.equal(local.tasks[0].nodes[0].content,'尚未保存的新内容');
});

test('采用保存结果时保留拖动卡片、连线对话框与待办对象引用', () => {
  const state=seedState(),task=state.tasks[0],card=task.nodes[0],edge=task.edges[0];
  const nodes=task.nodes,items=task.nodes.find(n=>n.type==='todo').items,item=items[0];
  const saved=structuredClone(state);saved.revision++;
  updateInPlace(state,saved);
  card.x=300;edge.label='对话框新标签';item.done=true;
  assert.equal(state.tasks[0],task);assert.equal(task.nodes,nodes);
  assert.equal(state.tasks[0].nodes[0].x,300);
  assert.equal(state.tasks[0].edges[0].label,'对话框新标签');
  assert.equal(task.nodes.find(n=>n.type==='todo').items,items);
  assert.equal(task.nodes.find(n=>n.type==='todo').items[0].done,true);
  assert.doesNotThrow(()=>validateState(state));
});

test('弹窗只保存用户实际修改的字段，同字段已更新时保留双方并拒绝覆盖', () => {
  const initial={title:'原任务',goal:'旧目标',nextAction:'旧行动'};
  const task={...initial,goal:'AI 新目标'};
  applyFormChanges(task,initial,{title:'网页改名',goal:'旧目标',nextAction:'旧行动'});
  assert.equal(task.title,'网页改名');assert.equal(task.goal,'AI 新目标');
  const nextInitial={...task};task.nextAction='AI 新行动';
  assert.throws(()=>applyFormChanges(task,nextInitial,{...nextInitial,nextAction:'网页新行动'}),{status:409});
  assert.equal(task.nextAction,'AI 新行动');
});
