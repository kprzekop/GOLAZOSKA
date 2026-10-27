import {json,sql,isAdmin} from '../lib/shared.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default async function handler(req,res){
 if(!isAdmin(req))return json(res,401,{error:'UNAUTHORIZED'});
 if(!['GET','POST'].includes(req.method))return json(res,405,{error:'METHOD'});
 try{
  const db=sql();await db`SELECT premiere_expire()`;
  if(req.method==='POST'){
   const {id,action,pool}=req.body||{};
   if(action==='pool'){
    if(typeof id!=='string'||!/^([5-7])-([1-9]|1[0-3])$/.test(id)||!['held','public'].includes(pool))
     return json(res,400,{error:'INVALID_INPUT'});
    await db`SELECT premiere_set_pool(${id},${pool})`;return json(res,200,{ok:true});
   }
   if(!uuid.test(String(id))||!['cancel','confirm','offer'].includes(action))return json(res,400,{error:'INVALID_INPUT'});
   const [r]=await db`SELECT premiere_admin_action(${id}::uuid,${action}) AS status`;return json(res,200,r);
  }
  const reservations=await db`SELECT r.id,r.name,r.email,r.phone,r.seats,r.status,r.created_at,r.verified_at,
   r.reminder_sent_at,r.offer_expires_at,ARRAY(SELECT s.id FROM premiere_seats s WHERE s.reservation_id=r.id ORDER BY s.row_no,s.seat_no) AS seat_ids
   FROM premiere_reservations r ORDER BY r.created_at,r.id`;
  const [cfg]=await db`SELECT public_capacity,guest_capacity,physical_capacity FROM premiere_config WHERE id=1`;
  const seats=await db`SELECT id,row_no,seat_no,pool,(reservation_id IS NOT NULL) AS taken FROM premiere_seats ORDER BY row_no,seat_no`;
  return json(res,200,{config:cfg,reservations,seats});
 }catch(e){
  if(['NO_CAPACITY','ACTION_UNAVAILABLE'].some(code=>String(e.message).includes(code)))return json(res,409,{error:'ACTION_UNAVAILABLE'});
  return json(res,503,{error:'UNAVAILABLE'});
 }
}
