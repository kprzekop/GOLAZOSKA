import {json,sql,sendMail,confirmUrl,tokenValid,escapeHtml} from '../lib/shared.js';
export default async function handler(req,res) {
  if(req.method!=='GET') return json(res,405,{error:'METHOD'});
  if(!tokenValid((req.headers.authorization||'').replace(/^Bearer /i,''),process.env.CRON_SECRET))
    return json(res,401,{error:'UNAUTHORIZED'});
  if(!process.env.DATABASE_URL || !process.env.RESEND_API_KEY) return json(res,503,{error:'UNAVAILABLE'});
  const db=sql(),now=new Date();
  const event=new Date('2026-11-21T00:00:00+01:00');
  if(now>=event) return json(res,200,{done:true});
  let promoted=0, sent=0, failed=0;
  try {
    for(let i=0;i<60;i++) {
      const [r]=await db`SELECT * FROM premiere_advance()`;
      if(!r?.promoted_id) break;
      promoted++;
    }
    const offers=await db`SELECT id,name,email,seats,token,offer_expires_at
      FROM premiere_reservations WHERE status='offered' AND offer_sent_at IS NULL ORDER BY created_at`;
    for(const r of offers) {
      try {
        await sendMail(r.email,'Zwolniło się miejsce – Goła Zośka 1812',
          `<p>Dzień dobry, ${escapeHtml(r.name)}.</p><p>Zwolniło się ${r.seats} ${r.seats===1?'miejsce':'miejsca'} na premierę. Potwierdź przyjęcie propozycji <a href="${confirmUrl(r.token)}">na tej stronie</a> do ${new Date(r.offer_expires_at).toLocaleString('pl-PL',{timeZone:'Europe/Warsaw'})}. Bez kliknięcia propozycja wygaśnie.</p>`);
        await db`UPDATE premiere_reservations SET offer_sent_at=now() WHERE id=${r.id}::uuid AND status='offered'`;
        sent++;
      } catch(e) {console.error('Offer email failed',r.id,e);failed++;}
    }
    if(now>=new Date('2026-11-14T00:00:00+01:00') && now<new Date('2026-11-18T00:00:00+01:00')) {
      const reminders=await db`SELECT id,name,email,seats,token FROM premiere_reservations
        WHERE status='reserved' AND reminder_sent_at IS NULL ORDER BY created_at`;
      for(const r of reminders) {
        try {
          await sendMail(r.email,'Potwierdź udział do 17 listopada – Goła Zośka 1812',
            `<p>Dzień dobry, ${escapeHtml(r.name)}.</p><p>Prosimy o <a href="${confirmUrl(r.token)}">potwierdzenie udziału</a> w premierze (21 listopada, ${r.seats} ${r.seats===1?'miejsce':'miejsca'}) do końca 17 listopada. Brak potwierdzenia oznacza zwolnienie miejsc dla listy rezerwowej.</p>`);
          await db`UPDATE premiere_reservations SET reminder_sent_at=now() WHERE id=${r.id}::uuid AND status='reserved'`;
          sent++;
        } catch(e) {console.error('Reminder email failed',r.id,e);failed++;}
      }
    }
    if(now>=new Date('2026-11-19T00:00:00+01:00')) {
      const confirmed=await db`SELECT id,name,email,seats,token FROM premiere_reservations
        WHERE status='confirmed' AND final_sent_at IS NULL ORDER BY created_at`;
      for(const r of confirmed) {
        try {
          await sendMail(r.email,'Przypomnienie o premierze – Goła Zośka 1812',
            `<p>Dzień dobry, ${escapeHtml(r.name)}.</p><p>Twoja rezerwacja na ${r.seats} ${r.seats===1?'miejsce':'miejsca'} na 21 listopada jest potwierdzona. Jeśli nie możesz przyjść, <a href="${confirmUrl(r.token)}">anuluj ją tutaj</a>. Szczegóły miejsca i godziny przekażemy osobno.</p>`);
          await db`UPDATE premiere_reservations SET final_sent_at=now() WHERE id=${r.id}::uuid AND status='confirmed'`;
          sent++;
        } catch(e) {console.error('Final email failed',r.id,e);failed++;}
      }
    }
    return json(res,200,{promoted,sent,failed});
  } catch(e) {console.error('Cron failed',e);return json(res,503,{error:'UNAVAILABLE'});}
}
