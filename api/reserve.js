import {advanceQueue} from '../lib/queue.js';
import {applySeatPolicy} from '../lib/seat-policy.js';
import {BASE,escapeHtml,json,sql,sendMail,actionMail} from '../lib/shared.js';
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
 try{input=validateBooking(interest?{...body,waiting:true,seatIds:[]}:body);if(!interest&&input.waiting&&body.acceptStanding!==true)throw Error('INVALID_INPUT');}catch{return json(res,400,{error:'INVALID_INPUT'});}
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
   const [schema]=await db`SELECT to_regclass('public.additional_screening_interest') IS NOT NULL AS ready`;
   if(!schema.ready)await db.transaction([
    db`SELECT pg_advisory_xact_lock(851191,2)`,
    db`CREATE TABLE IF NOT EXISTS additional_screening_interest (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL,
 email text NOT NULL UNIQUE,
 phone text NOT NULL,
 seats integer NOT NULL CHECK (seats BETWEEN 1 AND 2),
 created_at timestamptz NOT NULL DEFAULT now(),
 verified_at timestamptz
)`
   ]);
   const [entry]=await db`INSERT INTO additional_screening_interest(name,email,phone,seats)
    VALUES(${name},${email},${phone},${seats})
    ON CONFLICT(email) DO UPDATE SET id=gen_random_uuid(),name=excluded.name,phone=excluded.phone,
     seats=excluded.seats,created_at=now()
    WHERE additional_screening_interest.verified_at IS NULL
     AND additional_screening_interest.created_at<=now()-interval '24 hours'
    RETURNING id`;
   if(!entry)return json(res,409,{error:'DUPLICATE'});
   try{
    await sendMail(email,'Potwierdź zapis na kolejne seanse – Goła Zośka 1812',
     '<p>Dzień dobry, '+escapeHtml(name)+'.</p><p><a href="'+BASE+'/dodatkowy-seans.html?zapis='+entry.id+
     '">Potwierdź zgłoszenie w ciągu 24 godzin</a>. Kiedy ustalimy terminy, wyślemy propozycję miejsc w miarę dostępności.</p>');
   }catch{
    await db`DELETE FROM additional_screening_interest WHERE id=${entry.id}::uuid AND verified_at IS NULL`;
    return json(res,503,{error:'MAIL_UNAVAILABLE'});
   }
   return json(res,200,{admission:'interest'});
  }
  await applySeatPolicy(db);
  await advanceQueue(db);
  const encorePriority=waiting&&body.encorePriority===true;
  if(encorePriority){
   const [schema]=await db`SELECT EXISTS(SELECT 1 FROM pg_attribute
    WHERE attrelid='premiere_reservations'::regclass AND attname='encore_priority' AND NOT attisdropped) AS ready`;
   if(!schema.ready)await db`ALTER TABLE premiere_reservations ADD COLUMN IF NOT EXISTS encore_priority boolean NOT NULL DEFAULT false`;
  }
  const [row]=await db`SELECT * FROM premiere_create(${name},${email},${phone},${seatIds}::text[],${seats},${waiting})`;
  const [details]=await db`SELECT admission FROM premiere_reservations WHERE id=${row.booking_id}::uuid`;
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
