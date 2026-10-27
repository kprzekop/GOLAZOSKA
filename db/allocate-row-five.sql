-- Existing installation: add row 5 to the organizational pool.
-- Abort if any live booking occupies this row; reconcile it manually first.
BEGIN;
SELECT id FROM premiere_config WHERE id=1 FOR UPDATE;
SELECT premiere_expire();
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM premiere_seats WHERE row_no=5 AND reservation_id IS NOT NULL) THEN
  RAISE EXCEPTION 'ROW_FIVE_HAS_RESERVATIONS';
 END IF;
 UPDATE premiere_seats SET pool='organizational' WHERE row_no=5;
 UPDATE premiere_config SET
  public_capacity=(SELECT count(*) FROM premiere_seats WHERE pool='public'),
  guest_capacity=(SELECT count(*) FROM premiere_seats WHERE pool='organizational')
 WHERE id=1;
END $$;
COMMIT;
