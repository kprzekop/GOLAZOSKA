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

test('standing dispatch excludes waiting list and printed organizer tickets, and does not repeat sent proposals',async()=>{
 db=new PGlite();mails=[];fail=false;
 try{
  for(const file of ['schema.sql','migrate-admissions.sql','migrate-tickets.sql'])await db.exec(await readFile(new URL('../db/'+file,import.meta.url),'utf8'));
  await initializePreviewScreening(tag);
  await db.exec("UPDATE additional_screenings SET starts_at=now()+interval '7 days' WHERE id=1");
  await db.exec("INSERT INTO premiere_reservations(name,email,phone,seats,status,admission,verified_at) VALUES ('Standing','standing@example.test','600123456',2,'confirmed','standing',now()),('Waiting','waiting@example.test','600123457',1,'waiting','waiting',now()),('Printed','print@example.invalid','000000000',1,'confirmed','standing',now())");
  await db.exec("SELECT additional_screening_offer(1);SELECT additional_screening_offer(1)");
  const {sendStandingTransferBatch}=await import('../lib/standing-transfer-dispatch.js');
  const result=await sendStandingTransferBatch(tag);
  assert.equal(result.sent,1);assert.equal(result.failed,0);assert.equal(result.eligible,1);assert.equal(result.totalSent,1);assert.equal(result.withoutOffer,0);
  assert.equal(mails.length,1);assert.equal(mails[0][0],'standing@example.test');
  assert.equal((await sendStandingTransferBatch(tag)).sent,0);assert.equal(mails.length,1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM premiere_reservations WHERE status IN ('confirmed','waiting')")).rows[0].n,3);
 }finally{await db.close();}
});

test('direct 18:00 booking reserves exactly selected seats and rejects competing requests',async()=>{
 db=new PGlite();mails=[];fail=false;
 const previousFetch=globalThis.fetch;
 try{
  for(const file of ['schema.sql','migrate-admissions.sql','migrate-tickets.sql'])await db.exec(await readFile(new URL('../db/'+file,import.meta.url),'utf8'));
  Object.assign(process.env,{DATABASE_URL:'unused',RESEND_API_KEY:'test',MAIL_FROM:'test@example.test',TURNSTILE_SECRET_KEY:'test',TURNSTILE_HOSTNAME:'www.golazoska.com'});
  globalThis.fetch=async()=>({json:async()=>({success:true,hostname:'www.golazoska.com'})});
  const {default:reserve}=await import('../api/reserve.js');
  const request=async body=>reserve({method:'POST',body,headers:{}},{setHeader(){},status(code){this.code=code;return this;},json(body){return {code:this.code,body};}});
  const data={name:'Selected Viewer',email:'selected@example.test',phone:'600123456',phoneRepeat:'600123456',
   screeningInterest:true,seatIds:['7-7','7-8'],'cf-turnstile-response':'test'};
  const result=await request(data);
  assert.equal(result.code,200);assert.equal(result.body.status,'confirmed');
  assert.match(result.body.ticketUrl,/dodatkowy-seans/);
  const places=await db.query("SELECT row_no,seat_no FROM additional_screening_seats WHERE booking_id IS NOT NULL ORDER BY row_no,seat_no");
  assert.deepEqual(places.rows,[{row_no:7,seat_no:7},{row_no:7,seat_no:8}]);
  assert.equal(mails.length,1);assert.match(mails[0][2],/rząd 7, miejsce 7/);
  assert.equal((await request({...data,email:'competing@example.test'})).body.error,'SEATS_UNAVAILABLE');
  assert.equal((await request({...data,seatIds:['1-1']})).body.error,'DUPLICATE');
  assert.equal((await request({...data,email:'empty@example.test',seatIds:[]})).code,400);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM additional_screening_bookings")).rows[0].n,1);
 }finally{globalThis.fetch=previousFetch;await db.close();}
});

test('18:00 standing pool opens after all seats are occupied, respects ten people and releases cancelled admissions',async()=>{
 db=new PGlite();try{
  for(const file of ['schema.sql','migrate-admissions.sql','migrate-tickets.sql'])await db.exec(await readFile(new URL('../db/'+file,import.meta.url),'utf8'));
  const {prepareSelectedPreview}=await import('../lib/preview-selected-seats.js');await prepareSelectedPreview(tag);
  await db.exec("UPDATE additional_screenings SET starts_at=now()+interval '7 days' WHERE id=1");
  const create=async(email,count)=>(await db.query("SELECT preview_reserve_standing('Standing',$1,'600123456',$2) AS id",[email,count])).rows[0].id;
  await assert.rejects(create('early@example.test',1),/SEATED_AVAILABLE/);
  const occupied=(await db.query("INSERT INTO additional_screening_bookings(screening_id,source_id,name,email,status,expires_at) VALUES(1,gen_random_uuid(),'Occupied','occupied@example.test','confirmed',now()+interval '7 days') RETURNING id")).rows[0].id;
  await db.query('UPDATE additional_screening_seats SET booking_id=$1 WHERE screening_id=1',[occupied]);
  let first;
  for(let i=0;i<5;i++){const id=await create('standing-'+i+'@example.test',2);if(i===0)first=id;}
  await assert.rejects(create('full@example.test',1),/STANDING_UNAVAILABLE/);
  await assert.rejects(create('three@example.test',3),/INVALID_INPUT/);
  await db.query("SELECT additional_screening_reply($1,'decline')",[first]);
  await create('replacement@example.test',2);
  assert.equal((await db.query("SELECT sum(standing_seats)::int AS n FROM additional_screening_bookings WHERE status='confirmed'")).rows[0].n,10);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM additional_screening_seats WHERE booking_id=$1",[occupied])).rows[0].n,83);
 }finally{await db.close();}
});

test('receipt resend includes active real reservations at both hours once, even when initial mail was already marked sent',async()=>{
 db=new PGlite();mails=[];fail=false;
 try{
  for(const file of ['schema.sql','migrate-admissions.sql','migrate-tickets.sql'])await db.exec(await readFile(new URL('../db/'+file,import.meta.url),'utf8'));
  const {prepareSelectedPreview,deliverSelectedPreview}=await import('../lib/preview-selected-seats.js');
  const {deliverTickets}=await import('../lib/tickets.js');
  await prepareSelectedPreview(tag);
  await db.exec("UPDATE additional_screenings SET starts_at=now()+interval '7 days' WHERE id=1");
  const premiere=(await db.query("INSERT INTO premiere_reservations(name,email,phone,seats,status,admission,verified_at) VALUES('Real','real@example.test','600123456',2,'confirmed','standing',now()) RETURNING id")).rows[0].id;
  await db.exec("INSERT INTO premiere_reservations(name,email,phone,seats,status,admission,verified_at) VALUES('Printed','print@example.invalid','000000000',1,'confirmed','standing',now()),('Cancelled','cancelled@example.test','600123457',1,'cancelled','standing',now())");
  const preview=(await db.query("SELECT preview_reserve_selected('Direct','direct@example.test','600123456',ARRAY['7-7']) AS id")).rows[0].id;
  await deliverTickets(tag,premiere);await deliverSelectedPreview(tag,preview);mails=[];
  const {resendReservationReceipts}=await import('../lib/receipt-resend.js');
  const result=await resendReservationReceipts(tag,{batchSize:10,pauseMs:0,inspect:false});
  assert.equal(result.total,2);assert.equal(result.sent,2);assert.equal(result.pending,0);assert.equal(result.failed,0);assert.equal(result.originally_unsent,0);
  assert.equal(mails.length,2);assert.ok(mails.every(mail=>mail[4].startsWith('reservation-receipt-20261110/')));
  await resendReservationReceipts(tag,{batchSize:10,pauseMs:0,inspect:false});assert.equal(mails.length,2);
 }finally{await db.close();}
});

test('Thursday followup reminds only unaccepted proposals and after deadline sends valid 19:00 tickets once',async()=>{
 db=new PGlite();mails=[];fail=false;
 const previous=process.env.TRANSFER_FOLLOWUP_TARGETS_20261112;
 try{
  for(const file of ['schema.sql','migrate-admissions.sql','migrate-tickets.sql'])await db.exec(await readFile(new URL('../db/'+file,import.meta.url),'utf8'));
  const {prepareSelectedPreview}=await import('../lib/preview-selected-seats.js');
  await prepareSelectedPreview(tag);
  await db.exec("UPDATE additional_screenings SET starts_at='2026-11-21 18:00+01' WHERE id=1");
  const sources=[];
  for(let number=0;number<4;number++)sources.push((await db.query("INSERT INTO premiere_reservations(name,email,phone,seats,status,admission,verified_at) VALUES('Viewer',$1,'600123456',1,'confirmed','standing',now()) RETURNING id",['follow-'+number+'@example.test'])).rows[0].id);
  for(let number=0;number<4;number++)await db.query('SELECT additional_screening_offer(1)');
  const bookings=[];
  for(const id of sources)bookings.push((await db.query('SELECT id FROM additional_screening_bookings WHERE transfer_source_id=$1',[id])).rows[0].id);
  await db.query("SELECT preview_choose_and_transfer($1,ARRAY['7-7'])",[bookings[3]]);
  process.env.TRANSFER_FOLLOWUP_TARGETS_20261112=JSON.stringify(sources.map((id,number)=>({email:'follow-'+number+'@example.test'})));
  const {processTransferFollowups,TRANSFER_DEADLINE}=await import('../lib/transfer-followup.js');
  const first=await processTransferFollowups(tag,{at:new Date('2026-11-10T16:00:00+01:00'),pauseMs:0});
  assert.equal(first.targets,3);assert.equal(first.reminders_sent,3);assert.equal(first.sent,3);assert.equal(first.failed,0);
  assert.equal(mails.length,3);assert.ok(mails.every(mail=>mail[2].includes('12 listopada')));
  assert.equal((await db.query('SELECT expires_at FROM additional_screening_bookings WHERE id=$1',[bookings[1]])).rows[0].expires_at,new Date(TRANSFER_DEADLINE).toISOString());
  await processTransferFollowups(tag,{at:new Date('2026-11-11T16:00:00+01:00'),pauseMs:0});assert.equal(mails.length,3);
  await db.query("SELECT preview_choose_and_transfer($1,ARRAY['7-8'])",[bookings[0]]);
  await db.query("UPDATE additional_screening_seats SET booking_id=$1 WHERE screening_id=1 AND row_no=1 AND seat_no=1",[bookings[1]]);
  const expired=await processTransferFollowups(tag,{at:new Date('2026-11-13T00:01:00+01:00'),pauseMs:0});
  assert.equal(expired.accepted,1);assert.equal(expired.standing_notices_sent,2);assert.equal(expired.sent,2);
  assert.equal(mails.length,5);assert.ok(mails.slice(3).every(mail=>mail[1].includes('19:00')&&mail[2].includes('Termin przyjęcia')));
  assert.equal((await db.query("SELECT booking_id FROM additional_screening_seats WHERE screening_id=1 AND row_no=1 AND seat_no=1")).rows[0].booking_id,null);
  assert.equal((await db.query('SELECT status FROM additional_screening_bookings WHERE id=$1',[bookings[0]])).rows[0].status,'confirmed');
  assert.equal((await db.query('SELECT status FROM premiere_reservations WHERE id=$1',[sources[1]])).rows[0].status,'confirmed');
  await processTransferFollowups(tag,{at:new Date('2026-11-13T00:02:00+01:00'),pauseMs:0});assert.equal(mails.length,5);
 }finally{if(previous===undefined)delete process.env.TRANSFER_FOLLOWUP_TARGETS_20261112;else process.env.TRANSFER_FOLLOWUP_TARGETS_20261112=previous;await db.close();}
});
