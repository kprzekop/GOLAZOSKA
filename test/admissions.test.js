import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {ADMISSION_SCHEMA} from '../lib/admission-schema.js';
const base=await readFile(new URL('../db/schema.sql',import.meta.url),'utf8');
const rowFive=await readFile(new URL('../db/allocate-row-five.sql',import.meta.url),'utf8');
const fixed=(sql,time)=>sql.replaceAll('now()',"'"+time+"'::timestamptz");
const time0='2026-11-06 12:00+01';
async function setup(time=time0){
 const db=new PGlite();await db.exec(fixed(base,time));await db.exec(fixed(rowFive,time));await db.exec(fixed(ADMISSION_SCHEMA,time));return db;
}
async function clock(db,time){
 await db.exec("ALTER TABLE premiere_reservations ALTER COLUMN created_at SET DEFAULT '"+time+"'::timestamptz");
 await db.exec(fixed(ADMISSION_SCHEMA,time));
}
let serial=0;
async function create(db,count=1,ids=[]){
 return (await db.query('SELECT * FROM premiere_create($1,$2,$3,$4::text[],$5,$6)',
 ['Jan Kowalski','widz'+(++serial)+'@example.com','600123456',ids,count,ids.length===0])).rows[0];
}
async function action(db,r,action='confirm'){return (await db.query('SELECT * FROM premiere_action($1,$2)',[r.booking_token,action])).rows[0];}
async function row(db,r){return (await db.query('SELECT * FROM premiere_reservations WHERE id=$1',[r.booking_id])).rows[0];}
async function used(db){return (await db.query('SELECT premiere_standing_used() AS n')).rows[0].n;}
async function fill(db,n=20){for(let i=0;i<n;){const c=Math.min(2,n-i);const r=await create(db,c);await action(db,r);i+=c;}}
test('migracja jest zgodna z plikiem SQL i zachowuje istniejące rezerwacje',async()=>{
 assert.equal(ADMISSION_SCHEMA,await readFile(new URL('../db/migrate-admissions.sql',import.meta.url),'utf8'));
 const db=new PGlite();try{
  await db.exec(fixed(base,time0));const prior=await create(db,1,['6-1']);
  await db.exec(fixed(ADMISSION_SCHEMA,time0));await db.exec(fixed(ADMISSION_SCHEMA,time0));
  assert.equal((await row(db,prior)).admission,'seated');
  assert.equal((await db.query('SELECT reservation_id FROM premiere_seats WHERE id=$1',['6-1'])).rows[0].reservation_id,prior.booking_id);
 }finally{await db.close();}
});
test('20 osób, nie 20 zgłoszeń; dodatkowe grupy na liście i bez dzielenia grup',async()=>{
 const db=await setup();try{
  await fill(db,19);assert.equal(await used(db),19);
  const group=await create(db,2);assert.equal((await row(db,group)).admission,'waiting');
  assert.equal(await used(db),19);
  const last=await create(db,1);assert.equal((await row(db,last)).admission,'standing');
  assert.equal(await used(db),20);
  const overflow=await create(db,2);assert.equal((await row(db,overflow)).admission,'waiting');
  assert.equal((await db.query("SELECT count(*)::int n FROM premiere_seats WHERE reservation_id IS NOT NULL")).rows[0].n,0);
  await action(db,last,'cancel');assert.equal(await used(db),19);
 }finally{await db.close();}
});
test('równoczesne zapisy nie przekraczają puli 20 osób',async()=>{
 const db=await setup();try{
  const groups=await Promise.all(Array.from({length:13},()=>create(db,2)));
  assert.equal(await used(db),20);
  let standing=0,waiting=0;
  for(const r of groups){const b=await row(db,r);if(b.admission==='standing')standing+=b.seats;else waiting+=b.seats;}
  assert.equal(standing,20);assert.equal(waiting,6);
 }finally{await db.close();}
});
test('oferta foteli najpierw dla puli bez foteli; przyjęcie zwalnia wejścia',async()=>{
 const db=await setup();try{
  await fill(db);const waiting=await create(db,1);await action(db,waiting);
  const next=(await db.query('SELECT * FROM premiere_advance()')).rows[0].promoted_id;
  assert.notEqual(next,waiting.booking_id);
  const offered=(await db.query('SELECT * FROM premiere_reservations WHERE id=$1',[next])).rows[0];
  assert.equal(offered.admission,'standing');assert.equal(offered.offer_target,'seated');
  assert.equal(await used(db),20);
  await db.query("SELECT * FROM premiere_action($1,'confirm')",[offered.token]);
  assert.equal((await db.query('SELECT admission FROM premiere_reservations WHERE id=$1',[next])).rows[0].admission,'seated');
  assert.equal(await used(db),18);
  assert.equal((await row(db,waiting)).status,'waiting');
 }finally{await db.close();}
});
test('odmowa i wygaśnięcie oferty foteli zachowują potwierdzone wejście bez fotela',async()=>{
 const db=await setup('2026-11-15 12:00+01');try{
  const r=await create(db,2);await action(db,r);
  assert.equal((await row(db,r)).status,'confirmed');
  await db.query('SELECT premiere_offer($1)',[r.booking_id]);await action(db,r,'decline');
  assert.equal((await row(db,r)).status,'confirmed');assert.equal((await row(db,r)).admission,'standing');
  assert.equal(await used(db),2);
  assert.equal((await db.query('SELECT count(*)::int n FROM premiere_seats WHERE reservation_id=$1',[r.booking_id])).rows[0].n,0);
  const s=await create(db,1);await action(db,s);await db.query('SELECT premiere_offer($1)',[s.booking_id]);
  await clock(db,'2026-11-17 12:00+01');await db.query('SELECT premiere_expire()');
  assert.equal((await row(db,s)).status,'confirmed');assert.equal((await row(db,s)).admission,'standing');
  assert.equal(await used(db),3);
 }finally{await db.close();}
});
test('lista rezerwowa dostaje zwolnione wejścia bez foteli; oferta także liczy się do limitu',async()=>{
 const db=await setup();try{
  await fill(db);const waiting=await create(db,2);await action(db,waiting);
  // Fill all public seats; no upgrade to a seated place is possible.
  await db.query("UPDATE premiere_seats SET pool='held' WHERE pool='public'");
  const old=(await db.query("SELECT token FROM premiere_reservations WHERE admission='standing' LIMIT 1")).rows[0];
  await db.query("SELECT * FROM premiere_action($1,'cancel')",[old.token]);
  assert.equal(await used(db),18);
  const next=(await db.query('SELECT * FROM premiere_advance()')).rows[0].promoted_id;
  assert.equal(next,waiting.booking_id);assert.equal((await row(db,waiting)).offer_target,'standing');
  assert.equal(await used(db),20);
  await action(db,waiting);assert.equal((await row(db,waiting)).admission,'standing');assert.equal(await used(db),20);
 }finally{await db.close();}
});
test('brak weryfikacji w 24h i brak potwierdzenia do 18 listopada zwalniają wejścia',async()=>{
 const db=await setup();try{
  const stale=await create(db,2);assert.equal(await used(db),2);
  await clock(db,'2026-11-07 12:00+01');await db.query('SELECT premiere_expire()');
  assert.equal((await row(db,stale)).status,'expired');assert.equal(await used(db),0);
  const early=await create(db,2);await action(db,early);assert.equal((await row(db,early)).status,'reserved');
  await clock(db,'2026-11-18 19:00+01');await db.query('SELECT premiere_expire()');
  assert.equal((await row(db,early)).status,'expired');assert.equal(await used(db),0);
 }finally{await db.close();}
});

test('anulowanie i blokada foteli są atomowe i nie oddają ich kolejce',async()=>{
 const db=await setup('2026-11-15 12:00+01');try{
  const seated=await create(db,2,['6-1','6-2']);await action(db,seated);
  await db.query("SELECT premiere_admin_action($1,'cancel_hold')",[seated.booking_id]);
  assert.equal((await row(db,seated)).status,'cancelled');
  assert.deepEqual((await db.query("SELECT id,pool,reservation_id FROM premiere_seats WHERE id=ANY($1::text[]) ORDER BY id",[['6-1','6-2']])).rows,
   [{id:'6-1',pool:'held',reservation_id:null},{id:'6-2',pool:'held',reservation_id:null}]);
  assert.equal((await db.query('SELECT public_capacity FROM premiere_config')).rows[0].public_capacity,15);
  const other=await create(db,1);await action(db,other);await db.query('SELECT * FROM premiere_advance()');
  assert.equal((await db.query("SELECT count(*)::int n FROM premiere_seats WHERE id IN('6-1','6-2') AND reservation_id IS NOT NULL")).rows[0].n,0);
 }finally{await db.close();}
});

test('formularz bez wolnych foteli wymaga akceptacji zasad puli bez fotela',async()=>{
 const {JSDOM}=await import('jsdom');
 const html=await readFile(new URL('../rezerwacje.html',import.meta.url),'utf8');
 let posted=null;
 const dom=new JSDOM(html,{url:'https://www.golazoska.com/rezerwacje.html',runScripts:'dangerously',beforeParse(w){
  w.fetch=async(url,options)=>url==='/api/status'?{ok:true,json:async()=>({open:true,waitlist:true,siteKey:'test',
   overflow:{capacity:20,available:20},seats:[{id:'6-1',row:6,number:1,status:'taken'}]})}:
   (posted=JSON.parse(options.body),{ok:true,json:async()=>({status:'verification',admission:'standing'})});
 }});
 try{
  await new Promise(r=>setTimeout(r,30));const d=dom.window.document;
  assert.equal(d.getElementById('waiting').checked,true);
  assert.equal(d.getElementById('standingConsent').required,true);
  d.getElementById('name').value='Jan Kowalski';d.getElementById('email').value='jan@example.com';
  d.getElementById('phone').value='600123456';d.getElementById('phoneRepeat').value='600123456';
  d.getElementById('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
  assert.equal(posted,null);assert.match(d.getElementById('message').textContent,/Potwierdź zasady/);
  d.getElementById('standingConsent').checked=true;
  d.getElementById('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
  await new Promise(r=>setTimeout(r,30));
  assert.equal(posted.acceptStanding,true);assert.deepEqual(posted.seatIds,[]);
  assert.match(d.getElementById('message').textContent,/udział może odbyć się na stojąco/);
 }finally{dom.window.close();}
});

test('baza odrzuca trzy miejsca w każdej puli, także po aktualizacji istniejącej instalacji',async()=>{
 const db=new PGlite();try{
  // Reproduce an installed v2 database with the former four-seat limit.
  await db.exec(fixed(base.replaceAll('seats BETWEEN 1 AND 2','seats BETWEEN 1 AND 4').replaceAll('p_count NOT BETWEEN 1 AND 2','p_count NOT BETWEEN 1 AND 4'),time0));
  const oldSchema=ADMISSION_SCHEMA.replaceAll('p_count NOT BETWEEN 1 AND 2','p_count NOT BETWEEN 1 AND 4');
  await db.exec(fixed(oldSchema,time0));await db.query('UPDATE premiere_config SET admission_schema_version=2');
  const prior=await create(db,3,['6-1','6-2','6-3']);
  await db.exec(fixed(ADMISSION_SCHEMA,time0));
  assert.equal((await row(db,prior)).seats,3);
  assert.equal((await db.query('SELECT admission_schema_version FROM premiere_config')).rows[0].admission_schema_version,3);
  await assert.rejects(()=>create(db,3,['6-4','6-5','6-6']),/INVALID_INPUT/);
  await assert.rejects(()=>create(db,3),/INVALID_INPUT/);
  await fill(db);
  await assert.rejects(()=>create(db,3),/INVALID_INPUT/);
  assert.equal((await create(db,2)).booking_status,'waiting');
 }finally{await db.close();}
});
