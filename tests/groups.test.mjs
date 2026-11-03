import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store, validateState} from '../storage.mjs';
import {seedState} from '../seed.mjs';
import {createChanges, applyChanges} from '../public/changes.js';
import {mergeStates} from '../public/model.js';
import {createApp} from '../server.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function directory(t) {
  const dir=await mkdtemp(path.join(tmpdir(),'workdesk-groups-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));return dir;
}

test('legacy workspaces gain empty groups without changing tasks; grouping survives a restart',async t=>{
  const dir=await directory(t),legacy=seedState();delete legacy.groups;
  await writeFile(path.join(dir,'state.json'),JSON.stringify(legacy));
  const store=new Store(dir);await store.init();const base=await store.read();
  assert.deepEqual(base.tasks,legacy.tasks);assert.deepEqual(base.groups,[]);
  const local=structuredClone(base);local.groups.push({id:'work',name:'Work'});local.tasks[0].groupId='work';
  await store.patch(createChanges(base,local));
  const reopened=new Store(dir);await reopened.init();const saved=await reopened.read();
  assert.equal(saved.tasks[0].groupId,'work');assert.deepEqual(saved.groups,local.groups);
  assert.deepEqual(saved.tasks[0].nodes,legacy.tasks[0].nodes);
});

test('group validation rejects duplicates and dangling membership',()=>{
  const base=seedState();base.groups=[{id:'work',name:'Work'}];base.tasks[0].groupId='work';
  assert.doesNotThrow(()=>validateState(base));
  for (const groups of [null,[{id:'work',name:' '}],[{id:'work',name:'Work'},{id:'other',name:'work'}],[{id:'work',name:'Work'},{id:'work',name:'Other'}],[]]) {
    assert.throws(()=>validateState({...base,groups}));
  }
});

test('independent group edits merge; deletion racing a new membership conflicts in either order',()=>{
  const base=seedState();base.groups=[{id:'work',name:'Work'}];
  const left=structuredClone(base),right=structuredClone(base);
  left.groups.push({id:'personal',name:'Personal'});right.groups[0].name='Projects';
  const merged=applyChanges(applyChanges(base,createChanges(base,left)),createChanges(base,right));
  assert.equal(merged.groups.length,2);assert.equal(merged.groups.find(g=>g.id==='work').name,'Projects');
  const removed=structuredClone(base),assigned=structuredClone(base);
  removed.groups=[];assigned.tasks[0].groupId='work';
  for (const [first,second] of [[removed,assigned],[assigned,removed]]) {
    assert.throws(()=>applyChanges(first,createChanges(base,second)),{status:409});
    assert.throws(()=>mergeStates(base,first,second),{status:409});
  }
  // Patches generated from a legacy state still address new groups by ID.
  const legacy=seedState();delete legacy.groups;
  assert.equal(applyChanges(legacy,createChanges(legacy,left)).groups.length,2);
});

test('MCP can create, rename, filter, move and remove groups while preserving task content',async t=>{
  const dir=await directory(t),server=await createApp({dataDir:dir});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=new Client({name:'groups-test',version:'1'});
  t.after(async()=>{await client.close();await new Promise(resolve=>server.close(resolve));});
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+server.address().port+'/mcp')));
  const raw=(name,args={})=>client.callTool({name,arguments:args});
  const call=async(name,args={})=>{const result=await raw(name,args);assert.ok(!result.isError,result.content?.[0]?.text);return result.structuredContent;};
  for (const name of ['list_groups','create_group','update_group','delete_group']) assert.ok((await client.listTools()).tools.some(tool=>tool.name===name));
  const group=(await call('create_group',{name:'  Work  '})).group;
  assert.equal(group.name,'Work');
  assert.equal((await raw('create_group',{name:'work'})).isError,true);
  const task=(await call('create_task',{title:'Grouped task',group_id:group.id})).task;
  const card=(await call('create_card',{task_id:task.id,type:'note',title:'Keep this',content:'User content'})).card;
  assert.equal((await call('list_groups')).groups[0].taskCount,1);
  assert.equal((await call('list_tasks',{group_id:group.id})).tasks[0].id,task.id);
  assert.ok(!(await call('list_tasks',{group_id:null})).tasks.some(item=>item.id===task.id));
  assert.equal((await raw('update_task',{task_id:task.id,group_id:'missing'})).isError,true);
  await call('update_task',{task_id:task.id,group_id:null});
  assert.equal((await call('list_groups')).groups[0].taskCount,0);
  await call('update_task',{task_id:task.id,group_id:group.id,status:'archived'});
  await call('update_group',{group_id:group.id,name:'Projects'});
  assert.equal((await call('list_groups')).groups[0].name,'Projects');
  assert.equal((await raw('delete_group',{group_id:group.id,expected_revision:0})).isError,true);
  const removed=await call('delete_group',{group_id:group.id});
  assert.deepEqual(removed.movedTaskIds,[task.id]);
  const kept=(await call('get_task',{task_id:task.id})).task;
  assert.equal(kept.groupId,null);assert.equal(kept.status,'archived');assert.deepEqual(kept.nodes,[card]);
  assert.deepEqual((await call('list_groups')).groups,[]);
});
