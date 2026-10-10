import {json,sql} from './_shared.js';
export default async function handler(req,res) {
  if(req.method!=='GET') return json(res,405,{error:'METHOD'});
  if(!process.env.DATABASE_URL || !process.env.RESEND_API_KEY ||
    !process.env.TURNSTILE_SITE_KEY || !process.env.TURNSTILE_SECRET_KEY ||
    process.env.RESERVATIONS_OPEN!=='true')
    return json(res,200,{open:false});
  try {
    const db=sql();
    const [r]=await db`SELECT c.public_capacity,
      coalesce(sum(b.seats) FILTER (WHERE b.status IN ('verification','reserved','confirmed','offered')),0) AS used
      FROM premiere_config c LEFT JOIN premiere_reservations b ON true WHERE c.id=1 GROUP BY c.public_capacity`;
    return json(res,200,{open:true,siteKey:process.env.TURNSTILE_SITE_KEY,
      waitlist:Number(r.used)>=Number(r.public_capacity)});
  } catch {return json(res,503,{open:false});}
}
