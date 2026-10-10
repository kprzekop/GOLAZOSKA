-- Apply once to a private Neon Postgres database. All allocations take the same row lock.
CREATE TABLE IF NOT EXISTS premiere_config (
  id integer PRIMARY KEY CHECK (id = 1),
  public_capacity integer NOT NULL CHECK (public_capacity BETWEEN 0 AND 81),
  guest_capacity integer NOT NULL CHECK (guest_capacity BETWEEN 0 AND 81),
  physical_capacity integer NOT NULL DEFAULT 81 CHECK (physical_capacity = 81),
  CHECK (public_capacity + guest_capacity <= physical_capacity)
);
INSERT INTO premiere_config (id, public_capacity, guest_capacity)
VALUES (1, 60, 20) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS premiere_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  seats integer NOT NULL CHECK (seats BETWEEN 1 AND 4),
  status text NOT NULL CHECK (status IN ('verification','reserved','confirmed','waiting','offered','cancelled','expired')),
  token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  reminder_sent_at timestamptz,
  final_sent_at timestamptz,
  offer_sent_at timestamptz,
  offer_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email = lower(email))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_live_booking_per_email
ON premiere_reservations (email)
WHERE status IN ('verification','reserved','confirmed','waiting','offered');
CREATE INDEX IF NOT EXISTS premiere_queue ON premiere_reservations (status, created_at);

CREATE OR REPLACE FUNCTION premiere_create(p_name text, p_email text, p_seats integer)
RETURNS TABLE (booking_id uuid, booking_token uuid, booking_status text)
LANGUAGE plpgsql AS $$
DECLARE used integer; queued boolean; new_id uuid; new_token uuid; new_status text;
BEGIN
  IF p_seats NOT BETWEEN 1 AND 4 OR length(trim(p_name)) NOT BETWEEN 2 AND 120
     OR length(p_email) > 254 OR p_email !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;
  PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;
  IF EXISTS (SELECT 1 FROM premiere_reservations
             WHERE email=lower(trim(p_email)) AND status IN ('verification','reserved','confirmed','waiting','offered')) THEN
    RAISE EXCEPTION 'DUPLICATE';
  END IF;
  SELECT coalesce(sum(seats),0) INTO used FROM premiere_reservations
    WHERE status IN ('verification','reserved','confirmed','offered');
  SELECT EXISTS (SELECT 1 FROM premiere_reservations WHERE status='waiting') INTO queued;
  SELECT CASE WHEN queued OR used + p_seats > public_capacity THEN 'waiting' ELSE 'verification' END
    INTO new_status FROM premiere_config WHERE id=1;
  INSERT INTO premiere_reservations(name,email,seats,status)
    VALUES (trim(p_name),lower(trim(p_email)),p_seats,new_status)
    RETURNING id,token INTO new_id,new_token;
  RETURN QUERY SELECT new_id,new_token,new_status;
END $$;

-- Called only through an unguessable token mailed to the applicant.
CREATE OR REPLACE FUNCTION premiere_action(p_token uuid, p_action text)
RETURNS TABLE (booking_status text, booking_seats integer)
LANGUAGE plpgsql AS $$
DECLARE r premiere_reservations%ROWTYPE; next_status text;
BEGIN
  PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;
  SELECT * INTO r FROM premiere_reservations WHERE token=p_token FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF p_action='cancel' AND r.status IN ('verification','reserved','confirmed','waiting','offered') THEN
    next_status := 'cancelled';
  ELSIF p_action='confirm' AND r.status='verification' AND r.created_at > now()-interval '24 hours' THEN
    next_status := CASE WHEN now() >= '2026-11-14 00:00 Europe/Warsaw'::timestamptz THEN 'confirmed' ELSE 'reserved' END;
  ELSIF p_action='confirm' AND r.status='reserved'
    AND (r.reminder_sent_at IS NULL OR now() < '2026-11-18 00:00 Europe/Warsaw'::timestamptz) THEN
    next_status := 'confirmed';
  ELSIF p_action='confirm' AND r.status='offered' AND r.offer_expires_at > now() THEN
    next_status := CASE WHEN now() >= '2026-11-14 00:00 Europe/Warsaw'::timestamptz THEN 'confirmed' ELSE 'reserved' END;
  ELSIF p_action='confirm' AND r.status='confirmed' THEN
    next_status := 'confirmed';
  ELSE
    RAISE EXCEPTION 'ACTION_UNAVAILABLE';
  END IF;
  UPDATE premiere_reservations SET status=next_status,
      verified_at=CASE WHEN next_status IN ('reserved','confirmed') THEN coalesce(verified_at,now()) ELSE verified_at END,
      updated_at=now() WHERE id=r.id;
  RETURN QUERY SELECT next_status,r.seats;
END $$;

-- Daily cleanup plus one invitation from the ordered queue at a time.
-- A separate invocation is safe because allocation is serialized by config row.
CREATE OR REPLACE FUNCTION premiere_advance()
RETURNS TABLE (promoted_id uuid) LANGUAGE plpgsql AS $$
DECLARE free_seats integer; candidate uuid;
BEGIN
  PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;
  UPDATE premiere_reservations SET status='expired',updated_at=now()
    WHERE (status='verification' AND created_at < now()-interval '24 hours')
       OR (status='offered' AND offer_expires_at < now());
  UPDATE premiere_reservations SET status='expired',updated_at=now()
    WHERE status='reserved' AND reminder_sent_at IS NOT NULL
      AND now() >= '2026-11-18 00:00 Europe/Warsaw'::timestamptz;
  SELECT c.public_capacity-coalesce(sum(r.seats),0) INTO free_seats
    FROM premiere_config c LEFT JOIN premiere_reservations r
      ON r.status IN ('verification','reserved','confirmed','offered')
    WHERE c.id=1 GROUP BY c.public_capacity;
  SELECT id INTO candidate FROM premiere_reservations
    WHERE status='waiting' AND seats <= free_seats
    ORDER BY created_at,id LIMIT 1;
  IF candidate IS NOT NULL AND now() < '2026-11-21 00:00 Europe/Warsaw'::timestamptz THEN
    UPDATE premiere_reservations
      SET status='offered',offer_expires_at=least(now()+interval '48 hours','2026-11-21 00:00 Europe/Warsaw'::timestamptz),
          updated_at=now() WHERE id=candidate;
  END IF;
  RETURN QUERY SELECT candidate;
END $$;

-- Intentional manual overrides for organizer; no standing capacity is sold automatically.
CREATE OR REPLACE FUNCTION premiere_admin_action(p_id uuid,p_action text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE old_status text; new_status text; used integer; requested integer;
BEGIN
  PERFORM 1 FROM premiere_config WHERE id=1 FOR UPDATE;
  SELECT status,seats INTO old_status,requested FROM premiere_reservations WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF p_action='cancel' AND old_status IN ('verification','reserved','confirmed','waiting','offered') THEN
    new_status:='cancelled';
  ELSIF p_action='confirm' AND old_status IN ('verification','reserved','confirmed','offered') THEN
    new_status:='confirmed';
  ELSIF p_action='offer' AND old_status='waiting' THEN
    SELECT coalesce(sum(seats),0) INTO used FROM premiere_reservations
      WHERE status IN ('verification','reserved','confirmed','offered');
    IF used + requested > (SELECT public_capacity FROM premiere_config WHERE id=1) THEN
      RAISE EXCEPTION 'NO_CAPACITY';
    END IF;
    new_status:='offered';
  ELSE RAISE EXCEPTION 'ACTION_UNAVAILABLE';
  END IF;
  UPDATE premiere_reservations SET status=new_status,updated_at=now(),
    offer_expires_at=CASE WHEN new_status='offered' THEN now()+interval '48 hours' ELSE offer_expires_at END,
    offer_sent_at=CASE WHEN new_status='offered' THEN NULL ELSE offer_sent_at END
    WHERE id=p_id;
  RETURN new_status;
END $$;
