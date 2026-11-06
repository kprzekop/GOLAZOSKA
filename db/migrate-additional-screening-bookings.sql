-- Run after migrate-additional-screening-layouts.sql.
BEGIN;

ALTER TABLE premiere_reservations ADD COLUMN IF NOT EXISTS encore_priority boolean NOT NULL DEFAULT false;

ALTER TABLE additional_screenings
 ADD COLUMN IF NOT EXISTS invitations_open boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS additional_screening_interest (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL,
 email text NOT NULL UNIQUE,
 phone text NOT NULL,
 seats integer NOT NULL CHECK (seats BETWEEN 1 AND 2),
 created_at timestamptz NOT NULL DEFAULT now(),
 verified_at timestamptz
);

CREATE TABLE IF NOT EXISTS additional_screening_bookings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 screening_id integer NOT NULL REFERENCES additional_screenings(id),
 -- Keep the source identifier even after the premiere's retention cleanup.
 source_id uuid NOT NULL,
 name text NOT NULL,
 email text NOT NULL,
 status text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','confirmed','declined','expired','cancelled')),
 expires_at timestamptz NOT NULL,
 mailed_at timestamptz,
 mail_claimed_at timestamptz,
 UNIQUE (screening_id, source_id),
 UNIQUE (screening_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS additional_screening_one_active_offer
 ON additional_screening_bookings (source_id)
 WHERE status IN ('offered','confirmed');

ALTER TABLE additional_screening_seats ADD COLUMN IF NOT EXISTS booking_id uuid;
DO $constraints$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid='additional_screening_seats'::regclass
    AND conname='additional_screening_seats_booking_fk'
 ) THEN
  ALTER TABLE additional_screening_seats
   ADD CONSTRAINT additional_screening_seats_booking_fk
   FOREIGN KEY (screening_id, booking_id)
   REFERENCES additional_screening_bookings (screening_id, id);
 END IF;
END;
$constraints$;

CREATE OR REPLACE FUNCTION additional_screening_expire() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 WITH expired AS (
  UPDATE additional_screening_bookings SET status='expired'
  WHERE status='offered' AND expires_at<=now() RETURNING id
 )
 UPDATE additional_screening_seats SET booking_id=NULL
 WHERE booking_id IN (SELECT id FROM expired);
END;
$$;

CREATE OR REPLACE FUNCTION additional_screening_offer(p_screening integer) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
 showtime timestamptz;
 applicant record;
 available integer;
 booking uuid;
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
  WHERE verified_at IS NOT NULL AND ((admission='waiting' AND status IN ('waiting','expired'))
   OR (p_screening=1 AND admission='standing' AND status IN ('reserved','confirmed') AND email NOT LIKE '%@example.invalid')
   OR (encore_priority AND admission IN ('standing','seated') AND status IN ('reserved','confirmed','expired')))
  UNION ALL
  SELECT id,name,email,seats,created_at,1 AS priority FROM additional_screening_interest WHERE verified_at IS NOT NULL
 ) r WHERE NOT EXISTS (
  SELECT 1 FROM additional_screening_bookings b WHERE (b.email=r.email OR b.source_id=r.id)
  AND (b.screening_id=p_screening OR b.status IN ('offered','confirmed'))
 )
 ORDER BY r.priority,r.created_at,r.id LIMIT 1;
 IF NOT FOUND OR applicant.seats>available THEN RETURN NULL; END IF;

 INSERT INTO additional_screening_bookings(screening_id,source_id,name,email,expires_at)
 VALUES(p_screening,applicant.id,applicant.name,applicant.email,least(showtime,now()+interval '48 hours'))
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
 current_status text;
BEGIN
 PERFORM pg_advisory_xact_lock(851191,1);
 PERFORM additional_screening_expire();
 SELECT status INTO current_status FROM additional_screening_bookings WHERE id=p_id FOR UPDATE;
 IF current_status='offered' AND p_action='accept' THEN
  UPDATE additional_screening_bookings SET status='confirmed' WHERE id=p_id;
  RETURN 'confirmed';
 END IF;
 IF current_status IN ('offered','confirmed') AND p_action='decline'
 AND EXISTS (
  SELECT 1 FROM additional_screening_bookings b JOIN additional_screenings s ON s.id=b.screening_id
  WHERE b.id=p_id AND s.starts_at>now()
 ) THEN
  UPDATE additional_screening_bookings SET status=CASE WHEN current_status='offered' THEN 'declined' ELSE 'cancelled' END
  WHERE id=p_id RETURNING status INTO current_status;
  UPDATE additional_screening_seats SET booking_id=NULL WHERE booking_id=p_id;
 END IF;
 RETURN current_status;
END;
$$;

COMMIT;
