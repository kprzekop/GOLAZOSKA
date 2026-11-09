BEGIN;
CREATE OR REPLACE FUNCTION preview_reserve_selected(
 p_name text,p_email text,p_phone text,p_ids text[]
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
 source uuid;
 booking uuid;
 available integer;
 showtime timestamptz;
BEGIN
 PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;
 PERFORM pg_advisory_xact_lock(851191,1);
 PERFORM additional_screening_expire();
 SELECT starts_at INTO showtime FROM additional_screenings WHERE id=1 AND invitations_open AND starts_at>now();
 IF showtime IS NULL THEN RAISE EXCEPTION 'CLOSED'; END IF;
 IF p_ids IS NULL OR cardinality(p_ids) NOT BETWEEN 1 AND 2
 OR (SELECT count(DISTINCT value) FROM unnest(p_ids) value)<>cardinality(p_ids)
 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
 IF EXISTS(SELECT 1 FROM additional_screening_bookings WHERE screening_id=1 AND email=p_email
 AND status IN ('confirmed','offered')) THEN RAISE EXCEPTION 'DUPLICATE'; END IF;
 SELECT count(*) INTO available FROM additional_screening_seats WHERE screening_id=1
 AND pool='public' AND booking_id IS NULL AND row_no::text||'-'||seat_no::text=ANY(p_ids);
 IF available<>cardinality(p_ids) THEN RAISE EXCEPTION 'SEATS_UNAVAILABLE'; END IF;
 INSERT INTO additional_screening_interest(name,email,phone,seats,verified_at)
 VALUES(p_name,p_email,p_phone,cardinality(p_ids),now())
 ON CONFLICT(email) DO UPDATE SET id=gen_random_uuid(),name=excluded.name,phone=excluded.phone,
 seats=excluded.seats,verified_at=now(),created_at=now()
 RETURNING id INTO source;
 INSERT INTO additional_screening_bookings(screening_id,source_id,name,email,status,expires_at)
 VALUES(1,source,p_name,p_email,'confirmed',showtime)
 RETURNING id INTO booking;
 UPDATE additional_screening_seats SET booking_id=booking
 WHERE screening_id=1 AND row_no::text||'-'||seat_no::text=ANY(p_ids);
 RETURN booking;
END;
$$;
CREATE TABLE IF NOT EXISTS preview_selected_seats_v4(id integer PRIMARY KEY);
COMMIT;
