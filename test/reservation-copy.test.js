import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const html=await readFile(new URL('../rezerwacje.html',import.meta.url),'utf8');
async function page({open=true,available=20,free=true,now='2026-11-06T12:00:00+01:00'}={}){
 const dom=new JSDOM(html,{url:'https://www.golazoska.com/rezerwacje.html',runScripts:'dangerously',beforeParse(w){
  const RealDate=w.Date;w.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[now]));}static now(){return new RealDate(now).getTime();}};
  w.fetch=async()=>({ok:true,json:async()=>({open,opensAt:open?undefined:'2026-11-05T16:00:00+01:00',overflow:{capacity:20,available},siteKey:'test',seats:[{id:'6-1',row:6,number:1,status:free?'available':'taken'}]})});
 }});
 await new Promise(r=>setTimeout(r,30));return dom;
}
test('przed otwarciem zasady są widoczne, formularz i warianty ukryte',async()=>{
 const dom=await page({open:false,now:'2026-10-28T12:00:00+01:00'});try{
 const d=dom.window.document;assert.ok(d.getElementById('rules').textContent.includes('14 listopada'));
 assert.ok(d.getElementById('form').classList.contains('hidden'));
 assert.match(d.getElementById('availability').textContent,/5 listopada o godzinie 16:00/);
 }finally{dom.window.close();}
});
test('przy wolnych fotelach alternatywa jest schowana; pojawia się na życzenie',async()=>{
 const dom=await page();try{const d=dom.window.document;
 assert.ok(d.getElementById('alternativeChoice').classList.contains('hidden'));
 assert.equal(d.getElementById('standingConsent').required,false);
 assert.doesNotMatch(d.getElementById('availability').textContent,/Zapisy ruszają/);
 d.getElementById('alternative').click();
 assert.ok(!d.getElementById('alternativeChoice').classList.contains('hidden'));
 assert.equal(d.getElementById('waiting').checked,true);
 assert.match(d.getElementById('submit').textContent,/na stojąco/);
 }finally{dom.window.close();}
});
test('wariant odpowiada liczbie dostępnych wejść i wielkości grupy, zgoda jest ponawiana',async()=>{
 const dom=await page({free:false,available:1});try{const d=dom.window.document;
 assert.match(d.getElementById('overflowAvailability').textContent,/bez gwarancji fotela/);
 d.getElementById('standingConsent').checked=true;
 d.getElementById('seats').value='2';d.getElementById('seats').dispatchEvent(new dom.window.Event('change'));
 assert.match(d.getElementById('overflowAvailability').textContent,/Lista rezerwowa nie uprawnia/);
 assert.equal(d.getElementById('standingConsent').checked,false);
 assert.equal(d.getElementById('submit').textContent,'Zapisz na listę rezerwową');
 }finally{dom.window.close();}
});
test('późniejsze zgłoszenie nie pokazuje minionych terminów i wymaga tylko jednego potwierdzenia',async()=>{
 const dom=await page({now:'2026-11-20T20:00:00+01:00'});try{const d=dom.window.document;
 assert.match(d.getElementById('confirmationRule').textContent,/Nie musisz/);
 assert.doesNotMatch(d.getElementById('confirmationRule').textContent,/18 listopada/);
 assert.match(d.getElementById('verificationRule').textContent,/21 listopada/);
 assert.match(d.getElementById('verificationRule').textContent,/19:00/);
 }finally{dom.window.close();}
});
