// Loopback-only smoke tests: no live SiteFinder feed, credentials or campaign calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import proxyaddr from 'proxy-addr';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createSiteFinderMcpServer } from './mcp/sitefinder-mcp.js';

const feed={projects:[{Id:'mock-1',Name:'Synthetic school',MainContractor:'Mock contractor',MainContractorId:'mock-company',SiteClosed:false}]};
async function listen(server,t) {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return `http://127.0.0.1:${server.address().port}`;
}
async function check(client) {
  assert.equal((await client.listTools()).tools.length,5);
  const response=await client.callTool({name:'search_projects',arguments:{query:'Synthetic',limit:5}});
  assert.notEqual(response.isError,true);
  assert.equal(JSON.parse(response.content[0].text).projects[0].project_name,'Synthetic school');
}
test('updated MCP SDK supports stdio against a synthetic loopback feed',async t=>{
  const origin=await listen(createServer((req,res)=>{
    assert.equal(req.headers.authorization,undefined);
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify(req.url==='/health'?{ok:true}:feed));
  }),t);
  const transport=new StdioClientTransport({command:process.execPath,args:['mcp/stdio.js'],
    env:{PATH:process.env.PATH||'',SystemRoot:process.env.SystemRoot||'',SITEFINDER_URL:origin,SITEFINDER_MCP_TOKEN:''},stderr:'pipe'});
  const client=new Client({name:'synthetic-stdio-test',version:'1'});
  try {await client.connect(transport);await check(client);} finally {await client.close();}
});
test('updated MCP HTTP transport works with injected synthetic data',async t=>{
  const app=express();app.use(express.json());
  app.post('/mcp',async(req,res)=>{
    const server=createSiteFinderMcpServer({client:{origin:'http://example.invalid',listProjects:async()=>feed,health:async()=>({ok:true})}});
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on('close',()=>{void transport.close();void server.close();});
    await server.connect(transport);await transport.handleRequest(req,res,req.body);
  });
  const origin=await listen(createServer(app),t);
  const client=new Client({name:'synthetic-http-test',version:'1'});
  try {await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));await check(client);} finally {await client.close();}
});
test('proxy address checks reject addresses outside IPv4-mapped trusted subnets',()=>{
  const trust=proxyaddr.compile(['::ffff:192.0.2.0/120']);
  assert.equal(trust('192.0.2.5',0),true);
  assert.equal(trust('::ffff:192.0.2.5',0),true);
  assert.equal(trust('198.51.100.5',0),false);
  assert.equal(trust('::ffff:198.51.100.5',0),false);
});
test('one-hop Express proxy configuration ignores a forged earlier forwarding hop',async t=>{
  const app=express();app.set('trust proxy',1);app.get('/',(req,res)=>res.json({ip:req.ip}));
  const origin=await listen(createServer(app),t);
  const result=await fetch(origin,{headers:{'x-forwarded-for':'203.0.113.1, 198.51.100.2'}});
  assert.equal((await result.json()).ip,'198.51.100.2');
});
