import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
export default function handler(req,res){
 if(req.method!=='GET')return res.status(405).end();
 res.setHeader('Content-Type','application/javascript; charset=utf-8');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Cache-Control','public,max-age=86400');
 return res.status(200).send(readFileSync(require.resolve('jsqr'),'utf8'));
}
