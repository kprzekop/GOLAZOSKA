import {deliverPendingTickets,ticketUrl} from '../lib/tickets.js';
import {advanceQueue} from '../lib/queue.js';
import {applySeatPolicy} from '../lib/seat-policy.js';
import {json,sql,sendMail,confirmUrl,tokenValid,escapeHtml} from '../lib/shared.js';
import {EVENT_AT,REMIND_FROM,CONFIRM_BY,EVENT_DESCRIPTION,DEADLINE_LABEL,seatLabel} from '../lib/event.js';
export default async function handler(req,res){
 if(req.method!=='GET')return json(res,405,{error:'METHOD'});
 if(!tokenValid((req.headers.authorization||'').replace(/^Bearer /i,''),process.env.CRON_SECRET))
  return json(res,401,{error:'UNAUTHORIZED'});
 if(!process.env.DATABASE_URL||!process.env.RESEND_API_KEY||!process.env.MAIL_FROM)return json(res,503,{error:'UNAVAILABLE'});
 const db=sql(),now=new Date();let promoted=0,sent=0,failed=0;
 try{
  await applySeatPolicy(db);
  await db`SELECT premiere_expire()`;
  if(now>=new Date('2026-12-22T00:00:00+01:00')){
   await db`UPDATE premiere_seats SET reservation_id=NULL WHERE reservation_id IS NOT NULL`;
   await db`DELETE FROM premiere_reservations`;return json(res,200,{purged:true});
  }
  if(now>=new Date(EVENT_AT))return json(res,200,{done:true});
  const queue=await advanceQueue(db);promoted=queue.promoted;sent=queue.sent;failed=queue.failed;
  const tickets=await deliverPendingTickets(db);sent+=tickets.sent;failed+=tickets.failed;
  if(now>=new Date(REMIND_FROM)&&now<new Date(CONFIRM_BY)){
   const reminders=await db`SELECT id,name,email,token,admission FROM premiere_reservations WHERE status='reserved' AND reminder_sent_at IS NULL ORDER BY created_at`;
   for(const r of reminders){
    try{
     await sendMail(r.email,'Potwierdź udział do 18 listopada, godz. 19:00 – Goła Zośka',
      '<p>Dzień dobry, '+escapeHtml(r.name)+'.</p><p>'+EVENT_DESCRIPTION+'.</p><p>'+(r.admission==='standing'?'Twoje wejście nie gwarantuje fotela; udział może odbyć się na stojąco.':'Masz rezerwację miejsca siedzącego.')+'</p><p><a href="'+confirmUrl(r.token)+
      '">Potwierdź udział</a> do '+DEADLINE_LABEL+'. Brak potwierdzenia zwalnia miejsca do ponownej rezerwacji.</p>');
     await db`UPDATE premiere_reservations SET reminder_sent_at=now() WHERE id=${r.id}::uuid AND status='reserved'`;sent++;
    }catch{failed++;}
   }
  }
  if(now>=new Date('2026-11-19T00:00:00+01:00')){
   const confirmed=await db`SELECT r.id,r.name,r.email,r.token,r.seats,r.admission,ARRAY(SELECT s.id FROM premiere_seats s
    WHERE s.reservation_id=r.id ORDER BY s.row_no,s.seat_no) AS seat_ids FROM premiere_reservations r
    WHERE status='confirmed' AND final_sent_at IS NULL ORDER BY created_at`;
   for(const r of confirmed){
    try{
     await sendMail(r.email,'Przypomnienie o premierze – Goła Zośka 1812',
      '<p>Dzień dobry, '+escapeHtml(r.name)+'.</p><p>Rezerwacja potwierdzona: '+(r.admission==='standing'?'wejście dla '+r.seats+' osób bez gwarancji fotela; udział może odbyć się na stojąco':escapeHtml(seatLabel(r.seat_ids)))+
      '.</p><p>'+EVENT_DESCRIPTION+'.</p><p><a href="'+ticketUrl(r.token)+'">Pokaż wejściówki QR</a> — kody otrzymasz również w osobnej wiadomości.</p><p>Jeśli nie możesz przyjść, <a href="'+confirmUrl(r.token)+'">anuluj rezerwację</a>.</p>');
     await db`UPDATE premiere_reservations SET final_sent_at=now() WHERE id=${r.id}::uuid AND status='confirmed'`;sent++;
    }catch{failed++;}
   }
  }
  return json(res,200,{promoted,sent,failed});
 }catch{return json(res,503,{error:'UNAVAILABLE'});}
}
