import {initializePreviewScreening,sendPreviewTransferOffers} from './additional-screenings.js';

export async function sendOrganizerTransferTest(db){
 const ids=[...JSON.parse(process.env.STANDING_GUEST_PRINT_IDS||'[]'),...JSON.parse(process.env.STANDING_GUEST_PRINT_EXTRA_IDS||'[]')];
 const contact=process.env.STANDING_GUEST_PRINT_CONTACT;
 if(ids.length!==5||new Set(ids).size!==5||!contact)throw Error('ORGANIZER_TEST_CONFIGURATION');
 await initializePreviewScreening(db);
 const [existing]=await db`SELECT count(*)::int AS sent FROM additional_screening_bookings
  WHERE screening_id=1 AND transfer_source_id=ANY(${ids}::uuid[]) AND transfer_sent_at IS NOT NULL`;
 if(existing.sent===5)return {sent:0,failed:0,totalSent:5};
 await db.transaction([
  db`SELECT id FROM premiere_config WHERE id=1 FOR UPDATE`,
  db`SELECT pg_advisory_xact_lock(851191,1)`,
  db`SELECT set_config('gola.test_transfer_ids',${JSON.stringify(ids)},true),set_config('gola.test_transfer_contact',${contact},true)`,
  db.query(ORGANIZER_TRANSFER_TEST_SQL)
 ]);
 const result=await sendPreviewTransferOffers(db,{sourceIds:ids,subjectPrefix:'[PRÓBA] '});
 const [after]=await db`SELECT count(*)::int AS sent FROM additional_screening_bookings
  WHERE screening_id=1 AND transfer_source_id=ANY(${ids}::uuid[]) AND transfer_sent_at IS NOT NULL`;
 return {...result,totalSent:after.sent};
}

export const ORGANIZER_TRANSFER_TEST_SQL=`DO $test$
DECLARE
 source uuid;
 r premiere_reservations%ROWTYPE;
 booking uuid;
 showtime timestamptz;
 available integer;
BEGIN
 SELECT starts_at INTO showtime FROM additional_screenings WHERE id=1 AND starts_at>now() AND invitations_open;
 IF showtime IS NULL THEN RAISE EXCEPTION 'SHOW_UNAVAILABLE'; END IF;
 FOR source IN SELECT value::uuid FROM jsonb_array_elements_text(current_setting('gola.test_transfer_ids')::jsonb)
 LOOP
  SELECT * INTO r FROM premiere_reservations WHERE id=source
   AND email='druk-'||id||'@example.invalid' AND admission='standing'
   AND status IN ('reserved','confirmed','offered');
  IF NOT FOUND THEN CONTINUE; END IF;
  IF EXISTS(SELECT 1 FROM additional_screening_bookings WHERE screening_id=1 AND source_id=r.id) THEN CONTINUE; END IF;
  SELECT count(*) INTO available FROM additional_screening_seats WHERE screening_id=1 AND pool='public' AND booking_id IS NULL;
  IF available<r.seats THEN RAISE EXCEPTION 'NO_CAPACITY'; END IF;
  INSERT INTO additional_screening_bookings(screening_id,source_id,transfer_source_id,name,email,status,expires_at)
  VALUES(1,r.id,r.id,r.name,current_setting('gola.test_transfer_contact'),'offered',least(showtime,now()+interval '48 hours'))
  RETURNING id INTO booking;
  WITH chosen AS (
   SELECT row_no,seat_no FROM additional_screening_seats WHERE screening_id=1 AND pool='public' AND booking_id IS NULL
   ORDER BY row_no,seat_no LIMIT r.seats
  )
  UPDATE additional_screening_seats s SET booking_id=booking FROM chosen c
  WHERE s.screening_id=1 AND s.row_no=c.row_no AND s.seat_no=c.seat_no;
 END LOOP;
END;
$test$;`;
