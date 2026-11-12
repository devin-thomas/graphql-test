/** Full end-to-end GraphQL tests run after npm install (e.g. in CI). */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { CaseStore } from '../src/store.ts';
import { makeApp } from '../src/server.ts';

const token = 'local-test-only-bearer-token-123456789';
const dir = mkdtempSync(join(tmpdir(),'casegraph-api-'));
const store = new CaseStore(join(dir,'db.sqlite'));
const server = makeApp(store);
let base: string;

before(async () => {
  process.env.CASEGRAPH_WRITE_TOKEN = token;
  await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve,reject)=>server.close((e)=>e?reject(e):resolve()));
  store.close();
  rmSync(dir,{recursive:true,force:true});
  delete process.env.CASEGRAPH_WRITE_TOKEN;
});

async function operation(query: string,variables={},auth=false) {
  const res=await fetch(`${base}/graphql`,{
    method:'POST',
    headers: { 'Content-Type':'application/json', 'Accept':'application/graphql-response+json, application/json;q=0.9',...(auth?{Authorization:`Bearer ${token}`}:{})},
    body: JSON.stringify({query,variables})
  });
  return {status:res.status,requestId:res.headers.get('x-request-id'),body:await res.json()};
}

test('read-only GraphQL query returns nested customer/assignee/event relations',async()=>{
 const r=await operation('{ cases(first: 2) { totalCount edges { node { id subject customer { name } assignee { name } events { type } } } pageInfo { hasNextPage endCursor } } }');
 assert.equal(r.status,200);
 assert.equal(r.body.data.cases.totalCount,7);
 assert.equal(r.body.data.cases.edges.length,2);
 assert.equal(r.body.data.cases.edges[0].node.customer.name,'Northstar Logistics');
 assert.ok(r.requestId);
});

test('cursor pagination returns nonoverlapping case windows',async()=>{
 const a=await operation('{cases(first: 2) {edges {node {id}} pageInfo {endCursor}}}');
 const after=a.body.data.cases.pageInfo.endCursor;
 const b=await operation('query($after:String){cases(first:2,after:$after){edges{node{id}}}}',{after});
 assert.deepEqual(a.body.data.cases.edges.map((e:{node:{id:string}})=>e.node.id),['1','2']);
 assert.deepEqual(b.body.data.cases.edges.map((e:{node:{id:string}})=>e.node.id),['3','4']);
});

test('GraphQL schema validation error reports missing fields',async()=>{
 const r=await operation('{ cases(first: 1) { edges { node { nonexistentField } } } }');
 assert.ok(r.body.errors?.length);
 assert.match(r.body.errors[0].message,/Cannot query field/);
});

test('mutations require a token',async()=>{
 const query='mutation {addCaseNote(id:"1",message:"private") {id}}';
 const r=await operation(query);
 assert.equal(r.body.errors[0].extensions.code,'UNAUTHENTICATED');
 assert.equal(store.events(1).length,1);
});

test('authorized GraphQL mutations write and can be queried',async()=>{
 const query='mutation($input:CreateCaseInput!){createCase(input:$input){id subject customer{name} status}}';
 const created=await operation(query,{input:{customerId:'1',subject:'Fresh API bug',description:'Auth fails after refresh',severity:'HIGH'}},true);
 assert.equal(created.body.data.createCase.subject,'Fresh API bug');
 const id=created.body.data.createCase.id;
 const updated=await operation('mutation($id:ID!){updateCaseStatus(id:$id,status:IN_PROGRESS){id status}}',{id},true);
 assert.equal(updated.body.data.updateCaseStatus.status,'IN_PROGRESS');
 const assigned=await operation('mutation($id:ID!){assignCase(id:$id,agentId:"2"){assignee{name}}}',{id},true);
 assert.equal(assigned.body.data.assignCase.assignee.name,'Jordan Chen');
 const noted=await operation('mutation($id:ID!){addCaseNote(id:$id,message:"Reproduced 401"){message}}',{id},true);
 assert.equal(noted.body.data.addCaseNote.message,'Reproduced 401');
 const detail=await operation('query($id:ID!){case(id:$id){events{type}status}}',{id});
 assert.equal(detail.body.data.case.events.length,4);
});

test('domain-level errors include structured extensions',async()=>{
 const r=await operation('mutation {updateCaseStatus(id:"999999",status:RESOLVED){id}}',{},true);
 assert.equal(r.body.errors[0].extensions.code,'NOT_FOUND');
 assert.ok(r.body.errors[0].extensions.requestId);
});

test('serves dashboard and health endpoint',async()=>{
 const [home,health]=await Promise.all([fetch(base),fetch(`${base}/healthz`)]);
 assert.equal(home.status,200);
 assert.match(await home.text(),/CaseGraph/);
 assert.equal((await health.json()).status,'ok');
});
