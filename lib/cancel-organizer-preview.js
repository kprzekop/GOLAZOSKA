export const CANCEL_ORGANIZER_PREVIEW_SQL="WITH cancelled AS (\n UPDATE additional_screening_bookings SET status='cancelled',mail_claimed_at=NULL\n WHERE screening_id=1 AND lower(trim(email))=lower(trim(current_setting('gola.organizer_cancel_contact')))\n AND status IN ('offered','confirmed','expired')\n RETURNING id,standing_seats\n), released AS (\n UPDATE additional_screening_seats SET booking_id=NULL WHERE booking_id IN (SELECT id FROM cancelled) RETURNING seat_no\n)\nINSERT INTO organizer_preview_cancel_20261110(id,cancelled_bookings,released_seats,released_standing)\nSELECT 1,(SELECT count(*)::int FROM cancelled),(SELECT count(*)::int FROM released),\n (SELECT COALESCE(sum(standing_seats),0)::int FROM cancelled)\nON CONFLICT(id) DO NOTHING";

export async function cancelOrganizerPreview(db){
 const contact=process.env.STANDING_GUEST_PRINT_CONTACT;
 if(!contact)return {error:'CONTACT_UNAVAILABLE'};
 const [state]=await db`SELECT to_regclass('public.organizer_preview_cancel_20261110') IS NOT NULL AS ready`;
 if(!state.ready)await db.transaction([
  db`SELECT id FROM premiere_config WHERE id=1 FOR UPDATE`,
  db`SELECT pg_advisory_xact_lock(851191,1)`,
  db`SELECT set_config('gola.organizer_cancel_contact',${contact},true)`,
  db.query(`DO $cancel$ BEGIN
   IF to_regclass('public.organizer_preview_cancel_20261110') IS NOT NULL THEN RETURN; END IF;
   CREATE TABLE organizer_preview_cancel_20261110(
    id integer PRIMARY KEY CHECK(id=1),cancelled_bookings integer NOT NULL,
    released_seats integer NOT NULL,released_standing integer NOT NULL);
   ${CANCEL_ORGANIZER_PREVIEW_SQL};
  END; $cancel$;`)
 ]);
 const [result]=await db`SELECT cancelled_bookings,released_seats,released_standing,
  (SELECT count(*)::int FROM additional_screening_bookings WHERE screening_id=1
   AND lower(trim(email))=lower(trim(${contact})) AND status IN ('confirmed','offered')) AS remaining
  FROM organizer_preview_cancel_20261110 WHERE id=1`;
 return result;
}
