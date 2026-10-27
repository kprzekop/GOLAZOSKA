-- Apply to a NEW private database. For existing installations use db/migrate-numbered-seats.sql.
CREATE TABLE IF NOT EXISTS premiere_config (
 id integer PRIMARY KEY CHECK(id=1),
 public_capacity integer NOT NULL CHECK(public_capacity BETWEEN 0 AND 83),
 guest_capacity integer NOT NULL CHECK(guest_capacity BETWEEN 0 AND 83),
 physical_capacity integer NOT NULL DEFAULT 83 CHECK(physical_capacity=83),
 CHECK(public_capacity+guest_capacity<=physical_capacity)
);
INSERT INTO premiere_config VALUES(1,27,50,83) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS premiere_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, email text NOT NULL,
 phone text NOT NULL CHECK(phone ~ '^[+]?[0-9]{9,15}$'),
 seats integer NOT NULL CHECK(seats BETWEEN 1 AND 4),
 status text NOT NULL CHECK(status IN('verification','reserved','confirmed','waiting','offered','cancelled','expired')),
 token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 created_at timestamptz NOT NULL DEFAULT now(), verified_at timestamptz,
 reminder_sent_at timestamptz,final_sent_at timestamptz,offer_sent_at timestamptz,offer_expires_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),CHECK(email=lower(email))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_live_booking_per_email ON premiere_reservations(email)
 WHERE status IN('verification','reserved','confirmed','waiting','offered');
CREATE INDEX IF NOT EXISTS premiere_queue ON premiere_reservations(status,created_at);
CREATE TABLE IF NOT EXISTS premiere_seats (
 id text PRIMARY KEY, row_no integer NOT NULL CHECK(row_no BETWEEN 1 AND 7),
 seat_no integer NOT NULL CHECK(seat_no BETWEEN 1 AND 13),
 pool text NOT NULL CHECK(pool IN('organizational','held','public')),
 reservation_id uuid REFERENCES premiere_reservations(id),
 UNIQUE(row_no,seat_no),CHECK(id=row_no::text||'-'||seat_no::text),
 CHECK(reservation_id IS NULL OR pool='public')
);
INSERT INTO premiere_seats(id,row_no,seat_no,pool)
 SELECT r::text||'-'||s::text,r,s,
 CASE WHEN r<=4 THEN 'organizational' WHEN s>CASE r WHEN 5 THEN 10 WHEN 6 THEN 11 ELSE 6 END THEN 'held' ELSE 'public' END
 FROM generate_series(1,7) r
 CROSS JOIN LATERAL generate_series(1,CASE WHEN r=7 THEN 8 WHEN r%2=1 THEN 12 ELSE 13 END) s
 ON CONFLICT(id) DO NOTHING;

-- Every mutation locks the same config row. Expiry also runs on public reads and booking attempts.
CREATE OR REPLACE FUNCTION premiere_expire() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;
 UPDATE premiere_reservations SET status='expired',updated_at=now()
 WHERE (status IN('verification','waiting') AND verified_at IS NULL AND created_at<=now()-interval '24 hours')
 OR (status='offered' AND offer_expires_at<=now())
 OR (status IN('verification','reserved') AND created_at<'2026-11-18 19:00 Europe/Warsaw'::timestamptz
     AND now()>='2026-11-18 19:00 Europe/Warsaw'::timestamptz)
 OR (status IN('verification','reserved','waiting','offered') AND now()>='2026-11-21 19:00 Europe/Warsaw'::timestamptz);
 UPDATE premiere_seats SET reservation_id=NULL WHERE reservation_id IN
 (SELECT id FROM premiere_reservations WHERE status IN('expired','cancelled'));
END $$;

CREATE OR REPLACE FUNCTION premiere_create(p_name text,p_email text,p_phone text,p_ids text[],p_count integer,p_waiting boolean)
RETURNS TABLE(booking_id uuid,booking_token uuid,booking_status text) LANGUAGE plpgsql AS $$
DECLARE new_id uuid;new_token uuid;new_status text;available integer;
BEGIN
 PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;
 PERFORM premiere_expire();
 IF now()>='2026-11-21 19:00 Europe/Warsaw'::timestamptz THEN RAISE EXCEPTION 'CLOSED'; END IF;
 IF p_name IS NULL OR p_email IS NULL OR p_phone IS NULL OR p_ids IS NULL OR p_count IS NULL OR p_waiting IS NULL
 OR p_count NOT BETWEEN 1 AND 4 OR length(trim(p_name)) NOT BETWEEN 2 AND 120
 OR length(p_email)>254 OR p_email !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
 OR p_phone !~ '^[+]?[0-9]{9,15}$'
 OR (p_waiting AND cardinality(p_ids)<>0) OR (NOT p_waiting AND cardinality(p_ids)<>p_count)
 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
 IF EXISTS(SELECT 1 FROM premiere_reservations WHERE email=lower(trim(p_email))
 AND status IN('verification','reserved','confirmed','waiting','offered')) THEN RAISE EXCEPTION 'DUPLICATE'; END IF;
 IF NOT p_waiting THEN
  SELECT count(*) INTO available FROM premiere_seats WHERE id=ANY(p_ids) AND pool='public' AND reservation_id IS NULL;
  IF available<>p_count THEN RAISE EXCEPTION 'SEATS_UNAVAILABLE'; END IF;
 END IF;
 new_status:=CASE WHEN p_waiting THEN 'waiting' ELSE 'verification' END;
 INSERT INTO premiere_reservations(name,email,phone,seats,status)
 VALUES(trim(p_name),lower(trim(p_email)),p_phone,p_count,new_status) RETURNING id,token INTO new_id,new_token;
 IF NOT p_waiting THEN UPDATE premiere_seats SET reservation_id=new_id WHERE id=ANY(p_ids); END IF;
 RETURN QUERY SELECT new_id,new_token,new_status;
END $$;

CREATE OR REPLACE FUNCTION premiere_action(p_token uuid,p_action text)
RETURNS TABLE(booking_status text,booking_seats integer) LANGUAGE plpgsql AS $$
DECLARE r premiere_reservations%ROWTYPE;next_status text;
BEGIN
 PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;
 PERFORM premiere_expire();
 SELECT * INTO r FROM premiere_reservations WHERE token=p_token FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF p_action='cancel' AND r.status IN('verification','reserved','confirmed','waiting','offered') THEN next_status:='cancelled';
 ELSIF p_action='confirm' AND r.status='waiting' THEN next_status:='waiting';
 ELSIF p_action='confirm' AND r.status IN('verification','offered') THEN
  next_status:=CASE WHEN now()>='2026-11-14 19:00 Europe/Warsaw'::timestamptz THEN 'confirmed' ELSE 'reserved' END;
 ELSIF p_action='confirm' AND r.status='reserved' AND now()>='2026-11-14 19:00 Europe/Warsaw'::timestamptz THEN next_status:='confirmed';
 ELSIF p_action='confirm' AND r.status='confirmed' THEN next_status:='confirmed';
 ELSE RAISE EXCEPTION 'ACTION_UNAVAILABLE';END IF;
 UPDATE premiere_reservations SET status=next_status,updated_at=now(),
 verified_at=CASE WHEN p_action='confirm' THEN coalesce(verified_at,now()) ELSE verified_at END WHERE id=r.id;
 IF next_status='cancelled' THEN UPDATE premiere_seats SET reservation_id=NULL WHERE reservation_id=r.id;END IF;
 RETURN QUERY SELECT next_status,r.seats;
END $$;

CREATE OR REPLACE FUNCTION premiere_offer(p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE requested integer;chosen text[];
BEGIN
 PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;
 PERFORM premiere_expire();
 SELECT seats INTO requested FROM premiere_reservations WHERE id=p_id AND status='waiting' AND verified_at IS NOT NULL FOR UPDATE;
 IF requested IS NULL OR now()>='2026-11-21 19:00 Europe/Warsaw'::timestamptz THEN RAISE EXCEPTION 'ACTION_UNAVAILABLE';END IF;
 -- Prefer a contiguous block; otherwise offer the first available seats.
 SELECT array_agg(s.id ORDER BY s.seat_no) INTO chosen FROM premiere_seats s
 JOIN LATERAL (SELECT a.row_no,a.seat_no FROM premiere_seats a
  WHERE a.pool='public' AND a.reservation_id IS NULL AND
  (SELECT count(*) FROM premiere_seats b WHERE b.row_no=a.row_no AND b.seat_no BETWEEN a.seat_no AND a.seat_no+requested-1
   AND b.pool='public' AND b.reservation_id IS NULL)=requested
  ORDER BY a.row_no,a.seat_no LIMIT 1) block
 ON s.row_no=block.row_no AND s.seat_no BETWEEN block.seat_no AND block.seat_no+requested-1;
 IF cardinality(chosen) IS DISTINCT FROM requested THEN
 SELECT array_agg(id ORDER BY row_no,seat_no) INTO chosen FROM
 (SELECT id,row_no,seat_no FROM premiere_seats WHERE pool='public' AND reservation_id IS NULL ORDER BY row_no,seat_no LIMIT requested) x;
 END IF;
 IF cardinality(chosen) IS DISTINCT FROM requested THEN RAISE EXCEPTION 'NO_CAPACITY';END IF;
 UPDATE premiere_seats SET reservation_id=p_id WHERE id=ANY(chosen);
 UPDATE premiere_reservations SET status='offered',offer_sent_at=NULL,
 offer_expires_at=least(now()+interval '48 hours','2026-11-21 19:00 Europe/Warsaw'::timestamptz),updated_at=now() WHERE id=p_id;
END $$;

CREATE OR REPLACE FUNCTION premiere_advance() RETURNS TABLE(promoted_id uuid) LANGUAGE plpgsql AS $$
DECLARE candidate uuid;free_count integer;
BEGIN
 PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;PERFORM premiere_expire();
 SELECT count(*) INTO free_count FROM premiere_seats WHERE pool='public' AND reservation_id IS NULL;
 SELECT id INTO candidate FROM premiere_reservations WHERE status='waiting' AND verified_at IS NOT NULL AND seats<=free_count
 AND now()<'2026-11-21 19:00 Europe/Warsaw'::timestamptz ORDER BY created_at,id LIMIT 1;
 IF candidate IS NOT NULL THEN PERFORM premiere_offer(candidate);END IF;
 RETURN QUERY SELECT candidate;
END $$;

CREATE OR REPLACE FUNCTION premiere_admin_action(p_id uuid,p_action text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE old_status text;next_status text;
BEGIN
 PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;PERFORM premiere_expire();
 SELECT status INTO old_status FROM premiere_reservations WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF p_action='offer' THEN PERFORM premiere_offer(p_id);RETURN 'offered';
 ELSIF p_action='cancel' AND old_status IN('verification','reserved','confirmed','waiting','offered') THEN next_status:='cancelled';
 ELSIF p_action='confirm' AND old_status IN('verification','reserved','confirmed','offered')
 AND now()<'2026-11-21 19:00 Europe/Warsaw'::timestamptz THEN next_status:='confirmed';
 ELSE RAISE EXCEPTION 'ACTION_UNAVAILABLE';END IF;
 UPDATE premiere_reservations SET status=next_status,updated_at=now(),
 verified_at=CASE WHEN next_status='confirmed' THEN coalesce(verified_at,now()) ELSE verified_at END WHERE id=p_id;
 IF next_status='cancelled' THEN UPDATE premiere_seats SET reservation_id=NULL WHERE reservation_id=p_id;END IF;
 RETURN next_status;
END $$;

CREATE OR REPLACE FUNCTION premiere_set_pool(p_id text,p_pool text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;PERFORM premiere_expire();
 IF p_pool NOT IN('held','public') THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 UPDATE premiere_seats SET pool=p_pool WHERE id=p_id AND pool IN('held','public') AND reservation_id IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACTION_UNAVAILABLE';END IF;
 UPDATE premiere_config SET public_capacity=(SELECT count(*) FROM premiere_seats WHERE pool='public') WHERE id=1;
END $$;
