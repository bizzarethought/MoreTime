import type { IntakeStore } from "./intake-store.ts";
import { normalizeAddress } from "./store.ts";
import type { LinkStore } from "./store.ts";
import type { MessagingTransport } from "./api.ts";
import { ApiError } from "./errors.ts";
import { FollowUpStore } from "./follow-ups.ts";
import { EmailStore, GMAIL_SCOPE, googleJson } from "./email.ts";
import type { EmailConfig } from "./email.ts";

export function createEngagementApi(options:{intakes:IntakeStore;links:LinkStore;followUps:FollowUpStore;emails:EmailStore;config?:EmailConfig;allowedOrigins:string[];fallback:(request:Request)=>Promise<Response>;fetcher?:typeof fetch;transport?:MessagingTransport}) {
  return async(request:Request):Promise<Response>=>{
    const url=new URL(request.url),path=url.pathname;
    if(!["/api/follow-ups","/api/email","/api/email/connect","/api/email/callback","/api/connection/manage","/api/connection/manage/status"].includes(path)) return options.fallback(request);
    const headers=new Headers({"Content-Type":"application/json","Cache-Control":"no-store","Vary":"Origin"});
    const json=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers});
    const origin=request.headers.get("origin");
    if(origin&&!options.allowedOrigins.includes(origin))return json(403,{error:"origin_not_allowed"});
    if(origin){headers.set("Access-Control-Allow-Origin",origin);headers.set("Access-Control-Allow-Credentials","true");headers.set("Access-Control-Allow-Methods","GET, POST, DELETE, OPTIONS");headers.set("Access-Control-Allow-Headers","Authorization, Content-Type");}
    if(request.method==="OPTIONS")return new Response(null,{status:204,headers});
    try {
      if(path==="/api/connection/manage") {
        if(request.method!=="POST")return json(405,{error:"method_not_allowed"});
        if(!origin||!request.headers.get("content-type")?.startsWith("application/json"))return json(400,{error:"invalid_request"});
        let body:unknown;
        try{body=await request.json();}catch{return json(400,{error:"invalid_json"});}
        if(!body||typeof body!=="object"||Array.isArray(body)||!("consent" in body)||body.consent!==true||!("address" in body))return json(400,{error:"consent_required"});
        const address=normalizeAddress(body.address);
        if(!/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(address))return json(400,{error:"invalid_address"});
        if(!options.transport)return json(503,{error:"messaging_unavailable"});
        const session=options.links.issueManagement(address);
        try{await options.transport.welcome(address,`You requested to manage your MoreTime connection. Reply MANAGE ${session.code} within 5 minutes, only if you just requested it on the website. This opens Gmail and check-in settings for 20 minutes. Otherwise ignore this message.`);}
        catch{options.links.revokeManagement(session.accessToken);return json(502,{error:"messaging_unavailable"});}
        return json(201,{intakeId:session.intakeId,accessToken:session.accessToken,status:"pending",messageText:`MANAGE ${session.code}`,expiresAt:session.expiresAt});
      }
      if(path==="/api/connection/manage/status") {
        if(request.method!=="GET")return json(405,{error:"method_not_allowed"});
        const token=/^Bearer ([a-f0-9]{64})$/i.exec(request.headers.get("authorization")??"")?.[1];
        const status=token?options.links.managementStatus(token):undefined;
        return status?json(200,{intakeId:"management",status}):json(401,{error:"invalid_token"});
      }
      if(path==="/api/email/callback") {
        if(request.method!=="GET")return json(405,{error:"method_not_allowed"});
        const state=url.searchParams.get("state")??"";
        const cookie=request.headers.get("cookie")?.split(";").map(value=>value.trim()).find(value=>value.startsWith("moretime_email_state="))?.split("=")[1];
        if(!/^[a-f0-9]{64}$/.test(state)||cookie!==state)return json(400,{error:"invalid_state"});
        headers.set("Set-Cookie","moretime_email_state=; Path=/api/email/callback; HttpOnly; SameSite=Lax; Max-Age=0");
        const pending=options.emails.consume(state);
        if(!pending||!options.links.connectionForUser(pending.user_id))return json(400,{error:"expired_state"});
        if(url.searchParams.has("error"))return json(400,{error:"email_permission_declined"});
        if(!options.config)return json(503,{error:"email_unconfigured"});
        const code=url.searchParams.get("code");
        if(!code)return json(400,{error:"missing_code"});
        const config=options.config;
        const tokens=await googleJson("https://oauth2.googleapis.com/token",{method:"POST",body:new URLSearchParams({code,client_id:config.clientId,client_secret:config.clientSecret,redirect_uri:config.redirectUri,grant_type:"authorization_code",code_verifier:pending.verifier})},options.fetcher);
        if(typeof tokens.refresh_token!=="string"||typeof tokens.access_token!=="string"||!String(tokens.scope??"").split(" ").includes(GMAIL_SCOPE))return json(400,{error:"email_permission_required"});
        const profile=await googleJson("https://gmail.googleapis.com/gmail/v1/users/me/profile",{headers:{Authorization:`Bearer ${tokens.access_token}`}},options.fetcher);
        if(typeof profile.emailAddress!=="string")throw new Error("invalid_profile");
        if(!options.links.connectionForUser(pending.user_id))return json(401,{error:"disconnected"});
        options.emails.connect(pending.user_id,profile.emailAddress,tokens.refresh_token);
        headers.set("Content-Type","text/html; charset=utf-8");
        headers.set("Content-Security-Policy","default-src 'none'; frame-ancestors 'none'");
        return new Response("<!doctype html><html lang='en'><title>Gmail connected · MoreTime</title><body><h1>Gmail is connected.</h1><p>You can close this window and return to MoreTime. Payment notice alerts run only while your approved check-ins are enabled. Reply EMAIL OFF in Messages to disconnect Gmail.</p></body></html>",{headers});
      }
      const token=/^Bearer ([a-f0-9]{64})$/i.exec(request.headers.get("authorization")??"")?.[1];
      const userId=token?(options.intakes.connectedUser(token)??options.links.managementUser(token)):undefined;
      if(!userId)return json(401,{error:"verified_connection_required"});
      if(path==="/api/follow-ups") {
        if(request.method==="GET")return json(200,options.followUps.status(userId));
        if(request.method==="DELETE"){options.followUps.pause(userId);return json(200,options.followUps.status(userId));}
        if(request.method==="POST") {
          if(!request.headers.get("content-type")?.startsWith("application/json"))return json(415,{error:"invalid_content_type"});
          let body: unknown;
          try{body=await request.json();}catch{return json(400,{error:"invalid_json"});}
          if(!body||typeof body!=="object"||Array.isArray(body))return json(400,{error:"invalid_body"});
          if(!("consent" in body)||body.consent!==true||!("nextAt" in body)||typeof body.nextAt!=="string")return json(400,{error:"follow_up_consent_required"});
          try{options.followUps.approve(userId,Date.parse(body.nextAt));}catch{return json(400,{error:"invalid_schedule"});}
          return json(200,options.followUps.status(userId));
        }
      }
      if(path==="/api/email") {
        if(request.method==="GET")return json(200,{available:Boolean(options.config),...options.emails.status(userId)});
        if(request.method==="DELETE"){options.emails.remove(userId);return json(200,options.emails.status(userId));}
      }
      if(path==="/api/email/connect"&&request.method==="POST") {
        if(!options.config)return json(503,{error:"email_unconfigured"});
        if(!origin || !request.headers.get("content-type")?.startsWith("application/json"))return json(400,{error:"invalid_request"});
        let body: unknown;
        try{body=await request.json();}catch{return json(400,{error:"invalid_json"});}
        if(!body||typeof body!=="object"||Array.isArray(body))return json(400,{error:"invalid_body"});
        if(!("consent" in body)||body.consent!==true)return json(400,{error:"email_consent_required"});
        const pending=options.emails.start(userId),config=options.config;
        const auth=new URL("https://accounts.google.com/o/oauth2/v2/auth");
        auth.search=new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirectUri,response_type:"code",scope:GMAIL_SCOPE,access_type:"offline",prompt:"consent",state:pending.state,code_challenge:pending.challenge,code_challenge_method:"S256"}).toString();
        const secure=new URL(config.redirectUri).protocol==="https:"?"; Secure":"";
        headers.set("Set-Cookie",`moretime_email_state=${pending.state}; Path=/api/email/callback; HttpOnly; SameSite=Lax; Max-Age=300${secure}`);
        return json(200,{authorizationUrl:auth.href});
      }
      return json(405,{error:"method_not_allowed"});
    }catch(error){if(error instanceof ApiError)return json(error.status,{error:error.code,message:error.message});return json(502,{error:"engagement_unavailable"});}
  };
}
