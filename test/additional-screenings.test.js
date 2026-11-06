import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('additional screenings copy seats and advance verified applicants independently of premiere bookings',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`
   CREATE TABLE premiere_seats(row_no int,seat_no int);
   INSERT INTO premiere_seats SELECT r,s FROM generate_series(1,7) r
   CROSS JOIN LATERAL generate_series(1,CASE WHEN r=7 THEN 8 WHEN r%2=1 THEN 12 ELSE 13 END) s;
   CREATE TABLE premiere_reservations(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,email text,seats int,admission text,
    status text,verified_at timestamptz,created_at timestamptz
   );
   INSERT INTO premiere_reservations(name,email,seats,admission,status,verified_at,created_at) VALUES
    ('Unverified','unverified@example.test',1,'waiting','waiting',NULL,now()-interval '3 days'),
    ('First','first@example.test',2,'waiting','waiting',now(),now()-interval '2 days'),
    ('Second','second@example.test',1,'waiting','waiting',now(),now()-interval '1 day');
  `);
  for(const migration of ['layouts','bookings']){
   const sql=await readFile(new URL('../db/migrate-additional-screening-'+migration+'.sql',import.meta.url),'utf8');
   await db.exec(`DO $launch$ BEGIN ${sql.slice(sql.indexOf('BEGIN;')+6,sql.lastIndexOf('COMMIT;'))} END; $launch$;`);
   await db.exec(sql);
  }
  const pools=await db.query("SELECT pool,count(*)::int AS count FROM additional_screening_seats GROUP BY pool ORDER BY pool");
  assert.deepEqual(pools.rows,[{pool:'organizational',count:75},{pool:'public',count:174}]);
  const next=async(show)=> (await db.query('SELECT additional_screening_offer($1) AS id',[show])).rows[0].id;
  assert.equal(await next(1),null);
  await db.exec("UPDATE additional_screenings SET starts_at=now()+interval '7 days',invitations_open=true");
  const first=await next(1);
  assert.ok(first);
  const firstOffer=await db.query('SELECT name,(SELECT count(*)::int FROM additional_screening_seats WHERE booking_id=b.id) AS seats FROM additional_screening_bookings b WHERE b.id=$1',[first]);
  assert.deepEqual(firstOffer.rows,[{name:'First',seats:2}]);
  const second=await next(2);
  assert.ok(second);
  assert.equal(await next(3),null);
  const reply=async(id,action)=>(await db.query('SELECT additional_screening_reply($1,$2) AS status',[id,action])).rows[0].status;
  assert.equal(await reply(first,'accept'),'confirmed');
  assert.equal(await reply(first,'accept'),'confirmed');
  assert.equal(await reply(second,'decline'),'declined');
  const released=await db.query('SELECT count(*)::int AS count FROM additional_screening_seats WHERE booking_id=$1',[second]);
  assert.equal(released.rows[0].count,0);
  assert.ok(await next(3));
 }finally{await db.close();}
});
