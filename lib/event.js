export const RESERVATIONS_START='2026-11-05T16:00:00+01:00';
export const EVENT_AT='2026-11-21T19:00:00+01:00';
export const CONFIRM_BY='2026-11-18T19:00:00+01:00';
export const REMIND_FROM='2026-11-14T19:00:00+01:00';
export const EVENT_DESCRIPTION='21 listopada 2026, godz. 19:00 · sala widowiskowa MDK, Rynek Zygmunta Augusta 9, wejście od ul. Kościelnej, II piętro';
export const DEADLINE_LABEL='18 listopada 2026 o godz. 19:00';
export const normalizePhone=value=>String(value||'').replace(/[\s()-]/g,'').replace(/^00/,'+');
export function validateBooking(body){
  const name=String(body.name||'').trim(),email=String(body.email||'').trim().toLowerCase();
  const phone=normalizePhone(body.phone),phoneRepeat=normalizePhone(body.phoneRepeat);
  const seatIds=Array.isArray(body.seatIds)?body.seatIds:[];
  const waiting=body.waiting===true,seats=waiting?Number(body.seats):seatIds.length;
  if(name.length<2||name.length>120||email.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email)
    ||!/^\+?[0-9]{9,15}$/.test(phone)||phone!==phoneRepeat
    ||!Number.isInteger(seats)||seats<1||seats>4||new Set(seatIds).size!==seatIds.length
    ||(waiting&&seatIds.length)||seatIds.some(id=>typeof id!=='string'||!/^([1-7])-([1-9]|1[0-3])$/.test(id)))
    throw Error('INVALID_INPUT');
  return {name,email,phone,seatIds,seats,waiting};
}
export const seatLabel=ids=>ids.map(id=>{const [r,s]=id.split('-');return 'rząd '+r+', miejsce '+s;}).join('; ');

export function isReservationPeriod(now=new Date()){
 const time=now.getTime();
 return time>=new Date(RESERVATIONS_START).getTime()&&time<new Date(EVENT_AT).getTime();
}
