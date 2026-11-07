import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {RECONCILE_PREVIEW_SQL} from '../lib/preview-reconciliation.js';

test('confirmed transfers release standing capacity, pending proposals and later rebookings stay active',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`
   CREATE TABLE premiere_reservations (
    id text PRIMARY KEY,email text,phone text,seats int,admission text,status text,
    created_at timestamptz,updated_at timestamptz,offer_target text,offer_previous_status text,offer_expires_at timestamptz
   );
   CREATE TABLE premiere_seats(id text PRIMARY KEY,reservation_id text);
   CREATE TABLE additional_screening_bookings (
    id text PRIMARY KEY,screening_id int,transfer_source_id text,email text,status text,transferred_at timestamptz
   );
   INSERT INTO premiere_reservations(id,email,phone,seats,admission,status,created_at) VALUES
    ('agreed','agreed@example.test','+48600123456',2,'standing','confirmed','2026-11-05'),
    ('pending','pending@example.test','600123457',2,'standing','confirmed','2026-11-05'),
    ('direct','direct@example.test','600123458',1,'standing','confirmed','2026-11-05'),
    ('later','agreed@example.test','+48600123456',1,'standing','confirmed','2026-11-08');
   INSERT INTO additional_screening_bookings VALUES
    ('preview-agreed',1,'agreed','agreed@example.test','confirmed','2026-11-07'),
    ('preview-pending',1,'pending','pending@example.test','offered',NULL),
    ('preview-direct',1,NULL,'direct@example.test','confirmed',NULL);
  `);
  const result=(await db.query(RECONCILE_PREVIEW_SQL)).rows[0];
  assert.equal(result.removed_bookings,1);
  assert.equal(result.released_standing,2);
  assert.equal(result.awaiting_consent,1);
  const rows=(await db.query('SELECT id,status FROM premiere_reservations ORDER BY id')).rows;
  assert.deepEqual(rows,[{id:'agreed',status:'cancelled'},{id:'direct',status:'confirmed'},{id:'later',status:'confirmed'},{id:'pending',status:'confirmed'}]);
  assert.equal((await db.query(RECONCILE_PREVIEW_SQL)).rows[0].removed_bookings,0);
 }finally{await db.close();}
});
