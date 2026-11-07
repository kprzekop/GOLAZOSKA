import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import * as real from '../lib/shared.js';
let db,mails=[],fail=false;
const tag=(strings,...values)=>{const text=strings.map((s,i)=>s+(i<values.length?'$'+(i+1):'')).join('');return tag.query(text,values);};
tag.query=(text,values=[])=>({text,values,then(resolve,reject){return db.query(text,values).then(r=>r.rows).then(resolve,reject);}});
tag.transaction=queries=>db.transaction(async tx=>{const results=[];for(const q of queries)results.push((await tx.query(q.text,q.values)).rows);return results;});
mock.module('../lib/shared.js',{namedExports:{...real,sql:()=>tag,sendMail:async(...args)=>{if(fail)throw Error('MAIL');mails.push(args);}}});
const {default:handler}=await import('../api/additional-screening.js');
const {initializePreviewScreening,sendAdditionalScreeningOffers}=await import('../lib/additional-screenings.js');
async function call(method,body={},query={},auth=''){
 return handler({method,body,query,headers:{authorization:auth}}, {setHeader(){},status(code){this.code=code;return this;},json(body){return {code:this.code,body};}});
}
test('API, migration and durable emails: one proposal, no GET side effect, atomic consent, retry failed confirmation',async()=>{
 db=new PGlite();try{
  for(const file of ['schema.sql','migrate-admissions.sql','migrate-tickets.sql'])await db.exec(await readFile(new URL('../db/'+file,import.meta.url),'utf8'));
  await db.exec("INSERT INTO premiere_reservations(name,email,phone,seats,status,admission,verified_at) VALUES('Guest','guest@example.test','600123456',2,'confirmed','standing',now())");
  await initializePreviewScreening(tag);await initializePreviewScreening(tag);
  await db.exec("UPDATE additional_screenings SET starts_at=now()+interval '7 days' WHERE id=1");
  process.env.TRANSFER_DISPATCH_TOKEN='dispatch-test';process.env.ADMIN_TOKEN='admin-test';
  assert.equal((await call('POST',{action:'dispatch-transfers'})).code,401);
  assert.equal((await call('POST',{action:'dispatch-transfers',dryRun:true},{},'Bearer dispatch-test')).body.eligible_bookings,1);
  const sent=await call('POST',{action:'dispatch-transfers'},{},'Bearer dispatch-test');
  assert.equal(sent.code,200);assert.equal(sent.body.transfers.sent,1);
  assert.equal(mails.length,1);assert.match(mails[0][2],/Dopiero po wybraniu/);assert.match(mails[0][4],/^preview-seat-choice-v2\//);
  await call('POST',{action:'dispatch-transfers'},{},'Bearer dispatch-test');assert.equal(mails.length,1);
  const {id}=(await db.query('SELECT id FROM additional_screening_bookings')).rows[0];
  const get=await call('GET',{}, {id});assert.equal(get.body.transfer,true);assert.equal(get.body.status,'offered');
  assert.equal((await call('POST',{id,action:'accept'})).code,409);
  fail=true;const swapped=await call('POST',{id,action:'transfer',consent:true,seatIds:['7-7','7-8']});
  assert.equal(swapped.code,200);assert.equal(swapped.body.status,'confirmed');assert.ok(swapped.body.transferred_at);
  assert.equal((await db.query('SELECT status FROM premiere_reservations')).rows[0].status,'cancelled');
  fail=false;await sendAdditionalScreeningOffers(tag,{previewOnly:true});
  assert.equal(mails.length,2);assert.match(mails[1][1],/Zamiana potwierdzona/);
  await call('POST',{id,action:'transfer'});assert.equal(mails.length,2);
 }finally{await db.close();}
});

test('organizer trial sends only five selected printed tickets to their contact, with safe retry',async()=>{
 db=new PGlite();mails=[];fail=false;
 try{
  for(const file of ['schema.sql','migrate-admissions.sql','migrate-tickets.sql'])await db.exec(await readFile(new URL('../db/'+file,import.meta.url),'utf8'));
  await initializePreviewScreening(tag);
  await db.exec("UPDATE additional_screenings SET starts_at=now()+interval '7 days' WHERE id=1");
  const {randomUUID}=await import('node:crypto');
  const ids=Array.from({length:5},()=>randomUUID());
  for(const id of ids)await db.query("INSERT INTO premiere_reservations(id,name,email,phone,seats,status,admission,verified_at) VALUES($1::uuid,'Organizer','druk-'||$1::text||'@example.invalid','000000000',1,'confirmed','standing',now())",[id]);
  await db.exec("INSERT INTO premiere_reservations(name,email,phone,seats,status,admission,verified_at) VALUES('Other','other@example.test','600123456',1,'confirmed','standing',now())");
  process.env.STANDING_GUEST_PRINT_IDS=JSON.stringify(ids.slice(0,3));
  process.env.STANDING_GUEST_PRINT_EXTRA_IDS=JSON.stringify(ids.slice(3));
  process.env.STANDING_GUEST_PRINT_CONTACT='organizer@example.test';
  const {sendOrganizerTransferTest}=await import('../lib/organizer-transfer-test.js');
  const result=await sendOrganizerTransferTest(tag);
  assert.equal(result.sent,5);assert.equal(result.failed,0);assert.equal(result.totalSent,5);
  assert.equal(mails.length,5);assert.ok(mails.every(mail=>mail[0]==='organizer@example.test'&&mail[1].startsWith('[PRÓBA]')));
  assert.equal((await sendOrganizerTransferTest(tag)).sent,0);assert.equal(mails.length,5);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM premiere_reservations WHERE status='confirmed'")).rows[0].n,6);
 }finally{
  delete process.env.STANDING_GUEST_PRINT_IDS;delete process.env.STANDING_GUEST_PRINT_EXTRA_IDS;delete process.env.STANDING_GUEST_PRINT_CONTACT;
  await db.close();
 }
});
