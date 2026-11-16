import {processTransferFollowups} from '../lib/transfer-followup.js';
import {sendAdditionalScreeningOffers} from '../lib/additional-screenings.js';
import {deliverPendingTickets} from '../lib/tickets.js';
import {sendPreviewReminders} from '../lib/preview-reminders.js';
import {advanceQueue} from '../lib/queue.js';
import {applySeatPolicy} from '../lib/seat-policy.js';
import {json,sql,tokenValid} from '../lib/shared.js';
import {EVENT_AT} from '../lib/event.js';
export default async function handler(req,res){
 if(req.method!=='GET')return json(res,405,{error:'METHOD'});
 if(!tokenValid((req.headers.authorization||'').replace(/^Bearer /i,''),process.env.CRON_SECRET))
  return json(res,401,{error:'UNAUTHORIZED'});
 if(!process.env.DATABASE_URL||!process.env.RESEND_API_KEY||!process.env.MAIL_FROM)return json(res,503,{error:'UNAVAILABLE'});
 const db=sql(),now=new Date();let promoted=0,sent=0,failed=0;
 try{
  await applySeatPolicy(db);
  const followup=await processTransferFollowups(db);
  await db`SELECT premiere_expire()`;
  const additional=await sendAdditionalScreeningOffers(db);
  if(now>=new Date('2026-12-22T00:00:00+01:00')){
   await db`UPDATE premiere_seats SET reservation_id=NULL WHERE reservation_id IS NOT NULL`;
   await db`DELETE FROM premiere_reservations WHERE (admission <> 'waiting' AND NOT COALESCE((to_jsonb(premiere_reservations)->>'encore_priority')::boolean,false)) OR status = 'cancelled' OR verified_at IS NULL`;await db`DELETE FROM premiere_organizational_tickets`;return json(res,200,{purged:true,additional,followup});
  }
  if(now>=new Date(EVENT_AT))return json(res,200,{done:true,additional,followup});
  const queue=await advanceQueue(db);promoted=queue.promoted;sent=queue.sent;failed=queue.failed;
  const tickets=await deliverPendingTickets(db);sent+=tickets.sent;failed+=tickets.failed;
  const previewReminders=await sendPreviewReminders(db,now);
  return json(res,200,{promoted,sent,failed,additional,followup,previewReminders});
 }catch{return json(res,503,{error:'UNAVAILABLE'});}
}
