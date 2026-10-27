import {applySeatPolicy} from '../lib/seat-policy.js';
import {json,sql} from '../lib/shared.js';
import {RESERVATIONS_START,isReservationPeriod} from '../lib/event.js';
export default async function handler(req,res){
 if(req.method!=='GET')return json(res,405,{error:'METHOD'});
 if(!process.env.DATABASE_URL||!process.env.RESEND_API_KEY||!process.env.MAIL_FROM||
 !process.env.TURNSTILE_SITE_KEY||!process.env.TURNSTILE_SECRET_KEY||
 process.env.RESERVATIONS_OPEN!=='true')return json(res,200,{open:false});
 try{
  const db=sql(),seatPools=await applySeatPolicy(db);
  if(!isReservationPeriod())return json(res,200,{open:false,seatPools,
   ...(new Date()<new Date(RESERVATIONS_START)?{opensAt:RESERVATIONS_START}:{} )});
  await db`SELECT premiere_expire()`;
  const seats=await db`SELECT id,row_no,seat_no,pool,(reservation_id IS NOT NULL) AS taken FROM premiere_seats ORDER BY row_no,seat_no`;
  if(seats.length!==83)return json(res,503,{open:false});
  const map=seats.map(s=>({id:s.id,row:s.row_no,number:s.seat_no,
   status:s.pool==='organizational'?'organizational':s.pool==='held'?'held':s.taken?'taken':'available'}));
  return json(res,200,{open:true,seatPools,siteKey:process.env.TURNSTILE_SITE_KEY,waitlist:!map.some(s=>s.status==='available'),seats:map});
 }catch{return json(res,503,{open:false});}
}
