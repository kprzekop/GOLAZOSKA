BEGIN;
CREATE TABLE IF NOT EXISTS preview_unaccepted_holds_released_v3 (
 id integer PRIMARY KEY CHECK(id=1),
 released_seats integer NOT NULL,
 applied_at timestamptz NOT NULL DEFAULT now()
);
WITH released AS (
 UPDATE additional_screening_seats s SET booking_id=NULL
 FROM additional_screening_bookings b
 WHERE s.screening_id=1 AND s.booking_id=b.id
 AND b.transfer_source_id IS NOT NULL AND b.transferred_at IS NULL
 RETURNING s.seat_no
)
INSERT INTO preview_unaccepted_holds_released_v3(id,released_seats)
SELECT 1,count(*)::int FROM released
ON CONFLICT(id) DO UPDATE SET released_seats=preview_unaccepted_holds_released_v3.released_seats+excluded.released_seats;
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
 IF transfer_source IS NULL THEN
 WITH chosen AS (
  SELECT row_no,seat_no FROM additional_screening_seats
  WHERE screening_id=p_screening AND pool='public' AND booking_id IS NULL
  ORDER BY row_no,seat_no LIMIT applicant.seats
 )
 UPDATE additional_screening_seats s SET booking_id=booking FROM chosen c
 WHERE s.screening_id=p_screening AND s.row_no=c.row_no AND s.seat_no=c.seat_no;
 END IF;
 RETURN booking;
END;
$$;
COMMIT;
