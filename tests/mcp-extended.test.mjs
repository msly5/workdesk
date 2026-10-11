import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createApp} from '../server.mjs';

async function fixture(t) {
  const dir=await mkdtemp(path.join(tmpdir(),'workdesk-mcp-extended-'));
  const server=await createApp({dataDir:dir});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  const client=new Client({name:'extended-mcp-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(url+'/mcp')));
  t.after(async()=>{await client.close();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const raw=(name,args={})=>client.callTool({name,arguments:args});
  const call=async(name,args={})=>{
    const result=await raw(name,args);
    assert.ok(!result.isError,result.content?.[0]?.text);
    return result.structuredContent;
  };
  const task_id=(await call('create_task',{title:'扩展 MCP 验收'})).task.id;
  return {client,call,raw,task_id,url,dir};
}

test('MCP defaults leave task categories localizable and add an English copy suffix without rewriting user text',async t=>{
  const {call,task_id}=await fixture(t);
  assert.equal((await call('get_task',{task_id})).task.tag,'');
  const explicit=(await call('create_task',{title:'用户任务',tag:'用户分类'})).task;
  assert.equal(explicit.tag,'用户分类');
  const source=(await call('create_card',{task_id,type:'note',title:'用户标题'})).card;
  const longTitle='A'.repeat(500);
  const long=(await call('create_card',{task_id,type:'note',title:longTitle})).card;
  const copies=(await call('batch_cards',{task_id,operations:[
    {operation:'duplicate',card_id:source.id},
    {operation:'duplicate',card_id:source.id,title:'用户副本标题'},
    {operation:'duplicate',card_id:long.id}
  ]})).results.map(result=>result.card);
  assert.equal(copies[0].title,'用户标题 · Copy');
  assert.equal(copies[1].title,'用户副本标题');
  assert.equal(copies[2].title,longTitle.slice(0,493)+' · Copy');
  assert.equal(copies[2].title.length,500);
  assert.equal((await call('get_card',{task_id,card_id:source.id})).card.title,'用户标题');
  assert.equal((await call('get_card',{task_id,card_id:long.id})).card.title,longTitle);
});

test('4 MiB 合法 base64 可上传，非法编码和旧版本不写入附件',async t=>{
  const {call,raw,task_id,url,dir}=await fixture(t);
  const bytes=Buffer.alloc(4*1024*1024,0xa5);
  const uploaded=await call('attach_file',{task_id,name:'limit.bin',base64:bytes.toString('base64')});
  const downloaded=Buffer.from(await (await fetch(url+'/api/files/'+uploaded.card.assetId)).arrayBuffer());
  assert.deepEqual(downloaded,bytes);
  const files=await readFile(path.join(dir,'files.json'),'utf8');
  for(const base64 of ['A===','AA=A','AAAA====','AB==',Buffer.alloc(4*1024*1024+1).toString('base64')]) {
    assert.equal((await raw('attach_file',{task_id,name:'invalid.bin',base64})).isError,true);
  }
  const stale=await raw('attach_file',{task_id,name:'stale.txt',base64:'dGVzdA==',expected_revision:0});
  assert.equal(stale.isError,true);
  assert.equal(await readFile(path.join(dir,'files.json'),'utf8'),files);
});

test('附件按字节有界读取，UTF-8 续页不切裂中文或 emoji，拒绝跨任务和本地路径',async t=>{
  const {call,raw,task_id}=await fixture(t);
  const source='甲😀乙\n'.repeat(4);
  const text=(await call('attach_file',{task_id,name:'资料.txt',mime:'text/plain',base64:Buffer.from(source).toString('base64')})).card;
  let offset=0,decoded='',chunks=[];
  do {
    const chunk=await call('read_attachment',{task_id,asset_id:text.assetId,offset,limit:5});
    assert.equal(chunk.offset,offset);
    assert.ok(chunk.next_offset>offset);
    assert.ok(chunk.next_offset-offset<=5);
    assert.equal(chunk.text.includes('\ufffd'),false);
    decoded+=chunk.text;chunks.push(Buffer.from(chunk.base64,'base64'));
    offset=chunk.next_offset;
    if(!chunk.has_more)break;
  }while(true);
  assert.equal(decoded,source);
  assert.deepEqual(Buffer.concat(chunks),Buffer.from(source));
  const end=await call('read_attachment',{task_id,asset_id:text.assetId,offset});
  assert.equal(end.base64,'');assert.equal(end.has_more,false);
  assert.equal((await raw('read_attachment',{task_id,asset_id:text.assetId,offset:offset+1})).isError,true);
  assert.equal((await raw('read_attachment',{task_id,asset_id:text.assetId,limit:4*1024*1024+1})).isError,true);
  const binary=Buffer.from([0,255,128,1,2,3,4,5,6]);
  const asset=(await call('attach_file',{task_id,name:'bytes.bin',base64:binary.toString('base64')})).card.assetId;
  const chunk=await call('read_attachment',{task_id,asset_id:asset,offset:2,limit:4});
  assert.deepEqual(Buffer.from(chunk.base64,'base64'),binary.subarray(2,6));
  assert.equal(chunk.has_more,true);assert.equal(chunk.next_offset,6);assert.equal(chunk.total_bytes,binary.length);
  const other=(await call('create_task',{title:'另一个任务'})).task.id;
  assert.equal((await raw('read_attachment',{task_id:other,asset_id:asset})).isError,true);
  assert.equal((await raw('read_attachment',{task_id,asset_id:'missing'})).isError,true);
  assert.equal((await raw('read_attachment',{task_id,asset_id:asset,file_path:'/etc/hosts'})).isError,true);
});

test('卡片批次按序支持别名和复制，只增加一次版本；任一操作失败不保留部分修改',async t=>{
  const {call,raw,task_id,dir}=await fixture(t);
  const before=await call('get_task',{task_id});
  const result=await call('batch_cards',{task_id,expected_revision:before.revision,operations:[
    {operation:'create',type:'markdown',title:'文档',content:'初稿',ref:'document'},
    {operation:'update',card_ref:'document',content:'修订'},
    {operation:'duplicate',card_ref:'document',title:'副本',ref:'copy'},
    {operation:'delete',card_ref:'document'}
  ]});
  assert.equal(result.revision,before.revision+1);
  assert.equal(result.results[0].card.content,'初稿');
  const task=(await call('get_task',{task_id})).task;
  assert.equal(task.nodes.length,1);assert.equal(task.nodes[0].content,'修订');
  assert.equal(task.nodes[0].id,result.refs.copy);
  const todo=(await call('create_card',{task_id,type:'todo',title:'待办',items:[{text:'原事项'}]})).card;
  const duplicate=await call('batch_cards',{task_id,operations:[{operation:'duplicate',card_id:todo.id}]});
  assert.notEqual(duplicate.results[0].card.items[0].id,todo.items[0].id);
  const stable=await call('get_task',{task_id});
  const disk=await readFile(path.join(dir,'state.json'),'utf8');
  const cases=[
    [{operation:'update',card_id:task.nodes[0].id,content:'不该保存'},{operation:'delete',card_id:'missing'}],
    [{operation:'create',type:'note',title:'一',ref:'same'},{operation:'create',type:'note',title:'二',ref:'same'}],
    [{operation:'delete',card_ref:'future'},{operation:'create',type:'note',title:'后创建',ref:'future'}],
    [{operation:'update',card_id:todo.id,card_ref:'ambiguous',title:'无效'}],
    Array.from({length:101},()=>({operation:'create',type:'note',title:'超量'})),
    Array.from({length:4},()=>({operation:'create',type:'markdown',title:'过大批次',content:'中'.repeat(200000)}))
  ];
  for(const operations of cases)assert.equal((await raw('batch_cards',{task_id,operations})).isError,true);
  assert.equal((await raw('batch_cards',{task_id,expected_revision:0,operations:[{operation:'delete',card_id:todo.id}]})).isError,true);
  assert.deepEqual(await call('get_task',{task_id}),stable);
  assert.equal(await readFile(path.join(dir,'state.json'),'utf8'),disk);
});

test('卡片和任务统一搜索待办，卡片分页及任务资源 next_uri 无遗漏',async t=>{
  const {call,client,task_id,url}=await fixture(t);
  const operations=Array.from({length:55},(_,i)=>({operation:'create',type:'todo',title:'待办 '+i,items:[{text:'search-only-item '+i}]}));
  await call('batch_cards',{task_id,operations});
  const first=await call('list_cards',{task_id,query:'search-only-item'});
  assert.equal(first.total,55);assert.equal(first.cards.length,50);assert.equal(first.next_offset,50);
  assert.equal(first.cards[0].preview,'[ ] search-only-item 0');
  const last=await call('list_cards',{task_id,query:'search-only-item',offset:first.next_offset});
  assert.equal(last.cards.length,5);assert.equal(last.has_more,false);assert.equal(last.next_offset,null);
  assert.equal(new Set([...first.cards,...last.cards].map(card=>card.id)).size,55);
  assert.equal((await call('list_tasks',{query:'search-only-item'})).total,1);
  const state=await (await fetch(url+'/api/state')).json();
  const original=state.tasks.find(task=>task.id===task_id);
  for(let i=0;i<55;i++)state.tasks.push({...structuredClone(original),id:'extra-'+i,title:'额外任务 '+i,nodes:[],edges:[]});
  assert.equal((await fetch(url+'/api/state',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({state})})).status,200);
  const resource=JSON.parse((await client.readResource({uri:'workdesk://tasks'})).contents[0].text);
  assert.equal(resource.tasks.length,50);assert.ok(resource.next_uri);
  const remaining=JSON.parse((await client.readResource({uri:resource.next_uri})).contents[0].text);
  assert.equal(resource.tasks.length+remaining.tasks.length,resource.total);
  assert.equal(remaining.has_more,false);
});

test('HTTP 与 stdio 的附件图片内容、工具和批量操作一致',async t=>{
  const {call,raw,client,task_id,url}=await fixture(t);
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1kAAAAASUVORK5CYII=';
  const asset=(await call('attach_file',{task_id,name:'pixel.png',mime:'image/png',base64:png})).card.assetId;
  const args={task_id,asset_id:asset};
  const httpResult=await raw('read_attachment',args);
  assert.deepEqual(httpResult.content.find(item=>item.type==='image'),{type:'image',data:png,mimeType:'image/png'});
  const unusualMime=(await call('attach_file',{task_id,name:'mime.png',mime:'IMAGE/PNG; charset=binary',base64:png})).card.assetId;
  assert.equal((await raw('read_attachment',{task_id,asset_id:unusualMime})).content.find(item=>item.type==='image').mimeType,'image/png');
  const bridge=new Client({name:'extended-stdio-test',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('mcp-stdio.mjs')],env:{WORKDESK_MCP_URL:url+'/mcp'},stderr:'pipe'});
  t.after(()=>bridge.close());
  await bridge.connect(transport);
  assert.deepEqual((await bridge.listTools()).tools.map(tool=>tool.name),(await client.listTools()).tools.map(tool=>tool.name));
  const stdioResult=await bridge.callTool({name:'read_attachment',arguments:args});
  assert.deepEqual(stdioResult,await raw('read_attachment',args));
  const result=await bridge.callTool({name:'batch_cards',arguments:{task_id,operations:[{operation:'create',type:'note',title:'stdio 新卡片'}]}});
  assert.ok(!result.isError,result.content[0]?.text);
  assert.ok((await call('get_task',{task_id})).task.nodes.some(card=>card.title==='stdio 新卡片'));
  const httpPage=await client.readResource({uri:'workdesk://tasks/pages/0/1'});
  assert.deepEqual(await bridge.readResource({uri:'workdesk://tasks/pages/0/1'}),httpPage);
  await bridge.close();
});
