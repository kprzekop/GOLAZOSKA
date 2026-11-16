import {setTimeout as delay} from 'node:timers/promises';
import {BASE,escapeHtml,sendMail} from './shared.js';

const dispatchHours=new Map([['2026-11-16','11'],['2026-11-19','11'],['2026-11-20','11'],['2026-11-21','17']]);
const showTime='2026-11-21T18:00:00+01:00';
const localDate=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw'});
const localHour=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw',hour:'2-digit',hourCycle:'h23'});
export const previewReminderDay=now=>localDate.format(now);
export const canSendPreviewReminder=now=>dispatchHours.get(previewReminderDay(now))===localHour.format(now);

export function screeningReminderHtml({time,heading,introduction,entry,ticketLink,releaseLink,ticketLabel,posterLink}) {
 const booking=escapeHtml(ticketLink);
 const release=escapeHtml(releaseLink);
 const poster=escapeHtml(posterLink);
 const display="font-family:Oswald,'Arial Narrow',Arial,sans-serif";
 const button=display+';display:inline-block;padding:12px 22px;color:#221509;text-decoration:none;font-size:18px;font-weight:600';
 return `<!doctype html><html lang="pl"><head><meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 <style>@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@300;400;500;600&display=swap');</style>
 </head><body style="margin:0;background:#e9e7df">
 <table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#e9e7df"><tr><td align="center" style="padding:14px 8px">
 <table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#111b16" style="max-width:640px;background:#111b16;border:1px solid #8b7856;color:#eee9de">
 <tr><td>
 <table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#14221b" style="table-layout:fixed;background:#14221b">
 <tr><td width="48%" valign="middle"><img width="306" alt="Plakat filmu Goła Zośka 1812" src="${poster}" style="display:block;width:100%;max-width:306px;height:auto;border:0"></td>
 <td width="52%" valign="middle" style="padding:16px;${display};color:#eee9de">
 <p style="margin:0 0 12px;color:#ccb68c;font-size:12px;letter-spacing:1px">${heading}</p>
 <p style="margin:0 0 14px;font-size:24px;line-height:1.2;font-weight:500">DO ZOBACZENIA<br>W SOBOTĘ</p>
 <p style="margin:0;color:#e7d4b1;font-size:44px;line-height:1.15;font-weight:500">21</p>
 <p style="margin:0;color:#e7d4b1;font-size:16px">LISTOPADA 2026</p>
 <p style="margin:6px 0 12px;font-size:30px;line-height:1.25;font-weight:500">${time}</p>
 <p style="margin:0;color:#ccb68c;font-size:13px;letter-spacing:1px">AUGUSTÓW</p>
 <p style="margin:4px 0 0;font-size:14px;line-height:1.45">Sala widowiskowa MDK<br>Rynek Zygmunta Augusta 9<br>Wejście od ul. Kościelnej<br>II piętro</p>
 </td></tr></table></td></tr>
 <tr><td style="padding:26px 24px 22px;border-top:1px solid #8b7856;color:#eee9de;font:16px/1.6 Arial,sans-serif">
 <p style="margin:0 0 15px">Dzień dobry,</p>
 <p style="margin:0 0 15px">${introduction}</p>
 <p style="margin:0 0 18px">${entry}</p>
 <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 18px"><tr><td bgcolor="#cfba91"><a href="${booking}" style="${button};background:#cfba91">${ticketLabel}</a></td></tr></table>
 <p style="margin:0">Do zobaczenia w sobotę!<br><strong>Zespół filmu „Goła Zośka 1812”</strong></p>
 <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:24px"><tr><td style="border-top:1px solid #5a604a;padding-top:18px">
 <p style="margin:0 0 14px">Jeśli nie możesz przyjść, zwolnij miejsce dla innego widza.</p>
 <table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="#f5a04b"><a href="${release}" style="${button};background:#f5a04b">Zwolnij wejściówkę</a></td></tr></table>
 </td></tr></table></td></tr>
 <tr><td style="padding:14px 24px;border-top:1px solid #5a604a;color:#d0ba8f;${display};font-size:14px"><a href="${escapeHtml(BASE)}" style="color:#d0ba8f">golazoska.com</a> &nbsp;·&nbsp; Miłosna Entertainment</td></tr>
 </table></td></tr></table></body></html>`;
}

export function previewReminderHtml(bookingId,{ticketLink,releaseLink}={}) {
 const booking=BASE+'/dodatkowy-seans.html?oferta='+encodeURIComponent(bookingId);
 return screeningReminderHtml({
  time:'18:00',
  heading:'POKAZ PRZEDPREMIEROWY',
  introduction:'Przypominamy o sobotnim pokazie filmu „Goła Zośka 1812”. Po seansie zapraszamy na krótkie spotkanie z twórcami.',
  entry:'Przy wejściu pokaż wejściówkę z telefonu.',
  ticketLink:ticketLink??booking,
  releaseLink:releaseLink??booking,
  ticketLabel:'Pokaż wejściówkę',
  posterLink:BASE+'/images/plakat-gola-zoska-21-listopada.jpg'
 });
}

export async function sendPreviewReminders(db,now=new Date(),pauseMs=550) {
 if(!canSendPreviewReminder(now))return null;
 const day=previewReminderDay(now);
 const result={day,eligible:0,alreadySent:0,sent:0,failed:0};
 await db`ALTER TABLE additional_screening_bookings
  ADD COLUMN IF NOT EXISTS preview_reminder_dates date[] NOT NULL DEFAULT '{}'`;
 const bookings=await db`SELECT DISTINCT ON (lower(trim(b.email))) b.id,trim(b.email) AS email,
  ${day}::date=ANY(b.preview_reminder_dates) AS sent
  FROM additional_screening_bookings b JOIN additional_screenings s ON b.screening_id=s.id
  WHERE s.id=1 AND s.starts_at=${showTime}::timestamptz AND s.starts_at>${now.toISOString()}::timestamptz
   AND b.status='confirmed' AND trim(b.email) LIKE '%_@_%._%'
   AND lower(trim(b.email)) NOT LIKE '%@example.invalid'
  ORDER BY lower(trim(b.email)),(${day}::date=ANY(b.preview_reminder_dates)) DESC,b.id`;
 result.eligible=bookings.length;
 for(const booking of bookings){
  if(booking.sent){result.alreadySent++;continue;}
  try{
   const [active]=await db`SELECT 1 AS active FROM additional_screening_bookings
    WHERE id=${booking.id}::uuid AND status='confirmed' AND NOT (${day}::date=ANY(preview_reminder_dates))`;
   if(!active)continue;
   const mailId=await sendMail(booking.email,'Goła Zośka 1812 — przypomnienie o pokazie 21 listopada o 18:00',
    previewReminderHtml(booking.id),[],`preview-reminder/${day}/${booking.id}`);
   if(!mailId)throw Error('MAIL_UNCONFIRMED');
   await db`UPDATE additional_screening_bookings
    SET preview_reminder_dates=array_append(preview_reminder_dates,${day}::date)
    WHERE id=${booking.id}::uuid AND NOT (${day}::date=ANY(preview_reminder_dates))`;
   result.sent++;
  }catch{result.failed++;}
  if(pauseMs)await delay(pauseMs);
 }
 console.info('Goła Zośka 18:00 reminder',JSON.stringify(result));
 return result;
}
