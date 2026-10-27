-- Idempotent admission extension. Run after db/schema.sql and row-five allocation.
DO $setup$
BEGIN
 PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;
 ALTER TABLE premiere_config ADD COLUMN IF NOT EXISTS standing_capacity integer NOT NULL DEFAULT 20 CHECK(standing_capacity BETWEEN 0 AND 20);
 ALTER TABLE premiere_reservations ADD COLUMN IF NOT EXISTS admission text NOT NULL DEFAULT 'seated' CHECK(admission IN('seated','standing','waiting'));
 ALTER TABLE premiere_reservations ADD COLUMN IF NOT EXISTS offer_target text CHECK(offer_target IN('seated','standing'));
 ALTER TABLE premiere_reservations ADD COLUMN IF NOT EXISTS offer_previous_status text CHECK(offer_previous_status IN('reserved','confirmed','waiting'));
 ALTER TABLE premiere_reservations ADD COLUMN IF NOT EXISTS upgrade_declined_at timestamptz;
 UPDATE premiere_reservations SET admission='waiting' WHERE status='waiting';
 UPDATE premiere_reservations SET admission='waiting',offer_target='seated',offer_previous_status='waiting' WHERE status='offered' AND offer_target IS NULL;
 ALTER TABLE premiere_reservations ADD COLUMN IF NOT EXISTS offer_mail_claimed_at timestamptz;
 EXECUTE $create$CREATE OR REPLACE FUNCTION premiere_standing_used() RETURNS integer LANGUAGE sql STABLE AS $fn$
 SELECT coalesce(sum(seats),0)::int FROM premiere_reservations
 WHERE status IN('verification','reserved','confirmed','offered')
 AND (admission='standing' OR (status='offered' AND offer_target='standing'))
$fn$$create$;
 EXECUTE $create$CREATE OR REPLACE FUNCTION premiere_free_block(p_count integer) RETURNS text[] LANGUAGE plpgsql AS $fn$
DECLARE chosen text[];
BEGIN
 SELECT array_agg(s.id ORDER BY s.seat_no) INTO chosen FROM premiere_seats s
 JOIN LATERAL(SELECT a.row_no,a.seat_no FROM premiere_seats a
 WHERE a.pool='public' AND a.reservation_id IS NULL AND
 (SELECT count(*) FROM premiere_seats b WHERE b.row_no=a.row_no AND b.seat_no BETWEEN a.seat_no AND a.seat_no+p_count-1
 AND b.pool='public' AND b.reservation_id IS NULL)=p_count ORDER BY a.row_no,a.seat_no LIMIT 1) block
 ON s.row_no=block.row_no AND s.seat_no BETWEEN block.seat_no AND block.seat_no+p_count-1;
 IF cardinality(chosen) IS DISTINCT FROM p_count THEN
  SELECT array_agg(id ORDER BY row_no,seat_no) INTO chosen FROM
  (SELECT id,row_no,seat_no FROM premiere_seats WHERE pool='public' AND reservation_id IS NULL ORDER BY row_no,seat_no LIMIT p_count) x;
 END IF;
 IF cardinality(chosen) IS DISTINCT FROM p_count THEN RETURN NULL; END IF;
 RETURN chosen;
END $fn$$create$;
 EXECUTE $create$CREATE OR REPLACE FUNCTION premiere_expire() RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
 PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;
 -- An unanswered upgrade never removes an already confirmed standing admission.
 UPDATE premiere_seats SET reservation_id=NULL WHERE reservation_id IN
 (SELECT id FROM premiere_reservations WHERE status='offered' AND admission='standing' AND offer_expires_at<=now());
 UPDATE premiere_reservations SET status=offer_previous_status,offer_target=NULL,offer_previous_status=NULL,
 offer_sent_at=NULL,offer_expires_at=NULL,upgrade_declined_at=now(),updated_at=now()
 WHERE status='offered' AND admission='standing' AND offer_expires_at<=now();
 UPDATE premiere_reservations SET status='expired',updated_at=now()
 WHERE (status IN('verification','waiting') AND verified_at IS NULL AND created_at<=now()-interval '24 hours')
 OR (status='offered' AND admission='waiting' AND offer_expires_at<=now())
 OR ((status IN('verification','reserved') OR (status='offered' AND admission='standing' AND offer_previous_status='reserved'))
 AND created_at<'2026-11-18 19:00 Europe/Warsaw'::timestamptz AND now()>='2026-11-18 19:00 Europe/Warsaw'::timestamptz)
 OR (status IN('verification','reserved','waiting','offered') AND now()>='2026-11-21 19:00 Europe/Warsaw'::timestamptz);
 UPDATE premiere_seats SET reservation_id=NULL WHERE reservation_id IN
 (SELECT id FROM premiere_reservations WHERE status IN('expired','cancelled'));
END $fn$$create$;
 EXECUTE $create$CREATE OR REPLACE FUNCTION premiere_create(p_name text,p_email text,p_phone text,p_ids text[],p_count integer,p_waiting boolean)
RETURNS TABLE(booking_id uuid,booking_token uuid,booking_status text) LANGUAGE plpgsql AS $fn$
DECLARE new_id uuid;new_token uuid;new_status text;new_admission text;available integer;capacity integer;
BEGIN
 PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;PERFORM premiere_expire();
 IF now()>='2026-11-21 19:00 Europe/Warsaw'::timestamptz THEN RAISE EXCEPTION 'CLOSED';END IF;
 IF p_name IS NULL OR p_email IS NULL OR p_phone IS NULL OR p_ids IS NULL OR p_count IS NULL OR p_waiting IS NULL
 OR p_count NOT BETWEEN 1 AND 4 OR length(trim(p_name)) NOT BETWEEN 2 AND 120
 OR length(p_email)>254 OR p_email !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
 OR p_phone !~ '^[+]?[0-9]{9,15}$' OR (p_waiting AND cardinality(p_ids)<>0)
 OR (NOT p_waiting AND cardinality(p_ids)<>p_count) THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 IF EXISTS(SELECT 1 FROM premiere_reservations WHERE email=lower(trim(p_email))
 AND status IN('verification','reserved','confirmed','waiting','offered')) THEN RAISE EXCEPTION 'DUPLICATE';END IF;
 new_admission:='seated';new_status:='verification';
 IF p_waiting THEN
  SELECT standing_capacity INTO capacity FROM premiere_config WHERE id=1;
  IF premiere_standing_used()+p_count<=capacity THEN new_admission:='standing';
  ELSE new_admission:='waiting';new_status:='waiting';END IF;
 ELSE
  SELECT count(*) INTO available FROM premiere_seats WHERE id=ANY(p_ids) AND pool='public' AND reservation_id IS NULL;
  IF available<>p_count THEN RAISE EXCEPTION 'SEATS_UNAVAILABLE';END IF;
 END IF;
 INSERT INTO premiere_reservations(name,email,phone,seats,status,admission)
 VALUES(trim(p_name),lower(trim(p_email)),p_phone,p_count,new_status,new_admission) RETURNING id,token INTO new_id,new_token;
 IF new_admission='seated' THEN UPDATE premiere_seats SET reservation_id=new_id WHERE id=ANY(p_ids);END IF;
 RETURN QUERY SELECT new_id,new_token,new_status;
END $fn$$create$;
 EXECUTE $create$CREATE OR REPLACE FUNCTION premiere_action(p_token uuid,p_action text)
RETURNS TABLE(booking_status text,booking_seats integer) LANGUAGE plpgsql AS $fn$
DECLARE r premiere_reservations%ROWTYPE;next_status text;next_admission text;
BEGIN
 PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;PERFORM premiere_expire();
 SELECT * INTO r FROM premiere_reservations WHERE token=p_token FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 next_admission:=r.admission;
 IF p_action='decline' AND r.status='offered' AND r.admission='standing' AND r.offer_target='seated' THEN
  UPDATE premiere_seats SET reservation_id=NULL WHERE reservation_id=r.id;
  UPDATE premiere_reservations SET status=r.offer_previous_status,offer_target=NULL,offer_previous_status=NULL,
  offer_sent_at=NULL,offer_expires_at=NULL,upgrade_declined_at=now(),updated_at=now() WHERE id=r.id;
  RETURN QUERY SELECT r.offer_previous_status,r.seats;RETURN;
 ELSIF p_action='cancel' AND r.status IN('verification','reserved','confirmed','waiting','offered') THEN next_status:='cancelled';
 ELSIF p_action='confirm' AND r.status='waiting' THEN next_status:='waiting';
 ELSIF p_action='confirm' AND r.status IN('verification','offered') THEN
  next_status:=CASE WHEN now()>='2026-11-14 19:00 Europe/Warsaw'::timestamptz OR r.offer_previous_status='confirmed' THEN 'confirmed' ELSE 'reserved' END;
  IF r.status='offered' THEN next_admission:=r.offer_target;END IF;
 ELSIF p_action='confirm' AND r.status='reserved' AND now()>='2026-11-14 19:00 Europe/Warsaw'::timestamptz THEN next_status:='confirmed';
 ELSIF p_action='confirm' AND r.status='confirmed' THEN next_status:='confirmed';
 ELSE RAISE EXCEPTION 'ACTION_UNAVAILABLE';END IF;
 UPDATE premiere_reservations SET status=next_status,admission=next_admission,updated_at=now(),
 verified_at=CASE WHEN p_action='confirm' THEN coalesce(verified_at,now()) ELSE verified_at END,
 offer_target=CASE WHEN next_status='offered' THEN offer_target ELSE NULL END,
 offer_previous_status=CASE WHEN next_status='offered' THEN offer_previous_status ELSE NULL END,
 offer_expires_at=CASE WHEN next_status='offered' THEN offer_expires_at ELSE NULL END WHERE id=r.id;
 IF next_status='cancelled' THEN UPDATE premiere_seats SET reservation_id=NULL WHERE reservation_id=r.id;END IF;
 RETURN QUERY SELECT next_status,r.seats;
END $fn$$create$;
 EXECUTE $create$CREATE OR REPLACE FUNCTION premiere_offer(p_id uuid) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE r premiere_reservations%ROWTYPE;chosen text[];target text;capacity integer;
BEGIN
 PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;PERFORM premiere_expire();
 SELECT * INTO r FROM premiere_reservations WHERE id=p_id AND verified_at IS NOT NULL
 AND ((admission='standing' AND status IN('reserved','confirmed') AND upgrade_declined_at IS NULL)
 OR (admission='waiting' AND status='waiting')) FOR UPDATE;
 IF NOT FOUND OR now()>='2026-11-21 19:00 Europe/Warsaw'::timestamptz THEN RAISE EXCEPTION 'ACTION_UNAVAILABLE';END IF;
 chosen:=premiere_free_block(r.seats);
 IF chosen IS NOT NULL THEN target:='seated';
 ELSIF r.admission='waiting' THEN
  SELECT standing_capacity INTO capacity FROM premiere_config WHERE id=1;
  IF premiere_standing_used()+r.seats>capacity THEN RAISE EXCEPTION 'NO_CAPACITY';END IF;
  target:='standing';
 ELSE RAISE EXCEPTION 'NO_CAPACITY';END IF;
 IF target='seated' THEN UPDATE premiere_seats SET reservation_id=p_id WHERE id=ANY(chosen);END IF;
 UPDATE premiere_reservations SET status='offered',offer_target=target,offer_previous_status=r.status,offer_sent_at=NULL,
 offer_expires_at=least(now()+interval '48 hours','2026-11-21 19:00 Europe/Warsaw'::timestamptz),updated_at=now() WHERE id=p_id;
END $fn$$create$;
 EXECUTE $create$CREATE OR REPLACE FUNCTION premiere_advance() RETURNS TABLE(promoted_id uuid) LANGUAGE plpgsql AS $fn$
DECLARE candidate uuid;free_count integer;free_standing integer;
BEGIN
 PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;PERFORM premiere_expire();
 IF now()>='2026-11-21 19:00 Europe/Warsaw'::timestamptz THEN RETURN QUERY SELECT NULL::uuid;RETURN;END IF;
 SELECT count(*) INTO free_count FROM premiere_seats WHERE pool='public' AND reservation_id IS NULL;
 SELECT standing_capacity-premiere_standing_used() INTO free_standing FROM premiere_config WHERE id=1;
 -- Verified standing guests get the first choice of released seats, as a whole group.
 SELECT id INTO candidate FROM premiere_reservations WHERE admission='standing' AND status IN('reserved','confirmed')
 AND verified_at IS NOT NULL AND upgrade_declined_at IS NULL AND seats<=free_count ORDER BY created_at,id LIMIT 1;
 IF candidate IS NULL THEN
  SELECT id INTO candidate FROM premiere_reservations WHERE admission='waiting' AND status='waiting'
  AND verified_at IS NOT NULL AND seats<=greatest(free_count,free_standing) ORDER BY created_at,id LIMIT 1;
 END IF;
 IF candidate IS NOT NULL THEN PERFORM premiere_offer(candidate);END IF;
 RETURN QUERY SELECT candidate;
END $fn$$create$;
 EXECUTE $create$CREATE OR REPLACE FUNCTION premiere_admin_action(p_id uuid,p_action text) RETURNS text LANGUAGE plpgsql AS $fn$
DECLARE r premiere_reservations%ROWTYPE;
BEGIN
 PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;PERFORM premiere_expire();
 SELECT * INTO r FROM premiere_reservations WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF p_action='offer' THEN PERFORM premiere_offer(p_id);RETURN 'offered';
 ELSIF p_action IN('cancel','cancel_hold') AND r.status IN('verification','reserved','confirmed','waiting','offered') THEN
  IF p_action='cancel_hold' THEN
   UPDATE premiere_seats SET reservation_id=NULL,pool='held' WHERE reservation_id=p_id;
   UPDATE premiere_config SET public_capacity=(SELECT count(*) FROM premiere_seats WHERE pool='public') WHERE id=1;
  END IF;
  PERFORM premiere_action(r.token,'cancel');RETURN 'cancelled';
 ELSIF p_action='confirm' AND r.status IN('verification','reserved','confirmed','offered')
 AND now()<'2026-11-21 19:00 Europe/Warsaw'::timestamptz THEN
  UPDATE premiere_reservations SET status='confirmed',verified_at=coalesce(verified_at,now()),
  admission=CASE WHEN r.status='offered' THEN r.offer_target ELSE r.admission END,
  offer_target=NULL,offer_previous_status=NULL,offer_expires_at=NULL,updated_at=now() WHERE id=p_id;
  RETURN 'confirmed';
 ELSE RAISE EXCEPTION 'ACTION_UNAVAILABLE';END IF;
END $fn$$create$;
 ALTER TABLE premiere_config ADD COLUMN IF NOT EXISTS admission_schema_version integer NOT NULL DEFAULT 2;
END $setup$;
