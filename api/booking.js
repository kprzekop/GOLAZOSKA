import {advanceQueue} from '../lib/queue.js';
import {applySeatPolicy} from '../lib/seat-policy.js';
import {json,sql} from '../lib/shared.js';
import {REMIND_FROM,EVENT_AT} from '../lib/event.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default async function handler(req,res){
 if(!['GET','POST'].includes(req.method))return json(res,405,{error:'METHOD'});
 const token=String((req.method==='GET'?req.query.token:req.body?.token)||'');
 if(!uuid.test(token))return json(res,400,{error:'TOKEN'});
 try{
  const db=sql();await applySeatPolicy(db);await db`SELECT premiere_expire()`;
  if(req.method==='POST'){
   const action=req.body?.action;if(!['confirm','cancel','decline'].includes(action))return json(res,400,{error:'ACTION'});
   await db`SELECT * FROM premiere_action(${token}::uuid,${action})`;
  }
  await advanceQueue(db);
  const [r]=await db`SELECT r.status,r.admission,r.offer_target,r.seats,r.verified_at,r.offer_expires_at,
   ARRAY(SELECT s.id FROM premiere_seats s WHERE s.reservation_id=r.id ORDER BY s.row_no,s.seat_no) AS seat_ids
   FROM premiere_reservations r WHERE token=${token}::uuid`;
  if(!r)return json(res,404,{error:'NOT_FOUND'});
  const canConfirm=new Date()<new Date(EVENT_AT)&&(
   ['verification','offered'].includes(r.status)||(r.status==='waiting'&&!r.verified_at)||
   (r.status==='reserved'&&new Date()>=new Date(REMIND_FROM)));
  return json(res,200,{status:r.status,admission:r.admission,offerTarget:r.offer_target,seats:r.seats,seatIds:r.seat_ids,
   canDecline:r.status==='offered'&&r.admission==='standing'&&r.offer_target==='seated',
   emailVerified:!!r.verified_at,canConfirm,offerExpiresAt:r.offer_expires_at});
 }catch(e){
  if(String(e.message).includes('ACTION_UNAVAILABLE'))return json(res,409,{error:'ACTION_UNAVAILABLE'});
  if(String(e.message).includes('NOT_FOUND'))return json(res,404,{error:'NOT_FOUND'});
  return json(res,503,{error:'UNAVAILABLE'});
 }
}
