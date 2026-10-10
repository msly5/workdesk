import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function fixture(t) {
  const { createApp } = await import('../server.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'workdesk-mcp-'));
  const server = await createApp({dataDir:dir});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const client = new Client({name:'workdesk-test-agent',version:'1.0.0'});
  t.after(async () => { await client.close(); await new Promise(resolve => server.close(resolve)); await rm(dir,{recursive:true,force:true}); });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp')));
  const call = async (name,args = {}) => {
    const result = await client.callTool({name,arguments:args});
    assert.ok(!result.isError,result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  return {client,call,url,dir};
}

test('真实 MCP 客户端完成任务、文档、待办、连线、附件的完整操作并在网页 API 可见', async t => {
  const {client,call,url,dir} = await fixture(t);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ['list_tasks','get_task','create_task','update_task','create_card','update_card','delete_card','set_todo_item','remove_todo_item','connect_cards','delete_connection','attach_file']) assert.ok(names.includes(name),name);
  const created = await call('create_task',{title:'智能体验收',goal:'验证本地协作'});
  const task_id = created.task.id;
  const doc = (await call('create_card',{task_id,type:'markdown',title:'工作记录',content:'# 第一版'})).card;
  const todo = (await call('create_card',{task_id,type:'todo',title:'行动清单',items:[{text:'检查资料',done:false}]})).card;
  const note = (await call('create_card',{task_id,type:'note',title:'想法',content:'随后移除',color:'blue'})).card;
  const link = (await call('create_card',{task_id,type:'link',title:'参考',url:'https://example.com'})).card;
  await call('update_card',{task_id,card_id:doc.id,content:'# 更新后的记录\n\n来自 AI'});
  await call('update_task',{task_id,next_action:'审核更新',status:'waiting'});
  await call('set_todo_item',{task_id,card_id:todo.id,item_id:todo.items[0].id,done:true});
  const added = await call('set_todo_item',{task_id,card_id:todo.id,text:'暂时添加'});
  await call('remove_todo_item',{task_id,card_id:todo.id,item_id:added.item.id});
  const edge = (await call('connect_cards',{task_id,source:doc.id,target:todo.id,label:'落实为行动'})).edge;
  const removedEdge = (await call('connect_cards',{task_id,source:note.id,target:link.id})).edge;
  await call('delete_connection',{task_id,connection_id:removedEdge.id});
  await call('delete_card',{task_id,card_id:note.id});
  const bytes = Buffer.from('由智能体添加的本地附件');
  const file = (await call('attach_file',{task_id,name:'资料.txt',mime:'text/plain',base64:bytes.toString('base64')})).card;
  assert.deepEqual(Buffer.from(await (await fetch(url + '/api/files/' + file.assetId)).arrayBuffer()),bytes);
  const fetched = await call('get_task',{task_id});
  assert.equal(fetched.task.status,'waiting');
  assert.equal(fetched.task.nodes.find(n => n.id === todo.id).items[0].done,true);
  assert.deepEqual(fetched.task.edges.map(e=>e.id),[edge.id]);
  assert.equal((await call('get_card',{task_id,card_id:doc.id})).card.content,'# 更新后的记录\n\n来自 AI');
  assert.equal((await call('list_cards',{task_id,type:'markdown'})).cards.length,1);
  assert.equal((await call('list_tasks',{query:'智能体验收'})).tasks.length,1);
  assert.equal(await readFile(path.join(dir,'tasks',task_id,'docs',doc.id+'.md'),'utf8'),'# 更新后的记录\n\n来自 AI');
  const state = await (await fetch(url+'/api/state')).json();
  assert.equal(state.tasks.find(t=>t.id===task_id).nextAction,'审核更新');
  const resource = await client.readResource({uri:'workdesk://tasks/'+task_id});
  assert.equal(JSON.parse(resource.contents[0].text).task.id,task_id);
  await call('update_task',{task_id,status:'archived'});
  assert.equal((await call('list_tasks',{status:'archived',query:'智能体验收'})).tasks.length,1);
});

test('MCP 错误可读、修改原子化、拒绝跨站和非法参数', async t => {
  const {client,call,url} = await fixture(t);
  const task_id = (await call('create_task',{title:'并发验收'})).task.id;
  const results = await Promise.all(Array.from({length:6},(_,i)=>call('create_card',{task_id,type:'note',title:'卡片 '+i})));
  assert.equal((await call('get_task',{task_id})).task.nodes.length,6);
  for (const args of [{task_id:'../outside',card_id:results[0].card.id},{task_id,card_id:'missing'}]) {
    const error = await client.callTool({name:'delete_card',arguments:args});
    assert.equal(error.isError,true);
  }
  const badUrl = await client.callTool({name:'create_card',arguments:{task_id,type:'link',title:'无效链接',url:'javascript:alert(1)'}});
  assert.equal(badUrl.isError,true);
  const stale = await client.callTool({name:'update_task',arguments:{task_id,title:'旧版覆盖',expected_revision:0}});
  assert.equal(stale.isError,true);
  assert.equal((await call('get_task',{task_id})).task.title,'并发验收');
  const response = await fetch(url+'/mcp',{method:'POST',headers:{Origin:'https://example.org','Content-Type':'application/json'},body:'{}'});
  assert.equal(response.status,403);
});

test('网页与 AI 修改不同字段时合并，同一字段冲突时保留服务端内容', async t => {
  const {call,url} = await fixture(t);
  const base = await (await fetch(url+'/api/state')).json();
  const local = structuredClone(base);
  local.tasks[0].title = '网页新标题';
  await call('update_task',{task_id:base.tasks[0].id,next_action:'AI 安排的行动'});
  const saved = await fetch(url+'/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:local,base})});
  assert.equal(saved.status,200);
  const merged = (await saved.json()).state;
  assert.equal(merged.tasks[0].title,'网页新标题');
  assert.equal(merged.tasks[0].nextAction,'AI 安排的行动');
  const conflicting = structuredClone(merged); conflicting.tasks[0].title='另一份网页标题';
  await call('update_task',{task_id:merged.tasks[0].id,title:'AI 新标题'});
  const conflict = await fetch(url+'/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:conflicting,base:merged})});
  assert.equal(conflict.status,409);
  assert.equal((await call('get_task',{task_id:merged.tasks[0].id})).task.title,'AI 新标题');
});

test('stdio 桥接同一个本地服务，输出符合协议且修改在 HTTP 可见', async t => {
  const {url,call}=await fixture(t);
  const bridge=new Client({name:'stdio-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('mcp-stdio.mjs')],env:{WORKDESK_MCP_URL:url+'/mcp'},stderr:'pipe'});
  t.after(()=>bridge.close());
  await bridge.connect(transport);
  const result=await bridge.callTool({name:'create_task',arguments:{title:'stdio 新任务'}});
  assert.ok(!result.isError,result.content?.[0]?.text);
  const task=JSON.parse(result.content[0].text).task;
  assert.equal((await call('get_task',{task_id:task.id})).task.title,'stdio 新任务');
  const resources=await bridge.listResources();
  assert.ok(resources.resources.some(r=>r.uri==='workdesk://tasks'));
  await bridge.close();
});

test('MCP 新建和修改本地文件夹引用，保存后网页可见，支持切回网页链接', async t => {
  const {call,url,client} = await fixture(t);
  const task_id = (await call('create_task',{title:'文件夹引用验收'})).task.id;
  const folder = (await call('create_card',{task_id,type:'link',title:'工作资料',folder_path:'D:\\项目资料'})).card;
  assert.equal(folder.localFolder,true); assert.equal(folder.folderPath,'D:\\项目资料');
  await call('update_card',{task_id,card_id:folder.id,folder_path:'C:\\资料 中文 空格'});
  const state = await (await fetch(url+'/api/state')).json();
  assert.equal(state.tasks.find(task=>task.id===task_id).nodes[0].folderPath,'C:\\资料 中文 空格');
  for(const args of [{task_id,type:'note',title:'错误类型',folder_path:'D:\\资料'},{task_id,type:'link',title:'地址冲突',folder_path:'D:\\资料',url:'https://example.com'}]) {
    assert.equal((await client.callTool({name:'create_card',arguments:args})).isError,true);
  }
  const web = (await call('update_card',{task_id,card_id:folder.id,url:'https://example.com'})).card;
  assert.equal(web.localFolder,false); assert.equal(web.folderPath,undefined); assert.equal(web.url,'https://example.com');
});
