import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
async function setup(){
 const db=new PGlite();
 for(const f of ['schema.sql','migrate-admissions.sql','migrate-tickets.sql','migrate-additional-screening-layouts.sql','migrate-additional-screening-bookings.sql'])await db.exec(await readFile(new URL('../db/'+f,import.meta.url),'utf8'));
 await db.exec("UPDATE additional_screenings SET starts_at=now()+interval '7 days',invitations_open=true WHERE id=1");
 return db;
}
const migration=await readFile(new URL('../db/migrate-preview-transfers.sql',import.meta.url),'utf8');
async function guest(db,{email='viewer@example.test',admission='standing',status='confirmed',seats=2}={}){
 return (await db.query("INSERT INTO premiere_reservations(name,email,phone,seats,status,admission,verified_at) VALUES('Viewer',$1,'600123456',$2,$3,$4,now()) RETURNING id,token",[email,seats,status,admission])).rows[0];
}
const first=async(db,q,args=[])=>(await db.query(q,args)).rows[0];
const reply=async(db,id,action)=>(await first(db,'SELECT additional_screening_reply($1,$2) AS status',[id,action])).status;
const offer=async db=>(await first(db,'SELECT additional_screening_offer(1) AS id')).id;
test('standing and waiting: explicit consent swaps whole group, frees 19:00 and invalidates QR; replay is safe',async()=>{
 for(const admission of ['standing','waiting']){
  const db=await setup();try{
   const r=await guest(db,{admission,status:admission==='waiting'?'waiting':'confirmed'});
   await db.query('INSERT INTO premiere_tickets(reservation_id,person_no) VALUES($1,1)',[r.id]);
   await db.exec(migration);
   const id=await offer(db);assert.ok(id);
   assert.equal((await first(db,'SELECT status FROM additional_screening_bookings WHERE id=$1',[id])).status,'offered');
   assert.equal((await first(db,'SELECT status FROM premiere_reservations WHERE id=$1',[r.id])).status,admission==='waiting'?'waiting':'confirmed');
   await assert.rejects(reply(db,id,'accept'),/TRANSFER_CONSENT_REQUIRED/);
   assert.equal(await reply(db,id,'transfer'),'confirmed');
   assert.equal(await reply(db,id,'transfer'),'confirmed');
   assert.equal((await first(db,'SELECT status FROM premiere_reservations WHERE id=$1',[r.id])).status,'cancelled');
   assert.equal((await first(db,'SELECT count(*)::int AS n FROM additional_screening_seats WHERE booking_id=$1',[id])).n,2);
   const ticket=await first(db,'SELECT id FROM premiere_tickets WHERE reservation_id=$1',[r.id]);
   assert.equal((await first(db,'SELECT result FROM premiere_checkin($1,false)',[ticket.id])).result,'invalid');
   assert.equal(await reply(db,id,'decline'),'cancelled');
   assert.equal(await reply(db,id,'transfer'),'cancelled');
   assert.equal((await first(db,'SELECT status FROM premiere_reservations WHERE id=$1',[r.id])).status,'cancelled');
  }finally{await db.close();}
 }
});
test('decline or expiry frees only 18:00; insufficient seats and upgrades cannot cancel 19:00',async()=>{
 for(const scenario of ['decline','expiry','missing-seat','upgraded']){
  const db=await setup();try{
   const r=await guest(db);await db.exec(migration);const id=await offer(db);
   if(scenario==='decline')assert.equal(await reply(db,id,'decline'),'declined');
   if(scenario==='expiry'){await db.query("UPDATE additional_screening_bookings SET expires_at=now()-interval '1 second' WHERE id=$1",[id]);await assert.rejects(reply(db,id,'transfer'),/ACTION_UNAVAILABLE/);await db.exec('SELECT additional_screening_expire()');}
   if(scenario==='missing-seat'){await db.query('UPDATE additional_screening_seats SET booking_id=NULL WHERE booking_id=$1',[id]);await assert.rejects(reply(db,id,'transfer'),/SEATS_UNAVAILABLE/);}
   if(scenario==='upgraded'){await db.query("UPDATE premiere_reservations SET admission='seated' WHERE id=$1",[r.id]);await assert.rejects(reply(db,id,'transfer'),/ACTION_UNAVAILABLE/);}
   assert.equal((await first(db,'SELECT status FROM premiere_reservations WHERE id=$1',[r.id])).status,'confirmed');
   if(['decline','expiry'].includes(scenario))assert.equal((await first(db,'SELECT count(*)::int AS n FROM additional_screening_seats WHERE booking_id=$1',[id])).n,0);
  }finally{await db.close();}
 }
});
test('existing automatic 18:00 tickets stay valid and receive a separate consent; direct signups keep original flow',async()=>{
 const db=await setup();try{
  const r=await guest(db);const id=await offer(db);
  await db.exec(migration);await db.exec(migration);
  const old=await first(db,'SELECT status,transfer_source_id,transferred_at FROM additional_screening_bookings WHERE id=$1',[id]);
  assert.equal(old.status,'confirmed');assert.equal(old.transfer_source_id,r.id);assert.equal(old.transferred_at,null);
  assert.equal(await reply(db,id,'transfer'),'confirmed');
  await db.exec("INSERT INTO additional_screening_interest(name,email,phone,seats,verified_at) VALUES('Direct','direct@example.test','600123456',1,now())");
  const direct=await offer(db);
  const b=await first(db,'SELECT status,transfer_source_id FROM additional_screening_bookings WHERE id=$1',[direct]);
  assert.equal(b.status,'confirmed');assert.equal(b.transfer_source_id,null);
 }finally{await db.close();}
});
test('pending 19:00 seat upgrade is released atomically on transfer',async()=>{
 const db=await setup();try{
  const r=await guest(db,{status:'offered'});
  await db.query("UPDATE premiere_reservations SET offer_target='seated',offer_previous_status='confirmed' WHERE id=$1",[r.id]);
  await db.query("UPDATE premiere_seats SET reservation_id=$1 WHERE id IN ('6-1','6-2')",[r.id]);
  await db.exec(migration);const id=await offer(db);await reply(db,id,'transfer');
  assert.equal((await first(db,'SELECT count(*)::int AS n FROM premiere_seats WHERE reservation_id=$1',[r.id])).n,0);
 }finally{await db.close();}
});

test('seat choice: unavailable selection leaves 19:00 intact, successful swap releases old hold and supports replay',async()=>{
 const db=await setup();try{
  const source=await guest(db);
  await db.exec(migration);
  const id=await offer(db);
  await db.exec(await readFile(new URL('../db/migrate-preview-seat-choice.sql',import.meta.url),'utf8'));
  const choose=async seats=>(await first(db,'SELECT preview_choose_and_transfer($1,$2::text[]) AS status',[id,seats])).status;
  await assert.rejects(choose(['7-99','7-8']),/SEATS_UNAVAILABLE/);
  assert.equal((await first(db,'SELECT status FROM premiere_reservations WHERE id=$1',[source.id])).status,'confirmed');
  await assert.rejects(choose(['7-7','7-7']),/INVALID_INPUT/);
  assert.equal(await choose(['7-7','7-8']),'confirmed');
  assert.equal((await first(db,'SELECT status FROM premiere_reservations WHERE id=$1',[source.id])).status,'cancelled');
  const seats=await db.query('SELECT row_no,seat_no FROM additional_screening_seats WHERE booking_id=$1 ORDER BY row_no,seat_no',[id]);
  assert.deepEqual(seats.rows,[{row_no:7,seat_no:7},{row_no:7,seat_no:8}]);
  assert.equal(await choose(['1-1','1-2']),'confirmed');
  assert.deepEqual((await db.query('SELECT row_no,seat_no FROM additional_screening_seats WHERE booking_id=$1 ORDER BY row_no,seat_no',[id])).rows,seats.rows);
 }finally{await db.close();}
});

test('direct viewer reservation at 18:00 keeps its seats and confirmed status',async()=>{
 const db=await setup();try{
  const r=await guest(db);
  const interest=await first(db,"INSERT INTO additional_screening_interest(name,email,phone,seats,verified_at) VALUES('Direct','viewer@example.test','600123456',2,now()) RETURNING id");
  const booking=await first(db,"INSERT INTO additional_screening_bookings(screening_id,source_id,name,email,status,expires_at) VALUES(1,$1,'Direct','viewer@example.test','confirmed',now()+interval '2 days') RETURNING id",[interest.id]);
  await db.query("UPDATE additional_screening_seats SET booking_id=$1 WHERE screening_id=1 AND row_no=7 AND seat_no IN (7,8)",[booking.id]);
  await db.exec(migration);
  await db.exec(await readFile(new URL('../db/migrate-preview-seat-choice.sql',import.meta.url),'utf8'));
  const current=await first(db,'SELECT status,transfer_source_id FROM additional_screening_bookings WHERE id=$1',[booking.id]);
  assert.equal(current.status,'confirmed');assert.equal(current.transfer_source_id,null);
  assert.equal((await first(db,'SELECT count(*)::int AS n FROM additional_screening_seats WHERE booking_id=$1',[booking.id])).n,2);
  assert.equal((await first(db,'SELECT status FROM premiere_reservations WHERE id=$1',[r.id])).status,'confirmed');
 }finally{await db.close();}
});

test('release pending holds, preserve direct and accepted tickets, and allocate new proposals only on choice',async()=>{
 const db=await setup();try{
  const pending=await guest(db,{email:'pending-release@example.test'});
  await db.exec(migration);
  await db.exec(await readFile(new URL('../db/migrate-preview-seat-choice.sql',import.meta.url),'utf8'));
  const pendingId=await offer(db);
  const accepted=await guest(db,{email:'accepted-release@example.test'});
  const acceptedId=await offer(db);
  await reply(db,acceptedId,'transfer');
  await db.exec("INSERT INTO additional_screening_interest(name,email,phone,seats,verified_at) VALUES('Direct','direct-release@example.test','600123456',1,now())");
  const directId=await offer(db);
  const release=await readFile(new URL('../db/migrate-preview-release-holds.sql',import.meta.url),'utf8');
  await db.exec(release);await db.exec(release);
  assert.equal((await first(db,'SELECT released_seats FROM preview_unaccepted_holds_released_v3 WHERE id=1')).released_seats,2);
  const allocated=async id=>(await first(db,'SELECT count(*)::int AS n FROM additional_screening_seats WHERE booking_id=$1',[id])).n;
  assert.equal(await allocated(pendingId),0);
  assert.equal(await allocated(acceptedId),2);
  assert.equal(await allocated(directId),1);
  assert.equal((await first(db,'SELECT status FROM premiere_reservations WHERE id=$1',[pending.id])).status,'confirmed');
  const newcomer=await guest(db,{email:'new-release@example.test'});
  const newcomerId=await offer(db);
  assert.equal(await allocated(newcomerId),0);
  assert.equal((await first(db,"SELECT preview_choose_and_transfer($1,ARRAY['7-7','7-8']) AS status",[newcomerId])).status,'confirmed');
  assert.equal(await allocated(newcomerId),2);
  assert.equal((await first(db,'SELECT status FROM premiere_reservations WHERE id=$1',[newcomer.id])).status,'cancelled');
 }finally{await db.close();}
});
