import {sendMail,confirmUrl,escapeHtml} from './shared.js';
import {EVENT_AT,EVENT_DESCRIPTION,seatLabel} from './event.js';
// Shared by cancellation, confirmation, pool changes, status reads and the daily job.
export async function advanceQueue(db){
 let promoted=0,sent=0,failed=0;
 if(new Date()>=new Date(EVENT_AT))return {promoted,sent,failed};
 for(let i=0;i<83;i++){
  const [r]=await db`SELECT * FROM premiere_advance()`;
  if(!r?.promoted_id)break;promoted++;
 }
 const offers=await db`SELECT id FROM premiere_reservations WHERE status='offered' AND offer_sent_at IS NULL
 AND (offer_mail_claimed_at IS NULL OR offer_mail_claimed_at<now()-interval '5 minutes') ORDER BY created_at,id`;
 for(const item of offers){
  // Claim each delivery atomically to avoid duplicate emails from concurrent requests.
  const [r]=await db`UPDATE premiere_reservations SET offer_mail_claimed_at=now() WHERE id=${item.id}::uuid
   AND status='offered' AND offer_sent_at IS NULL
   AND (offer_mail_claimed_at IS NULL OR offer_mail_claimed_at<now()-interval '5 minutes')
   RETURNING id,name,email,seats,token,admission,offer_target,offer_expires_at`;
  if(!r)continue;
  try{
   const seats=await db`SELECT id FROM premiere_seats WHERE reservation_id=${r.id}::uuid ORDER BY row_no,seat_no`;
   const offer=r.offer_target==='standing'
    ?'Proponujemy wejście dla '+r.seats+' osób bez gwarancji fotela; udział może odbyć się na stojąco.'
    :'Proponowane fotele: '+escapeHtml(seatLabel(seats.map(s=>s.id)))+'.';
   const keep=r.admission==='standing'?'<p>Masz już wejście bez gwarancji fotela. Nieprzyjęcie oferty foteli nie anuluje tego wejścia. Termin potwierdzenia udziału nadal obowiązuje. Możesz wybrać „Zostaję bez fotela” pod linkiem.</p>':'';
   await sendMail(r.email,'Propozycja miejsca – Goła Zośka 1812',
    '<p>Dzień dobry, '+escapeHtml(r.name)+'.</p><p>'+EVENT_DESCRIPTION+'.</p><p>'+offer+
    ' <a href="'+confirmUrl(r.token)+'">Przyjmij propozycję</a> do '+new Date(r.offer_expires_at).toLocaleString('pl-PL',{timeZone:'Europe/Warsaw'})+'.</p>'+keep);
   await db`UPDATE premiere_reservations SET offer_sent_at=now(),offer_mail_claimed_at=NULL WHERE id=${r.id}::uuid AND status='offered'`;
   sent++;
  }catch{
   await db`UPDATE premiere_reservations SET offer_mail_claimed_at=NULL WHERE id=${r.id}::uuid AND status='offered'`;failed++;
  }
 }
 return {promoted,sent,failed};
}
