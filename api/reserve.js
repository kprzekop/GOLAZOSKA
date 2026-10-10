import {json,sql,sendMail,actionMail} from './_shared.js';
export default async function handler(req,res) {
  if(req.method!=='POST') return json(res,405,{error:'METHOD'});
  if(process.env.RESERVATIONS_OPEN!=='true') return json(res,503,{error:'CLOSED'});
  if(!process.env.DATABASE_URL || !process.env.RESEND_API_KEY ||
    !process.env.TURNSTILE_SECRET_KEY) return json(res,503,{error:'UNAVAILABLE'});
  const body=req.body || {};
  if(body.website) return json(res,200,{status:'received'});
  const name=String(body.name||'').trim(),email=String(body.email||'').trim().toLowerCase(),seats=Number(body.seats);
  if(name.length<2 || name.length>120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !Number.isInteger(seats) || seats<1 || seats>4)
    return json(res,400,{error:'INVALID_INPUT'});
  try {
    const challenge=String(body['cf-turnstile-response']||'');
    if(!challenge || challenge.length>2048) return json(res,400,{error:'CHALLENGE'});
    const verification=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({secret:process.env.TURNSTILE_SECRET_KEY,response:challenge})
    }).then(r=>r.json());
    if(!verification.success || verification.hostname!==(process.env.TURNSTILE_HOSTNAME||'www.golazoska.com'))
      return json(res,400,{error:'CHALLENGE'});
    const db=sql();
    const [row]=await db`SELECT * FROM premiere_create(${name},${email},${seats})`;
    try {
      await sendMail(email,row.booking_status==='waiting'?'Lista rezerwowa – Goła Zośka 1812':'Potwierdź adres – Goła Zośka 1812',
        actionMail(name,seats,row.booking_token,row.booking_status==='waiting'));
    } catch(e) {
      // Do not leave an applicant holding a seat without a working email.
      await db`SELECT * FROM premiere_action(${row.booking_token},'cancel')`;
      console.error('Reservation mail delivery failed',e);
      return json(res,503,{error:'MAIL_UNAVAILABLE'});
    }
    return json(res,200,{status:row.booking_status==='waiting'?'waiting':'verification'});
  } catch(e) {
    if(String(e.message).includes('DUPLICATE')) return json(res,409,{error:'DUPLICATE'});
    if(String(e.message).includes('INVALID_INPUT')) return json(res,400,{error:'INVALID_INPUT'});
    console.error('Reservation failed',e);
    return json(res,503,{error:'UNAVAILABLE'});
  }
}
