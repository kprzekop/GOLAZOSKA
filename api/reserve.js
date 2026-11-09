import {prepareSelectedPreview,deliverSelectedPreview} from '../lib/preview-selected-seats.js';
import {deliverTickets,ticketUrl} from '../lib/tickets.js';
import {advanceQueue} from '../lib/queue.js';
import {applySeatPolicy} from '../lib/seat-policy.js';
import {escapeHtml,json,sql,sendMail,actionMail} from '../lib/shared.js';
import {validateBooking,isReservationPeriod} from '../lib/event.js';
export default async function handler(req,res){
 if(req.method==='GET'&&req.query?.interest==='true')return json(res,200,{siteKey:process.env.TURNSTILE_SITE_KEY});
 if(req.method!=='POST')return json(res,405,{error:'METHOD'});
 const body=req.body||{},interest=body.screeningInterest===true;
 if(!interest&&(process.env.RESERVATIONS_OPEN!=='true'||!isReservationPeriod()))return json(res,503,{error:'CLOSED'});
 if(!process.env.DATABASE_URL||!process.env.RESEND_API_KEY||!process.env.MAIL_FROM||!process.env.TURNSTILE_SECRET_KEY)
 return json(res,503,{error:'UNAVAILABLE'});
 if(body.website)return json(res,400,{error:'INVALID_INPUT'});
 let input;
 try{input=validateBooking(interest?{...body,waiting:false}:body);if(!interest&&input.waiting&&body.acceptStanding!==true)throw Error('INVALID_INPUT');}catch{return json(res,400,{error:'INVALID_INPUT'});}
 try{
  const challenge=String(body['cf-turnstile-response']||'');
  if(!challenge||challenge.length>2048)return json(res,400,{error:'CHALLENGE'});
  const v=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{
   method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({secret:process.env.TURNSTILE_SECRET_KEY,response:challenge})
  }).then(r=>r.json());
  if(!v.success||v.hostname!==(process.env.TURNSTILE_HOSTNAME||'www.golazoska.com'))
   return json(res,400,{error:'CHALLENGE'});
  const {name,email,phone,seatIds,seats,waiting}=input,db=sql();
  if(interest){
   await prepareSelectedPreview(db);
   const [booking]=await db`SELECT preview_reserve_selected(${name},${email},${phone},${seatIds}::text[]) AS id`;
   await deliverSelectedPreview(db,booking.id);
   return json(res,200,{status:'confirmed',admission:'seated',ticketUrl:'/dodatkowy-seans.html?oferta='+booking.id});
  }
  await applySeatPolicy(db);
  await advanceQueue(db);
  const encorePriority=waiting&&body.encorePriority===true;
  if(encorePriority){
   const [schema]=await db`SELECT EXISTS(SELECT 1 FROM pg_attribute
    WHERE attrelid='premiere_reservations'::regclass AND attname='encore_priority' AND NOT attisdropped) AS ready`;
   if(!schema.ready)await db`ALTER TABLE premiere_reservations ADD COLUMN IF NOT EXISTS encore_priority boolean NOT NULL DEFAULT false`;
  }
  let row;
  if(body.standingOnly===true){
   if(!waiting||seatIds.length)return json(res,400,{error:'INVALID_INPUT'});
   try{
    const [created]=await db.transaction([
     db`SELECT * FROM premiere_create(${name},${email},${phone},${seatIds}::text[],${seats},true)`,
     db`SELECT 1 / CASE WHEN EXISTS(SELECT 1 FROM premiere_reservations WHERE email=${email}
      AND admission='standing' AND status IN ('verification','reserved','confirmed','offered')) THEN 1 ELSE 0 END`
    ]);
    row=created[0];
   }catch(error){
    if(String(error.message).includes('division by zero'))return json(res,409,{error:'STANDING_UNAVAILABLE'});
    throw error;
   }
  }else [row]=await db`SELECT * FROM premiere_create(${name},${email},${phone},${seatIds}::text[],${seats},${waiting})`;
  const [details]=await db`SELECT admission FROM premiere_reservations WHERE id=${row.booking_id}::uuid`;
  if(details.admission!=='waiting'){
   const [confirmed]=await db`UPDATE premiere_reservations SET status='confirmed',verified_at=COALESCE(verified_at,now())
    WHERE id=${row.booking_id}::uuid AND status IN ('verification','reserved','confirmed') RETURNING id`;
   if(!confirmed)return json(res,409,{error:'SEATS_UNAVAILABLE'});
   if(encorePriority)await db`UPDATE premiere_reservations SET encore_priority=true WHERE id=${row.booking_id}::uuid`;
   await deliverTickets(db,row.booking_id);
   return json(res,200,{status:'confirmed',admission:details.admission,ticketUrl:ticketUrl(row.booking_token)});
  }
  try{
   if(encorePriority)await db`UPDATE premiere_reservations SET encore_priority=true WHERE id=${row.booking_id}::uuid`;
   await sendMail(email,details.admission==='waiting'?'Potwierdź adres – lista rezerwowa Goła Zośka':details.admission==='standing'?'Potwierdź wejście bez gwarancji fotela – Goła Zośka':'Potwierdź adres – Goła Zośka 1812',
    actionMail(name,seats,row.booking_token,details.admission==='waiting',seatIds,details.admission)+(encorePriority?'<p>Zapisaliśmy Twoją prośbę o pierwszeństwo przy rezerwacji miejsc na kolejny seans.</p>':''));
  }catch{
   await db`SELECT * FROM premiere_action(${row.booking_token}::uuid,'cancel')`;
   return json(res,503,{error:'MAIL_UNAVAILABLE'});
  }
  return json(res,200,{status:row.booking_status,admission:details.admission});
 }catch(e){
  for(const [code,status]of [['DUPLICATE',409],['SEATS_UNAVAILABLE',409],['INVALID_INPUT',400],['CLOSED',503]])
   if(String(e.message).includes(code))return json(res,status,{error:code});
  console.error('Reservation failed');return json(res,503,{error:'UNAVAILABLE'});
 }
}
