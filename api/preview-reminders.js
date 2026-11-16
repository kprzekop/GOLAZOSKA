import {sendPreviewReminders} from '../lib/preview-reminders.js';
import {json,sql,tokenValid} from '../lib/shared.js';

export default async function handler(req,res){
 if(req.method!=='GET')return json(res,405,{error:'METHOD'});
 if(!tokenValid((req.headers.authorization||'').replace(/^Bearer /i,''),process.env.CRON_SECRET))
  return json(res,401,{error:'UNAUTHORIZED'});
 if(!process.env.DATABASE_URL||!process.env.RESEND_API_KEY||!process.env.MAIL_FROM)
  return json(res,503,{error:'UNAVAILABLE'});
 try{return json(res,200,{previewReminders:await sendPreviewReminders(sql())});}
 catch(error){
  console.error('Goła Zośka 18:00 reminder failed',error?.code??error?.name??'UNKNOWN');
  return json(res,503,{error:'UNAVAILABLE'});
 }
}
