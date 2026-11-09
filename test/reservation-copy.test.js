import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const html=await readFile(new URL('../rezerwacje.html',import.meta.url),'utf8');
test('both old reservation links and preview links lead to 18:00, with no 19:00 application',async()=>{
 for(const suffix of ['', '?kolejne=1']){
  const calls=[];
  const dom=new JSDOM(html,{url:'https://www.golazoska.com/rezerwacje.html'+suffix,runScripts:'dangerously',beforeParse(w){
   w.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.includes('plan=18')?{seats:[{row:1,number:1,status:'available'}]}:{siteKey:'test',admission:'interest'}};};
  }});
  try{
   await new Promise(r=>setTimeout(r,30));const d=dom.window.document;
   assert.ok(!d.getElementById('form').classList.contains('hidden'));
   assert.ok(d.getElementById('premiereOptions').classList.contains('hidden'));
   assert.match(d.querySelector('h1').textContent,/18:00/);
   assert.match(d.getElementById('availability').textContent,/Po rezerwacji wybranych foteli/);
   assert.equal(calls.some(c=>c.url==='/api/status'),false);
   d.querySelector('#previewMap button').click();
   d.getElementById('phone').value=d.getElementById('phoneRepeat').value='600123456';
   d.getElementById('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
   await new Promise(r=>setTimeout(r,30));
   const body=JSON.parse(calls.find(c=>c.options?.method==='POST').options.body);
   assert.equal(body.screeningInterest,true);
  }finally{dom.window.close();}
 }
});
