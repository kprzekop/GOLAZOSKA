import test from 'node:test';
import assert from 'node:assert/strict';
import {RESERVATIONS_START,isReservationPeriod} from '../lib/event.js';
test('zapisy zaczynają się dokładnie 5 listopada o godzinie 18:00 czasu polskiego',()=>{
 assert.equal(RESERVATIONS_START,'2026-11-05T18:00:00+01:00');
 assert.equal(isReservationPeriod(new Date('2026-11-05T16:59:59.999Z')),false);
 assert.equal(isReservationPeriod(new Date('2026-11-05T17:00:00.000Z')),true);
 assert.equal(isReservationPeriod(new Date('2026-11-21T17:59:59.999Z')),true);
 assert.equal(isReservationPeriod(new Date('2026-11-21T18:00:00.000Z')),false);
 assert.equal(isReservationPeriod(new Date(NaN)),false);
});
