import {isAdmin,json,sql,tokenValid} from '../lib/shared.js';
import {additionalScreeningsReady,initializePreviewScreening,sendAdditionalScreeningOffers,deliverTransferConfirmation} from '../lib/additional-screenings.js';

export default async function handler(req,res){
 if(!['GET','POST'].includes(req.method))return json(res,405,{error:'METHOD'});
 if(req.method==='GET'&&req.query?.plan==='18'){
  try{
   const db=sql();
   await initializePreviewScreening(db);
   const seats=await db`SELECT row_no AS row,seat_no AS number,
    CASE WHEN booking_id IS NOT NULL THEN 'taken' WHEN pool='public' THEN 'available' ELSE pool END AS status
    FROM additional_screening_seats WHERE screening_id=1 ORDER BY row_no,seat_no`;
   return json(res,200,{seats});
  }catch{return json(res,503,{error:'UNAVAILABLE'});}
 }
 if(req.method==='POST'&&req.body?.action==='dispatch-transfers'){
  const token=(req.headers.authorization||'').replace(/^Bearer /i,'');
  if(!isAdmin(req)&&!tokenValid(token,process.env.TRANSFER_DISPATCH_TOKEN))return json(res,401,{error:'UNAUTHORIZED'});
  try{
   const db=sql();await initializePreviewScreening(db);
   if(req.body.dryRun){
    const [stats]=await db`SELECT
     (SELECT count(*)::int FROM premiere_reservations WHERE verified_at IS NOT NULL AND admission IN ('standing','waiting') AND status IN ('reserved','confirmed','waiting','offered') AND email NOT LIKE '%@example.invalid') AS eligible_bookings,
     (SELECT count(*)::int FROM additional_screening_bookings WHERE transfer_source_id IS NOT NULL AND transferred_at IS NULL AND status IN ('offered','confirmed')) AS pending_transfers,
     (SELECT count(*)::int FROM additional_screening_bookings WHERE transfer_sent_at IS NOT NULL) AS sent_proposals,
     (SELECT count(*)::int FROM additional_screening_bookings WHERE transferred_at IS NOT NULL) AS completed_transfers,
     (SELECT count(*)::int FROM additional_screening_seats WHERE screening_id=1 AND pool='public' AND booking_id IS NULL) AS free_seats`;
    return json(res,200,stats);
   }
   return json(res,200,await sendAdditionalScreeningOffers(db,{previewOnly:true}));
  }
  catch{return json(res,503,{error:'UNAVAILABLE'});}
 }
 const {id,action}=req.method==='GET'?(req.query||{}):(req.body||{});
 if(req.method==='POST'&&action==='schedule'){
  if(!isAdmin(req))return json(res,401,{error:'UNAUTHORIZED'});
  const {startsAt,invitationsOpen}=req.body;
  if(![1,2,3].includes(id)||typeof invitationsOpen!=='boolean'
   ||typeof startsAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(startsAt))
   return json(res,400,{error:'INVALID_INPUT'});
  try{
   const db=sql();
   if(!await additionalScreeningsReady(db))return json(res,503,{error:'UNAVAILABLE'});
   const [,updated]=await db.transaction([
    db`SELECT pg_advisory_xact_lock(851191,1)`,
    db`UPDATE additional_screenings SET starts_at=${startsAt}::timestamp AT TIME ZONE 'Europe/Warsaw',
     invitations_open=${invitationsOpen} WHERE id=${id}
     AND ${startsAt}::timestamp AT TIME ZONE 'Europe/Warsaw'>now()
     AND (starts_at=${startsAt}::timestamp AT TIME ZONE 'Europe/Warsaw' OR NOT EXISTS (
      SELECT 1 FROM additional_screening_bookings WHERE screening_id=${id}
     )) RETURNING id`
   ]);
   return updated.length?json(res,200,{ok:true}):json(res,409,{error:'ACTION_UNAVAILABLE'});
  }catch{return json(res,503,{error:'UNAVAILABLE'});}
 }
 if(typeof id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
  ||(req.method==='POST'&&!['accept','transfer','decline','verify-interest'].includes(action)))return json(res,400,{error:'INVALID_INPUT'});
 try{
  const db=sql();
  if(action==='verify-interest'&&req.method==='POST'){
   const [schema]=await db`SELECT to_regclass('public.additional_screening_interest') IS NOT NULL AS ready`;
   if(!schema.ready)return json(res,404,{error:'NOT_FOUND'});
   const [entry]=await db`UPDATE additional_screening_interest SET verified_at=COALESCE(verified_at,now())
    WHERE id=${id}::uuid AND (verified_at IS NOT NULL OR created_at>now()-interval '24 hours') RETURNING id`;
   return entry?json(res,200,{ok:true}):json(res,404,{error:'NOT_FOUND'});
  }
  if(!await additionalScreeningsReady(db))return json(res,404,{error:'NOT_FOUND'});
  await initializePreviewScreening(db);
  if(req.method==='POST'&&action==='transfer'){
   const seats=req.body.seatIds;
   if(req.body.consent!==true||!Array.isArray(seats)||seats.length<1||seats.length>2
    ||seats.some(seat=>typeof seat!=='string'||!/^([1-7])-([1-9]|1[0-3])$/.test(seat)))return json(res,400,{error:'INVALID_INPUT'});
   await db`SELECT preview_choose_and_transfer(${id}::uuid,${seats}::text[])`;
  }else if(req.method==='POST')await db`SELECT additional_screening_reply(${id}::uuid,${action})`;
  if(req.method==='POST'&&action==='transfer')await deliverTransferConfirmation(db,id);
  const [offer]=await db`SELECT b.transfer_source_id IS NOT NULL AS transfer, b.transferred_at, CASE WHEN b.status='offered' AND b.expires_at<=now()
   THEN 'expired' ELSE b.status END AS status,s.starts_at,b.expires_at,
   ARRAY(SELECT p.row_no||'-'||p.seat_no FROM additional_screening_seats p
    WHERE p.booking_id=b.id ORDER BY p.row_no,p.seat_no) AS seats
   FROM additional_screening_bookings b JOIN additional_screenings s ON s.id=b.screening_id WHERE b.id=${id}::uuid`;
  if(offer&&offer.transfer&&!offer.transferred_at){
   const [group]=await db`SELECT r.seats FROM premiere_reservations r
    JOIN additional_screening_bookings b ON b.transfer_source_id=r.id WHERE b.id=${id}::uuid`;
   offer.groupSize=group?.seats||offer.seats.length;
   offer.plan=await db`SELECT row_no AS row,seat_no AS number,
    CASE WHEN pool='public' AND (booking_id IS NULL OR booking_id=${id}::uuid) THEN 'available' ELSE 'taken' END AS status
    FROM additional_screening_seats WHERE screening_id=1 ORDER BY row_no,seat_no`;
  }
  return offer?json(res,200,offer):json(res,404,{error:'NOT_FOUND'});
 }catch(error){
  for(const code of ['TRANSFER_CONSENT_REQUIRED','ACTION_UNAVAILABLE','SEATS_UNAVAILABLE'])if(String(error.message).includes(code))return json(res,409,{error:code});
  return json(res,503,{error:'UNAVAILABLE'});
 }
}
