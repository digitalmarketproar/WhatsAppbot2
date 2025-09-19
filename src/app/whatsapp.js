// src/app/whatsapp.js
'use strict';
const { default: makeWASocket, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const NodeCache = require('node-cache');
const mongoose = require('mongoose');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const logger = require('../lib/logger');
const { mongoAuthState } = require('../lib/wa-mongo-auth');
const { registerSelfHeal } = require('../lib/selfheal');

const MONGO_URI = process.env.MONGODB_URI || '';
const CREDS_COL = process.env.BAILEYS_CREDS_COLLECTION || 'baileyscreds';
const KEYS_COL = process.env.BAILEYS_KEY_COLLECTION || 'baileyskeys';
const ENABLE_WA_ECHO = String(process.env.ENABLE_WA_ECHO || '') === '1';
const PAIR_NUMBER = process.env.PAIR_NUMBER || null;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_ADMIN_ID = process.env.TELEGRAM_ADMIN_ID || '';

const ONCE_FLAG = path.join('/tmp', 'wipe_baileys_done');

function parseList(v){return String(v||'').split(',').map(s=>s.trim()).filter(Boolean);}

async function tgSendPhoto(pngBuf, caption){
  try{
    if(!TELEGRAM_TOKEN||!TELEGRAM_ADMIN_ID) return;
    const fd=new FormData();
    fd.append('chat_id',TELEGRAM_ADMIN_ID);
    if(caption) fd.append('caption',caption);
    const blob=new Blob([pngBuf],{type:'image/png'});
    fd.append('photo',blob,'wa-qr.png');
    const url=`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`;
    const r=await fetch(url,{method:'POST',body:fd});
    if(!r.ok){const t=await r.text().catch(()=> ''); logger.warn({status:r.status,t},'tgSendPhoto fail');}
  }catch(e){logger.warn({e},'tgSendPhoto err');}
}
async function tgSendText(text){
  try{
    if(!TELEGRAM_TOKEN||!TELEGRAM_ADMIN_ID) return;
    const url=`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:TELEGRAM_ADMIN_ID,text})});
    if(!r.ok){const t=await r.text().catch(()=> ''); logger.warn({status:r.status,t},'tgSendText fail');}
  }catch(e){logger.warn({e},'tgSendText err');}
}

/* ---- Lock (singleton) ---- */
const WA_LOCK_KEY = process.env.WA_LOCK_KEY || '_wa_singleton_lock';
const WA_LOCK_TTL_MS = Number(process.env.WA_LOCK_TTL_MS || 60_000);
let _lockRenewTimer=null,_lockMongoClient=null;

async function acquireLockOrExit(){
  if(!MONGO_URI) throw new Error('MONGODB_URI مطلوب.');
  const holderId=process.env.RENDER_INSTANCE_ID||process.env.HOSTNAME||String(process.pid);
  _lockMongoClient=new MongoClient(MONGO_URI,{serverSelectionTimeoutMS:8000});
  await _lockMongoClient.connect();
  const col=_lockMongoClient.db().collection('locks');
  const now=Date.now();
  const doc={_id:WA_LOCK_KEY,holder:holderId,expiresAt:now+WA_LOCK_TTL_MS};
  try{
    await col.insertOne(doc);
    logger.info({holderId,key:WA_LOCK_KEY},'✅ lock acquired (insert)');
  }catch(e){
    if(e?.code!==11000){ logger.error({e},'lock insert unexpected'); process.exit(0); }
    const taken=await col.findOneAndUpdate(
      {_id:WA_LOCK_KEY,expiresAt:{$lte:now}},
      {$set:{holder:holderId,expiresAt:now+WA_LOCK_TTL_MS}},
      {returnDocument:'after'}
    );
    if(!taken || taken.holder!==holderId){ logger.error({holderId},'lock held elsewhere'); process.exit(0); }
    logger.info({holderId,key:WA_LOCK_KEY},'✅ lock acquired (takeover)');
  }
  _lockRenewTimer=setInterval(async()=>{
    try{ await col.updateOne({_id:WA_LOCK_KEY,holder:holderId},{$set:{expiresAt:Date.now()+WA_LOCK_TTL_MS}}); }
    catch(e){ logger.warn({e},'lock renew fail'); }
  }, Math.max(5000, Math.floor(WA_LOCK_TTL_MS/2)));
  _lockRenewTimer.unref?.();
}
function releaseLock(){
  const holderId=process.env.RENDER_INSTANCE_ID||process.env.HOSTNAME||String(process.pid);
  try{ _lockRenewTimer&&clearInterval(_lockRenewTimer);}catch{}
  (async()=>{
    try{ if(_lockMongoClient){ await _lockMongoClient.db().collection('locks').deleteOne({_id:WA_LOCK_KEY,holder:holderId}); } }catch{}
    try{ await _lockMongoClient?.close?.(); }catch{}
  })().catch(()=>{});
}

/* ---- Wipe helpers ---- */
if(process.env.WIPE_BAILEYS && process.env.WIPE_BAILEYS!=='0'){
  logger.warn('WIPE_BAILEYS مفعّل؛ سيحذف اعتماد Baileys.');
}
async function maybeWipeDatabase(){
  const mode=(process.env.WIPE_BAILEYS||'').toLowerCase().trim();
  if(!mode) return;
  if(String(process.env.WIPE_BAILEYS_ONCE||'')==='1' && fs.existsSync(ONCE_FLAG)) return;
  if(!MONGO_URI){ logger.warn('WIPE_BAILEYS set but MONGODB_URI empty'); return; }
  let conn;
  try{
    conn=await mongoose.createConnection(MONGO_URI,{serverSelectionTimeoutMS:10000}).asPromise();
    const db=conn.db;
    if(mode==='all'){
      await db.dropDatabase();
      logger.warn('🗑️ dropped DB');
    }else if(mode==='1'){
      const r1=await db.collection(CREDS_COL).deleteMany({});
      const r2=await db.collection(KEYS_COL).deleteMany({});
      logger.warn({deleted:{[CREDS_COL]:r1?.deletedCount||0,[KEYS_COL]:r2?.deletedCount||0}},'✅ wiped baileys collections');
    }else if(mode==='custom'){
      const list=parseList(process.env.WIPE_BAILEYS_COLLECTIONS);
      if(!list.length){ logger.warn('custom wipe: empty list'); }
      else{
        const deleted={};
        for(const c of list){ try{ const r=await db.collection(c).deleteMany({}); deleted[c]=r?.deletedCount||0; }catch(e){ logger.warn({c,e},'wipe fail'); } }
        logger.warn({deleted},'✅ custom wipe done');
      }
    }
    if(String(process.env.WIPE_BAILEYS_ONCE||'')==='1'){ try{ fs.writeFileSync(ONCE_FLAG,String(Date.now())); }catch{} }
  }catch(e){ logger.warn({e},'wipe error'); }
  finally{ try{ await conn?.close(); }catch{} }
}
async function wipeAuthMongoNow(){
  if(!MONGO_URI) return;
  let conn;
  try{
    conn=await mongoose.createConnection(MONGO_URI,{serverSelectionTimeoutMS:10000}).asPromise();
    const db=conn.db;
    const r1=await db.collection(CREDS_COL).deleteMany({});
    const r2=await db.collection(KEYS_COL).deleteMany({});
    logger.warn({deleted:{[CREDS_COL]:r1?.deletedCount||0,[KEYS_COL]:r2?.deletedCount||0}},'🧹 wiped after logout');
  }catch(e){ logger.warn({e},'wipeAuthMongoNow err'); }
  finally{ try{ await conn?.close(); }catch{} }
}

/* ---- Message store ---- */
const messageStore=new Map();
const MAX_STORE=Number(process.env.WA_MESSAGE_STORE_MAX||5000);
function storeMessage(m){
  if(!m?.key?.id) return;
  if(messageStore.size>=MAX_STORE){ const k=messageStore.keys().next().value; if(k) messageStore.delete(k); }
  messageStore.set(m.key.id,m);
}

/* ---- Socket lifecycle ---- */
let currentSock=null, reconnecting=false, generation=0;
function safeCloseSock(s){ try{s?.end?.();}catch{} try{s?.ws?.close?.();}catch{} }

async function createSingleSocket({telegram}={}){
  if(!MONGO_URI) throw new Error('MONGODB_URI مطلوب.');
  const { state, saveCreds } = await mongoAuthState(logger);
  const { version } = await fetchLatestBaileysVersion();
  const msgRetryCounterCache = new NodeCache({ stdTTL:Number(process.env.WA_RETRY_TTL||3600), checkperiod:Number(process.env.WA_RETRY_CHECK||120), useClones:false });

  const sock=makeWASocket({
    version, auth: state, logger,
    printQRInTerminal: !TELEGRAM_TOKEN || !TELEGRAM_ADMIN_ID, // اطبع QR في اللوج فقط إذا لم نتمكّن من إرساله لتليجرام
    emitOwnEvents:false, syncFullHistory:false, shouldSyncHistoryMessage:()=>false,
    markOnlineOnConnect:true,
    getMessage: async (key)=> (key?.id? messageStore.get(key.id):undefined),
    msgRetryCounterCache, shouldIgnoreJid:(jid)=> jid==='status@broadcast',
    browser:['Ubuntu','Chrome','22.04.4'], connectTimeoutMs:60_000,
  });

  const myGen=++generation;
  logger.info({gen:myGen},'WA socket created');
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u)=>{
    const { connection, lastDisconnect, qr } = u||{};
    const code = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode ?? lastDisconnect?.statusCode;
    logger.info({gen:myGen,connection,code,hasQR:Boolean(qr)},'WA connection.update');

    if(qr && TELEGRAM_TOKEN && TELEGRAM_ADMIN_ID){
      try{
        const png=await QRCode.toBuffer(qr,{type:'png',margin:1,scale:6});
        await tgSendPhoto(png, 'امسح الـQR لربط الواتساب');
      }catch(e){ logger.warn({e},'QR gen/send fail'); }
    }

    try{
      if(!sock.authState.creds?.registered && PAIR_NUMBER){
        const codeTxt=await sock.requestPairingCode(PAIR_NUMBER);
        logger.info({code:codeTxt},'PAIRING CODE');
        await tgSendText(`PAIR CODE: \`${codeTxt}\``);
      }
    }catch(e){ logger.warn({e},'pairing code fail'); }

    if(connection==='open'){
      logger.info('WA connection open');
      try{ await sock.sendPresenceUpdate('available'); }catch{}
    }

    if(connection==='close'){
      const isLoggedOut = code===DisconnectReason.loggedOut || code===401;
      if(isLoggedOut){ logger.error('WA logged out — wiping & stop.'); await wipeAuthMongoNow(); return; }
      if(!reconnecting){
        reconnecting=true;
        logger.warn({gen:myGen,code},'WA closed, clean restart…');
        safeCloseSock(currentSock); currentSock=null;
        setTimeout(async()=>{
          try{ currentSock=await createSingleSocket({telegram}); logger.info({gen:generation},'WA restarted'); }
          catch(err){ logger.error({err},'WA restart failed'); }
          finally{ reconnecting=false; }
        },2000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({messages,type})=>{
    try{
      for(const m of messages||[]){
        const jid=m?.key?.remoteJid; if(jid==='status@broadcast') continue;
        storeMessage(m);
        if(!ENABLE_WA_ECHO || m.key?.fromMe) continue;
        const t=m.message?.conversation||m.message?.extendedTextMessage?.text||m.message?.imageMessage?.caption||m.message?.videoMessage?.caption||'';
        await sock.sendMessage(jid,{text:t?`echo: ${t}`:'received.'});
      }
    }catch(e){ logger.warn({e,type},'messages.upsert err'); }
  });

  sock.ev.on('messages.update', async (updates)=>{
    for(const u of updates||[]){
      try{
        const needsResync = u.update?.retry || u.update?.status===409 || u.update?.status===410;
        if(needsResync){ try{ await sock.resyncAppState?.(['critical_unblock_low']); }catch(e){ logger.warn({e},'resync fail'); } }
      }catch(e){ logger.warn({e,u},'messages.update err'); }
    }
  });

  registerSelfHeal(sock,{messageStore});
  return sock;
}

let wipedOnce=false;
async function startWhatsApp({telegram}={}){
  if(!MONGO_URI) throw new Error('MONGODB_URI مطلوب.');
  await acquireLockOrExit();
  if(!wipedOnce){ try{ await maybeWipeDatabase(); }catch(e){ logger.warn({e},'maybeWipeDatabase err'); } wipedOnce=true; }
  if(currentSock) return currentSock;
  currentSock=await createSingleSocket({telegram});
  const shutdown=()=>{ logger.warn('SIGTERM/SIGINT: closing WA socket'); safeCloseSock(currentSock); currentSock=null; releaseLock(); };
  process.once('SIGINT',shutdown); process.once('SIGTERM',shutdown);
  return currentSock;
}

module.exports={ startWhatsApp };
