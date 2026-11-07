import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const html=await readFile(new URL('../dodatkowy-seans.html',import.meta.url),'utf8');
test('opening link never transfers; checkbox and explicit transfer POST required; success disables replay',async()=>{
 const calls=[];
 const dom=new JSDOM(html,{url:'https://www.golazoska.com/dodatkowy-seans.html?oferta=abcdef',runScripts:'dangerously',beforeParse(w){
  w.fetch=async(url,options)=>{calls.push(options);return {ok:true,json:async()=>({status:options?'confirmed':'offered',transfer:true,transferred_at:options?'2026-11-06T12:00:00Z':null,starts_at:'2099-11-21T17:00:00Z',expires_at:'2099-11-08T17:00:00Z',seats:['1-1','1-2'],groupSize:2,plan:[{row:1,number:1,status:'available'},{row:1,number:2,status:'available'}]})};};
 }});
 try{
  await new Promise(r=>setTimeout(r,30));const d=dom.window.document;
  assert.equal(calls.length,1);assert.equal(calls[0],undefined);
  assert.equal(d.getElementById('accept').disabled,true);
  const consent=d.getElementById('consent');consent.checked=true;consent.dispatchEvent(new dom.window.Event('change'));
  const seats=d.querySelectorAll('#choiceMap button');seats[0].click();seats[1].click();
  d.getElementById('accept').click();await new Promise(r=>setTimeout(r,30));
  assert.equal(JSON.parse(calls[1].body).action,'transfer');
  assert.equal(d.getElementById('accept').hidden,true);
  assert.match(d.getElementById('status').textContent,/ważna wejściówka/);
  assert.match(d.getElementById('transferInfo').textContent,/stare wejściówki są nieważne/);
 }finally{dom.window.close();}
});
