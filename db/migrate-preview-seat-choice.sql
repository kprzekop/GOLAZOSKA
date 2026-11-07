BEGIN;
UPDATE additional_screening_bookings b SET status='offered',expires_at=least(s.starts_at,now()+interval '48 hours'),
 transfer_sent_at=NULL,transfer_claimed_at=NULL
FROM additional_screenings s
WHERE s.id=b.screening_id AND b.transfer_source_id IS NOT NULL AND b.transferred_at IS NULL
 AND b.status IN ('offered','confirmed') AND s.starts_at>now();

CREATE OR REPLACE FUNCTION preview_choose_and_transfer(p_id uuid,p_seats text[]) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
 b additional_screening_bookings%ROWTYPE;
 needed integer;
 matched integer;
 result text;
BEGIN
 PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;
 PERFORM pg_advisory_xact_lock(851191,1);
 PERFORM additional_screening_expire();
 SELECT * INTO b FROM additional_screening_bookings WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACTION_UNAVAILABLE'; END IF;
 IF b.transferred_at IS NOT NULL THEN RETURN b.status; END IF;
 IF b.transfer_source_id IS NULL OR b.status NOT IN ('offered','confirmed')
  THEN RAISE EXCEPTION 'ACTION_UNAVAILABLE'; END IF;
 SELECT seats INTO needed FROM premiere_reservations WHERE id=b.transfer_source_id;
 IF needed IS NULL OR p_seats IS NULL OR cardinality(p_seats)<>needed
  OR (SELECT count(DISTINCT value) FROM unnest(p_seats) value)<>needed
  THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
 SELECT count(*) INTO matched FROM additional_screening_seats
 WHERE screening_id=1 AND pool='public'
 AND row_no::text||'-'||seat_no::text=ANY(p_seats)
 AND (booking_id IS NULL OR booking_id=b.id);
 IF matched<>needed THEN RAISE EXCEPTION 'SEATS_UNAVAILABLE'; END IF;
 UPDATE additional_screening_seats SET booking_id=NULL WHERE booking_id=b.id;
 UPDATE additional_screening_seats SET booking_id=b.id
 WHERE screening_id=1 AND row_no::text||'-'||seat_no::text=ANY(p_seats);
 result:=additional_screening_reply(p_id,'transfer');
 RETURN result;
END;
$$;
CREATE TABLE IF NOT EXISTS preview_transfer_seat_choice_v2(id integer PRIMARY KEY);
COMMIT;