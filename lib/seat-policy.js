// Apply the organizer's row-five allocation once, without cancelling existing bookings.
export async function applySeatPolicy(db){
 const [r]=await db`SELECT EXISTS(SELECT 1 FROM premiere_seats WHERE row_no=5 AND pool<>'organizational') AS needed`;
 if(r.needed){
  await db.transaction([
   db`SELECT id FROM premiere_config WHERE id=1 FOR UPDATE`,
   db`SELECT premiere_expire()`,
   db`DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM premiere_seats WHERE row_no=5 AND reservation_id IS NOT NULL) THEN
  RAISE EXCEPTION 'ROW_FIVE_HAS_RESERVATIONS';
 END IF;
 UPDATE premiere_seats SET pool='organizational' WHERE row_no=5;
 UPDATE premiere_config SET
  public_capacity=(SELECT count(*) FROM premiere_seats WHERE pool='public'),
  guest_capacity=(SELECT count(*) FROM premiere_seats WHERE pool='organizational')
 WHERE id=1;
END $$;`
  ]);
 }
 const rows=await db`SELECT pool,count(*)::int AS seats FROM premiere_seats GROUP BY pool`;
 return Object.fromEntries(rows.map(r=>[r.pool,r.seats]));
}
