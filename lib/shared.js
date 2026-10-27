import {EVENT_DESCRIPTION,DEADLINE_LABEL,seatLabel} from './event.js';
import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { Resend } from 'resend';

export const BASE = (process.env.PUBLIC_BASE_URL || 'https://www.golazoska.com').replace(/\/$/,'');
export const FROM = process.env.MAIL_FROM || 'Goła Zośka <rezerwacje@golazoska.com>';
export const sql = () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_UNAVAILABLE');
  return neon(process.env.DATABASE_URL);
};
export const json = (res, status, body) => {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  return res.status(status).json(body);
};
export const tokenValid = (received, expected) => {
  if (!expected || !received) return false;
  const a=Buffer.from(received),b=Buffer.from(expected);
  return a.length===b.length && crypto.timingSafeEqual(a,b);
};
export const isAdmin = req => tokenValid((req.headers.authorization || '').replace(/^Bearer /i,''),process.env.ADMIN_TOKEN);
export const confirmUrl = token => `${BASE}/rezerwacja.html?token=${encodeURIComponent(token)}`;
export async function sendMail(to,subject,html) {
  if (!process.env.RESEND_API_KEY) throw new Error('MAIL_UNAVAILABLE');
  const result=await new Resend(process.env.RESEND_API_KEY).emails.send({
    from:FROM,to,subject,html,replyTo:process.env.MAIL_REPLY_TO || undefined
  });
  if (result.error) {
    // Log provider diagnostics without email addresses, tokens, or message contents.
    const message=String(result.error.message||'')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]')
      .replace(/re_[A-Za-z0-9_-]+/g,'[key]')
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,'[token]')
      .slice(0,400);
    console.error('Mail delivery rejected',JSON.stringify({
      code:result.error.name,status:result.error.statusCode,message
    }));
    throw new Error('MAIL_REJECTED');
  }
}
export const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[ch]));
export const admissionLabel=kind=>({seated:'miejsce siedzące',standing:'wejście bez gwarancji fotela – udział może być na stojąco',waiting:'lista rezerwowa – bez prawa wejścia'}[kind]||kind);
export const actionMail=(name,seats,token,wait=false,ids=[],admission='seated')=>{
 const url=confirmUrl(token),safe=escapeHtml(name);
 const type=wait?'waiting':admission;
 const details=type==='waiting'
 ? '<p>Lista rezerwowa: '+seats+' osób. To zgłoszenie nie uprawnia do wejścia. Jeśli zwolnią się miejsca siedzące lub wejścia bez gwarancji fotela, wyślemy osobną ofertę do przyjęcia.</p>'
 : type==='standing'
 ? '<p>Wejście bez gwarancji fotela: '+seats+' osób. Po potwierdzeniu zgłoszenia zapraszamy na pokaz; udział może odbyć się na stojąco. Nie masz przypisanego miejsca siedzącego. Jeśli zwolnią się fotele, najpierw zaproponujemy je osobom z tej puli, zgodnie z kolejnością zgłoszeń i wielkością grupy.</p>'
 : '<p>Bezpłatna rezerwacja: '+escapeHtml(seatLabel(ids))+'.</p>';
 return '<p>Dzień dobry, '+safe+'.</p><p>'+EVENT_DESCRIPTION+'.</p>'+details+
 '<p>Potwierdź adres e-mail w ciągu 24 godzin. Bez potwierdzenia zgłoszenie wygasa.</p>'+
 (type==='waiting'?'':'<p>Potwierdź także udział od 14 listopada godz. 19:00 do '+DEADLINE_LABEL+'. Wyślemy przypomnienie. Brak potwierdzenia zwalnia rezerwację. Weryfikacja e-maila od 14 listopada godz. 19:00 od razu potwierdza udział. Dla zgłoszeń przed terminem końcowym 18 listopada godz. 19:00 jest także granicą weryfikacji e-maila. Późniejsze zgłoszenia wymagają potwierdzenia w 24 godziny, najpóźniej do początku pokazu.</p>')+
 '<p><a href="'+url+'">Potwierdź adres lub zarządzaj zgłoszeniem</a></p>';
};
