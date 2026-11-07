export const RECONCILE_PREVIEW_SQL="WITH contacts AS (\n SELECT b.id,b.transferred_at,b.status,b.transfer_source_id,b.email,source.phone\n FROM additional_screening_bookings b\n LEFT JOIN premiere_reservations source ON source.id=b.transfer_source_id\n WHERE b.screening_id=1\n), matches AS (\n SELECT DISTINCT r.id,r.seats,r.admission,c.transferred_at,c.status AS preview_status\n FROM premiere_reservations r JOIN contacts c\n ON r.id=c.transfer_source_id OR (\n  lower(trim(r.email))=lower(trim(c.email))\n  AND regexp_replace(r.phone,'[^0-9]','','g')<>''\n  AND regexp_replace(r.phone,'[^0-9]','','g')=regexp_replace(c.phone,'[^0-9]','','g')\n )\n WHERE r.admission IN ('standing','waiting')\n AND r.status IN ('verification','reserved','confirmed','waiting','offered')\n AND (c.transferred_at IS NULL OR r.created_at<=c.transferred_at)\n), cancelled AS (\n UPDATE premiere_reservations r SET status='cancelled',offer_target=NULL,offer_previous_status=NULL,\n offer_expires_at=NULL,updated_at=now()\n WHERE r.id IN (SELECT id FROM matches WHERE transferred_at IS NOT NULL AND preview_status='confirmed')\n RETURNING r.id,r.seats,r.admission\n), released AS (\n UPDATE premiere_seats SET reservation_id=NULL WHERE reservation_id IN (SELECT id FROM cancelled) RETURNING id\n)\nSELECT\n (SELECT count(*)::int FROM cancelled) AS removed_bookings,\n (SELECT COALESCE(sum(seats),0)::int FROM cancelled WHERE admission='standing') AS released_standing,\n (SELECT count(DISTINCT id)::int FROM matches WHERE transferred_at IS NULL AND preview_status IN ('offered','confirmed')) AS awaiting_consent,\n (SELECT count(*)::int FROM additional_screening_bookings WHERE screening_id=1 AND transferred_at IS NOT NULL AND status='confirmed') AS completed_transfers,\n (SELECT count(*)::int FROM released) AS released_seated";

export async function reconcilePreviewTransfers(db){
 const [schema]=await db`SELECT to_regclass('public.preview_transfer_seat_choice_v2') IS NOT NULL AS ready`;
 if(!schema.ready)return null;
 const [, , result]=await db.transaction([
  db`SELECT id FROM premiere_config WHERE id=1 FOR UPDATE`,
  db`SELECT pg_advisory_xact_lock(851191,1)`,
  db.query(RECONCILE_PREVIEW_SQL)
 ]);
 return result[0];
}
