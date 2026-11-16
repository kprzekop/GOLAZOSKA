import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {EVENT_AT} from './event.js';
import {admitted,ticketUrl} from './tickets.js';
import {confirmUrl,sendMail} from './shared.js';
import {canSendPreviewReminder,previewReminderDay,screeningReminderHtml} from './preview-reminders.js';

const posterContentId='plakat-premiery-gola-zoska';
const posterPath=new URL('../images/plakat-gola-zoska-mail.jpg',import.meta.url);

export const premierePosterAttachment=async()=>({filename:'plakat-gola-zoska-1812.jpg',content:await readFile(posterPath),contentId:posterContentId});

export function premiereReminderHtml(token,{ticketLink,releaseLink}={}){
 return screeningReminderHtml({
  time:'19:00',
  heading:'PREMIERA',
  introduction:'Przypominamy o sobotniej premierze filmu „Goła Zośka 1812” w Augustowie. Po seansie zapraszamy na spotkanie z twórcami i dyskusję o filmie.',
  entry:'Przy wejściu pokaż kod QR z wejściówki.',
  ticketLink:ticketLink??ticketUrl(token),
  releaseLink:releaseLink??confirmUrl(token),
  ticketLabel:'Pokaż wejściówki QR',
  posterLink:'cid:'+posterContentId
 });
}

export async function sendPremiereReminders(db,now=new Date(),pauseMs=550){
 if(!canSendPreviewReminder(now)||now>=new Date(EVENT_AT))return null;
 const day=previewReminderDay(now);
 const result={day,eligible:0,alreadySent:0,sent:0,failed:0};
 await db`ALTER TABLE premiere_reservations ADD COLUMN IF NOT EXISTS premiere_reminder_dates date[] NOT NULL DEFAULT '{}'`;
 const bookings=await db`SELECT r.id,r.email,${day}::date=ANY(r.premiere_reminder_dates) AS sent
  FROM premiere_reservations r
  WHERE r.admission IN ('seated','standing')
   AND (r.status='confirmed' OR (r.status='offered' AND r.admission='standing' AND r.offer_previous_status='confirmed'))
   AND r.email LIKE '%_@_%._%' AND lower(r.email) NOT LIKE '%@example.invalid'
  ORDER BY r.created_at,r.id`;
 result.eligible=bookings.length;
 const poster=bookings.some(row=>!row.sent)?await premierePosterAttachment():null;
 for(const booking of bookings){
  if(booking.sent){result.alreadySent++;continue;}
  try{
   const [active]=await db`SELECT email,token,status,admission,offer_previous_status FROM premiere_reservations
    WHERE id=${booking.id}::uuid AND NOT (${day}::date=ANY(premiere_reminder_dates))
      AND email LIKE '%_@_%._%' AND lower(email) NOT LIKE '%@example.invalid'`;
   if(!active||!admitted(active))continue;
   const mailId=await sendMail(active.email,'Goła Zośka 1812 — premiera 21 listopada o 19:00',
    premiereReminderHtml(active.token),[poster],
    `premiere-reminder/${day}/${booking.id}`);
   if(!mailId)throw Error('MAIL_UNCONFIRMED');
   await db`UPDATE premiere_reservations SET premiere_reminder_dates=array_append(premiere_reminder_dates,${day}::date)
    WHERE id=${booking.id}::uuid AND NOT (${day}::date=ANY(premiere_reminder_dates))`;
   result.sent++;
  }catch{result.failed++;}
  if(pauseMs)await delay(pauseMs);
 }
 console.info('Goła Zośka 19:00 reminder',JSON.stringify(result));
 return result;
}
