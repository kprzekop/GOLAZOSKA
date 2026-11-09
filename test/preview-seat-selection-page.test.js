import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const html=await readFile(new URL('../rezerwacje.html',import.meta.url),'utf8');
test('18:00 form selects two available seats and sends their identifiers',async()=>{
 const sent=[];
 const dom=new JSDOM(html,{url:'https://www.golazoska.com/rezerwacje.html?pokaz=18',runScripts:'dangerously',beforeParse(w){
  w.fetch=async(url,options)=>{
   if(options){sent.push(JSON.parse(options.body));return {ok:true,json:async()=>({status:'confirmed',admission:'seated',ticketUrl:'/dodatkowy-seans.html?oferta=test'})};}
   return {ok:true,json:async()=>String(url).includes('plan=18')?
    {seats:[{row:1,number:1,status:'available'},{row:1,number:2,status:'available'},{row:1,number:3,status:'taken'}]}:
    {siteKey:'test'}};
  };
 }});
 try{
  await new Promise(resolve=>setTimeout(resolve,30));
  const d=dom.window.document;
  let buttons=d.querySelectorAll('#previewMap button');
  assert.equal(buttons.length,3);assert.equal(buttons[2].disabled,true);
  buttons[0].click();d.querySelectorAll('#previewMap button')[1].click();
  assert.equal(d.querySelectorAll('#previewMap button[aria-pressed="true"]').length,2);
  for(const [id,value] of Object.entries({name:'Viewer',email:'viewer@example.test',phone:'600123456',phoneRepeat:'600123456'}))d.getElementById(id).value=value;
  d.getElementById('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.deepEqual(sent[0].seatIds,['1-1','1-2']);assert.equal(sent[0].screeningInterest,true);
  assert.match(d.getElementById('message').textContent,/Rezerwacja gotowa/);
 }finally{dom.window.close();}
});
