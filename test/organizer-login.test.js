import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const html=await readFile(new URL('../organizator.html',import.meta.url),'utf8');
async function page({ok=true,credentials=true,storeReject=false}={}){
 const saved=[];
 const dom=new JSDOM(html,{url:'https://www.golazoska.com/organizator.html',runScripts:'dangerously',beforeParse(w){
  w.fetch=async()=>({ok,status:ok?200:401,json:async()=>ok?{reservations:[],seats:[],config:{public_capacity:17,guest_capacity:62,standing_capacity:20,standing_used:0}}:{}});
  if(credentials){
   w.PasswordCredential=class{constructor(form){this.id=form.elements.username.value;this.password=form.elements.password.value;}};
   Object.defineProperty(w.navigator,'credentials',{value:{store:async credential=>{if(storeReject)throw Error('declined');saved.push(credential);}}});
  }
 }});
 dom.window.document.getElementById('key').value='test-password-only';
 dom.window.document.getElementById('auth').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
 await new Promise(resolve=>setTimeout(resolve,30));return {dom,saved};
}
test('menedżer haseł otrzymuje dane dopiero po poprawnym logowaniu',async()=>{
 const {dom,saved}=await page();try{
  const d=dom.window.document;
  assert.equal(d.getElementById('username').autocomplete,'username');
  assert.equal(d.getElementById('key').autocomplete,'current-password');
  assert.equal(d.getElementById('auth').method,'post');
  assert.equal(saved.length,1);assert.equal(saved[0].id,'organizator');assert.equal(saved[0].password,'test-password-only');
  assert.equal(dom.window.localStorage.length,0);assert.equal(dom.window.sessionStorage.length,0);
  d.getElementById('refresh').click();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(saved.length,1);
 }finally{dom.window.close();}
});
test('błędne hasło nie jest przekazywane do zapisania',async()=>{
 const {dom,saved}=await page({ok:false});try{
  assert.equal(saved.length,0);assert.match(dom.window.document.getElementById('status').textContent,/Nieprawidłowe hasło/);
 }finally{dom.window.close();}
});
test('brak obsługi zapisu lub odmowa przeglądarki nie blokuje panelu',async()=>{
 for(const options of [{credentials:false},{storeReject:true}]){
  const {dom}=await page(options);try{
   assert.equal(dom.window.document.getElementById('table').hidden,false);
   assert.equal(dom.window.document.getElementById('status').textContent,'Lista aktualna.');
  }finally{dom.window.close();}
 }
});
