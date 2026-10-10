import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { Resend } from 'resend';

export const BASE = (process.env.PUBLIC_BASE_URL || 'https://www.golazoska.com').replace(/\/$/,'');
export const FROM = process.env.MAIL_FROM || 'Goła Zośka <premiera@golazoska.com>';
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
  if (result.error) throw new Error(`MAIL_ERROR: ${result.error.message}`);
}
export const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[ch]));
export const actionMail = (name,seats,token,wait=false) => {
  const url=confirmUrl(token),safe=escapeHtml(name);
  return wait
    ? `<p>Dzień dobry, ${safe}.</p><p>Jesteś na liście rezerwowej na premierę „Gołej Zośki 1812” (${seats} ${seats===1?'miejsce':'miejsca'}). Jeśli miejsce się zwolni, wyślemy osobną propozycję. Ta wiadomość nie uprawnia do wejścia.</p><p>Możesz <a href="${url}">sprawdzić lub anulować zgłoszenie</a>.</p>`
    : `<p>Dzień dobry, ${safe}.</p><p>Przyjęliśmy zgłoszenie na ${seats} ${seats===1?'miejsce':'miejsca'} na bezpłatną premierę „Gołej Zośki 1812”, 21 listopada.</p><p><strong><a href="${url}">Sprawdź swój adres e-mail w ciągu 24 godzin</a></strong>, aby utrzymać rezerwację. Przed pokazem poprosimy także o ponowne potwierdzenie udziału do 17 listopada. Miejsca bez potwierdzenia mogą trafić do osób z listy rezerwowej.</p><p>Godzinę i miejsce przekażemy osobno.</p>`;
};
