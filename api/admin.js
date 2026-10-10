import {json,sql,isAdmin} from './_shared.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default async function handler(req,res) {
  if(!isAdmin(req)) return json(res,401,{error:'UNAUTHORIZED'});
  if(!['GET','POST'].includes(req.method)) return json(res,405,{error:'METHOD'});
  try {
    const db=sql();
    if(req.method==='POST') {
      const {id,action}=req.body||{};
      if(!uuid.test(String(id)) || !['cancel','confirm','offer'].includes(action))
        return json(res,400,{error:'INVALID_INPUT'});
      const [r]=await db`SELECT premiere_admin_action(${id}::uuid,${action}) AS status`;
      return json(res,200,r);
    }
    const reservations=await db`SELECT id,name,email,seats,status,created_at,verified_at,
      reminder_sent_at,offer_expires_at FROM premiere_reservations ORDER BY created_at,id`;
    const [cfg]=await db`SELECT public_capacity,guest_capacity,physical_capacity FROM premiere_config WHERE id=1`;
    return json(res,200,{config:cfg,reservations});
  } catch(e) {
    if(String(e.message).includes('NO_CAPACITY')) return json(res,409,{error:'NO_CAPACITY'});
    if(String(e.message).includes('ACTION_UNAVAILABLE')) return json(res,409,{error:'ACTION_UNAVAILABLE'});
    console.error('Admin API failed',e);
    return json(res,503,{error:'UNAVAILABLE'});
  }
}
