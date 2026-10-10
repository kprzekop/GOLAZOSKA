import {json,sql} from './_shared.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default async function handler(req,res) {
  if(!['GET','POST'].includes(req.method)) return json(res,405,{error:'METHOD'});
  const token=String((req.method==='GET'?req.query.token:req.body?.token)||'');
  if(!uuid.test(token)) return json(res,400,{error:'TOKEN'});
  try {
    const db=sql();
    if(req.method==='GET') {
      const [r]=await db`SELECT status,seats,offer_expires_at FROM premiere_reservations WHERE token=${token}::uuid`;
      if(!r) return json(res,404,{error:'NOT_FOUND'});
      return json(res,200,{status:r.status,seats:r.seats,offerExpiresAt:r.offer_expires_at});
    }
    const action=req.body?.action;
    if(!['confirm','cancel'].includes(action)) return json(res,400,{error:'ACTION'});
    const [r]=await db`SELECT * FROM premiere_action(${token}::uuid,${action})`;
    return json(res,200,{status:r.booking_status,seats:r.booking_seats});
  } catch(e) {
    if(String(e.message).includes('ACTION_UNAVAILABLE')) return json(res,409,{error:'ACTION_UNAVAILABLE'});
    if(String(e.message).includes('NOT_FOUND')) return json(res,404,{error:'NOT_FOUND'});
    console.error('Booking action failed',e);
    return json(res,503,{error:'UNAVAILABLE'});
  }
}
