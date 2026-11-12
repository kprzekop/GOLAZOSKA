import {readFile} from 'node:fs/promises';
import {BASE,escapeHtml,sendMail} from './shared.js';
import {initializePreviewScreening} from './additional-screenings.js';

async function prepareSelectedBase(db){
 await initializePreviewScreening(db);
 const [schema]=await db`SELECT to_regclass('public.preview_selected_seats_v4') IS NOT NULL AS ready`;
 if(schema.ready)return;
 const migration=await readFile(new URL('../db/migrate-preview-selected-seats.sql',import.meta.url),'utf8');
 const body=migration.slice(migration.indexOf('BEGIN;')+6,migration.lastIndexOf('COMMIT;'));
 await db.transaction([
  db`SELECT id FROM premiere_config WHERE id=1 FOR UPDATE`,
  db`SELECT pg_advisory_xact_lock(851191,1)`,
  db.query(`DO $migration$ BEGIN
   IF to_regclass('public.preview_selected_seats_v4') IS NOT NULL THEN RETURN; END IF;
   ${body}
  END; $migration$;`)
 ]);
}

export async function prepareSelectedPreview(db){
 await prepareSelectedBase(db);
 const [schema]=await db`SELECT to_regclass('public.preview_standing_overflow_v5') IS NOT NULL AS ready`;
 if(!schema.ready)await preparePreviewStanding(db);
 const [limit]=await db`SELECT to_regclass('public.preview_standing_online_limit_v1') IS NOT NULL AS ready`;
 if(limit.ready)return;
 await db.transaction([
  db`SELECT id FROM premiere_config WHERE id=1 FOR UPDATE`,
  db`SELECT pg_advisory_xact_lock(851191,1)`,
  db`DO $limit$ BEGIN
   IF to_regclass('public.preview_standing_online_limit_v1') IS NOT NULL THEN RETURN; END IF;
   UPDATE additional_screenings SET standing_capacity=LEAST(standing_capacity,2) WHERE id=1;
   CREATE TABLE preview_standing_online_limit_v1(id integer PRIMARY KEY);
  END; $limit$;`
 ]);
}

async function preparePreviewStanding(db){
 const migration=await readFile(new URL('../db/migrate-preview-standing-overflow.sql',import.meta.url),'utf8');
 const body=migration.slice(migration.indexOf('BEGIN;')+6,migration.lastIndexOf('COMMIT;'));
 await db.transaction([
  db`SELECT id FROM premiere_config WHERE id=1 FOR UPDATE`,
  db`SELECT pg_advisory_xact_lock(851191,1)`,
  db.query(`DO $migration$ BEGIN
   IF to_regclass('public.preview_standing_overflow_v5') IS NOT NULL THEN RETURN; END IF;
   ${body}
  END; $migration$;`)
 ]);
}

export async function deliverSelectedPreview(db,id,{resendKey=null}={}){
 const [booking]=await db`UPDATE additional_screening_bookings b SET mail_claimed_at=now()
  FROM additional_screenings s WHERE b.id=${id}::uuid AND s.id=b.screening_id
  AND b.status='confirmed' AND (b.transfer_source_id IS NULL OR (${resendKey}::text IS NOT NULL AND b.transferred_at IS NOT NULL))
  AND (b.mailed_at IS NULL OR ${resendKey}::text IS NOT NULL)
  AND (b.mail_claimed_at IS NULL OR b.mail_claimed_at<now()-interval '10 minutes')
  RETURNING b.id,b.name,b.email,b.standing_seats,s.starts_at`;
 if(!booking)return {sent:0,failed:0};
 try{
  const seats=await db`SELECT row_no,seat_no FROM additional_screening_seats WHERE booking_id=${id}::uuid ORDER BY row_no,seat_no`;
  const date=new Date(booking.starts_at).toLocaleString('pl-PL',{timeZone:'Europe/Warsaw'});
  const places=booking.standing_seats>0?'wejście bez gwarancji fotela dla '+booking.standing_seats+' osób':seats.map(seat=>'rząd '+seat.row_no+', miejsce '+seat.seat_no).join('; ');
  const providerId=await sendMail(booking.email,'Twoja wejściówka na pokaz o 18:00 – Goła Zośka 1812',
   '<p>Dzień dobry, '+escapeHtml(booking.name)+'.</p><p>'+date+
   ' · sala widowiskowa MDK, Rynek Zygmunta Augusta 9. Wejście od ul. Kościelnej, II piętro.</p><p>Twoje wejście: '+
   places+'.</p><p>Po pokazie krótkie spotkanie z twórcami.</p><p>Wejściówka jest już ważna. <a href="'+BASE+
   '/dodatkowy-seans.html?oferta='+id+'">Pokaż wejściówkę lub anuluj rezerwację</a>.</p>',
   [],resendKey||'preview-ticket/'+id);
  await db`UPDATE additional_screening_bookings SET mailed_at=now(),mail_claimed_at=NULL WHERE id=${id}::uuid`;
  return providerId?{sent:1,failed:0,providerId}:{sent:1,failed:0};
 }catch{
  await db`UPDATE additional_screening_bookings SET mail_claimed_at=NULL WHERE id=${id}::uuid`;
  return {sent:0,failed:1};
 }
}
