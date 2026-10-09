import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationWindow, restoredHistoryScroll } from '../web/src/conversation-window.js';
const rows = Array.from({length: 200}, (_, i) => ({id: String(i)}));
test('long conversations render recent twenty without dropping source records', () => {
 const v = conversationWindow(rows); assert.equal(v.items.length,20); assert.equal(v.items[0].id,'180'); assert.equal(v.olderCount,180); assert.equal(rows.length,200);
});
test('older window survives new replies and scroll anchor stays stable', () => {
 const v=conversationWindow(rows,conversationWindow(rows).previousId); assert.equal(v.items.length,40); assert.equal(v.items[0].id,'160');
 assert.equal(conversationWindow([...rows,{id:'200'}],v.items[0].id).items[0].id,'160'); assert.equal(restoredHistoryScroll(1000,80,1700),780);
});
test('deep links render and missing boundaries recover',()=>{
 assert.equal(conversationWindow(rows,undefined,'5').items[0].id,'5'); assert.equal(conversationWindow(rows,'missing').items.length,20); assert.equal(conversationWindow([]).items.length,0); assert.equal(conversationWindow(rows.slice(0,5)).olderCount,0);
});
