import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LinkStore } from "../src/store.ts";
import { IntakeStore, intakeIdentity } from "../src/intake-store.ts";
import { ConversationStore } from "../src/conversation-store.ts";
import { FollowUpStore, runFollowUps } from "../src/follow-ups.ts";
import { EmailStore, GMAIL_SCOPE, emailConfig, gmailNotices } from "../src/email.ts";
import { createEngagementApi } from "../src/engagement-api.ts";
import { createMessageHandler } from "../src/assistant.ts";
const DAY=86400000,origin="http://localhost:8000",phone="+12015550123";
function harness(t:TestContext) {
  let time=Date.now();const now=()=>time;
  const dir=mkdtempSync(join(tmpdir(),"moretime-engagement-")),path=join(dir,"test.sqlite");
  const links=new LinkStore(path,now),intakes=new IntakeStore(path,now),followUps=new FollowUpStore(path,now),emails=new EmailStore(path,Buffer.alloc(32,1),now),conversations=new ConversationStore(path);
  const identity=intakeIdentity(),challenge=links.issue(identity.userId,phone);
  intakes.save(identity,challenge.expiresAt,{address:phone,details:"Overdue bill",zipCode:"07102",state:null,bill:null});
  const connect=()=>links.prepareReply({id:"connect",sender:phone,spaceId:"dm:test",line:"shared",text:`CONNECT ${challenge.code}`});
  const config={clientId:"test",clientSecret:"secret",redirectUri:"http://localhost:8080/api/email/callback",key:Buffer.alloc(32,1)};
  let googleCalls=0;
  const fetcher:typeof fetch=async(input,init)=>{
    googleCalls++;
    if(String(input).includes("/token")){assert.equal(new URLSearchParams(String(init?.body)).get("grant_type"),"authorization_code");return Response.json({access_token:"access",refresh_token:"refresh-private",scope:GMAIL_SCOPE});}
    return Response.json({emailAddress:"test@example.com"});
  };
  const api=createEngagementApi({intakes,links,followUps,emails,config,allowedOrigins:[origin],fallback:async()=>new Response(null,{status:404}),fetcher});
  const request=(path:string,method="GET",body?:unknown,from=origin)=>new Request(`http://localhost:8080${path}`,{method,headers:{origin:from,authorization:`Bearer ${identity.accessToken}`,...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});
  t.after(()=>{conversations.close();emails.close();followUps.close();intakes.close();links.close();rmSync(dir,{recursive:true,force:true});});
  return {links,intakes,followUps,emails,conversations,identity,connect,api,request,path,now,advance:(ms:number)=>time+=ms,calls:()=>googleCalls};
}
test("check-in approval requires a verified number, explicit consent and a bounded schedule",async t=>{
  const h=harness(t),body={consent:true,nextAt:new Date(h.now()+DAY).toISOString()};
  assert.equal((await h.api(h.request("/api/follow-ups","POST",body))).status,401);
  h.connect();
  assert.equal((await h.api(h.request("/api/follow-ups","POST",body,"https://evil.test"))).status,403);
  assert.equal((await h.api(h.request("/api/follow-ups","POST",{...body,consent:false}))).status,400);
  assert.equal((await h.api(h.request("/api/follow-ups","POST",{...body,nextAt:new Date(h.now()+31*DAY).toISOString()}))).status,400);
  assert.equal((await h.api(h.request("/api/follow-ups","POST",body))).status,200);
  assert.equal(h.followUps.status(h.identity.userId).enabled,true);
  await h.api(h.request("/api/follow-ups","DELETE"));assert.equal(h.followUps.status(h.identity.userId).enabled,false);
});
test("check-ins survive restart and overdue schedules deliver once without ambiguous retries",async t=>{
  const h=harness(t);h.connect();h.followUps.approve(h.identity.userId,h.now()+DAY);h.advance(3*DAY);
  const restarted=new FollowUpStore(h.path,h.now);t.after(()=>restarted.close());
  let sends=0;
  await runFollowUps({followUps:restarted,links:h.links,send:async()=>{sends++;throw new Error("delivery ambiguous");}});
  await runFollowUps({followUps:h.followUps,links:h.links,send:async()=>{sends++;}});
  assert.equal(sends,1);
  const db=new DatabaseSync(h.path);assert.equal(db.prepare("SELECT status FROM follow_up_attempts").get()?.status,"uncertain");db.close();
  h.advance(7*DAY);await runFollowUps({followUps:h.followUps,links:h.links,send:async()=>{sends++;}});assert.equal(sends,2);
  h.followUps.pause(h.identity.userId);h.advance(7*DAY);assert.deepEqual(h.followUps.claim(),[]);
});
test("snooze suppresses mail alerts and 90-day approval expires",t=>{
  const h=harness(t);h.followUps.approve(h.identity.userId,h.now()+DAY);
  assert.equal(h.followUps.emailAlertsEnabled(h.identity.userId),true);
  h.followUps.snooze(h.identity.userId,7);assert.equal(h.followUps.emailAlertsEnabled(h.identity.userId),false);
  h.advance(7*DAY);assert.equal(h.followUps.emailAlertsEnabled(h.identity.userId),true);
  h.advance(90*DAY);assert.equal(h.followUps.status(h.identity.userId).enabled,false);assert.deepEqual(h.followUps.claim(),[]);
});
test("OAuth uses browser-bound, single-use state, PKCE and encrypted offline credentials",async t=>{
  const h=harness(t);h.connect();
  assert.equal((await h.api(h.request("/api/email/connect","POST",{consent:false}))).status,400);
  const start=await h.api(h.request("/api/email/connect","POST",{consent:true}));assert.equal(start.status,200);
  const auth=new URL((await start.json()).authorizationUrl),state=auth.searchParams.get("state")!;
  assert.equal(auth.searchParams.get("scope"),GMAIL_SCOPE);assert.equal(auth.searchParams.get("code_challenge_method"),"S256");
  assert.match(start.headers.get("set-cookie")!,/HttpOnly; SameSite=Lax/);
  const callback=`http://localhost:8080/api/email/callback?code=test-code&state=${state}`;
  assert.equal((await h.api(new Request(callback))).status,400);assert.equal(h.calls(),0);
  assert.equal((await h.api(new Request(callback,{headers:{cookie:`moretime_email_state=${state}`}}))).status,200);
  assert.equal(h.emails.token(h.identity.userId),"refresh-private");
  const db=new DatabaseSync(h.path);assert.ok(!String(db.prepare("SELECT token FROM email_connections").get()?.token).includes("refresh-private"));db.close();
  assert.equal((await h.api(new Request(callback,{headers:{cookie:`moretime_email_state=${state}`}}))).status,400);
  assert.equal(h.calls(),2);
  await h.api(h.request("/api/email","DELETE"));assert.equal(h.emails.status(h.identity.userId).connected,false);assert.throws(()=>h.emails.token(h.identity.userId));
});
test("expired OAuth and a disconnected user cannot save Gmail credentials",async t=>{
  const h=harness(t);h.connect();
  const start=await h.api(h.request("/api/email/connect","POST",{consent:true}));const state=new URL((await start.json()).authorizationUrl).searchParams.get("state")!;
  h.advance(6*60000);
  assert.equal((await h.api(new Request(`http://localhost:8080/api/email/callback?code=x&state=${state}`,{headers:{cookie:`moretime_email_state=${state}`}}))).status,400);assert.equal(h.calls(),0);
  h.links.disconnect(h.identity.userId);assert.equal((await h.api(h.request("/api/email"))).status,401);
});
test("new-mail searches are time-bounded and reservations limit alerts and duplicates",async t=>{
  const h=harness(t);h.emails.connect(h.identity.userId,"test@example.com","refresh");
  const fetcher:typeof fetch=async input=>{
    if(String(input).includes("/token"))return Response.json({access_token:"access"});
    const q=new URL(String(input)).searchParams.get("q")!;assert.match(q,/after:/);assert.match(q,/newer_than:7d/);
    return Response.json({messages:[{id:"notice1"},{id:"notice2"}]});
  };
  const config={clientId:"id",clientSecret:"secret",redirectUri:"http://localhost:8080/api/email/callback",key:Buffer.alloc(32,1)};
  const ids=await gmailNotices(config,h.emails,h.identity.userId,h.now(),fetcher);assert.equal(ids.length,2);
  assert.equal(h.emails.reserve(h.identity.userId,ids),true);assert.equal(h.emails.reserve(h.identity.userId,["notice3"]),false);
  assert.deepEqual(await gmailNotices(config,h.emails,h.identity.userId,h.now(),fetcher),[]);
  h.advance(DAY);assert.equal(h.emails.reserve(h.identity.userId,["notice3"]),true);
});
test("Messages controls work without Gemini and STOP removes both integrations",async t=>{
  const h=harness(t);h.connect();h.followUps.approve(h.identity.userId,h.now()+DAY);h.emails.connect(h.identity.userId,"test@example.com","refresh");
  const handle=createMessageHandler({store:h.links,intakes:h.intakes,conversations:h.conversations,followUps:h.followUps,emails:h.emails});
  const msg=(id:string,text:string)=>({id,sender:phone,spaceId:"dm:test",line:"shared",text});
  assert.match((await handle(msg("snooze","SNOOZE 7"))).reply,/wait 7 days/);assert.equal(h.followUps.emailAlertsEnabled(h.identity.userId),false);
  assert.match((await handle(msg("resolved","RESOLVED"))).reply,/paused/);assert.equal(h.followUps.status(h.identity.userId).enabled,false);
  assert.match((await handle(msg("stop","STOP"))).reply,/disconnected/);assert.equal(h.emails.status(h.identity.userId).connected,false);assert.equal(h.links.connectionForUser(h.identity.userId),undefined);
});
test("email configuration rejects insecure remote callbacks and invalid encryption keys",()=>{
  assert.equal(emailConfig({}),undefined);
  assert.throws(()=>emailConfig({GOOGLE_EMAIL_CLIENT_ID:"id",GOOGLE_EMAIL_CLIENT_SECRET:"secret",GOOGLE_EMAIL_REDIRECT_URI:"http://example.com/api/email/callback",EMAIL_TOKEN_KEY:"00".repeat(32)}));
  assert.throws(()=>emailConfig({GOOGLE_EMAIL_CLIENT_ID:"id",GOOGLE_EMAIL_CLIENT_SECRET:"secret",GOOGLE_EMAIL_REDIRECT_URI:"http://localhost:8080/api/email/callback",EMAIL_TOKEN_KEY:"bad"}));
});

test("OAuth bind links cannot attach a mailbox to a different browser",async t=>{
  const h=harness(t);h.connect();const start=await h.api(h.request("/api/email/connect","POST",{consent:true}));
  const state=new URL((await start.json()).authorizationUrl).searchParams.get("state")!;
  const bind=await h.api(new Request(`http://localhost:8080/api/email/callback?bind=${state}`));
  assert.equal(bind.status,400);assert.equal(bind.headers.get("set-cookie"),null);
  const callback=await h.api(new Request(`http://localhost:8080/api/email/callback?state=${state}&code=test`,{headers:{cookie:"moretime_email_state=another-browser"}}));
  assert.equal(callback.status,400);assert.equal(h.calls(),0);
});
test("malformed engagement payloads fail before approval or OAuth state creation",async t=>{
  const h=harness(t);h.connect();
  for(const path of ["/api/email/connect","/api/follow-ups"]){
    const request=new Request(`http://localhost:8080${path}`,{method:"POST",headers:{origin,authorization:`Bearer ${h.identity.accessToken}`,"content-type":"application/json"},body:"null"});
    assert.equal((await h.api(request)).status,400);
  }
  assert.equal(h.followUps.status(h.identity.userId).enabled,false);
});

test("existing users can reopen settings only after sender-bound management verification",async t=>{
  const h=harness(t);h.connect();
  const before=h.intakes.forConnection(h.identity.userId);
  let welcome="";
  const api=createEngagementApi({intakes:h.intakes,links:h.links,followUps:h.followUps,emails:h.emails,allowedOrigins:[origin],fallback:async()=>new Response(null,{status:404}),transport:{welcome:async(address,text)=>{assert.equal(address,phone);welcome=text;return {messagingAddress:null};}}});
  const issued=await api(h.request("/api/connection/manage","POST",{address:phone,consent:true}));assert.equal(issued.status,201);
  const session=await issued.json();assert.match(welcome,/MANAGE/);
  const statusRequest=()=>new Request("http://localhost:8080/api/connection/manage/status",{headers:{origin,authorization:`Bearer ${session.accessToken}`}});
  assert.equal((await (await api(statusRequest())).json()).status,"pending");
  const emailRequest=()=>new Request("http://localhost:8080/api/email",{headers:{origin,authorization:`Bearer ${session.accessToken}`}});
  assert.equal((await api(emailRequest())).status,401);
  const code=session.messageText.split(" ")[1];assert.equal(h.links.confirmManagement("+12015550999",code),false);
  const handler=createMessageHandler({store:h.links,intakes:h.intakes,conversations:h.conversations,followUps:h.followUps,emails:h.emails});
  assert.match((await handler({id:"manage-reply",sender:phone,spaceId:"dm:test",line:"shared",text:session.messageText})).reply,/management is verified/);
  assert.equal(h.links.confirmManagement(phone,code),false,"a code is single-use");
  assert.equal((await (await api(statusRequest())).json()).status,"connected");assert.equal((await api(emailRequest())).status,200);
  assert.deepEqual(h.intakes.forConnection(h.identity.userId),before,"saved intake is unchanged");
  h.links.disconnect(h.identity.userId);assert.equal((await api(emailRequest())).status,401);
});
test("management sessions expire, replacement codes invalidate pending requests and requests are limited",t=>{
  const h=harness(t);h.connect();
  const first=h.links.issueManagement(phone),second=h.links.issueManagement(phone);
  assert.equal(h.links.confirmManagement(phone,first.code),false);
  assert.equal(h.links.confirmManagement(phone,second.code),true);
  assert.equal(h.links.managementUser(second.accessToken),h.identity.userId);
  h.links.issueManagement(phone);assert.throws(()=>h.links.issueManagement(phone),/Wait five minutes/);
  h.advance(21*60000);assert.equal(h.links.managementStatus(second.accessToken),"expired");assert.equal(h.links.managementUser(second.accessToken),undefined);
  const expired=h.links.issueManagement(phone);h.advance(6*60000);assert.equal(h.links.confirmManagement(phone,expired.code),false);
});
test("management requires outreach consent and revokes verification after failed delivery",async t=>{
  const h=harness(t);h.connect();let sent=0;
  const api=createEngagementApi({intakes:h.intakes,links:h.links,followUps:h.followUps,emails:h.emails,allowedOrigins:[origin],fallback:async()=>new Response(null,{status:404}),transport:{welcome:async()=>{sent++;throw new Error("ambiguous_delivery");}}});
  assert.equal((await api(h.request("/api/connection/manage","POST",{address:phone,consent:false}))).status,400);assert.equal(sent,0);
  assert.equal((await api(h.request("/api/connection/manage","POST",{address:phone,consent:true}))).status,502);assert.equal(sent,1);
  const db=new DatabaseSync(h.path);assert.equal(db.prepare("SELECT COUNT(*) AS count FROM management_sessions").get()?.count,0);db.close();
});
