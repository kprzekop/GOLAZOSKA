import {initializePreviewScreening,sendPreviewTransferOffers} from './additional-screenings.js';

export async function sendStandingTransferBatch(db){
 await initializePreviewScreening(db);
 const sources=await db`SELECT id FROM premiere_reservations
  WHERE admission='standing' AND status IN ('reserved','confirmed','offered')
  AND verified_at IS NOT NULL AND email NOT LIKE '%@example.invalid'`;
 const ids=sources.map(source=>source.id);
 if(!ids.length)return {sent:0,failed:0,eligible:0,totalSent:0,withoutOffer:0};
 const result=await sendPreviewTransferOffers(db,{sourceIds:ids});
 const [stats]=await db`SELECT
  (SELECT count(*)::int FROM additional_screening_bookings
   WHERE screening_id=1 AND transfer_source_id=ANY(${ids}::uuid[]) AND transfer_sent_at IS NOT NULL) AS total_sent,
  (SELECT count(*)::int FROM premiere_reservations r WHERE r.id=ANY(${ids}::uuid[]) AND NOT EXISTS(
   SELECT 1 FROM additional_screening_bookings b WHERE b.screening_id=1 AND b.transfer_source_id=r.id
   AND b.transferred_at IS NULL AND (b.status='confirmed' OR (b.status='offered' AND b.expires_at>now()))
  )) AS without_offer`;
 return {...result,eligible:ids.length,totalSent:stats.total_sent,withoutOffer:stats.without_offer};
}
