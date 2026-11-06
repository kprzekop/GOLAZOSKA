import {readFile} from 'node:fs/promises';
import {BASE,escapeHtml,sendMail} from './shared.js';

export async function additionalScreeningsReady(db){
 const [result]=await db`SELECT to_regclass('public.additional_screening_bookings') IS NOT NULL AS ready`;
 return result.ready;
}

export async function initializePreviewScreening(db){
 const [state]=await db`SELECT to_regclass('public.preview_screening_20261121_auto_tickets') IS NOT NULL AS ready`;
 if(state.ready)return;
 const [layout,bookings]=await Promise.all([
  readFile(new URL('../db/migrate-additional-screening-layouts.sql',import.meta.url),'utf8'),
  readFile(new URL('../db/migrate-additional-screening-bookings.sql',import.meta.url),'utf8')
 ]);
 const body=sql=>sql.slice(sql.indexOf('BEGIN;')+6,sql.lastIndexOf('COMMIT;'));
 await db.transaction([
  db`SELECT pg_advisory_xact_lock(851191,2)`,
  db.query(`DO $launch$
   BEGIN
    IF to_regclass('public.preview_screening_20261121_auto_tickets') IS NOT NULL THEN RETURN; END IF;
    ${body(layout)}
    ${body(bookings)}
    UPDATE additional_screenings SET starts_at='2026-11-21 18:00 Europe/Warsaw'::timestamptz,
     invitations_open=true WHERE id=1 AND starts_at IS NULL;
    UPDATE additional_screening_seats SET pool='public'
    WHERE screening_id=1 AND pool='organizational' AND booking_id IS NULL;
    UPDATE additional_screening_bookings SET status='confirmed',mailed_at=NULL,mail_claimed_at=NULL
    WHERE screening_id=1 AND status='offered' AND expires_at>now();
    UPDATE additional_screening_interest SET verified_at=now() WHERE verified_at IS NULL
    AND created_at>now()-interval '24 hours';
    CREATE TABLE preview_screening_20261121_auto_tickets (id integer PRIMARY KEY);
   END;
   $launch$;`)
 ]);
}

export async function sendAdditionalScreeningOffers(db){
 const result={sent:0,failed:0};
 await initializePreviewScreening(db);
 await db`SELECT additional_screening_expire()`;
 const shows=await db`SELECT id FROM additional_screenings WHERE invitations_open AND starts_at>now() ORDER BY starts_at,id`;
 for(const show of shows){
  for(let count=0;count<83;count++){
   const [offer]=await db`SELECT additional_screening_offer(${show.id}) AS id`;
   if(!offer.id)break;
  }
 }
 // Keep each daily run bounded and leave the rest in the durable delivery queue.
 for(let count=0;count<83;count++){
  const [offer]=await db`WITH candidate AS (
    SELECT b.id FROM additional_screening_bookings b JOIN additional_screenings s ON s.id=b.screening_id
    WHERE s.invitations_open AND ((b.status='offered' AND b.expires_at>now()) OR (b.screening_id=1 AND b.status='confirmed' AND s.starts_at>now())) AND b.mailed_at IS NULL
    AND (b.mail_claimed_at IS NULL OR b.mail_claimed_at<now()-interval '10 minutes')
    ORDER BY b.expires_at,b.id LIMIT 1 FOR UPDATE OF b SKIP LOCKED
   )
   UPDATE additional_screening_bookings b SET mail_claimed_at=now()
   FROM candidate c,additional_screenings s WHERE b.id=c.id AND s.id=b.screening_id
   RETURNING b.id,b.name,b.email,b.expires_at,b.screening_id,s.starts_at`;
  if(!offer)break;
  try{
   const url=BASE+'/dodatkowy-seans.html?oferta='+offer.id;
   const format=new Intl.DateTimeFormat('pl-PL',{dateStyle:'long',timeStyle:'short',timeZone:'Europe/Warsaw'});
   if(offer.screening_id===1){
    const seats=await db`SELECT row_no,seat_no FROM additional_screening_seats WHERE booking_id=${offer.id}::uuid ORDER BY row_no,seat_no`;
    await sendMail(offer.email,'Twoja wejściówka na pokaz o 18:00 – Goła Zośka 1812',
     '<p>Dzień dobry, '+escapeHtml(offer.name)+'.</p><p>'+format.format(new Date(offer.starts_at))+
     ' · sala widowiskowa MDK w Augustowie. Po seansie spotkanie z twórcami.</p><p>'+seats.map(seat=>'Rząd '+seat.row_no+', miejsce '+seat.seat_no).join(' · ')+
     '</p><p>Wejściówka jest już ważna. Pokaż ją przy wejściu. <a href="'+escapeHtml(url)+'">Pokaż wejściówkę lub anuluj rezerwację</a>.</p>');
   }else await sendMail(offer.email,'Propozycja miejsc na dodatkowy seans – Goła Zośka 1812',
    '<p>Dzień dobry, '+escapeHtml(offer.name)+'.</p><p>Proponujemy bezpłatne miejsca na seans '+format.format(new Date(offer.starts_at))+
    ' w sali widowiskowej MDK w Augustowie. Po pokazie odbędzie się krótkie spotkanie z twórcami.</p><p>Dotychczasowe wejście na premierę o 19:00 pozostaje ważne.</p><p><a href="'+escapeHtml(url)+'">Sprawdź miejsca i przyjmij propozycję</a> do '+
    format.format(new Date(offer.expires_at))+'.</p>');
   await db`UPDATE additional_screening_bookings SET mailed_at=now(),mail_claimed_at=NULL WHERE id=${offer.id}::uuid`;
   result.sent++;
  }catch{
   result.failed++;
  }
 }
 return result;
}
