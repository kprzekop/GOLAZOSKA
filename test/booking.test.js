import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {JSDOM} from 'jsdom';
import {validateBooking,normalizePhone,EVENT_AT,CONFIRM_BY,REMIND_FROM} from '../lib/event.js';
const schema=await readFile(new URL('../db/schema.sql',import.meta.url),'utf8');
const at=(sql,time)=>sql.replaceAll('now()',"'"+time+"'::timestamptz");
async function database(time='2026-10-27 12:00+01'){
 const db=new PGlite();await db.exec(at(schema,time));return db;
}
async function clock(db,time){await db.exec("ALTER TABLE premiere_reservations ALTER COLUMN created_at SET DEFAULT '"+time+"'::timestamptz;");await db.exec(at(schema.slice(schema.indexOf('CREATE OR REPLACE FUNCTION premiere_expire')),time));}
async function create(db,ids,email='widz@example.com',waiting=false,count=ids.length){
 return (await db.query('SELECT * FROM premiere_create($1,$2,$3,$4::text[],$5,$6)',['Jan Kowalski',email,'+48600123456',ids,count,waiting])).rows[0];
}
const good={name:'Jan Kowalski',email:'WIDZ@example.com',phone:'+48 600 123 456',phoneRepeat:'+48 (600) 123-456',seatIds:['5-1','5-2']};
test('telefon, zgodność powtórzeń i limity sprawdzane na serwerze',()=>{
 assert.equal(normalizePhone('0048 600-123-456'),'+48600123456');
 assert.equal(validateBooking(good).phone,'+48600123456');
 assert.equal(validateBooking(good).email,'widz@example.com');
 for(const body of [{...good,phoneRepeat:'600123457'},{...good,phone:'abc',phoneRepeat:'abc'},
 {...good,seatIds:['5-1','5-1']},{...good,seatIds:[]},{...good,seatIds:['5-1','5-2','5-3','5-4','5-5']},
 {...good,waiting:true,seatIds:['5-1']},{...good,waiting:true,seatIds:[],seats:0}])
 assert.throws(()=>validateBooking(body),/INVALID_INPUT/);
 assert.equal(validateBooking({...good,waiting:true,seatIds:[],seats:3}).seats,3);
});
test('plan 83 miejsc i blokady organizatora; brak podwójnego przydziału',async()=>{
 const db=await database();try{
  const rows=(await db.query('SELECT row_no,count(*)::int AS n FROM premiere_seats GROUP BY row_no ORDER BY row_no')).rows;
  assert.deepEqual(rows.map(r=>r.n),[12,13,12,13,12,13,8]);
  assert.deepEqual((await db.query("SELECT pool,count(*)::int AS n FROM premiere_seats GROUP BY pool ORDER BY pool")).rows,
   [{pool:'held',n:6},{pool:'organizational',n:50},{pool:'public',n:27}]);
  for(const ids of [['1-1'],['5-11'],['6-12'],['7-7'],['7-9'],['5-1','5-1']])
   await assert.rejects(()=>create(db,ids),/SEATS_UNAVAILABLE/);
  const r=await create(db,['5-1','5-2']);assert.equal(r.booking_status,'verification');
  await assert.rejects(()=>create(db,['5-1'],'other@example.com'),/SEATS_UNAVAILABLE/);
  await assert.rejects(()=>create(db,['5-3']),/DUPLICATE/);
  await db.query("SELECT * FROM premiere_action($1,'confirm')",[r.booking_token]);
  assert.equal((await db.query('SELECT status FROM premiere_reservations WHERE id=$1',[r.booking_id])).rows[0].status,'reserved');
  await assert.rejects(()=>db.query("SELECT * FROM premiere_action($1,'confirm')",[r.booking_token]),/ACTION_UNAVAILABLE/);
  await db.query("SELECT * FROM premiere_action($1,'cancel')",[r.booking_token]);
  assert.equal((await create(db,['5-1'],'other@example.com')).booking_status,'verification');
 }finally{await db.close();}
});
test('weryfikacja 24h, potwierdzenie w listopadzie i dokładny termin 18 listopada 19:00',async()=>{
 const db=await database();try{
  const stale=await create(db,['5-1'],'stale@example.com');
  await clock(db,'2026-10-28 12:00+01');await db.query('SELECT premiere_expire()');
  assert.equal((await db.query('SELECT status FROM premiere_reservations WHERE id=$1',[stale.booking_id])).rows[0].status,'expired');
  await clock(db,'2026-11-13 18:00+01');
  const unconfirmed=await create(db,['5-1'],'unconfirmed@example.com');
  await db.query("SELECT * FROM premiere_action($1,'confirm')",[unconfirmed.booking_token]);
  const confirmed=await create(db,['5-2'],'confirmed@example.com');
  await db.query("SELECT * FROM premiere_action($1,'confirm')",[confirmed.booking_token]);
  await clock(db,'2026-11-14 19:00+01');await db.query("SELECT * FROM premiere_action($1,'confirm')",[confirmed.booking_token]);
  await clock(db,'2026-11-18 18:59:59+01');await db.query('SELECT premiere_expire()');
  assert.equal((await db.query('SELECT status FROM premiere_reservations WHERE id=$1',[unconfirmed.booking_id])).rows[0].status,'reserved');
  await clock(db,'2026-11-18 19:00+01');await db.query('SELECT premiere_expire()');
  assert.equal((await db.query('SELECT status FROM premiere_reservations WHERE id=$1',[unconfirmed.booking_id])).rows[0].status,'expired');
  await assert.rejects(()=>db.query("SELECT * FROM premiere_action($1,'confirm')",[unconfirmed.booking_token]),/ACTION_UNAVAILABLE/);
  assert.equal((await db.query('SELECT status FROM premiere_reservations WHERE id=$1',[confirmed.booking_id])).rows[0].status,'confirmed');
  const late=await create(db,['5-1'],'late@example.com');await db.query("SELECT * FROM premiere_action($1,'confirm')",[late.booking_token]);
  assert.equal((await db.query('SELECT status FROM premiere_reservations WHERE id=$1',[late.booking_id])).rows[0].status,'confirmed');
  await clock(db,'2026-11-21 19:00+01');
  await assert.rejects(()=>create(db,['5-3'],'closed@example.com'),/CLOSED/);
 }finally{await db.close();}
});
test('lista rezerwowa wymaga weryfikacji, oferta dostaje fotele i wygasa',async()=>{
 const db=await database();try{
  const waiting=await create(db,[],'waiting@example.com',true,3);
  assert.equal((await db.query('SELECT * FROM premiere_advance()')).rows[0].promoted_id,null);
  await db.query("SELECT * FROM premiere_action($1,'confirm')",[waiting.booking_token]);
  assert.equal((await db.query('SELECT * FROM premiere_advance()')).rows[0].promoted_id,waiting.booking_id);
  assert.deepEqual((await db.query('SELECT id FROM premiere_seats WHERE reservation_id=$1 ORDER BY row_no,seat_no',[waiting.booking_id])).rows.map(r=>r.id),['5-1','5-2','5-3']);
  await clock(db,'2026-10-29 12:00+01');await db.query('SELECT premiere_expire()');
  assert.equal((await db.query('SELECT status FROM premiere_reservations WHERE id=$1',[waiting.booking_id])).rows[0].status,'expired');
  assert.equal((await db.query('SELECT count(*)::int n FROM premiere_seats WHERE reservation_id=$1',[waiting.booking_id])).rows[0].n,0);
 }finally{await db.close();}
});
test('panel odblokowuje 6 miejsc, chroni organizatora i zajęte fotele',async()=>{
 const db=await database();try{
  await db.query("SELECT premiere_set_pool('5-11','public')");
  assert.equal((await db.query('SELECT public_capacity FROM premiere_config')).rows[0].public_capacity,28);
  await assert.rejects(()=>db.query("SELECT premiere_set_pool('1-1','public')"),/ACTION_UNAVAILABLE/);
  await create(db,['5-11']);await assert.rejects(()=>db.query("SELECT premiere_set_pool('5-11','held')"),/ACTION_UNAVAILABLE/);
  await db.query("SELECT premiere_set_pool('5-12','public')");await db.query("SELECT premiere_set_pool('5-12','held')");
  assert.equal((await db.query('SELECT public_capacity FROM premiere_config')).rows[0].public_capacity,28);
 }finally{await db.close();}
});
test('terminy JS są zgodne z SQL i dokładnie trzy doby przed seansem',()=>{
 assert.equal(new Date(EVENT_AT)-new Date(CONFIRM_BY),3*24*60*60*1000);
 for(const value of [EVENT_AT,CONFIRM_BY,REMIND_FROM]){
  const local=value.slice(0,10)+' '+value.slice(11,16)+' Europe/Warsaw';
  assert.ok(schema.includes(local),local);
 }
});
test('formularz: plan, limit czterech, konflikt miejsc i powtórzony telefon',async()=>{
 const db=await database();try{
  const seats=(await db.query('SELECT id,row_no AS row,seat_no AS number,pool FROM premiere_seats ORDER BY row_no,seat_no')).rows.map(s=>({...s,status:s.pool==='public'?'available':s.pool}));
  const html=await readFile(new URL('../rezerwacje.html',import.meta.url),'utf8');
  let posted=null;
  const dom=new JSDOM(html,{url:'https://www.golazoska.com/rezerwacje.html',runScripts:'dangerously',beforeParse(w){
   w.fetch=async(url,options)=>{
    if(url==='/api/status')return {ok:true,json:async()=>({open:true,siteKey:'test',seats})};
    posted=JSON.parse(options.body);return {ok:false,json:async()=>({error:'SEATS_UNAVAILABLE'})};
   };
  }});
  await new Promise(r=>setTimeout(r,30));const d=dom.window.document;
  assert.equal(d.querySelectorAll('.seat').length,83);
  assert.equal(d.querySelectorAll('.seat:disabled').length,56);
  const buttons=[...d.querySelectorAll('.seat:not(:disabled)')];
  for(const b of buttons.slice(0,5))b.click();
  assert.equal(d.querySelectorAll('[aria-pressed="true"]').length,4);
  d.getElementById('name').value='Jan Kowalski';d.getElementById('email').value='widz@example.com';
  d.getElementById('phone').value='600 123 456';d.getElementById('phoneRepeat').value='600123457';
  d.getElementById('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
  assert.equal(posted,null);assert.match(d.getElementById('message').textContent,/identycznie/);
  d.getElementById('phoneRepeat').value='600123456';d.getElementById('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
  await new Promise(r=>setTimeout(r,30));assert.equal(posted.seatIds.length,4);
  assert.match(d.getElementById('message').textContent,/Ktoś właśnie/);dom.window.close();
 }finally{await db.close();}
});

test('migracja pustej instalacji i ochrona istniejących zgłoszeń',async()=>{
 const legacy=await readFile(new URL('legacy-schema.sql',import.meta.url),'utf8');
 const migration=await readFile(new URL('../db/migrate-numbered-seats.sql',import.meta.url),'utf8');
 const empty=new PGlite(),used=new PGlite();
 try{
  await empty.exec(legacy);await empty.exec(migration);
  assert.equal((await empty.query('SELECT count(*)::int n FROM premiere_seats')).rows[0].n,83);
  assert.equal((await create(empty,['5-1'])).booking_status,'verification');
  await used.exec(legacy);await used.query("INSERT INTO premiere_reservations(name,email,seats,status)VALUES('Jan Kowalski','jan@example.com',1,'confirmed')");
  await assert.rejects(()=>used.exec(migration),/MANUAL_MIGRATION_REQUIRED/);await used.exec('ROLLBACK');
  assert.equal((await used.query('SELECT count(*)::int n FROM premiere_reservations')).rows[0].n,1);
  assert.equal((await used.query('SELECT physical_capacity FROM premiere_config')).rows[0].physical_capacity,81);
 }finally{await empty.close();await used.close();}
});
