import QRCode from 'qrcode';
import {BASE,sendMail} from './shared.js';
import {previewReminderHtml} from './preview-reminders.js';
import {premierePosterAttachment,premiereReminderHtml} from './premiere-reminders.js';

const opensAt=new Date('2026-11-16T10:25:00+01:00');
const closesAt=new Date('2026-11-16T12:00:00+01:00');
export const technicalReminderWindow=now=>now>=opensAt&&now<closesAt;

export async function sendTechnicalReminders(now) {
 if(!technicalReminderWindow(now))return null;
 const recipient=process.env.TECH_REMINDER_RECIPIENT_20261116;
 if(!recipient)throw Error('TECHNICAL_RECIPIENT_MISSING');
 const results={};
 for(const [hour,render] of [['18',previewReminderHtml],['19',premiereReminderHtml]]){
  try{
   const ticketLink=BASE+'/proba-wejsciowki.html?pokaz='+hour;
   const releaseLink=ticketLink+'&akcja=zwolnij';
   const contentId='test-qr-'+hour;
   const label='Rząd 32, miejsce 1';
   const qrPayload='Goła Zośka 1812 | TEST | pokaz '+hour+':00 | '+label+' | Wejściówka nieważna';
   const content=await QRCode.toBuffer(qrPayload,{type:'png',width:280,margin:4,errorCorrectionLevel:'M'});
   const attachments=[{filename:'test-qr-'+hour+'00-rzad-32-miejsce-1.png',content,contentId}];
   if(hour==='19')attachments.push(await premierePosterAttachment());
   const sample='<div style="padding:12px;margin:0 0 16px;border:1px solid #c99454">'
    +'<p style="margin:0 0 8px"><strong>TEST TECHNICZNY · '+label+'</strong><br>Próbny kod QR. Wejściówka nieważna.</p>'
    +'<img src="cid:'+contentId+'" width="160" height="160" alt="Próbny QR: '+label+'"></div>';
   const html=render(null,{ticketLink,releaseLink}).replace('<p style="margin:0 0 15px">Dzień dobry,</p>',sample+'<p style="margin:0 0 15px">Dzień dobry,</p>');
   const messageId=await sendMail(recipient,'[TEST] Goła Zośka 1812 — przypomnienie na '+hour+':00',html,attachments,'gola-test-reminder-20261116-'+hour);
   if(!messageId)throw Error('MAIL_UNCONFIRMED');
   results[hour]={accepted:true,messageId};
  }catch(error){results[hour]={accepted:false,error:error?.message??'UNKNOWN'};}
 }
 console.info('Goła Zośka technical reminder',JSON.stringify(results));
 return results;
}
