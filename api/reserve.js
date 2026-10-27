import {json,sql,sendMail,actionMail} from '../lib/shared.js';
import {validateBooking,EVENT_AT} from '../lib/event.js';
export default async function handler(req,res){
 if(req.method!=='POST')return json(res,405,{error:'METHOD'});
 if(process.env.RESERVATIONS_OPEN!=='true'||new Date()>=new Date(EVENT_AT))return json(res,503,{error:'CLOSED'});
 if(!process.env.DATABASE_URL||!process.env.RESEND_API_KEY||!process.env.MAIL_FROM||!process.env.TURNSTILE_SECRET_KEY)
 return json(res,503,{error:'UNAVAILABLE'});
 const body=req.body||{};
 if(body.website)return json(res,400,{error:'INVALID_INPUT'});
 let input;
 try{input=validateBooking(body);}catch{return json(res,400,{error:'INVALID_INPUT'});}
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
  const [row]=await db`SELECT * FROM premiere_create(${name},${email},${phone},${seatIds}::text[],${seats},${waiting})`;
  try{
   await sendMail(email,waiting?'Potwierdź adres – lista rezerwowa Goła Zośka':'Potwierdź adres – Goła Zośka 1812',
    actionMail(name,seats,row.booking_token,waiting,seatIds));
  }catch{
   await db`SELECT * FROM premiere_action(${row.booking_token}::uuid,'cancel')`;
   return json(res,503,{error:'MAIL_UNAVAILABLE'});
  }
  return json(res,200,{status:row.booking_status});
 }catch(e){
  for(const [code,status]of [['DUPLICATE',409],['SEATS_UNAVAILABLE',409],['INVALID_INPUT',400],['CLOSED',503]])
   if(String(e.message).includes(code))return json(res,status,{error:code});
  console.error('Reservation failed');return json(res,503,{error:'UNAVAILABLE'});
 }
}
