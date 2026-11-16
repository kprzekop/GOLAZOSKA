import {canSendPreviewReminder,sendPreviewReminders} from '../lib/preview-reminders.js';
import {sendPremiereReminders} from '../lib/premiere-reminders.js';
import {sendTechnicalReminders,technicalReminderWindow} from '../lib/technical-reminders.js';
import {json,sql,tokenValid} from '../lib/shared.js';

export default async function handler(req,res){
 if(req.method!=='GET')return json(res,405,{error:'METHOD'});
 if(!tokenValid((req.headers.authorization||'').replace(/^Bearer /i,''),process.env.CRON_SECRET))
  return json(res,401,{error:'UNAUTHORIZED'});
 if(!process.env.DATABASE_URL||!process.env.RESEND_API_KEY||!process.env.MAIL_FROM)
  return json(res,503,{error:'UNAVAILABLE'});
 const now=new Date();
 const result={};
 let failed=false;
 if(technicalReminderWindow(now)){
  try{result.technicalReminders=await sendTechnicalReminders(now);}
  catch(error){
   console.error('Goła Zośka technical reminder failed',error?.message??'UNKNOWN');
   result.technicalReminders={error:'UNAVAILABLE'};
   failed=true;
  }
 }
 if(!canSendPreviewReminder(now))return json(res,failed?503:200,result);
 const db=sql();
 for(const [name,showtime,send] of [
  ['premiereReminders','19:00',sendPremiereReminders],
  ['previewReminders','18:00',sendPreviewReminders]
 ]){
  try{result[name]=await send(db,now);}
  catch(error){
   console.error('Goła Zośka '+showtime+' reminder failed',error?.code??error?.name??'UNKNOWN');
   result[name]={error:'UNAVAILABLE'};
   failed=true;
  }
 }
 return json(res,failed?503:200,result);
}
