-- Explicit, atomic 19:00 -> 18:00 consent. Existing 18:00 tickets stay valid.
BEGIN;
ALTER TABLE additional_screening_bookings ADD COLUMN IF NOT EXISTS transfer_source_id uuid;
ALTER TABLE additional_screening_bookings ADD COLUMN IF NOT EXISTS transferred_at timestamptz;
ALTER TABLE additional_screening_bookings ADD COLUMN IF NOT EXISTS transfer_sent_at timestamptz;
ALTER TABLE additional_screening_bookings ADD COLUMN IF NOT EXISTS transfer_claimed_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS preview_one_transfer_per_source
 ON additional_screening_bookings(transfer_source_id) WHERE transfer_source_id IS NOT NULL;
-- Match existing auto-assigned tickets by email as well as their original source.
UPDATE additional_screening_bookings b SET transfer_source_id=r.id
FROM premiere_reservations r WHERE b.screening_id=1 AND b.status IN ('offered','confirmed')
 AND b.transfer_source_id IS NULL AND b.email=r.email
 AND r.verified_at IS NOT NULL AND r.email NOT LIKE '%@example.invalid'
 AND r.admission IN ('standing','waiting') AND r.status IN ('reserved','confirmed','waiting','offered')
 AND (SELECT count(*) FROM additional_screening_seats s WHERE s.booking_id=b.id)=r.seats;
CREATE OR REPLACE FUNCTION additional_screening_offer(p_screening integer) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
 showtime timestamptz;
 applicant record;
 available integer;
 booking uuid;
 transfer_source uuid;
BEGIN
 -- Serialize assignments across shows so one applicant can have one live offer.
 PERFORM pg_advisory_xact_lock(851191,1);
 PERFORM additional_screening_expire();
 SELECT starts_at INTO showtime FROM additional_screenings
 WHERE id=p_screening AND invitations_open AND starts_at>now() FOR UPDATE;
 IF showtime IS NULL THEN RETURN NULL; END IF;
 SELECT count(*) INTO available FROM additional_screening_seats
 WHERE screening_id=p_screening AND pool='public' AND booking_id IS NULL;
 SELECT r.* INTO applicant FROM (
  SELECT id,name,email,seats,created_at,0 AS priority FROM premiere_reservations
  WHERE verified_at IS NOT NULL AND email NOT LIKE '%@example.invalid' AND ((admission='waiting' AND status IN ('waiting','offered'))
   OR (p_screening=1 AND admission='standing' AND status IN ('reserved','confirmed','offered') AND email NOT LIKE '%@example.invalid')
   OR (encore_priority AND admission IN ('standing','seated') AND status IN ('reserved','confirmed','expired')))
  UNION ALL
  SELECT id,name,email,seats,created_at,1 AS priority FROM additional_screening_interest WHERE verified_at IS NOT NULL
 ) r WHERE NOT EXISTS (
  SELECT 1 FROM additional_screening_bookings b WHERE (b.email=r.email OR b.source_id=r.id)
  AND (b.screening_id=p_screening OR b.status IN ('offered','confirmed'))
 )
 ORDER BY r.priority,r.created_at,r.id LIMIT 1;
 IF NOT FOUND OR applicant.seats>available THEN RETURN NULL; END IF;

 IF p_screening=1 THEN
  SELECT id INTO transfer_source FROM premiere_reservations WHERE id=applicant.id
   AND admission IN ('standing','waiting') AND status IN ('reserved','confirmed','waiting','offered');
 END IF;
 INSERT INTO additional_screening_bookings(screening_id,source_id,name,email,status,expires_at,transfer_source_id)
 VALUES(p_screening,applicant.id,applicant.name,applicant.email,CASE WHEN p_screening=1 AND transfer_source IS NULL THEN 'confirmed' ELSE 'offered' END,least(showtime,now()+interval '48 hours'),transfer_source)
 RETURNING id INTO booking;
 WITH chosen AS (
  SELECT row_no,seat_no FROM additional_screening_seats
  WHERE screening_id=p_screening AND pool='public' AND booking_id IS NULL
  ORDER BY row_no,seat_no LIMIT applicant.seats
 )
 UPDATE additional_screening_seats s SET booking_id=booking FROM chosen c
 WHERE s.screening_id=p_screening AND s.row_no=c.row_no AND s.seat_no=c.seat_no;
 RETURN booking;
END;
$$;

CREATE OR REPLACE FUNCTION additional_screening_reply(p_id uuid,p_action text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
 b additional_screening_bookings%ROWTYPE;
 r premiere_reservations%ROWTYPE;
 showtime timestamptz;
 allocated integer;
BEGIN
 -- Same order as premiere operations; prevent cancellation/upgrade/check-in races.
 PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;
 PERFORM pg_advisory_xact_lock(851191,1);
 PERFORM additional_screening_expire();
 SELECT * INTO b FROM additional_screening_bookings WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT starts_at INTO showtime FROM additional_screenings WHERE id=b.screening_id;
 IF p_action='accept' AND b.transferred_at IS NOT NULL THEN RETURN b.status; END IF;
 -- Old accept links cannot silently consent to giving up 19:00.
 IF b.transfer_source_id IS NOT NULL AND b.transferred_at IS NULL
 AND p_action='accept' THEN RAISE EXCEPTION 'TRANSFER_CONSENT_REQUIRED'; END IF;
 IF p_action='transfer' THEN
  IF b.transferred_at IS NOT NULL THEN RETURN b.status; END IF;
  IF b.transfer_source_id IS NULL OR b.status NOT IN ('offered','confirmed')
   OR showtime IS NULL OR showtime<=now() THEN RAISE EXCEPTION 'ACTION_UNAVAILABLE'; END IF;
  SELECT * INTO r FROM premiere_reservations WHERE id=b.transfer_source_id FOR UPDATE;
  IF NOT FOUND OR r.admission NOT IN ('standing','waiting')
   OR r.status NOT IN ('reserved','confirmed','waiting','offered') THEN RAISE EXCEPTION 'ACTION_UNAVAILABLE'; END IF;
  SELECT count(*) INTO allocated FROM additional_screening_seats WHERE booking_id=b.id AND screening_id=1;
  IF allocated<>r.seats THEN RAISE EXCEPTION 'SEATS_UNAVAILABLE'; END IF;
  IF EXISTS(SELECT 1 FROM premiere_tickets WHERE reservation_id=r.id AND checked_in_at IS NOT NULL)
   THEN RAISE EXCEPTION 'ACTION_UNAVAILABLE'; END IF;
  UPDATE premiere_reservations SET status='cancelled',offer_target=NULL,offer_previous_status=NULL,
   offer_expires_at=NULL,updated_at=now() WHERE id=r.id;
  UPDATE premiere_seats SET reservation_id=NULL WHERE reservation_id=r.id;
  UPDATE additional_screening_bookings SET status='confirmed',transferred_at=now(),mailed_at=NULL,mail_claimed_at=NULL WHERE id=b.id;
  RETURN 'confirmed';
 END IF;
 IF b.status='offered' AND p_action='accept' AND showtime>now() THEN
  UPDATE additional_screening_bookings SET status='confirmed' WHERE id=p_id;
  RETURN 'confirmed';
 END IF;
 IF b.status IN ('offered','confirmed') AND p_action='decline' AND showtime>now() THEN
  UPDATE additional_screening_bookings SET status=CASE WHEN b.status='offered' THEN 'declined' ELSE 'cancelled' END
   WHERE id=p_id RETURNING status INTO b.status;
  UPDATE additional_screening_seats SET booking_id=NULL WHERE booking_id=p_id;
 END IF;
 RETURN b.status;
END;
$$;
CREATE TABLE IF NOT EXISTS preview_transfer_consent_v1(id integer PRIMARY KEY);
COMMIT;
