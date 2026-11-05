import {BASE,escapeHtml,sendMail} from './shared.js';

export async function additionalScreeningsReady(db){
 const [result]=await db`SELECT to_regclass('public.additional_screening_bookings') IS NOT NULL AS ready`;
 return result.ready;
}

export async function sendAdditionalScreeningOffers(db){
 const result={sent:0,failed:0};
 if(!await additionalScreeningsReady(db))return result;
 await db`SELECT additional_screening_expire()`;
 const shows=await db`SELECT id FROM additional_screenings WHERE invitations_open AND starts_at>now() ORDER BY starts_at,id`;
 for(const show of shows){
  for(let count=0;count<58;count++){
   const [offer]=await db`SELECT additional_screening_offer(${show.id}) AS id`;
   if(!offer.id)break;
  }
 }
 // Keep each daily run bounded and leave the rest in the durable delivery queue.
 for(let count=0;count<58;count++){
  const [offer]=await db`WITH candidate AS (
    SELECT b.id FROM additional_screening_bookings b JOIN additional_screenings s ON s.id=b.screening_id
    WHERE s.invitations_open AND b.status='offered' AND b.expires_at>now() AND b.mailed_at IS NULL
    AND (b.mail_claimed_at IS NULL OR b.mail_claimed_at<now()-interval '10 minutes')
    ORDER BY b.expires_at,b.id LIMIT 1 FOR UPDATE OF b SKIP LOCKED
   )
   UPDATE additional_screening_bookings b SET mail_claimed_at=now()
   FROM candidate c,additional_screenings s WHERE b.id=c.id AND s.id=b.screening_id
   RETURNING b.id,b.name,b.email,b.expires_at,s.starts_at`;
  if(!offer)break;
  try{
   const url=BASE+'/dodatkowy-seans.html?oferta='+offer.id;
   const format=new Intl.DateTimeFormat('pl-PL',{dateStyle:'long',timeStyle:'short',timeZone:'Europe/Warsaw'});
   await sendMail(offer.email,'Propozycja miejsc na dodatkowy seans – Goła Zośka 1812',
    '<p>Dzień dobry, '+escapeHtml(offer.name)+'.</p><p>Proponujemy bezpłatne miejsca na seans '+format.format(new Date(offer.starts_at))+
    ' w sali widowiskowej MDK w Augustowie.</p><p><a href="'+escapeHtml(url)+'">Sprawdź miejsca i przyjmij propozycję</a> do '+
    format.format(new Date(offer.expires_at))+'.</p>');
   await db`UPDATE additional_screening_bookings SET mailed_at=now(),mail_claimed_at=NULL WHERE id=${offer.id}::uuid`;
   result.sent++;
  }catch{
   result.failed++;
  }
 }
 return result;
}
