import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallCaseStore, runCallReminders } from '../src/call-case.ts';
import { LinkStore } from '../src/store.ts';
import { bill, budgetCase, statement } from './structured-fixtures.ts';

function setup(t: TestContext) {
 const dir=mkdtempSync(join(tmpdir(),'call-case-')),path=join(dir,'state.sqlite');
 let now=Date.UTC(2026,9,11,12); const calls=new CallCaseStore(path,()=>now),links=new LinkStore(path);
 const challenge=links.issue('user','+12015550123');
 links.prepareReply({id:'connect',text:`CONNECT ${challenge.code}`,sender:'+12015550123',spaceId:'dm:test',line:'shared'});
 t.after(()=>{calls.close();links.close();rmSync(dir,{recursive:true,force:true});});
 let id=0; const session={bill:bill(),caseState:budgetCase()};
 return {calls,links,path,session,advance:(ms:number)=>now+=ms,cmd:(text:string,user='user')=>calls.command(user,`msg-${++id}`,text,session)!};
}

test('call script uses saved budget and selected bill without claiming verified contact',t=>{
 const h=setup(t);assert.match(h.cmd('CALL'),/30.00 per month/);assert.match(h.cmd('CALL'),/USD 180.00/);
 assert.match(h.calls.command('other','missing','CALL')!,/Share a bill/);
 assert.match(h.calls.command('other','multi','CALL',{bill:bill([statement(),statement({id:'bill_2'})]),caseState:budgetCase()})!,/Choose which bill/);
 assert.match(h.calls.command('other','eob','CALL',{bill:bill([statement({documentType:'eob'})]),caseState:budgetCase()})!,/not a payment demand/);
});
test('multiline reports require confirmation; corrections cancel reminders and retain statement facts',t=>{
 const h=setup(t);assert.match(h.cmd('CALLED $30 monthly\nWritten terms tomorrow'),/CONFIRM CALL/);
 assert.match(h.cmd('REMIND IN 2 MINUTES'),/confirm the call update first/);
 h.cmd('CONFIRM CALL');h.cmd('REMIND IN 2 MINUTES');h.cmd('CALLED Actually $40 monthly');h.advance(180000);
 assert.equal(h.calls.claim().length,0);assert.equal(h.calls.current('user')?.confirmed,0);
 assert.equal(h.session.bill.amountDue,180);assert.match(h.cmd('CALL STATUS'),/Waiting for your confirmation/);
});
test('one-time reminder delivers contextual report without recurring consent and never repeats',async t=>{
 const h=setup(t);h.cmd('CALLED Terms due tomorrow');h.cmd('CONFIRM CALL');h.cmd('REMIND IN 2 MINUTES');h.advance(120000);
 const messages:string[]=[];const run=()=>runCallReminders({calls:h.calls,links:h.links,send:async(c,text)=>{assert.equal(c.user_id,'user');messages.push(text);}});
 await run();await run();assert.equal(messages.length,1);assert.match(messages[0]!,/Terms due tomorrow/);assert.match(h.cmd('CALL STATUS'),/was sent/);
});
test('duplicate receipts survive reopening and do not reset newer reports or extend schedules',t=>{
 const h=setup(t);h.cmd('CALL');h.calls.command('user','schedule','REMIND IN 2 MINUTES',h.session);h.advance(60000);
 const reopened=new CallCaseStore(h.path,()=>Date.UTC(2026,9,11,12,1));
 try {reopened.command('user','schedule','REMIND IN 2 MINUTES',h.session);}finally{reopened.close();}
 h.advance(60000);assert.equal(h.calls.claim().length,1);
 h.calls.command('user','report','CALLED first',h.session);h.cmd('CALLED second');h.calls.command('user','report','CALLED first',h.session);
 assert.equal(h.calls.current('user')?.notes,'second');
});
test('reservations exclude other workers and cancellation prevents delivery',t=>{
 const h=setup(t);h.cmd('CALL');h.cmd('REMIND IN 1 MINUTE');h.advance(60000);const [job]=h.calls.claim();assert.ok(job);
 const second=new CallCaseStore(h.path,()=>Date.UTC(2026,9,11,12,2));try{assert.equal(second.claim().length,0);}finally{second.close();}
 assert.equal(h.calls.isDeliverable('other',job.id),false);h.cmd('REMIND OFF');assert.equal(h.calls.isDeliverable('user',job.id),false);
 h.calls.finish(job.id,'sent');assert.match(h.cmd('CALL STATUS'),/No call follow-up/);
});
test('ambiguous delivery is not retried and logs no private call contents',async t=>{
 const h=setup(t);h.cmd('CALL');h.cmd('REMIND IN 1 MINUTE');h.advance(60000);let sends=0;const logs:string[]=[];
 t.mock.method(console,'error',(s:string)=>logs.push(s));
 const run=()=>runCallReminders({calls:h.calls,links:h.links,send:async()=>{sends++;throw Error('private call contents');}});
 await run();await run();assert.equal(sends,1);assert.match(h.cmd('CALL STATUS'),/not confirmed/);assert.ok(!logs.join('').includes('private call contents'));
});
test('snooze, bounds, disconnection and deletion respect user isolation',async t=>{
 const h=setup(t);h.cmd('CALL');assert.match(h.cmd('REMIND IN 0 MINUTES'),/one minute/);assert.match(h.cmd('REMIND IN 31 DAYS'),/30 days/);
 h.cmd('REMIND IN 1 MINUTE');assert.equal(h.calls.snooze('other',7),false);assert.equal(h.calls.snooze('user',1),true);h.advance(60000);assert.equal(h.calls.claim().length,0);
 h.advance(86400000);h.links.disconnect('user');let sent=false;await runCallReminders({calls:h.calls,links:h.links,send:async()=>{sent=true;}});assert.equal(sent,false);
 h.calls.remove('user');assert.equal(h.calls.current('user'),undefined);
});
