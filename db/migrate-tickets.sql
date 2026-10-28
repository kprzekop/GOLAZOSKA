CREATE TABLE IF NOT EXISTS premiere_tickets(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 reservation_id uuid NOT NULL REFERENCES premiere_reservations(id) ON DELETE CASCADE,
 person_no integer NOT NULL CHECK(person_no BETWEEN 1 AND 4),
 checked_in_at timestamptz,
 UNIQUE(reservation_id,person_no)
);
ALTER TABLE premiere_reservations ADD COLUMN IF NOT EXISTS ticket_sent_for text;
ALTER TABLE premiere_reservations ADD COLUMN IF NOT EXISTS ticket_mail_claimed_at timestamptz;
CREATE OR REPLACE FUNCTION premiere_checkin(p_ticket uuid,p_enter boolean)
RETURNS TABLE(result text,guest_name text,person_no integer,admission text,seat_id text,entered_at timestamptz)
LANGUAGE plpgsql AS $fn$
DECLARE t premiere_tickets%ROWTYPE;r premiere_reservations%ROWTYPE;place text;
BEGIN
 PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;
 PERFORM premiere_expire();
 SELECT * INTO t FROM premiere_tickets WHERE id=p_ticket FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found',NULL::text,NULL::integer,NULL::text,NULL::text,NULL::timestamptz;RETURN;END IF;
 SELECT * INTO r FROM premiere_reservations WHERE id=t.reservation_id FOR UPDATE;
 IF r.status NOT IN('confirmed','offered') OR r.admission NOT IN('seated','standing')
 OR (r.status='offered' AND NOT(r.admission='standing' AND r.offer_previous_status='confirmed'))
 OR now()>='2026-11-22 00:00 Europe/Warsaw'::timestamptz THEN
  RETURN QUERY SELECT 'invalid',r.name,t.person_no,r.admission,NULL::text,t.checked_in_at;RETURN;
 END IF;
 IF r.admission='seated' THEN
  SELECT s.id INTO place FROM premiere_seats s WHERE s.reservation_id=r.id ORDER BY s.row_no,s.seat_no OFFSET t.person_no-1 LIMIT 1;
  IF place IS NULL THEN RETURN QUERY SELECT 'invalid',r.name,t.person_no,r.admission,NULL::text,t.checked_in_at;RETURN;END IF;
 END IF;
 IF t.checked_in_at IS NOT NULL THEN
  RETURN QUERY SELECT 'used',r.name,t.person_no,r.admission,place,t.checked_in_at;RETURN;
 END IF;
 IF p_enter THEN UPDATE premiere_tickets SET checked_in_at=now() WHERE id=t.id RETURNING checked_in_at INTO t.checked_in_at;END IF;
 RETURN QUERY SELECT CASE WHEN p_enter THEN 'entered' ELSE 'valid' END,r.name,t.person_no,r.admission,place,t.checked_in_at;
END $fn$;
