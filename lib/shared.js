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
export const actionMail=(name,seats,token,wait=false,ids=[])=>{
 const url=confirmUrl(token),safe=escapeHtml(name);
 return '<p>Dzień dobry, '+safe+'.</p><p>'+EVENT_DESCRIPTION+'.</p>'+
 (wait?'<p>Zgłoszenie na listę rezerwową: '+seats+' miejsc. To nie jest rezerwacja miejsc. Potwierdź adres e-mail w ciągu 24 godzin, aby zachować zgłoszenie. Jeśli miejsca się zwolnią, wyślemy ofertę z przydziałem miejsc.</p>':
 '<p>Bezpłatna rezerwacja: '+escapeHtml(seatLabel(ids))+'.</p><p>Potwierdź adres e-mail w ciągu 24 godzin. Dla zgłoszeń złożonych przed '+DEADLINE_LABEL+' obowiązuje również ten ostateczny termin.</p><p>14 listopada poprosimy o potwierdzenie udziału do '+DEADLINE_LABEL+'. Brak potwierdzenia zwalnia miejsca. Potwierdzenie adresu od 14 listopada godz. 19:00 potwierdza także udział. Zgłoszenia złożone po terminie końcowym wymagają potwierdzenia w ciągu 24 godzin, najpóźniej do początku pokazu.</p>')+
 '<p><a href="'+url+'">Potwierdź adres lub zarządzaj zgłoszeniem</a></p>';
};
