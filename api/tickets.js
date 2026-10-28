import {applySeatPolicy} from '../lib/seat-policy.js';
import {json,sql} from '../lib/shared.js';
import {uuid,admitted,ensureTickets,qrPng} from '../lib/tickets.js';
export default async function handler(req,res){
 res.setHeader('Referrer-Policy','no-referrer');
 if(req.method!=='GET')return json(res,405,{error:'METHOD'});
 try{
  const db=sql();await applySeatPolicy(db);await db`SELECT premiere_expire()`;
  if(req.query.ticket){
   if(!uuid.test(String(req.query.ticket)))return json(res,400,{error:'TOKEN'});
   const [t]=await db`SELECT r.status,r.admission,r.offer_previous_status FROM premiere_tickets t JOIN premiere_reservations r ON r.id=t.reservation_id WHERE t.id=${req.query.ticket}::uuid`;
   if(!t||!admitted(t))return json(res,404,{error:'INVALID'});
   const png=await qrPng(req.query.ticket);
   res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','image/png');
   res.setHeader('X-Content-Type-Options','nosniff');return res.status(200).send(png);
  }
  const token=String(req.query.token||'');
  if(!uuid.test(token))return json(res,400,{error:'TOKEN'});
  const [r]=await db`SELECT r.id,r.status,r.admission,r.offer_previous_status,
  ARRAY(SELECT s.id FROM premiere_seats s WHERE s.reservation_id=r.id ORDER BY s.row_no,s.seat_no) AS seat_ids
  FROM premiere_reservations r WHERE token=${token}::uuid`;
  if(!r)return json(res,404,{error:'NOT_FOUND'});
  if(!admitted(r))return json(res,409,{error:'NOT_CONFIRMED'});
  const tickets=await ensureTickets(db,r.id);
  return json(res,200,{admission:r.admission,tickets:tickets.map(t=>({id:t.id,person:t.person_no,used:!!t.checked_in_at,seat:r.admission==='seated'?r.seat_ids[t.person_no-1]:null}))});
 }catch{return json(res,503,{error:'UNAVAILABLE'});}
}
