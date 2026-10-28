import QRCode from 'qrcode';
import {BASE,sendMail,escapeHtml} from './shared.js';
import {EVENT_DESCRIPTION,seatLabel} from './event.js';
export const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ticketPayload=id=>'GZ26:'+id;
export const ticketUrl=token=>BASE+'/wejsciowki.html?token='+encodeURIComponent(token);
export const admitted=r=>r.admission!=='waiting'&&(r.status==='confirmed'||(r.status==='offered'&&r.admission==='standing'&&r.offer_previous_status==='confirmed'));
export async function ensureTickets(db,id){
 await db`INSERT INTO premiere_tickets(reservation_id,person_no)
 SELECT r.id,n FROM premiere_reservations r CROSS JOIN LATERAL generate_series(1,r.seats) n
 WHERE r.id=${id}::uuid AND r.admission IN('seated','standing')
 AND (r.status='confirmed' OR (r.status='offered' AND r.admission='standing' AND r.offer_previous_status='confirmed'))
 ON CONFLICT(reservation_id,person_no) DO NOTHING`;
 return db`SELECT id,person_no,checked_in_at FROM premiere_tickets WHERE reservation_id=${id}::uuid ORDER BY person_no`;
}
export const qrPng=id=>QRCode.toBuffer(ticketPayload(id),{type:'png',width:360,margin:4,errorCorrectionLevel:'M'});
export async function deliverTickets(db,id){
 const [r]=await db`SELECT r.id,r.name,r.email,r.token,r.status,r.admission,r.offer_previous_status,
 ARRAY(SELECT s.id FROM premiere_seats s WHERE s.reservation_id=r.id ORDER BY s.row_no,s.seat_no) AS seat_ids
 FROM premiere_reservations r WHERE r.id=${id}::uuid`;
 if(!r||!admitted(r))return {sent:0,failed:0};
 const signature=r.admission+':'+(r.admission==='seated'?r.seat_ids.join(','):'standing');
 const [claimed]=await db`UPDATE premiere_reservations SET ticket_mail_claimed_at=now()
 WHERE id=${id}::uuid AND ticket_sent_for IS DISTINCT FROM ${signature}
 AND (ticket_mail_claimed_at IS NULL OR ticket_mail_claimed_at<now()-interval '5 minutes') RETURNING id`;
 if(!claimed)return {sent:0,failed:0};
 try{
  const tickets=await ensureTickets(db,id),attachments=[];
  let html='<p>Dzień dobry, '+escapeHtml(r.name)+'.</p><p>'+EVENT_DESCRIPTION+'.</p><p>Udział potwierdzony. Każdy kod jest wejściówką dla jednej osoby. Pokaż kod przy wejściu na telefonie lub wydruku.</p>';
  for(const t of tickets){
   const place=r.admission==='seated'?seatLabel([r.seat_ids[t.person_no-1]]):'Wejście na stojąco / bez gwarancji fotela';
   const cid='ticket-'+t.person_no;
   attachments.push({filename:'wejsciowka-'+t.person_no+'.png',content:await qrPng(t.id),contentId:cid});
   html+='<h2>Wejściówka '+t.person_no+'</h2><p>'+escapeHtml(place)+'</p><img src="cid:'+cid+'" width="280" height="280" alt="Kod QR wejściówki '+t.person_no+'"><p>Numer: '+t.id+'</p>';
  }
  html+='<p><a href="'+ticketUrl(r.token)+'">Pokaż lub wydrukuj wejściówki</a></p><p>Nie publikuj kodów. Każdego można użyć tylko raz. Anulowanie zgłoszenia unieważnia wejściówki.</p>';
  await sendMail(r.email,'Twoje wejściówki QR – Goła Zośka 1812',html,attachments);
  await db`UPDATE premiere_reservations SET ticket_sent_for=${signature},ticket_mail_claimed_at=NULL WHERE id=${id}::uuid`;
  return {sent:1,failed:0};
 }catch{
  await db`UPDATE premiere_reservations SET ticket_mail_claimed_at=NULL WHERE id=${id}::uuid`;
  return {sent:0,failed:1};
 }
}
export async function deliverPendingTickets(db){
 const rows=await db`SELECT id FROM premiere_reservations WHERE status='confirmed' OR (status='offered' AND admission='standing' AND offer_previous_status='confirmed') ORDER BY created_at`;
 let sent=0,failed=0;
 for(const r of rows){const result=await deliverTickets(db,r.id);sent+=result.sent;failed+=result.failed;}
 return {sent,failed};
}
