import {readFile} from 'node:fs/promises';
import {BASE,escapeHtml,sendMail} from './shared.js';

export async function additionalScreeningsReady(db){
 const [result]=await db`SELECT to_regclass('public.additional_screening_bookings') IS NOT NULL AS ready`;
 return result.ready;
}

async function initializePreviewBase(db){
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

export async function initializePreviewScreening(db){
 await initializePreviewBase(db);
 const [state]=await db`SELECT to_regclass('public.preview_transfer_consent_v1') IS NOT NULL AS ready`;
 if(state.ready)return;
 const migration=await readFile(new URL('../db/migrate-preview-transfers.sql',import.meta.url),'utf8');
 const body=migration.slice(migration.indexOf('BEGIN;')+6,migration.lastIndexOf('COMMIT;'));
 await db.transaction([
  db`SELECT id FROM premiere_config WHERE id=1 FOR UPDATE`,
  db`SELECT pg_advisory_xact_lock(851191,1)`,
  db`SELECT pg_advisory_xact_lock(851191,2)`,
  db.query(`DO $migration$ BEGIN
   IF to_regclass('public.preview_transfer_consent_v1') IS NOT NULL THEN RETURN; END IF;
   ${body}
  END; $migration$;`)
 ]);
}

const format=new Intl.DateTimeFormat('pl-PL',{dateStyle:'long',timeStyle:'short',timeZone:'Europe/Warsaw'});
export async function sendPreviewTransferOffers(db){
 const result={sent:0,failed:0};
 for(let i=0;i<83;i++){
  const [offer]=await db`WITH candidate AS (
   SELECT b.id FROM additional_screening_bookings b JOIN additional_screenings s ON s.id=b.screening_id
   JOIN premiere_reservations r ON r.id=b.transfer_source_id
   WHERE b.transferred_at IS NULL AND b.transfer_sent_at IS NULL AND s.starts_at>now()
   AND (b.status='confirmed' OR (b.status='offered' AND b.expires_at>now()))
   AND r.admission IN ('standing','waiting') AND r.status IN ('reserved','confirmed','waiting','offered')
   AND (b.transfer_claimed_at IS NULL OR b.transfer_claimed_at<now()-interval '10 minutes')
   ORDER BY r.created_at,b.id LIMIT 1 FOR UPDATE OF b SKIP LOCKED
  ) UPDATE additional_screening_bookings b SET transfer_claimed_at=now()
   FROM candidate c,additional_screenings s WHERE b.id=c.id AND s.id=b.screening_id
   RETURNING b.id,b.name,b.email,b.status,b.expires_at,s.starts_at`;
  if(!offer)break;
  try{
   const seats=await db`SELECT row_no,seat_no FROM additional_screening_seats WHERE booking_id=${offer.id}::uuid ORDER BY row_no,seat_no`;
   const url=BASE+'/dodatkowy-seans.html?oferta='+offer.id;
   await sendMail(offer.email,'Zamień 19:00 na miejsca siedzące o 18:00 – Goła Zośka 1812',
    '<p>Dzień dobry, '+escapeHtml(offer.name)+'.</p><p>Zapraszamy do zamiany zgłoszenia na premierę o 19:00 na bezpłatne miejsca siedzące na pokazie przedpremierowym: '+format.format(new Date(offer.starts_at))+'.</p>'+
    '<p>Sala widowiskowa MDK, Rynek Zygmunta Augusta 9, wejście od ul. Kościelnej, II piętro. Po seansie krótkie spotkanie z twórcami.</p><p>Fotele dla Twojej grupy: '+seats.map(s=>'rząd '+s.row_no+', miejsce '+s.seat_no).join('; ')+'.</p>'+
    '<p><strong>Dopiero po wybraniu „Zamieniam na 18:00” anulujemy całe zgłoszenie na 19:00 — wejście na stojąco lub wpis na liście rezerwowej. Dotychczasowe wejściówki na 19:00 stracą ważność.</strong></p>'+
    '<p>Odmowa lub brak odpowiedzi nie zmienia zgłoszenia na 19:00. Samo otwarcie linku nie dokonuje zamiany.</p>'+
    '<p><a href="'+escapeHtml(url)+'">Sprawdź miejsca i zdecyduj o zamianie</a></p>'+
    (offer.status==='offered'?'<p>Propozycja ważna do '+format.format(new Date(offer.expires_at))+'.</p>':'<p>Masz już przydzielone miejsca na 18:00. Prosimy o decyzję, czy rezygnujesz ze zgłoszenia na 19:00 na rzecz tego pokazu.</p>'),
    [],'preview-transfer-offer/'+offer.id);
   await db`UPDATE additional_screening_bookings SET transfer_sent_at=now(),transfer_claimed_at=NULL WHERE id=${offer.id}::uuid`;
   result.sent++;
  }catch{await db`UPDATE additional_screening_bookings SET transfer_claimed_at=NULL WHERE id=${offer.id}::uuid`;result.failed++;}
 }
 return result;
}

export async function deliverTransferConfirmation(db,id){
 const [offer]=await db`UPDATE additional_screening_bookings b SET mail_claimed_at=now()
  FROM additional_screenings s WHERE b.id=${id}::uuid AND b.screening_id=s.id
  AND b.transferred_at IS NOT NULL AND b.status='confirmed' AND b.mailed_at IS NULL
  AND (b.mail_claimed_at IS NULL OR b.mail_claimed_at<now()-interval '10 minutes')
  RETURNING b.id,b.name,b.email,s.starts_at`;
 if(!offer)return {sent:0,failed:0};
 try{
  const seats=await db`SELECT row_no,seat_no FROM additional_screening_seats WHERE booking_id=${id}::uuid ORDER BY row_no,seat_no`;
  await sendMail(offer.email,'Zamiana potwierdzona: wejściówka na 18:00 – Goła Zośka 1812',
   '<p>Dzień dobry, '+escapeHtml(offer.name)+'.</p><p>Zamiana zakończona. Zgłoszenie na 19:00 zostało anulowane, a stare wejściówki na ten pokaz są nieważne.</p><p>Twoje ważne miejsca na '+format.format(new Date(offer.starts_at))+': '+seats.map(s=>'rząd '+s.row_no+', miejsce '+s.seat_no).join('; ')+'.</p><p>Sala widowiskowa MDK, Rynek Zygmunta Augusta 9, wejście od ul. Kościelnej, II piętro.</p><p><a href="'+escapeHtml(BASE+'/dodatkowy-seans.html?oferta='+id)+'">Pokaż ważną wejściówkę na 18:00</a>. Zachowaj ten link i pokaż go przy wejściu.</p>',
   [],'preview-transfer-confirmation/'+id);
  await db`UPDATE additional_screening_bookings SET mailed_at=now(),mail_claimed_at=NULL WHERE id=${id}::uuid`;
  return {sent:1,failed:0};
 }catch{await db`UPDATE additional_screening_bookings SET mail_claimed_at=NULL WHERE id=${id}::uuid`;return {sent:0,failed:1};}
}

export async function sendAdditionalScreeningOffers(db,{previewOnly=false}={}){
 const result={sent:0,failed:0};
 await initializePreviewScreening(db);
 await db`SELECT additional_screening_expire()`;
 const shows=await db`SELECT id FROM additional_screenings WHERE invitations_open AND starts_at>now() AND (NOT ${previewOnly} OR id=1) ORDER BY starts_at,id`;
 for(const show of shows){
  for(let count=0;count<83;count++){
   const [offer]=await db`SELECT additional_screening_offer(${show.id}) AS id`;
   if(!offer.id)break;
  }
 }
 const transfers=await sendPreviewTransferOffers(db);
 result.sent+=transfers.sent;result.failed+=transfers.failed;
 const pending=await db`SELECT id FROM additional_screening_bookings WHERE transferred_at IS NOT NULL AND status='confirmed' AND mailed_at IS NULL LIMIT 83`;
 for(const item of pending){const delivery=await deliverTransferConfirmation(db,item.id);result.sent+=delivery.sent;result.failed+=delivery.failed;}
 if(previewOnly)return {...result,transfers};
 // Keep each daily run bounded and leave the rest in the durable delivery queue.
 for(let count=0;count<83;count++){
  const [offer]=await db`WITH candidate AS (
    SELECT b.id FROM additional_screening_bookings b JOIN additional_screenings s ON s.id=b.screening_id
    WHERE s.invitations_open AND (NOT ${previewOnly} OR s.id=1) AND b.transfer_source_id IS NULL AND ((b.status='offered' AND b.expires_at>now()) OR (b.screening_id=1 AND b.status='confirmed' AND s.starts_at>now())) AND b.mailed_at IS NULL
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
