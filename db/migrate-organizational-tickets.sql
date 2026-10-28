DO $setup$
BEGIN
 CREATE TABLE IF NOT EXISTS premiere_organizational_tickets(
 id uuid PRIMARY KEY,
 seat_id text NOT NULL UNIQUE REFERENCES premiere_seats(id) ON DELETE CASCADE,
 checked_in_at timestamptz,
 revoked boolean NOT NULL DEFAULT false
 );
 EXECUTE $create$CREATE OR REPLACE FUNCTION premiere_seed_org_tickets(p_tickets jsonb) RETURNS integer LANGUAGE plpgsql AS $fn$
 DECLARE n integer;
 BEGIN
  PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;
  IF now()>='2026-12-22 00:00 Europe/Warsaw'::timestamptz THEN RETURN 0;END IF;
  IF jsonb_array_length(p_tickets)<>62 OR
   (SELECT count(DISTINCT x.seat) FROM jsonb_to_recordset(p_tickets) AS x(id uuid,seat text))<>62 OR
   (SELECT count(DISTINCT x.id) FROM jsonb_to_recordset(p_tickets) AS x(id uuid,seat text))<>62 OR
   EXISTS(SELECT 1 FROM jsonb_to_recordset(p_tickets) AS x(id uuid,seat text) LEFT JOIN premiere_seats s ON s.id=x.seat
    WHERE x.id IS NULL OR s.id IS NULL OR s.row_no NOT BETWEEN 1 AND 5 OR s.pool<>'organizational' OR s.reservation_id IS NOT NULL)
   THEN RAISE EXCEPTION 'INVALID_ORGANIZATIONAL_TICKETS';END IF;
  INSERT INTO premiere_organizational_tickets(id,seat_id)
   SELECT x.id,x.seat FROM jsonb_to_recordset(p_tickets) AS x(id uuid,seat text)
   ON CONFLICT(seat_id) DO NOTHING;
  GET DIAGNOSTICS n=ROW_COUNT;RETURN n;
 END $fn$$create$;
 EXECUTE $create$CREATE OR REPLACE FUNCTION premiere_checkin_org(p_ticket uuid,p_enter boolean)
 RETURNS TABLE(result text,guest_name text,person_no integer,admission text,seat_id text,entered_at timestamptz) LANGUAGE plpgsql AS $fn$
 DECLARE t premiere_organizational_tickets%ROWTYPE;seat premiere_seats%ROWTYPE;
 BEGIN
  PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;
  SELECT * INTO t FROM premiere_organizational_tickets WHERE id=p_ticket FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found',NULL::text,NULL::integer,NULL::text,NULL::text,NULL::timestamptz;RETURN;END IF;
  SELECT * INTO seat FROM premiere_seats WHERE id=t.seat_id;
  IF t.revoked OR seat.pool<>'organizational' OR seat.row_no NOT BETWEEN 1 AND 5 OR seat.reservation_id IS NOT NULL
   OR now()>='2026-11-22 00:00 Europe/Warsaw'::timestamptz THEN
   RETURN QUERY SELECT 'invalid','Zaproszenie organizatora',1,'seated',t.seat_id,t.checked_in_at;RETURN;
  END IF;
  IF t.checked_in_at IS NOT NULL THEN RETURN QUERY SELECT 'used','Zaproszenie organizatora',1,'seated',t.seat_id,t.checked_in_at;RETURN;END IF;
  IF p_enter THEN UPDATE premiere_organizational_tickets SET checked_in_at=now() WHERE id=t.id RETURNING checked_in_at INTO t.checked_in_at;END IF;
  RETURN QUERY SELECT CASE WHEN p_enter THEN 'entered' ELSE 'valid' END,'Zaproszenie organizatora',1,'seated',t.seat_id,t.checked_in_at;
 END $fn$$create$;
END $setup$;
