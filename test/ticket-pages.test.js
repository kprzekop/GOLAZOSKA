import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const id='a59e1426-4378-49fd-b1f5-4eb5934408c1';
const settle=()=>new Promise(r=>setTimeout(r,35));
test('strona widza pokazuje osobne kody i przycisk wydruku',async()=>{
 const html=await readFile(new URL('../wejsciowki.html',import.meta.url),'utf8');
 const dom=new JSDOM(html,{url:'https://www.golazoska.com/wejsciowki.html?token='+id,runScripts:'dangerously',beforeParse(w){
 w.fetch=async()=>({ok:true,json:async()=>({tickets:[{id,person:1,seat:'6-1',used:false},{id:'0aa27b88-8939-4173-879d-af6f46813daa',person:2,seat:'6-2',used:false}]})});
 }});try{await settle();const d=dom.window.document;assert.equal(d.querySelectorAll('.ticket img').length,2);assert.match(d.querySelector('.ticket').textContent,/Rząd 6, miejsce 1/);assert.equal(d.getElementById('print').hidden,false);}
 finally{dom.window.close();}
});
test('obsługa: logowanie, ręczny odczyt, osobne zatwierdzenie i wynik już wykorzystany',async()=>{
 const html=await readFile(new URL('../kontrola.html',import.meta.url),'utf8');let entered=false,posts=0;
 const dom=new JSDOM(html,{url:'https://www.golazoska.com/kontrola.html',runScripts:'dangerously',beforeParse(w){
 w.HTMLCanvasElement.prototype.getContext=()=>({});
 w.fetch=async(url,options)=>{
 assert.equal(options.headers.Authorization,'Bearer door-test');
 const body=options.body?JSON.parse(options.body):{};
 if(options.method==='POST'){posts++;if(body.action==='enter')entered=true;}
 return {ok:true,status:200,json:async()=>options.method==='GET'?{tickets:[]}:{result:entered?'entered':'valid',guest_name:'Jan Kowalski',person_no:1,seat_id:'6-1'}};
 };
 }});try{
 const d=dom.window.document;d.getElementById('password').value='door-test';d.getElementById('login').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await settle();
 assert.equal(d.getElementById('panel').hidden,false);
 d.getElementById('ticketNumber').value=id;d.getElementById('manual').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await settle();
 assert.equal(entered,false);assert.equal(posts,1);assert.match(d.getElementById('verdict').textContent,/WAŻNA/);assert.equal(d.getElementById('enter').hidden,false);
 d.getElementById('enter').click();await settle();assert.equal(entered,true);assert.equal(d.getElementById('verdict').textContent,'WPUSZCZONO');
 d.getElementById('logout').click();assert.equal(d.getElementById('panel').hidden,true);assert.equal(dom.window.localStorage.length,0);
 }finally{dom.window.close();}
});
