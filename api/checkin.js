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
      const organizational=await db`SELECT t.id,1 AS person_no,t.checked_in_at,
    COALESCE(t.guest_name,'Zaproszenie organizatora')||' - rząd '||s.row_no||', miejsce '||s.seat_no AS name,
    'seated' AS admission,CASE WHEN t.revoked THEN 'cancelled' ELSE 'confirmed' END AS status
    FROM premiere_organizational_tickets t JOIN premiere_seats s ON s.id=t.seat_id
    WHERE s.pool='organizational' AND NOT t.revoked
    AND (('rząd '||s.row_no||', miejsce '||s.seat_no) ILIKE ${term} OR t.guest_name ILIKE ${term} OR t.id::text=${q})
    ORDER BY s.row_no,s.seat_no LIMIT 62`;
   return json(res,200,{tickets:[...rows,...organizational]});
  }
  const id=String(req.body?.ticket||'').replace(/^GZ26:/,'');
  if(!uuid.test(id)||!['inspect','enter'].includes(req.body?.action))return json(res,400,{error:'INVALID_INPUT'});
  let [result]=await db`SELECT * FROM premiere_checkin(${id}::uuid,${req.body.action==='enter'})`;
  if(result.result==='not_found'){
   [result]=await db`SELECT c.result,c.person_no,c.admission,c.seat_id,c.entered_at,COALESCE(t.guest_name,c.guest_name) AS guest_name
    FROM premiere_checkin_org(${id}::uuid,${req.body.action==='enter'}) c
    LEFT JOIN premiere_organizational_tickets t ON t.id=${id}::uuid`;
  }
  return json(res,200,result);
 }catch{return json(res,503,{error:'UNAVAILABLE'});}
}
