/* ADHDBP Control Panel — background reminder Worker (Phase 2)
   - POST /subscribe : saves a phone's push subscription
   - cron (every minute): reads tasks from Firebase, finds anything due,
     and sends a silent push so the phone's service worker shows it —
     even when the app is fully closed.

   Set these in the Worker's Settings → Variables:
     FB_URL          = https://adhd-bipolar-organization-default-rtdb.firebaseio.com
     VAPID_SUBJECT   = mailto:you@example.com   (your email)
     VAPID_PUBLIC    = (the public key)
     VAPID_PRIVATE   = (the private key, mark as "encrypt"/secret)
   And bind a KV namespace named: SUBS
*/

const FB_PATH = "td_k9m4x7qz2p";

/* ---- Work Task Board proxy (credentials live here as encrypted secrets, not in the public app) ---- */
let bTok="", bRef="", bExp=0;
async function boardAuth(env){
  if(!env.BOARD_API_KEY || !env.BOARD_EMAIL || !env.BOARD_PASSWORD) return false;
  if(bTok && Date.now()<bExp-60000) return true;
  try{
    if(bRef){
      const r=await fetch("https://securetoken.googleapis.com/v1/token?key="+env.BOARD_API_KEY,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:"grant_type=refresh_token&refresh_token="+encodeURIComponent(bRef)});
      if(r.ok){ const j=await r.json(); bTok=j.id_token; bRef=j.refresh_token; bExp=Date.now()+(parseInt(j.expires_in,10)||3600)*1000; return true; }
    }
    const r=await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key="+env.BOARD_API_KEY,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:env.BOARD_EMAIL,password:env.BOARD_PASSWORD,returnSecureToken:true})});
    if(r.ok){ const j=await r.json(); bTok=j.idToken; bRef=j.refreshToken; bExp=Date.now()+(parseInt(j.expiresIn,10)||3600)*1000; return true; }
  }catch(e){}
  bTok=""; return false;
}
function boardBase(env){ return (env.BOARD_URL||"").replace(/\/$/,"")+"/"+(env.BOARD_PATH||"steves_taskboard"); }

function b64urlToBytes(s){ s=s.replace(/-/g,"+").replace(/_/g,"/"); while(s.length%4)s+="="; const bin=atob(s); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i); return u; }
function bytesToB64url(b){ const u=new Uint8Array(b); let s=""; for(let i=0;i<u.length;i++)s+=String.fromCharCode(u[i]); return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
function subKey(endpoint){ return "sub:"+bytesToB64url(new TextEncoder().encode(endpoint)); }

async function importVapidKey(pub, priv){
  const pb=b64urlToBytes(pub);
  const x=bytesToB64url(pb.slice(1,33)), y=bytesToB64url(pb.slice(33,65));
  return crypto.subtle.importKey("jwk",{kty:"EC",crv:"P-256",x,y,d:priv,ext:true},{name:"ECDSA",namedCurve:"P-256"},false,["sign"]);
}
async function vapidHeaders(endpoint, env){
  const aud=new URL(endpoint).origin;
  const header={typ:"JWT",alg:"ES256"};
  const payload={aud,exp:Math.floor(Date.now()/1000)+43200,sub:env.VAPID_SUBJECT||"mailto:you@example.com"};
  const enc=o=>bytesToB64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned=enc(header)+"."+enc(payload);
  const key=await importVapidKey(env.VAPID_PUBLIC, env.VAPID_PRIVATE);
  const sig=await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},key,new TextEncoder().encode(unsigned));
  const jwt=unsigned+"."+bytesToB64url(new Uint8Array(sig));
  return { "Authorization":"vapid t="+jwt+", k="+env.VAPID_PUBLIC, "TTL":"1800", "Urgency":"high" };
}
async function sendPush(sub, env){
  try{
    const headers=await vapidHeaders(sub.endpoint, env);
    const r=await fetch(sub.endpoint,{method:"POST",headers});
    if(r.status===404||r.status===410){ await env.SUBS.delete(subKey(sub.endpoint)); }
    return r.status;
  }catch(e){ return 0; }
}

async function runReminders(env, force){
  const fb=(env.FB_URL||"").replace(/\/$/,"");
  if(!fb) return;
  let cfg=null; try{ const cfgRaw=await env.SUBS.get("config"); cfg=cfgRaw?JSON.parse(cfgRaw):null; }catch(e){}
  // Quiet hours: skip sending overnight (so due tasks wait until morning rather than buzzing at 3am).
  if(!force && cfg && cfg.quiet && typeof cfg.start==="number" && typeof cfg.end==="number"){
    if(inQuiet(localHour(cfg.tz||"UTC"), cfg.start, cfg.end)) return;
  }
  const res=await fetch(fb+"/"+FB_PATH+".json");
  if(!res.ok) return;
  const data=await res.json();
  const tasks=Array.isArray(data)?data:(data?Object.values(data):[]);
  const now=Date.now();
  // Morning summary: once a day at the chosen local hour, drop a signal and ping all devices.
  let summaryPing=false;
  if(!force && cfg && cfg.summary && cfg.summary.on && typeof cfg.summary.hour==="number"){
    try{
      const tz=cfg.tz||"UTC"; const h=localHour(tz);
      const dayKey=new Intl.DateTimeFormat("en-CA",{timeZone:tz}).format(new Date()); // YYYY-MM-DD local
      if(h===cfg.summary.hour){
        const seen=await env.SUBS.get("summary:"+dayKey);
        if(!seen){
          await env.SUBS.put("summary:"+dayKey,"1",{expirationTtl:172800});
          await fetch(fb+"/_summary.json",{method:"PUT",body:JSON.stringify({ms:now})});
          summaryPing=true;
        }
      }
    }catch(e){}
  }
  // Each task can ping at its reminder time and at each deadline lead-time.
  const dueIds=new Set();
  let newlyDue=false;
  for(const t of tasks){
    if(!t || t.deleted || t.status==="done") continue;
    const times=[];
    if(t.dueMs && t.dueMs<=now) times.push(t.dueMs);
    if(Array.isArray(t.remindMs)) for(const ms of t.remindMs){ if(ms<=now) times.push(ms); }
    if(!times.length) continue;
    dueIds.add(t.id);
    for(const ms of times){
      const k="pushed:"+t.id+":"+ms;
      const prev=await env.SUBS.get(k);
      if(force || !prev){ newlyDue=true; await env.SUBS.put(k,"1",{expirationTtl:1209600}); }
    }
  }
  const due=tasks.filter(t=>t && dueIds.has(t.id));
  if(newlyDue || force || summaryPing){
    const list=await env.SUBS.list({prefix:"sub:"});
    for(const key of list.keys){
      const v=await env.SUBS.get(key.name);
      if(!v) continue;
      try{ await sendPush(JSON.parse(v), env); }catch(e){}
    }
  }
  // SMS fallback: text once if a task is STILL due and untouched after the grace period.
  if(cfg && cfg.sms && cfg.sms.on && cfg.sms.webhook && cfg.sms.phone){
    const graceMs=(cfg.sms.graceMin||10)*60000;
    for(const t of due){
      if(now - t.dueMs < graceMs) continue;                 // not past grace yet
      if(t.updatedAt && t.updatedAt >= t.dueMs) continue;    // she acted on it after it came due → handled
      const k="smsed:"+t.id;
      const prev=await env.SUBS.get(k);
      if(prev===String(t.dueMs)) continue;                   // already texted for this due time
      await env.SUBS.put(k, String(t.dueMs), {expirationTtl:1209600});
      try{
        await fetch(cfg.sms.webhook, {method:"POST", headers:{"Content-Type":"application/json"},
          body:JSON.stringify({ phone:cfg.sms.phone, message:"Reminder: "+(t.title||"task")+" — still on your list." })});
      }catch(e){}
    }
  }
}
function localHour(tz){ try{ let h=parseInt(new Intl.DateTimeFormat("en-US",{timeZone:tz,hour:"numeric",hour12:false}).format(new Date())); if(h===24)h=0; return h; }catch(e){ return new Date().getUTCHours(); } }
function inQuiet(h,start,end){ if(start===end) return false; return start<end ? (h>=start && h<end) : (h>=start || h<end); }

export default {
  async fetch(req, env){
   try{
    const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type"};
    if(req.method==="OPTIONS") return new Response(null,{headers:cors});
    const url=new URL(req.url);
    if(url.pathname==="/subscribe" && req.method==="POST"){
      let sub; try{ sub=await req.json(); }catch(e){ return new Response("bad json",{status:400,headers:cors}); }
      if(!sub || !sub.endpoint) return new Response("no endpoint",{status:400,headers:cors});
      await env.SUBS.put(subKey(sub.endpoint), JSON.stringify(sub));
      return new Response(JSON.stringify({ok:true}),{headers:{...cors,"Content-Type":"application/json"}});
    }
    if(url.pathname==="/count" && req.method==="GET"){
      const list=await env.SUBS.list({prefix:"sub:"}); const hosts=[];
      for(const k of list.keys){ const v=await env.SUBS.get(k.name); if(v){ try{ hosts.push(new URL(JSON.parse(v).endpoint).host); }catch(e){} } }
      return new Response(JSON.stringify({subscriptions:hosts.length, hosts}, null, 2),{headers:{...cors,"Content-Type":"application/json"}});
    }
    if(url.pathname==="/breakdown" && req.method==="POST"){
      if(!env.ANTHROPIC_API_KEY) return new Response(JSON.stringify({error:"no_key"}),{status:400,headers:{...cors,"Content-Type":"application/json"}});
      let body; try{ body=await req.json(); }catch(e){ return new Response(JSON.stringify({error:"bad"}),{status:400,headers:{...cors,"Content-Type":"application/json"}}); }
      const title=String(body.title||"").slice(0,300); const notes=String(body.notes||"").slice(0,600);
      const prompt="Break this task into 3 to 6 small, concrete, physical next-steps that someone with ADHD could start immediately. Each step: short (a few words), starts with a verb, one single action, in order. Task: \""+title+"\""+(notes?("\nContext: "+notes):"")+"\n\nReturn ONLY a JSON array of strings and nothing else.";
      try{
        const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
          headers:{"x-api-key":env.ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"},
          body:JSON.stringify({model:(env.ANTHROPIC_MODEL||"claude-haiku-4-5-20251001"),max_tokens:400,messages:[{role:"user",content:prompt}]})});
        const j=await r.json();
        let text=""; if(j && Array.isArray(j.content)) text=j.content.filter(b=>b.type==="text").map(b=>b.text).join("");
        let steps=[]; try{ const m=text.match(/\[[\s\S]*\]/); steps=JSON.parse(m?m[0]:text); }
        catch(e){ steps=text.split("\n").map(s=>s.replace(/^[-*\d.\)\s]+/,"").trim()).filter(Boolean); }
        steps=(Array.isArray(steps)?steps:[]).map(s=>String(s).trim()).filter(Boolean).slice(0,8);
        return new Response(JSON.stringify({steps}),{headers:{...cors,"Content-Type":"application/json"}});
      }catch(e){ return new Response(JSON.stringify({error:"failed"}),{status:500,headers:{...cors,"Content-Type":"application/json"}}); }
    }
    if(url.pathname==="/board/tasks" && req.method==="GET"){
      const ok=await boardAuth(env);
      if(!ok) return new Response(JSON.stringify({error:"board_auth"}),{status:400,headers:{...cors,"Content-Type":"application/json"}});
      const r=await fetch(boardBase(env)+"/tasks.json?auth="+encodeURIComponent(bTok),{cache:"no-store"});
      if(!r.ok) return new Response(JSON.stringify({error:"board_fetch"}),{status:502,headers:{...cors,"Content-Type":"application/json"}});
      const data=await r.json();
      return new Response(JSON.stringify({tasks:data?Object.values(data):[]}),{headers:{...cors,"Content-Type":"application/json"}});
    }
    if(url.pathname==="/board/complete" && req.method==="POST"){
      let body; try{ body=await req.json(); }catch(e){ return new Response("bad json",{status:400,headers:cors}); }
      if(!body || !body.id) return new Response("no id",{status:400,headers:cors});
      const ok=await boardAuth(env);
      if(!ok) return new Response(JSON.stringify({error:"board_auth"}),{status:400,headers:{...cors,"Content-Type":"application/json"}});
      const u=boardBase(env)+"/tasks/"+encodeURIComponent(body.id)+".json?auth="+encodeURIComponent(bTok);
      const r=await fetch(u,{cache:"no-store"});
      if(!r.ok) return new Response(JSON.stringify({error:"board_fetch"}),{status:502,headers:{...cors,"Content-Type":"application/json"}});
      const t=await r.json();
      if(!t) return new Response(JSON.stringify({error:"not_found"}),{status:404,headers:{...cors,"Content-Type":"application/json"}});
      t.status="done"; t.updatedAt=Date.now();
      t.activity=Array.isArray(t.activity)?t.activity:[]; t.activity.push({by:(body.by||"Kelly"), ts:Date.now(), text:"completed (via ADHDBP)"});
      const w=await fetch(u,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(t)});
      return new Response(JSON.stringify({ok:w.ok}),{status:w.ok?200:502,headers:{...cors,"Content-Type":"application/json"}});
    }
    if(url.pathname==="/config" && req.method==="POST"){
      let cfg; try{ cfg=await req.json(); }catch(e){ return new Response("bad json",{status:400,headers:cors}); }
      await env.SUBS.put("config", JSON.stringify(cfg));
      return new Response(JSON.stringify({ok:true}),{headers:{...cors,"Content-Type":"application/json"}});
    }
    if(url.pathname==="/test" && (req.method==="POST" || req.method==="GET")){
      const list=await env.SUBS.list({prefix:"sub:"}); const results=[];
      for(const k of list.keys){ const v=await env.SUBS.get(k.name); if(!v) continue;
        let sub; try{ sub=JSON.parse(v); }catch(e){ continue; }
        const status=await sendPush(sub, env);
        let host="?"; try{ host=new URL(sub.endpoint).host; }catch(e){}
        results.push({host, status});
      }
      return new Response(JSON.stringify({sent:results.length, results}, null, 2),{headers:{...cors,"Content-Type":"application/json"}});
    }
    return new Response("ADHDBP push worker is running.",{headers:cors});
   }catch(err){
    return new Response("Worker error: "+((err&&err.message)||String(err)),{status:500,headers:{"Access-Control-Allow-Origin":"*"}});
   }
  },
  async scheduled(event, env, ctx){ ctx.waitUntil(runReminders(env, false)); }
};
