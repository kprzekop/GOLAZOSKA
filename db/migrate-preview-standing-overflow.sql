BEGIN;
ALTER TABLE additional_screenings ADD COLUMN IF NOT EXISTS standing_capacity integer NOT NULL DEFAULT 0 CHECK(standing_capacity BETWEEN 0 AND 10);
UPDATE additional_screenings SET standing_capacity=10 WHERE id=1;
ALTER TABLE additional_screening_bookings ADD COLUMN IF NOT EXISTS standing_seats integer NOT NULL DEFAULT 0 CHECK(standing_seats BETWEEN 0 AND 2);
CREATE OR REPLACE FUNCTION preview_reserve_standing(p_name text,p_email text,p_phone text,p_count integer) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
 source uuid;
 booking uuid;
 showtime timestamptz;
 capacity integer;
 used integer;
BEGIN
 PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;
 PERFORM pg_advisory_xact_lock(851191,1);
 PERFORM additional_screening_expire();
 IF p_count NOT BETWEEN 1 AND 2 OR p_count IS NULL THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
 SELECT starts_at,standing_capacity INTO showtime,capacity FROM additional_screenings WHERE id=1 AND invitations_open AND starts_at>now();
 IF showtime IS NULL THEN RAISE EXCEPTION 'CLOSED'; END IF;
 IF EXISTS(SELECT 1 FROM additional_screening_seats WHERE screening_id=1 AND pool='public' AND booking_id IS NULL)
 THEN RAISE EXCEPTION 'SEATED_AVAILABLE'; END IF;
 IF EXISTS(SELECT 1 FROM additional_screening_bookings WHERE screening_id=1 AND email=p_email AND status IN ('confirmed','offered'))
 THEN RAISE EXCEPTION 'DUPLICATE'; END IF;
 SELECT COALESCE(sum(standing_seats),0)::int INTO used FROM additional_screening_bookings
 WHERE screening_id=1 AND (status='confirmed' OR (status='offered' AND expires_at>now()));
 IF used+p_count>capacity THEN RAISE EXCEPTION 'STANDING_UNAVAILABLE'; END IF;
 INSERT INTO additional_screening_interest(name,email,phone,seats,verified_at)
 VALUES(p_name,p_email,p_phone,p_count,now())
 ON CONFLICT(email) DO UPDATE SET id=gen_random_uuid(),name=excluded.name,phone=excluded.phone,seats=excluded.seats,
 created_at=now(),verified_at=now() RETURNING id INTO source;
 INSERT INTO additional_screening_bookings(screening_id,source_id,name,email,status,expires_at,standing_seats)
 VALUES(1,source,p_name,p_email,'confirmed',showtime,p_count) RETURNING id INTO booking;
 RETURN booking;
END;
$$;
CREATE TABLE IF NOT EXISTS preview_standing_overflow_v5(id integer PRIMARY KEY);
COMMIT;
