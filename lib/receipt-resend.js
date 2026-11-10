import {deliverTickets} from './tickets.js';
import {prepareSelectedPreview,deliverSelectedPreview} from './preview-selected-seats.js';

async function receiptStats(db){
 const [stats]=await db`SELECT
  count(*)::int AS total,
  count(*) FILTER(WHERE kind='18')::int AS preview,
  count(*) FILTER(WHERE kind='19')::int AS premiere,
  count(*) FILTER(WHERE sent_at IS NOT NULL)::int AS sent,
  count(*) FILTER(WHERE sent_at IS NULL AND attempts<3)::int AS pending,
  count(*) FILTER(WHERE sent_at IS NULL AND attempts>=3)::int AS failed,
  count(*) FILTER(WHERE NOT was_sent)::int AS originally_unsent,
  count(*) FILTER(WHERE provider_id IS NOT NULL AND provider_state IS NULL)::int AS unchecked
  FROM receipt_resend_20261110`;
 const events=await db`SELECT provider_state,count(*)::int AS count FROM receipt_resend_20261110
  WHERE provider_state IS NOT NULL GROUP BY provider_state`;
 const [batch]=await db`SELECT inspection_status FROM receipt_resend_batch_20261110 WHERE id=1`;
 return {...stats,events,inspectionStatus:batch?.inspection_status};
}

export async function resendReservationReceipts(db,{batchSize=5,pauseMs=700,inspect=true}={}){
 await prepareSelectedPreview(db);
 const [schema]=await db`SELECT to_regclass('public.receipt_resend_20261110') IS NOT NULL AS ready`;
 if(!schema.ready)await db.transaction([
  db`SELECT id FROM premiere_config WHERE id=1 FOR UPDATE`,
  db`CREATE TABLE IF NOT EXISTS receipt_resend_20261110(
   kind text NOT NULL CHECK(kind IN ('18','19')),booking_id uuid NOT NULL,
   was_sent boolean NOT NULL,attempts integer NOT NULL DEFAULT 0,
   next_attempt_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz,
   provider_id text,provider_state text,last_error text,
   PRIMARY KEY(kind,booking_id))`,
  db`CREATE TABLE IF NOT EXISTS receipt_resend_batch_20261110(
   id integer PRIMARY KEY CHECK(id=1),lease_until timestamptz,lease_token uuid,inspection_status integer)`,
  db`INSERT INTO receipt_resend_batch_20261110(id) VALUES(1) ON CONFLICT(id) DO NOTHING`
 ]);
 const [lease]=await db`UPDATE receipt_resend_batch_20261110
  SET lease_until=now()+interval '2 minutes',lease_token=gen_random_uuid()
  WHERE id=1 AND (lease_until IS NULL OR lease_until<now()) RETURNING lease_token`;
 if(!lease)return {...await receiptStats(db),busy:true};
 try{
  await db`INSERT INTO receipt_resend_20261110(kind,booking_id,was_sent)
   SELECT '19',id,ticket_sent_for IS NOT NULL FROM premiere_reservations
   WHERE email NOT LIKE '%@example.invalid' AND admission IN ('seated','standing')
   AND (status='confirmed' OR (status='offered' AND admission='standing' AND offer_previous_status='confirmed'))
   ON CONFLICT(kind,booking_id) DO NOTHING`;
  await db`INSERT INTO receipt_resend_20261110(kind,booking_id,was_sent)
   SELECT '18',id,mailed_at IS NOT NULL FROM additional_screening_bookings
   WHERE screening_id=1 AND status='confirmed' AND email NOT LIKE '%@example.invalid'
   AND (transfer_source_id IS NULL OR transferred_at IS NOT NULL)
   ON CONFLICT(kind,booking_id) DO NOTHING`;
  for(let number=0;number<batchSize;number++){
   const [item]=await db`UPDATE receipt_resend_20261110 SET attempts=attempts+1,next_attempt_at=now()+interval '1 minute'
    WHERE (kind,booking_id)=(SELECT kind,booking_id FROM receipt_resend_20261110
     WHERE sent_at IS NULL AND attempts<3 AND next_attempt_at<=now() ORDER BY kind,booking_id LIMIT 1)
    RETURNING kind,booking_id`;
   if(!item)break;
   if(number&&pauseMs)await new Promise(resolve=>setTimeout(resolve,pauseMs));
   const resendKey='reservation-receipt-20261110/'+item.kind+'/'+item.booking_id;
   const result=item.kind==='19'?await deliverTickets(db,item.booking_id,{resendKey}):
    await deliverSelectedPreview(db,item.booking_id,{resendKey});
   if(result?.sent)await db`UPDATE receipt_resend_20261110
    SET sent_at=now(),provider_id=${result.providerId||null},last_error=NULL
    WHERE kind=${item.kind} AND booking_id=${item.booking_id}::uuid`;
   else await db`UPDATE receipt_resend_20261110 SET last_error=${result?.failed?'MAIL_SEND_FAILED':'DELIVERY_BUSY'}
    WHERE kind=${item.kind} AND booking_id=${item.booking_id}::uuid`;
  }
  const [access]=await db`SELECT inspection_status FROM receipt_resend_batch_20261110 WHERE id=1`;
  if(inspect&&access?.inspection_status!==403){
   const unchecked=await db`SELECT kind,booking_id,provider_id FROM receipt_resend_20261110
    WHERE provider_id IS NOT NULL AND provider_state IS NULL ORDER BY sent_at LIMIT 5`;
   for(const item of unchecked){
    if(pauseMs)await new Promise(resolve=>setTimeout(resolve,pauseMs));
    try{
     const response=await fetch('https://api.resend.com/emails/'+encodeURIComponent(item.provider_id),
      {headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY}});
     await db`UPDATE receipt_resend_batch_20261110 SET inspection_status=${response.status} WHERE id=1`;
     if(response.status===403)break;
     if(!response.ok)continue;
     const detail=await response.json();
     const state=['sent','delivered','bounced','complained','delivery_delayed','failed','opened','clicked'].includes(detail.last_event)?detail.last_event:'unknown';
     await db`UPDATE receipt_resend_20261110 SET provider_state=${state}
      WHERE kind=${item.kind} AND booking_id=${item.booking_id}::uuid`;
    }catch{await db`UPDATE receipt_resend_batch_20261110 SET inspection_status=0 WHERE id=1`;}
   }
  }
  return await receiptStats(db);
 }finally{
  await db`UPDATE receipt_resend_batch_20261110 SET lease_until=NULL WHERE id=1 AND lease_token=${lease.lease_token}::uuid`;
 }
}
