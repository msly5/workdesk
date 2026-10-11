import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp.mjs';

// Bridge to the running workspace: never open a second Store in another process.
const endpoint=new URL(process.env.WORKDESK_MCP_URL || 'http://127.0.0.1:4317/mcp');
if(endpoint.protocol!=='http:' || !['127.0.0.1','localhost'].includes(endpoint.hostname) || endpoint.pathname!=='/mcp') {
  console.error('WORKDESK_MCP_URL 必须是本机工作台的 http://127.0.0.1:端口/mcp 地址。');
  process.exit(1);
}
const client=new Client({name:'workdesk-stdio-bridge',version:'0.2.0'});
const transport=new StreamableHTTPClientTransport(endpoint);
let server;
try {
  await client.connect(transport,{timeout:10000});
  server=createMcpServer({invoke:async(name,args)=>{
    const result=await client.callTool({name,arguments:args},undefined,{timeout:30000});
    if(result.isError)throw new Error(result.content?.find(c=>c.type==='text')?.text||'本地工作台操作失败');
    return result.structuredContent||JSON.parse(result.content[0].text);
  }});
  await server.connect(new StdioServerTransport());
}catch(error){
  console.error('无法连接本地工作台。请先双击 '+(process.platform==='darwin'?'start.command':'start.cmd')+'，确认 '+endpoint.origin+' 可以打开。\n'+error.message);
  await client.close().catch(()=>{});process.exit(1);
}
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await server.close().catch(()=>{});await client.close().catch(()=>{});}
process.on('SIGINT',()=>stop().finally(()=>process.exit(0)));
process.on('SIGTERM',()=>stop().finally(()=>process.exit(0)));
process.stdin.on('end',()=>stop().finally(()=>process.exit(0)));
