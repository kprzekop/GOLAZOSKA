import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {PNG} from 'pngjs';
import jsQR from 'jsqr';
import * as shared from '../lib/shared.js';
let db,mails=[],fail=false;
function sql(){
 const tag=(strings,...values)=>{const text=strings.map((s,i)=>s+(i<values.length?'$'+(i+1):'')).join('');return {text,values,then(a,b){return db.query(text,values).then(r=>r.rows).then(a,b);}};};
 tag.query=(text,values=[])=>({text,values,then(a,b){return db.query(text,values).then(r=>r.rows).then(a,b);}});
 tag.transaction=queries=>db.transaction(async tx=>{const out=[];for(const q of queries)out.push((await tx.query(q.text,q.values)).rows);return out;});
 return tag;
}
mock.module('../lib/shared.js',{namedExports:{...shared,sql,sendMail:async(...args)=>{if(fail)throw Error('MAIL');mails.push(args);}}});
const {ADMISSION_SCHEMA}=await import('../lib/admission-schema.js');
const {TICKET_SCHEMA}=await import('../lib/ticket-schema.js');
const {ensureTickets,deliverTickets,qrPng,ticketPayload}=await import('../lib/tickets.js');
const {default:checkin}=await import('../api/checkin.js');
const {default:tickets}=await import('../api/tickets.js');
const base=await readFile(new URL('../db/schema.sql',import.meta.url),'utf8');
const fixed=s=>s.replaceAll('now()',"'2026-11-21 18:00+01'::timestamptz");
async function setup(){
 db=new PGlite();mails=[];fail=false;
 await db.exec(fixed(base));await db.exec(fixed(await readFile(new URL('../db/allocate-row-five.sql',import.meta.url),'utf8')));await db.exec(fixed(ADMISSION_SCHEMA));await db.exec(fixed(TICKET_SCHEMA));
 process.env.ADMIN_TOKEN='admin-test';process.env.CHECKIN_TOKEN='door-test';
}
let serial=0;
async function create(ids=['6-1','6-2'],confirm=true){
 const [r]=(await db.query('SELECT * FROM premiere_create($1,$2,$3,$4::text[],$5,$6)',['Jan Kowalski','qr'+(++serial)+'@example.com','600123456',ids,ids.length||2,!ids.length])).rows;
 if(confirm)await db.query("SELECT * FROM premiere_action($1,'confirm')",[r.booking_token]);
 return r;
}
async function call(handler,method='GET',body={},query={},auth=''){
 const req={method,body,query,headers:{authorization:auth}};
 const res={code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(body){return{code:this.code,body};},send(body){return{code:this.code,body,headers:this.headers};}};
 return handler(req,res);
}
test('QR: osobne wejściówki, PNG dekoduje się, e-mail zawiera obrazy i nie jest wysyłany ponownie',async()=>{
 await setup();try{
 const r=await create();const first=await ensureTickets(sql(),r.booking_id);const again=await ensureTickets(sql(),r.booking_id);
 assert.equal(first.length,2);assert.notEqual(first[0].id,first[1].id);assert.deepEqual(again,first);
 assert.deepEqual(await deliverTickets(sql(),r.booking_id),{sent:1,failed:0});assert.equal(mails.length,1);
 assert.equal(mails[0][3].length,2);assert.match(mails[0][2],/rząd 6, miejsce 1/);
 const png=PNG.sync.read(mails[0][3][0].content);
 const decoded=jsQR(new Uint8ClampedArray(png.data),png.width,png.height);
 assert.equal(decoded.data,ticketPayload(first[0].id));assert.doesNotMatch(decoded.data,/Kowalski|example|600123/);
 assert.deepEqual(await deliverTickets(sql(),r.booking_id),{sent:0,failed:0});
 }finally{await db.close();}
});
test('kontrola: osobne wejścia i atomowa blokada podwójnego skanu na dwóch telefonach',async()=>{
 await setup();try{
 const r=await create(),ts=await ensureTickets(sql(),r.booking_id);
 assert.equal((await call(checkin,'POST',{ticket:ts[0].id,action:'inspect'})).code,401);
 assert.equal((await call(checkin,'POST',{ticket:ts[0].id,action:'inspect'},{},'Bearer door-test')).body.result,'valid');
 const both=await Promise.all([0,1].map(()=>call(checkin,'POST',{ticket:ts[0].id,action:'enter'},{},'Bearer door-test')));
 assert.deepEqual(both.map(r=>r.body.result).sort(),['entered','used']);
 assert.equal((await call(checkin,'POST',{ticket:ts[1].id,action:'inspect'},{},'Bearer door-test')).body.result,'valid');
 assert.equal((await call(checkin,'GET',{}, {q:'Kowalski'},'Bearer door-test')).body.tickets.length,2);
 assert.equal((await call(tickets,'GET',{}, {token:r.booking_token})).body.tickets[0].used,true);
 await db.query("SELECT * FROM premiere_action($1,'cancel')",[r.booking_token]);
 assert.equal((await call(checkin,'POST',{ticket:ts[1].id,action:'enter'},{},'Bearer door-test')).body.result,'invalid');
 assert.equal((await call(tickets,'GET',{}, {ticket:ts[1].id})).code,404);
 }finally{await db.close();}
});
test('brak wejściówek dla niepotwierdzonych i listy rezerwowej; ponowienie maila po awarii',async()=>{
 await setup();try{
 const r=await create(['6-1'],false);
 assert.equal((await ensureTickets(sql(),r.booking_id)).length,0);
 assert.equal((await call(tickets,'GET',{}, {token:r.booking_token})).code,409);
 await db.query("SELECT * FROM premiere_action($1,'confirm')",[r.booking_token]);
 fail=true;assert.equal((await deliverTickets(sql(),r.booking_id)).failed,1);fail=false;
 assert.equal((await deliverTickets(sql(),r.booking_id)).sent,1);
 await db.query('UPDATE premiere_config SET standing_capacity=0');
 const wait=await create([],true);assert.equal((await ensureTickets(sql(),wait.booking_id)).length,0);
 assert.equal((await deliverTickets(sql(),wait.booking_id)).sent,0);
 }finally{await db.close();}
});
test('ten sam kod po przyjęciu foteli; osobna aktualizacja e-maila, anulowanie i upływ ważności blokują wejście',async()=>{
 await setup();try{
 const r=await create([],true),ts=await ensureTickets(sql(),r.booking_id);
 await deliverTickets(sql(),r.booking_id);
 await db.query('SELECT premiere_offer($1)',[r.booking_id]);
 let state=await call(checkin,'POST',{ticket:ts[0].id,action:'inspect'},{},'Bearer door-test');assert.equal(state.body.result,'valid');assert.equal(state.body.seat_id,null);
 await db.query("SELECT * FROM premiere_action($1,'confirm')",[r.booking_token]);
 assert.deepEqual((await ensureTickets(sql(),r.booking_id)).map(t=>t.id),ts.map(t=>t.id));
 assert.equal((await deliverTickets(sql(),r.booking_id)).sent,1);
 state=await call(checkin,'POST',{ticket:ts[0].id,action:'inspect'},{},'Bearer door-test');assert.equal(state.body.seat_id,'6-1');
 await db.exec(TICKET_SCHEMA.replaceAll('now()',"'2026-11-22 00:00+01'::timestamptz"));
 state=(await db.query('SELECT * FROM premiere_checkin($1,false)',[ts[0].id])).rows[0];assert.equal(state.result,'invalid');
 assert.equal(TICKET_SCHEMA,await readFile(new URL('../db/migrate-tickets.sql',import.meta.url),'utf8'));
 }finally{await db.close();}
});

test('62 zaproszenia organizatora: pełny plan 1–5, trwałe kody i wspólna kontrola wejścia',async()=>{
 await setup();try{
  const {randomUUID}=await import('node:crypto');
  const entries=[12,13,12,13,12].flatMap((n,i)=>Array.from({length:n},(_,j)=>({id:randomUUID(),seat:(i+1)+'-'+(j+1)})));
  process.env.ORGANIZATIONAL_TICKETS_JSON=JSON.stringify(entries);
  const inspected=await call(checkin,'POST',{ticket:entries[0].id,action:'inspect'},{},'Bearer door-test');
  assert.equal(inspected.code,200);assert.equal(inspected.body.result,'valid');assert.equal(inspected.body.seat_id,'1-1');
  assert.equal((await db.query('SELECT count(*)::int n FROM premiere_organizational_tickets')).rows[0].n,62);
  for(const entry of entries){const [r]=(await db.query('SELECT * FROM premiere_checkin_org($1,false)',[entry.id])).rows;assert.equal(r.result,'valid');assert.equal(r.seat_id,entry.seat);}
  const both=await Promise.all([0,1].map(()=>call(checkin,'POST',{ticket:entries[0].id,action:'enter'},{},'Bearer door-test')));
  assert.deepEqual(both.map(r=>r.body.result).sort(),['entered','used']);
  assert.equal((await call(checkin,'GET',{}, {q:'rząd 1'},'Bearer door-test')).body.tickets.length,12);
  assert.equal((await db.query("SELECT count(*)::int n FROM premiere_seats WHERE pool='public'")).rows[0].n,17);
  await db.query('UPDATE premiere_organizational_tickets SET revoked=true WHERE id=$1',[entries[1].id]);
  assert.equal((await call(checkin,'POST',{ticket:entries[1].id,action:'inspect'},{},'Bearer door-test')).body.result,'invalid');
  await assert.rejects(()=>db.query('SELECT premiere_seed_org_tickets($1::jsonb)',[JSON.stringify(entries.slice(1))]),/INVALID_ORGANIZATIONAL/);
  assert.equal((await db.query('SELECT count(*)::int n FROM premiere_organizational_tickets')).rows[0].n,62);
 }finally{delete process.env.ORGANIZATIONAL_TICKETS_JSON;await db.close();}
});
