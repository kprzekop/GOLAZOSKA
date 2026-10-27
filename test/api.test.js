import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import * as real from '../lib/shared.js';
let db,mails=[],failMail=false;
mock.module('../lib/shared.js',{namedExports:{
 ...real,
 sql:()=>async(strings,...values)=>(await db.query(strings.map((s,i)=>s+(i<values.length?'$'+(i+1):'')).join(''),values)).rows,
 sendMail:async(...args)=>{if(failMail)throw Error('MAIL');mails.push(args);}
}});
const {default:reserve}=await import('../api/reserve.js');
const {default:status}=await import('../api/status.js');
const {default:booking}=await import('../api/booking.js');
const {default:admin}=await import('../api/admin.js');
const {default:cron}=await import('../api/cron.js');
const schema=await readFile(new URL('../db/schema.sql',import.meta.url),'utf8');
async function call(handler,method='GET',body={},query={},auth=''){
 const req={method,body,query,headers:{authorization:auth}};
 const res={code:200,setHeader(){},status(s){this.code=s;return this;},json(body){return{code:this.code,body};}};
 return handler(req,res);
}
const data={name:'Jan Kowalski',email:'widz@example.com',phone:'600 123 456',phoneRepeat:'600123456',seatIds:['5-1','5-2'],'cf-turnstile-response':'test'};
test('API: formularz → baza → e-mail → weryfikacja → panel → anulowanie',async()=>{
 mock.timers.enable({apis:['Date'],now:new Date('2026-11-06T12:00:00+01:00')});
 db=new PGlite();await db.exec(schema.replaceAll('now()',"'2026-11-06 12:00+01'::timestamptz"));const fetchBefore=globalThis.fetch;
 Object.assign(process.env,{DATABASE_URL:'postgres://unused',RESEND_API_KEY:'test',MAIL_FROM:'test@example.com',
 TURNSTILE_SITE_KEY:'test',TURNSTILE_SECRET_KEY:'test',TURNSTILE_HOSTNAME:'www.golazoska.com',RESERVATIONS_OPEN:'true',ADMIN_TOKEN:'admin-test',CRON_SECRET:'cron-test'});
 globalThis.fetch=async()=>({json:async()=>({success:true,hostname:'www.golazoska.com'})});
 try{
  process.env.RESERVATIONS_OPEN='false';assert.equal((await call(status)).body.open,false);
  process.env.RESERVATIONS_OPEN='true';
  mock.timers.setTime(new Date('2026-11-05T17:59:59+01:00').getTime());
  const closed=await call(status);
  assert.equal(closed.body.open,false);
  assert.equal(closed.body.opensAt,'2026-11-05T18:00:00+01:00');
  assert.equal(closed.body.seats,undefined);
  assert.equal((await call(reserve,'POST',data)).body.error,'CLOSED');
  assert.equal(mails.length,0);
  mock.timers.setTime(new Date('2026-11-05T18:00:00+01:00').getTime());
  assert.equal((await call(status)).body.open,true);
  process.env.RESERVATIONS_OPEN='false';
  assert.equal((await call(status)).body.open,false);
  assert.equal((await call(reserve,'POST',data)).body.error,'CLOSED');
  process.env.RESERVATIONS_OPEN='true';
  mock.timers.setTime(new Date('2026-11-06T12:00:00+01:00').getTime());
  const s=await call(status);assert.equal(s.body.seats.length,83);assert.equal(s.body.seats.filter(s=>s.status==='available').length,27);
  assert.equal((await call(admin)).code,401);assert.equal((await call(cron)).code,401);
  assert.equal((await call(reserve,'POST',{...data,phoneRepeat:'600123457'})).code,400);
  assert.equal((await call(reserve,'POST',{...data,seatIds:['5-11']})).code,409);
  assert.equal((await call(reserve,'POST',data)).code,200);assert.equal(mails.length,1);
  assert.match(mails[0][2],/rząd 5, miejsce 1/);assert.match(mails[0][2],/18 listopada 2026 o godz. 19:00/);
  assert.match(mails[0][2],/Kościelnej/);
  const [row]=(await db.query('SELECT * FROM premiere_reservations')).rows;
  assert.equal(row.phone,'600123456');
  const verify=await call(booking,'POST',{token:row.token,action:'confirm'});
  assert.equal(verify.code,200);assert.equal(verify.body.status,'reserved');assert.equal(verify.body.canConfirm,false);
  assert.deepEqual(verify.body.seatIds,['5-1','5-2']);
  assert.equal((await call(reserve,'POST',{...data,email:'other@example.com'})).body.error,'SEATS_UNAVAILABLE');
  const list=await call(admin,'GET',{},{} ,'Bearer admin-test');assert.equal(list.body.reservations[0].phone,'600123456');
  assert.equal((await call(admin,'POST',{action:'pool',id:'5-11',pool:'public'},{} ,'Bearer admin-test')).code,200);
  assert.equal((await call(status)).body.seats.filter(s=>s.status==='available').length,26);
  assert.equal((await call(booking,'POST',{token:row.token,action:'cancel'})).body.status,'cancelled');
  assert.equal((await call(status)).body.seats.filter(s=>s.status==='available').length,28);
  failMail=true;
  assert.equal((await call(reserve,'POST',{...data,email:'failure@example.com'})).body.error,'MAIL_UNAVAILABLE');
  assert.equal((await call(status)).body.seats.filter(s=>s.status==='available').length,28);
 }finally{globalThis.fetch=fetchBefore;failMail=false;await db.close();mock.timers.reset();}
});

test('zadanie dzienne: prośba o potwierdzenie, termin zwolnienia, przypomnienie i usunięcie danych',async()=>{
 db=new PGlite();mails=[];await db.exec(schema.replaceAll('now()',"'2026-11-13 12:00+01'::timestamptz"));
 mock.timers.enable({apis:['Date'],now:new Date('2026-11-13T12:00:00+01:00')});
 async function time(value){
  mock.timers.setTime(new Date(value).getTime());
  const sqlTime=value.replace('T',' ');
  await db.exec(schema.slice(schema.indexOf('CREATE OR REPLACE FUNCTION premiere_expire')).replaceAll('now()',"'"+sqlTime+"'::timestamptz"));
 }
 try{
  const [row]=(await db.query("SELECT * FROM premiere_create('Jan Kowalski','jan@example.com','600123456',ARRAY['5-1'],1,false)")).rows;
  await db.query("SELECT * FROM premiere_action($1,'confirm')",[row.booking_token]);
  await time('2026-11-14T19:00:00+01:00');
  assert.equal((await call(cron,'GET',{},{} ,'Bearer cron-test')).body.sent,1);
  assert.match(mails[0][2],/18 listopada 2026 o godz. 19:00/);
  await call(cron,'GET',{},{} ,'Bearer cron-test');assert.equal(mails.length,1);
  await time('2026-11-18T19:00:00+01:00');await call(status);
  assert.equal((await db.query('SELECT status FROM premiere_reservations WHERE id=$1',[row.booking_id])).rows[0].status,'expired');
  await db.exec("ALTER TABLE premiere_reservations ALTER COLUMN created_at SET DEFAULT '2026-11-18 19:00+01'::timestamptz");
  const [late]=(await db.query("SELECT * FROM premiere_create('Jan Kowalski','late@example.com','600123456',ARRAY['5-1'],1,false)")).rows;
  await db.query("SELECT * FROM premiere_action($1,'confirm')",[late.booking_token]);
  await time('2026-11-19T19:00:00+01:00');
  assert.equal((await call(cron,'GET',{},{} ,'Bearer cron-test')).body.sent,1);
  assert.match(mails[1][2],/Kościelnej/);assert.match(mails[1][2],/rząd 5, miejsce 1/);
  await time('2026-12-22T19:00:00+01:00');
  assert.equal((await call(cron,'GET',{},{} ,'Bearer cron-test')).body.purged,true);
  assert.equal((await db.query('SELECT count(*)::int n FROM premiere_reservations')).rows[0].n,0);
 }finally{await db.close();mock.timers.reset();}
});
