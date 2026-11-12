import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaseStore, cursorFor, DomainError } from '../src/store.ts';

function setup() {
  const dir=mkdtempSync(join(tmpdir(),'casegraph-'));
  const path=join(dir,'cases.sqlite');
  const store=new CaseStore(path);
  return {store,path,cleanup(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('seeds synthetic support cases with relations',()=>{
 const s=setup();try {
  assert.equal(s.store.countCases(),7);
  assert.equal(s.store.customers().length,4);
  assert.equal(s.store.agents().length,3);
  const case1=s.store.getCase(1)!;
  assert.equal(case1.customerId,1);
  assert.equal(case1.severity,'CRITICAL');
  assert.equal(s.store.events(1).length,1);
 }finally{s.cleanup();}
});

test('filtering and stable cursor pagination preserve totalCount',()=>{
 const s=setup();try {
  const page=s.store.cases({first:2});
  assert.equal(page.edges.length,2);
  assert.equal(page.totalCount,7);
  assert.equal(page.pageInfo.hasNextPage,true);
  const page2=s.store.cases({first:2,after:page.pageInfo.endCursor});
  assert.deepEqual(page2.edges.map(e=>e.node.id),[3,4]);
  assert.equal(s.store.cases({status:'NEW'}).totalCount,3);
  assert.equal(s.store.cases({severity:'HIGH'}).totalCount,3);
  assert.equal(s.store.cases({customerId:1}).totalCount,2);
  assert.equal(s.store.cases({search:'OAuth'}).totalCount,1);
  assert.equal(s.store.cases({search:'100%'}).totalCount,0);
  assert.throws(()=>s.store.cases({first:51}),/between 1 and 50/);
  assert.throws(()=>s.store.cases({after:'invalid'}),/pagination cursor/);
  assert.equal(page.edges[0].cursor,cursorFor(1));
 }finally{s.cleanup();}
});

test('authenticated mutators can create, assign, change status, add notes; timeline persists after restart',()=>{
 const s=setup(); let id=0;
 try {
  const record=s.store.createCase({customerId:3,subject:' Broken API ',description:'REST 503s after deploy',severity:'HIGH'},'Devin');
  id=record.id;
  assert.equal(record.subject,'Broken API');
  assert.equal(record.status,'NEW');
  assert.equal(s.store.assign(id,2,'Devin').assignedAgentId,2);
  assert.equal(s.store.updateStatus(id,'IN_PROGRESS','Devin').status,'IN_PROGRESS');
  const note=s.store.addNote(id,'Checked traces and request IDs','Devin');
  assert.equal(note.type,'NOTE');
  assert.deepEqual(s.store.events(id).map(e=>e.type),['CREATED','ASSIGNED','STATUS_CHANGED','NOTE']);
  assert.throws(()=>s.store.updateStatus(id,'IN_PROGRESS','Devin'),(e:unknown)=>e instanceof DomainError&&e.code==='CONFLICT');
  assert.throws(()=>s.store.assign(id,999,'Devin'),(e:unknown)=>e instanceof DomainError&&e.code==='NOT_FOUND');
  assert.throws(()=>s.store.createCase({customerId:1,subject:'',description:'Oops',severity:'HIGH'},'Devin'),/subject/);
  s.store.close();
  const again=new CaseStore(s.path);
  try {assert.equal(again.getCase(id)?.subject,'Broken API');assert.equal(again.events(id).length,4);} finally {again.close();}
 }finally {rmSync(join(s.path,'..'),{recursive:true,force:true});}
});

test('metrics change when case is resolved',()=>{
 const s=setup();try {
  assert.deepEqual(s.store.metrics(),{total:7,new:3,inProgress:2,waiting:1,resolved:1});
  s.store.updateStatus(6,'RESOLVED','Devin');
  assert.equal(s.store.metrics().resolved,2);
 }finally{s.cleanup();}
});
