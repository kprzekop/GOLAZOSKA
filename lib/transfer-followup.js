import {BASE,confirmUrl,escapeHtml,sendMail} from './shared.js';
import {prepareSelectedPreview} from './preview-selected-seats.js';
import {deliverTickets} from './tickets.js';

export const TRANSFER_DEADLINE='2026-11-12T23:59:59+01:00';

async function followupStats(db){
 const [stats]=await db`SELECT count(*)::int AS targets,
  count(*) FILTER(WHERE f.reminder_sent_at IS NOT NULL)::int AS reminders_sent,
  count(*) FILTER(WHERE b.transferred_at IS NOT NULL)::int AS accepted,
  count(*) FILTER(WHERE f.fallback_sent_at IS NOT NULL)::int AS standing_notices_sent
  FROM transfer_followup_20261112 f JOIN additional_screening_bookings b ON b.id=f.booking_id`;
 const targetCheck=await db`SELECT target.ordinality::int AS target,
  count(b.id)::int AS matched,
  count(b.id) FILTER(WHERE b.transferred_at IS NOT NULL)::int AS transferred,
  count(b.id) FILTER(WHERE b.status='confirmed' AND b.transfer_source_id IS NULL)::int AS direct_confirmed,
  count(b.id) FILTER(WHERE b.status IN ('cancelled','declined'))::int AS cancelled_or_declined,
  count(b.id) FILTER(WHERE b.status='expired')::int AS expired,
  count(b.id) FILTER(WHERE b.status='offered')::int AS offered,
  count(b.id) FILTER(WHERE r.admission='standing' AND r.status IN ('reserved','confirmed','offered'))::int AS standing,
  count(b.id) FILTER(WHERE r.admission='waiting' AND r.status IN ('waiting','offered'))::int AS waiting
  FROM jsonb_array_elements(${process.env.TRANSFER_FOLLOWUP_TARGETS_20261112}::jsonb) WITH ORDINALITY target(value,ordinality)
  LEFT JOIN additional_screening_bookings b ON b.screening_id=1 AND
   (lower(trim(b.email))=lower(trim(target.value->>'email')) OR lower(trim(b.name))=lower(trim(target.value->>'name')))
  LEFT JOIN premiere_reservations r ON r.id=b.transfer_source_id
  GROUP BY target.ordinality ORDER BY target.ordinality`;
 return {...stats,targetCheck,version:'followup-existing-preview-v2'};
}

export async function processTransferFollowups(db,{at=new Date(),pauseMs=700}={}){
 const targets=process.env.TRANSFER_FOLLOWUP_TARGETS_20261112;
 if(!targets)return {configured:false};
 if(at>=new Date('2026-11-21T19:00:00+01:00'))return {done:true};
 await prepareSelectedPreview(db);
 const timestamp=at.toISOString();
 const [schema]=await db`SELECT to_regclass('public.transfer_followup_20261112') IS NOT NULL AS ready`;
 if(!schema.ready)await db.transaction([
  db`SELECT id FROM premiere_config WHERE id=1 FOR UPDATE`,
  db`SELECT pg_advisory_xact_lock(851191,1)`,
  db`SELECT set_config('gola.transfer_followup_targets',${targets},true)`,
  db.query(`DO $setup$ BEGIN
   IF to_regclass('public.transfer_followup_20261112') IS NOT NULL THEN RETURN; END IF;
   CREATE TABLE transfer_followup_20261112(
    booking_id uuid PRIMARY KEY,source_id uuid NOT NULL,reminder_sent_at timestamptz,
    reminder_claimed_at timestamptz,fallback_sent_at timestamptz,fallback_claimed_at timestamptz);
   INSERT INTO transfer_followup_20261112(booking_id,source_id)
   SELECT b.id,r.id FROM additional_screening_bookings b JOIN premiere_reservations r ON r.id=b.transfer_source_id
   WHERE b.screening_id=1 AND b.transferred_at IS NULL AND b.status IN ('offered','confirmed','expired')
   AND r.admission='standing' AND r.status IN ('reserved','confirmed','offered')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(current_setting('gola.transfer_followup_targets')::jsonb) target
    WHERE lower(trim(b.email))=lower(trim(target->>'email')) OR lower(trim(b.name))=lower(trim(target->>'name')));
   IF (SELECT count(*) FROM transfer_followup_20261112)>3 THEN RAISE EXCEPTION 'AMBIGUOUS_TARGETS'; END IF;
   UPDATE additional_screening_bookings SET status='offered',expires_at='${TRANSFER_DEADLINE}'::timestamptz
   WHERE id IN (SELECT booking_id FROM transfer_followup_20261112) AND transferred_at IS NULL;
  END; $setup$;`)
 ]);
 let sent=0,failed=0;
 if(at<new Date(TRANSFER_DEADLINE)){
  await db.transaction([
   db`SELECT id FROM premiere_config WHERE id=1 FOR UPDATE`,
   db`SELECT pg_advisory_xact_lock(851191,1)`,
   db`INSERT INTO transfer_followup_20261112(booking_id,source_id)
    SELECT b.id,r.id FROM additional_screening_bookings b JOIN premiere_reservations r ON r.id=b.transfer_source_id
    WHERE b.screening_id=1 AND b.transferred_at IS NULL  
    AND r.admission='standing' AND r.status IN ('reserved','confirmed','offered')
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(${targets}::jsonb) target
     WHERE lower(trim(b.email))=lower(trim(target->>'email')) OR lower(trim(b.name))=lower(trim(target->>'name')))
    ON CONFLICT(booking_id) DO NOTHING`,
   db`UPDATE additional_screening_bookings b SET status='declined'
    FROM transfer_followup_20261112 f WHERE b.id=f.booking_id AND b.transferred_at IS NULL
    AND f.reminder_sent_at IS NULL AND EXISTS(SELECT 1 FROM additional_screening_bookings direct
     WHERE direct.screening_id=1 AND direct.status='confirmed' AND direct.transfer_source_id IS NULL AND direct.email=b.email)`,
   db`UPDATE additional_screening_bookings b SET status='offered',expires_at=${TRANSFER_DEADLINE}::timestamptz
    FROM transfer_followup_20261112 f WHERE b.id=f.booking_id AND b.transferred_at IS NULL
    AND f.reminder_sent_at IS NULL AND b.status IN ('offered','confirmed','expired')
    AND NOT EXISTS(SELECT 1 FROM additional_screening_bookings direct WHERE direct.screening_id=1
     AND direct.status='confirmed' AND direct.transfer_source_id IS NULL AND direct.email=b.email)`
  ]);
  const pending=await db`SELECT f.booking_id FROM transfer_followup_20261112 f
   JOIN additional_screening_bookings b ON b.id=f.booking_id
   WHERE f.reminder_sent_at IS NULL AND b.transferred_at IS NULL AND (b.status='offered' OR EXISTS(SELECT 1 FROM additional_screening_bookings direct WHERE direct.screening_id=1 AND direct.status='confirmed' AND direct.transfer_source_id IS NULL AND direct.email=b.email))`;
  for(const item of pending){
   const [booking]=await db`UPDATE transfer_followup_20261112 f SET reminder_claimed_at=now()
    FROM additional_screening_bookings b,premiere_reservations r
    WHERE f.booking_id=${item.booking_id}::uuid AND b.id=f.booking_id AND r.id=f.source_id
    AND f.reminder_sent_at IS NULL AND b.transferred_at IS NULL
    AND (b.status='offered' OR EXISTS(SELECT 1 FROM additional_screening_bookings direct WHERE direct.screening_id=1 AND direct.status='confirmed' AND direct.transfer_source_id IS NULL AND direct.email=b.email))
    AND r.admission='standing' AND r.status IN ('reserved','confirmed','offered')
    AND (f.reminder_claimed_at IS NULL OR f.reminder_claimed_at<now()-interval '10 minutes')
    RETURNING f.booking_id,b.name,b.email,r.token AS source_token,
     (SELECT direct.id FROM additional_screening_bookings direct WHERE direct.screening_id=1
      AND direct.status='confirmed' AND direct.transfer_source_id IS NULL AND direct.email=b.email LIMIT 1) AS direct_id`;
   if(!booking)continue;
   if(pauseMs)await new Promise(resolve=>setTimeout(resolve,pauseMs));
   try{
    if(booking.direct_id)await sendMail(booking.email,'Wybierz godzinę pokazu – masz już rezerwację na 18:00',
     '<p>Dzień dobry, '+escapeHtml(booking.name)+'.</p><p>Masz już ważną, samodzielnie dokonaną rezerwację foteli na pokaz 21 listopada o 18:00 oraz wejście stojące na premierę o 19:00.</p>'+
     '<p>Prosimy o wybór godziny do czwartku, 12 listopada, godz. 23:59. Jeśli wybierasz 18:00, <a href="'+confirmUrl(booking.source_token)+
     '">otwórz zgłoszenie na 19:00 i wybierz „Anuluj rezerwację”</a>, aby zwolnić wejście dla kolejnej osoby.</p>'+
     '<p><a href="'+BASE+'/dodatkowy-seans.html?oferta='+booking.direct_id+'">Twoja ważna wejściówka na 18:00</a>.</p>'+
     '<p>Twoje samodzielnie wybrane fotele na 18:00 zachowują ważność. Brak decyzji nie anuluje wejścia stojącego na 19:00.</p>',
     [],'transfer-followup-20261112/'+booking.booking_id);
    else await sendMail(booking.email,'Do czwartku wybierz fotel na 18:00 – Goła Zośka 1812',
     '<p>Dzień dobry, '+escapeHtml(booking.name)+'.</p><p>Przypominamy o dodatkowym pokazie przedpremierowym 21 listopada o godz. 18:00. Po seansie odbędzie się krótkie spotkanie z twórcami.</p>'+
     '<p>Masz pierwszeństwo wyboru dostępnych foteli. <a href="'+BASE+'/dodatkowy-seans.html?oferta='+booking.booking_id+
     '">Wybierz miejsca i zatwierdź zamianę</a> do czwartku, 12 listopada, godz. 23:59.</p>'+
     '<p>Zatwierdzenie zamiany anuluje Twoje zgłoszenie na 19:00. Jeśli nie wybierzesz zmiany w terminie, propozycja na 18:00 wygaśnie, a Twoje wejście stojące na premierę o 19:00 pozostanie ważne. Wyślemy wtedy wiadomość z wejściówką.</p>',
     [],'transfer-followup-20261112/'+booking.booking_id);
    await db`UPDATE transfer_followup_20261112 SET reminder_sent_at=${timestamp}::timestamptz,reminder_claimed_at=NULL WHERE booking_id=${booking.booking_id}::uuid`;sent++;
   }catch{
    await db`UPDATE transfer_followup_20261112 SET reminder_claimed_at=NULL WHERE booking_id=${booking.booking_id}::uuid`;failed++;
   }
  }
 }else{
  await db.transaction([
   db`SELECT id FROM premiere_config WHERE id=1 FOR UPDATE`,
   db`SELECT pg_advisory_xact_lock(851191,1)`,
   db`WITH expired AS (
    UPDATE additional_screening_bookings b SET status='expired' FROM transfer_followup_20261112 f
    WHERE b.id=f.booking_id AND b.transferred_at IS NULL AND b.status='offered' AND b.expires_at<=${timestamp}::timestamptz RETURNING b.id
   ) UPDATE additional_screening_seats SET booking_id=NULL WHERE booking_id IN (SELECT id FROM expired)`
  ]);
  const pending=await db`SELECT f.booking_id FROM transfer_followup_20261112 f
   JOIN additional_screening_bookings b ON b.id=f.booking_id WHERE f.fallback_sent_at IS NULL AND b.transferred_at IS NULL`;
  for(const item of pending){
   const [booking]=await db`UPDATE transfer_followup_20261112 f SET fallback_claimed_at=now()
    FROM additional_screening_bookings b,premiere_reservations r
    WHERE f.booking_id=${item.booking_id}::uuid AND b.id=f.booking_id AND r.id=f.source_id
    AND f.fallback_sent_at IS NULL AND b.transferred_at IS NULL
    AND r.admission='standing' AND (r.status='confirmed' OR (r.status='offered' AND r.offer_previous_status='confirmed'))
    AND (f.fallback_claimed_at IS NULL OR f.fallback_claimed_at<now()-interval '10 minutes')
    RETURNING f.booking_id,f.source_id`;
   if(!booking)continue;
   if(pauseMs)await new Promise(resolve=>setTimeout(resolve,pauseMs));
   const result=await deliverTickets(db,booking.source_id,{
    resendKey:'standing-after-deadline-20261112/'+booking.booking_id,
    subject:'Twoje wejście stojące na premierę o 19:00 pozostaje ważne',
    reminderText:'Termin przyjęcia propozycji na 18:00 minął. Propozycja wygasła. Zachowujesz ważne wejście bez gwarancji fotela na premierę 21 listopada o 19:00.'
   });
   if(result.sent){
    await db`UPDATE transfer_followup_20261112 SET fallback_sent_at=${timestamp}::timestamptz,fallback_claimed_at=NULL WHERE booking_id=${booking.booking_id}::uuid`;sent++;
   }else{
    await db`UPDATE transfer_followup_20261112 SET fallback_claimed_at=NULL WHERE booking_id=${booking.booking_id}::uuid`;failed+=result.failed;
   }
  }
 }
 return {...await followupStats(db),sent,failed,deadline:TRANSFER_DEADLINE};
}
