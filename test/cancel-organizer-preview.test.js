import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {cancelOrganizerPreview} from '../lib/cancel-organizer-preview.js';

test('cancel organizer entries only on 18:00, release their seats, and preserve later new reservations',async()=>{
 const db=new PGlite();
 const previous=process.env.STANDING_GUEST_PRINT_CONTACT;
 process.env.STANDING_GUEST_PRINT_CONTACT='zakupy@przekop.pl';
 const tag=(parts,...values)=>tag.query(parts.map((part,index)=>part+(index<values.length?'$'+(index+1):'')).join(''),values);
 tag.query=(text,values=[])=>({text,values,then(resolve,reject){return db.query(text,values).then(result=>result.rows).then(resolve,reject);}});
 tag.transaction=queries=>db.transaction(async tx=>{const results=[];for(const query of queries)results.push((await tx.query(query.text,query.values)).rows);return results;});
 try{
  await db.exec(`
   CREATE TABLE premiere_config(id integer PRIMARY KEY);INSERT INTO premiere_config VALUES(1);
   CREATE TABLE premiere_reservations(id text,status text);INSERT INTO premiere_reservations VALUES('19-own','confirmed');
   CREATE TABLE additional_screening_bookings(id text PRIMARY KEY,screening_id integer,email text,status text,standing_seats integer DEFAULT 0,mail_claimed_at timestamptz);
   CREATE TABLE additional_screening_seats(seat_no integer,booking_id text);
   INSERT INTO additional_screening_bookings(id,screening_id,email,status) VALUES
    ('pending',1,'zakupy@przekop.pl','offered'),('own-ticket',1,'ZAKUPY@przekop.pl','confirmed'),
    ('viewer',1,'viewer@example.test','confirmed'),('other-show',2,'zakupy@przekop.pl','confirmed');
   INSERT INTO additional_screening_seats VALUES(1,'own-ticket'),(2,'viewer'),(3,'other-show');
  `);
  const result=await cancelOrganizerPreview(tag);
  assert.equal(result.cancelled_bookings,2);assert.equal(result.released_seats,1);assert.equal(result.remaining,0);
  assert.equal((await db.query("SELECT booking_id FROM additional_screening_seats WHERE seat_no=1")).rows[0].booking_id,null);
  assert.equal((await db.query("SELECT status FROM additional_screening_bookings WHERE id='viewer'")).rows[0].status,'confirmed');
  assert.equal((await db.query("SELECT status FROM additional_screening_bookings WHERE id='other-show'")).rows[0].status,'confirmed');
  assert.equal((await db.query('SELECT status FROM premiere_reservations')).rows[0].status,'confirmed');
  await db.exec("INSERT INTO additional_screening_bookings(id,screening_id,email,status) VALUES('later',1,'zakupy@przekop.pl','confirmed')");
  assert.equal((await cancelOrganizerPreview(tag)).remaining,1);
  assert.equal((await db.query("SELECT status FROM additional_screening_bookings WHERE id='later'")).rows[0].status,'confirmed');
 }finally{if(previous===undefined)delete process.env.STANDING_GUEST_PRINT_CONTACT;else process.env.STANDING_GUEST_PRINT_CONTACT=previous;await db.close();}
});
