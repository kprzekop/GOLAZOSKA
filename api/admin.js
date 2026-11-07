import {additionalScreeningsReady,initializePreviewScreening} from '../lib/additional-screenings.js';
import {deliverTickets,qrPng} from '../lib/tickets.js';
import {advanceQueue} from '../lib/queue.js';
import {applySeatPolicy} from '../lib/seat-policy.js';
import {json,sql,isAdmin} from '../lib/shared.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default async function handler(req,res){
 if(!isAdmin(req))return json(res,401,{error:'UNAUTHORIZED'});
 if(!['GET','POST'].includes(req.method))return json(res,405,{error:'METHOD'});
 try{
  const db=sql();await applySeatPolicy(db);await initializePreviewScreening(db);await db`SELECT premiere_expire()`;
  if(req.method==='POST'){
   const {id,action,pool}=req.body||{};
   if(['guest_assign','guest_release','guest_qr'].includes(action)){
    if(typeof id!=='string'||!/^([1-7])-([1-9]|1[0-3])$/.test(id))return json(res,400,{error:'INVALID_INPUT'});
    if(action==='guest_qr'){
     const [ticket]=await db`SELECT t.id FROM premiere_organizational_tickets t JOIN premiere_seats s ON s.id=t.seat_id
      WHERE t.seat_id=${id} AND s.pool='organizational' AND NOT t.revoked`;
     if(!ticket)return json(res,409,{error:'ACTION_UNAVAILABLE'});
     const png=await qrPng(ticket.id);
     return json(res,200,{png:png.toString('base64')});
    }
    if(action==='guest_assign'){
     if(typeof req.body.name!=='string'||req.body.name.trim().length>120)return json(res,400,{error:'INVALID_INPUT'});
     const [,updated]=await db.transaction([
      db`SELECT id FROM premiere_config WHERE id=1 FOR UPDATE`,
      db`UPDATE premiere_organizational_tickets t SET guest_name=${req.body.name.trim()||null}
       FROM premiere_seats s WHERE s.id=t.seat_id AND s.id=${id} AND s.pool='organizational'
       AND NOT t.revoked AND t.checked_in_at IS NULL RETURNING t.seat_id`
     ]);
     return json(res,updated.length?200:409,updated.length?{ok:true}:{error:'ACTION_UNAVAILABLE'});
    }
    const [,released]=await db.transaction([
     db`SELECT id FROM premiere_config WHERE id=1 FOR UPDATE`,
     db`WITH revoked AS (
       UPDATE premiere_organizational_tickets t SET revoked=true,guest_name=NULL
       FROM premiere_seats s WHERE s.id=t.seat_id AND s.id=${id} AND s.pool='organizational'
       AND s.reservation_id IS NULL AND NOT t.revoked AND t.checked_in_at IS NULL
       AND now()<'2026-11-21 19:00 Europe/Warsaw'::timestamptz RETURNING t.seat_id
      ), moved AS (
       UPDATE premiere_seats SET pool='public' WHERE id IN (SELECT seat_id FROM revoked) RETURNING id
      )
      UPDATE premiere_config SET public_capacity=public_capacity+1,guest_capacity=guest_capacity-1
      WHERE id=1 AND EXISTS(SELECT 1 FROM moved) RETURNING id`
    ]);
    if(!released.length)return json(res,409,{error:'ACTION_UNAVAILABLE'});
    await advanceQueue(db);
    return json(res,200,{ok:true});
   }
   if(action==='pool'){
    if(typeof id!=='string'||!/^([1-7])-([1-9]|1[0-3])$/.test(id)||!['held','public'].includes(pool))
     return json(res,400,{error:'INVALID_INPUT'});
    await db`SELECT premiere_set_pool(${id},${pool})`;if(pool==='public')await advanceQueue(db);return json(res,200,{ok:true});
   }
   if(!uuid.test(String(id))||!['cancel','cancel_hold','confirm','offer'].includes(action))return json(res,400,{error:'INVALID_INPUT'});
   const [r]=await db`SELECT premiere_admin_action(${id}::uuid,${action}) AS status`;if(action!=='cancel_hold')await advanceQueue(db);if(action==='confirm')await deliverTickets(db,id);return json(res,200,r);
  }
  await advanceQueue(db);
  const printContact=process.env.STANDING_GUEST_PRINT_CONTACT||null;
  const originalPrintIds=process.env.STANDING_GUEST_PRINT_IDS||'[]';
  const extraPrintIds=process.env.STANDING_GUEST_PRINT_EXTRA_IDS||'[]';
  const reservations=await db`SELECT r.id,r.name,
   CASE WHEN r.email='druk-'||r.id||'@example.invalid'
    AND ((${originalPrintIds}::jsonb || ${extraPrintIds}::jsonb) ? r.id::text)
    THEN COALESCE(${printContact},r.email) ELSE r.email END AS email,
   COALESCE((to_jsonb(r)->>'encore_priority')::boolean,false) AS encore_priority,
   r.phone,r.seats,r.status,r.admission,r.offer_target,r.upgrade_declined_at,r.created_at,r.verified_at,
   r.reminder_sent_at,r.offer_expires_at,ARRAY(SELECT s.id FROM premiere_seats s WHERE s.reservation_id=r.id ORDER BY s.row_no,s.seat_no) AS seat_ids
   FROM premiere_reservations r ORDER BY r.created_at,r.id`;
  const [interestTable]=await db`SELECT to_regclass('public.additional_screening_interest') IS NOT NULL AS ready`;
  if(interestTable.ready)reservations.push(...await db`SELECT id,name,email,phone,seats,created_at,verified_at,
   'interest' AS admission,'verified' AS status FROM additional_screening_interest WHERE verified_at IS NOT NULL ORDER BY created_at,id`);
  const [cfg]=await db`SELECT public_capacity,guest_capacity,physical_capacity,standing_capacity,premiere_standing_used() AS standing_used FROM premiere_config WHERE id=1`;
  const seats=await db`SELECT s.id,s.row_no,s.seat_no,s.pool,(s.reservation_id IS NOT NULL) AS taken,
   t.guest_name,t.checked_in_at,(t.id IS NOT NULL AND NOT t.revoked) AS guest_ticket
   FROM premiere_seats s LEFT JOIN premiere_organizational_tickets t ON t.seat_id=s.id ORDER BY s.row_no,s.seat_no`;
  const [layouts]=await db`SELECT to_regclass('public.additional_screening_seats') IS NOT NULL AS ready`;
  const screenings=layouts.ready?await db`SELECT s.id,s.starts_at,
   COALESCE(jsonb_agg(jsonb_build_object('row_no',p.row_no,'seat_no',p.seat_no,'pool',p.pool,'booking_id',p.booking_id)
    ORDER BY p.row_no,p.seat_no) FILTER (WHERE p.seat_no IS NOT NULL),'[]'::jsonb) AS seats
   FROM additional_screenings s LEFT JOIN additional_screening_seats p ON p.screening_id=s.id
   GROUP BY s.id ORDER BY s.id`:[];
  const invitationsReady=await additionalScreeningsReady(db);
  const screeningSettings=invitationsReady?await db`SELECT id,invitations_open,
   to_char(starts_at AT TIME ZONE 'Europe/Warsaw','YYYY-MM-DD"T"HH24:MI') AS local_start,
   (SELECT count(*)::int FROM additional_screening_bookings b WHERE b.screening_id=s.id AND b.status='confirmed') AS confirmed,
   (SELECT count(*)::int FROM additional_screening_bookings b WHERE b.screening_id=s.id AND b.status='offered' AND b.expires_at>now()) AS offered
   FROM additional_screenings s`:[];
  const screeningBookings=invitationsReady?await db`SELECT b.id,b.screening_id,b.name,b.email,b.status,b.expires_at,
   b.transfer_sent_at,b.transferred_at,b.transfer_source_id,
   ARRAY(SELECT p.row_no||'-'||p.seat_no FROM additional_screening_seats p WHERE p.booking_id=b.id ORDER BY p.row_no,p.seat_no) AS seat_ids
   FROM additional_screening_bookings b ORDER BY b.screening_id,b.name,b.id`:[];
  const moved=new Set(screeningBookings.filter(b=>b.transferred_at).map(b=>b.transfer_source_id));
  return json(res,200,{config:cfg,reservations:reservations.filter(r=>!moved.has(r.id)),seats,screenings,screeningSettings,screeningBookings});
 }catch(e){
  if(['NO_CAPACITY','ACTION_UNAVAILABLE'].some(code=>String(e.message).includes(code)))return json(res,409,{error:'ACTION_UNAVAILABLE'});
  return json(res,503,{error:'UNAVAILABLE'});
 }
}
