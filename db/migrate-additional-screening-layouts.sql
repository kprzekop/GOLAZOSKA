BEGIN;

-- Draft screenings acquire a date and time when the schedule is agreed.
CREATE TABLE IF NOT EXISTS additional_screenings (
 id integer PRIMARY KEY,
 starts_at timestamptz
);

CREATE TABLE IF NOT EXISTS additional_screening_seats (
 screening_id integer NOT NULL REFERENCES additional_screenings(id),
 row_no integer NOT NULL CHECK (row_no BETWEEN 1 AND 7),
 seat_no integer NOT NULL CHECK (
  seat_no BETWEEN 1 AND CASE
   WHEN row_no = 7 THEN 8
   WHEN row_no % 2 = 1 THEN 12
   ELSE 13
  END
 ),
 pool text NOT NULL CHECK (pool IN ('organizational', 'held', 'public')),
 PRIMARY KEY (screening_id, row_no, seat_no)
);

INSERT INTO additional_screenings (id)
VALUES (1), (2), (3)
ON CONFLICT (id) DO NOTHING;

-- Copy the physical numbering, without carrying over premiere allocations.
INSERT INTO additional_screening_seats (screening_id, row_no, seat_no, pool)
SELECT screening.id, seat.row_no, seat.seat_no,
 CASE WHEN seat.row_no IN (4, 5) THEN 'organizational' ELSE 'public' END
FROM additional_screenings AS screening
CROSS JOIN premiere_seats AS seat
WHERE screening.id IN (1, 2, 3)
ON CONFLICT (screening_id, row_no, seat_no) DO NOTHING;

DO $verify$
BEGIN
 IF (SELECT count(*) FROM additional_screening_seats WHERE screening_id IN (1, 2, 3)) <> 249 THEN
  RAISE EXCEPTION 'Expected 83 seats for each of the three draft screenings';
 END IF;
END;
$verify$;

COMMIT;
