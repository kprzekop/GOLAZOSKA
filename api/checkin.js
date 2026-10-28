import {applySeatPolicy} from '../lib/seat-policy.js';
import {json,sql,isAdmin,tokenValid} from '../lib/shared.js';
import {uuid} from '../lib/tickets.js';
export const isStaff=req=>isAdmin(req)||tokenValid((req.headers.authorization||'').replace(/^Bearer /i,''),process.env.CHECKIN_TOKEN);
export default async function handler(req,res){
 if(!isStaff(req))return json(res,401,{error:'UNAUTHORIZED'});
 if(!['GET','POST'].includes(req.method))return json(res,405,{error:'METHOD'});
 try{
  const db=sql();await applySeatPolicy(db);await db`SELECT premiere_expire()`;
  if(req.method==='GET'){
   const q=String(req.query.q||'').trim();
   if(q.length<3)return json(res,200,{tickets:[]});
   if(q.length>120)return json(res,400,{error:'QUERY'});
   const term='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
   const rows=await db`SELECT t.id,t.person_no,t.checked_in_at,r.name,r.admission,r.status
    FROM premiere_tickets t JOIN premiere_reservations r ON r.id=t.reservation_id
    WHERE r.name ILIKE ${term} OR r.email ILIKE ${term} OR t.id::text=${q}
    ORDER BY r.name,t.person_no LIMIT 50`;
   return json(res,200,{tickets:rows});
  }
  const id=String(req.body?.ticket||'').replace(/^GZ26:/,'');
  if(!uuid.test(id)||!['inspect','enter'].includes(req.body?.action))return json(res,400,{error:'INVALID_INPUT'});
  const [result]=await db`SELECT * FROM premiere_checkin(${id}::uuid,${req.body.action==='enter'})`;
  return json(res,200,result);
 }catch{return json(res,503,{error:'UNAVAILABLE'});}
}
