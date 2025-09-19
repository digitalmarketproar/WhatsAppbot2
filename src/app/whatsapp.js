// src/app/whatsapp.js
'use strict';
const { default: makeWASocket, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const NodeCache = require('node-cache');
const logger = require('../lib/logger');
const { mongoAuthState } = require('../lib/wa-mongo-auth');
const { registerSelfHeal } = require('../lib/selfheal');
const mongoose = require('mongoose');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const PAIR_NUMBER = process.env.PAIR_NUMBER || null;
const ENABLE_WA_ECHO = String(process.env.ENABLE_WA_ECHO || '') === '1';
const CREDS_COL = process.env.BAILEYS_CREDS_COLLECTION || 'baileyscreds';
const KEYS_COL = process.env.BAILEYS_KEY_COLLECTION || 'baileyskeys';
const MONGO_URI = process.env.MONGODB_URI || '';
const ONCE_FLAG = path.join('/tmp', 'wipe_baileys_done');

const WA_LOCK_KEY = process.env.WA_LOCK_KEY || '_wa_singleton_lock';
const WA_LOCK_TTL_MS = Number(process.env.WA_LOCK_TTL_MS || 60000);
let _lockRenewTimer = null;
let _lockMongoClient = null;

let currentSock = null;
let reconnecting = false;
let generation = 0;
const messageStore = new Map();
const MAX_STORE = Number(process.env.WA_MESSAGE_STORE_MAX || 5000);
let lastPairTS = 0;
const PAIR_COOLDOWN_MS = 30000;

function parseList(val){return String(val||'').split(',').map(s=>s.trim()).filter(Boolean);}
if(process.env.WIPE_BAILEYS && process.env.WIPE_BAILEYS!=='0'){logger.warn('WIPE_BAILEYS enabled');}

async function acquireLockOrExit(){
  if(!MONGO_URI) throw new Error('MONGODB_URI required');
  const holderId = process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || String(process.pid);
  _lockMongoClient = new MongoClient(MONGO_URI,{serverSelectionTimeoutMS:8000});
  await _lockMongoClient.connect();
  const col=_lockMongoClient.db().collection('locks');
  const now=Date.now();
  const doc={_id:WA_LOCK_KEY,holder:holderId,expiresAt:now+WA_LOCK_TTL_MS};
  try{
    await col.insertOne(doc);
    logger.info({holderId,key:WA_LOCK_KEY},'✅ Acquired WA singleton lock (insert).');
  }catch(e){
    if(e?.code!==11000){logger.error({e},'Lock insert failed');process.exit(0);}
    const docAfter=await col.findOneAndUpdate({_id:WA_LOCK_KEY,expiresAt:{$lte:now}},{$set:{holder:holderId,expiresAt:now+WA_LOCK_TTL_MS}});
    if(!docAfter||docAfter.holder!==holderId){logger.error({holderId},'WA lock not acquired. Exiting.');process.exit(0);}
    logger.info({holderId,key:WA_LOCK_KEY},'✅ Acquired WA singleton lock (takeover).');
  }
  _lockRenewTimer=setInterval(async()=>{try{await col.updateOne({_id:WA_LOCK_KEY,holder:holderId},{$set:{expiresAt:Date.now()+WA_LOCK_TTL_MS}});}catch(e){logger.warn({e},'Failed to renew WA lock');}},Math.max(5000,Math.floor(WA_LOCK_TTL_MS/2)));
  _lockRenewTimer.unref?.();
}

function releaseLock(){
  const holderId = process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || String(process.pid);
  try{_lockRenewTimer&&clearInterval(_lockRenewTimer);}catch{}
  (async()=>{
    try{if(_lockMongoClient){await _lockMongoClient.db().collection('locks').deleteOne({_id:WA_LOCK_KEY,holder:holderId});}}catch{}
    try{await _lockMongoClient?.close?.();}catch{}
  })().catch(()=>{});
}

async function maybeWipeDatabase(){
  const mode=(process.env.WIPE_BAILEYS||'').toLowerCase().trim();
  if(!mode) return;
  if(String(process.env.WIPE_BAILEYS_ONCE||'')==='1'&&fs.existsSync(ONCE_FLAG)){logger.warn('WIPE_BAILEYS_ONCE: skip');return;}
  const uri=process.env.MONGODB_URI; if(!uri){logger.warn('WIPE_BAILEYS set but MONGODB_URI empty');return;}
  let conn;
  try{
    logger.warn({mode},'🧹 wiping DB');
    conn=await mongoose.createConnection(uri,{serverSelectionTimeoutMS:10000}).asPromise();
    const db=conn.db;
    if(mode==='all'){const name=db.databaseName;await db.dropDatabase();logger.warn(`🗑️ dropped database "${name}"`);}
    else if(mode==='1'){const r1=await db.collection(CREDS_COL).deleteMany({});const r2=await db.collection(KEYS_COL).deleteMany({});logger.warn({collections:[CREDS_COL,KEYS_COL],deleted:{[CREDS_COL]:r1?.deletedCount||0,[KEYS_COL]:r2?.deletedCount||0}},'✅ wiped Baileys collections');}
    else if(mode==='custom'){const list=parseList(process.env.WIPE_BAILEYS_COLLECTIONS);if(!list.length){logger.warn('custom wipe but no collections');}else{const deleted={};for(const c of list){try{const res=await db.collection(c).deleteMany({});deleted[c]=res?.deletedCount||0;}catch(e){logger.warn({c,e},'wipe col fail');}}logger.warn({deleted},'✅ wiped custom');}}
    else{logger.warn({mode},'unknown wipe mode');}
    if(String(process.env.WIPE_BAILEYS_ONCE||'')==='1'){try{fs.writeFileSync(ONCE_FLAG,String(Date.now()));}catch{}}
  }catch(e){logger.warn({e},'❌ wipe DB failed');}finally{try{await conn?.close();}catch{}}
}

async function wipeAuthMongoNow(){
  const uri=process.env.MONGODB_URI; if(!uri){logger.warn('MONGODB_URI empty');return;}
  let conn; try{
    conn=await mongoose.createConnection(uri,{serverSelectionTimeoutMS:10000}).asPromise();
    const db=conn.db;
    const r1=await db.collection(CREDS_COL).deleteMany({});
    const r2=await db.collection(KEYS_COL).deleteMany({});
    logger.warn({collections:[CREDS_COL,KEYS_COL],deleted:{[CREDS_COL]:r1?.deletedCount||0,[KEYS_COL]:r2?.deletedCount||0}},'🧹 wiped after loggedOut');
  }catch(e){logger.warn({e},'❌ wipeAuthMongoNow failed');}finally{try{await conn?.close();}catch{}}
}

function storeMessage(m){if(!m?.key?.id) return; if(messageStore.size>=MAX_STORE){const k=messageStore.keys().next().value;if(k) messageStore.delete(k);} messageStore.set(m.key.id,m);}

function safeCloseSock(sock){try{sock?.end?.();}catch{} try{sock?.ws?.close?.();}catch{}}

async function createSingleSocket({telegram}={}){
  if(!MONGO_URI) throw new Error('MONGODB_URI required');
  const { state, saveCreds } = await mongoAuthState(logger);
  const { version } = await fetchLatestBaileysVersion();
  const msgRetryCounterCache=new NodeCache({stdTTL:Number(process.env.WA_RETRY_TTL||3600),checkperiod:Number(process.env.WA_RETRY_CHECK||120),useClones:false});
  const sock=makeWASocket({version,auth:state,logger,printQRInTerminal:!telegram,emitOwnEvents:false,syncFullHistory:false,shouldSyncHistoryMessage:()=>false,markOnlineOnConnect:true,getMessage:async(k)=>(k?.id?messageStore.get(k.id):undefined),msgRetryCounterCache,shouldIgnoreJid:(jid)=>jid==='status@broadcast',browser:['Ubuntu','Chrome','22.04.4'],connectTimeoutMs:60000});
  const myGen=++generation; logger.info({gen:myGen},'WA socket created');

  const tgSendText=async(txt)=>{try{if(telegram && typeof telegram.sendMessage==='function'){const chatId=process.env.TELEGRAM_ADMIN_ID||process.env.TG_CHAT_ID; if(chatId) await telegram.sendMessage(chatId,txt,{parse_mode:'Markdown'});}}catch(e){logger.warn({e},'send TG fail');}};
  const tgSendQR=async(qr)=>{try{if(telegram){if(typeof telegram.sendQR==='function'){await telegram.sendQR(qr);}else if(typeof telegram.sendMessage==='function'){const chatId=process.env.TELEGRAM_ADMIN_ID||process.env.TG_CHAT_ID; if(chatId) await telegram.sendMessage(chatId,'Scan this WhatsApp QR:\n'+qr);}}}catch(e){logger.warn({e},'send QR TG fail');}};
  let pairSentThisGen=false;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u)=>{
    const { connection, lastDisconnect, qr } = u||{};
    const code = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode ?? lastDisconnect?.statusCode;
    logger.info({gen:myGen,connection,code,hasQR:Boolean(qr)},'WA connection.update');

    if(qr && telegram){await tgSendQR(qr);}

    try{
      const now=Date.now();
      const canSendNow = !pairSentThisGen && (!lastDisconnect || code!==DisconnectReason.loggedOut) && (now-lastPairTS>PAIR_COOLDOWN_MS);
      if(!sock.authState.creds?.registered && PAIR_NUMBER && canSendNow){
        pairSentThisGen=true;
        const codeTxt=await sock.requestPairingCode(PAIR_NUMBER);
        lastPairTS=Date.now();
        logger.info({code:codeTxt},'PAIRING CODE');
        await tgSendText(`PAIR CODE: \`${codeTxt}\``);
      }
    }catch(e){logger.warn({e},'pairing code fail');}

    if(connection==='open'){logger.info('WA connection open');try{await sock.sendPresenceUpdate('available');}catch{}}

    if(connection==='close'){
      const isLoggedOut = code===DisconnectReason.loggedOut;
      if(isLoggedOut){logger.error('WA logged out — wiping & stop.');await wipeAuthMongoNow();return;}
      if(!reconnecting){
        reconnecting=true;
        logger.warn({gen:myGen,code},'WA closed, clean restart…');
        safeCloseSock(currentSock); currentSock=null;
        const sincePair=Date.now()-lastPairTS;
        const backoff = sincePair < PAIR_COOLDOWN_MS ? Math.max(8000, PAIR_COOLDOWN_MS - sincePair + 2000) : 2000;
        setTimeout(async()=>{try{currentSock=await createSingleSocket({telegram});logger.info({gen:generation},'WA restarted');}catch(err){logger.error({err},'WA restart failed');}finally{reconnecting=false;}},backoff);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({messages,type})=>{
    try{
      for(const m of messages||[]){
        const rjid=m?.key?.remoteJid; if(rjid==='status@broadcast') continue;
        storeMessage(m);
        if(!ENABLE_WA_ECHO) continue;
        if(m.key?.fromMe) continue;
        const text=m.message?.conversation||m.message?.extendedTextMessage?.text||m.message?.imageMessage?.caption||m.message?.videoMessage?.caption||'';
        await sock.sendMessage(rjid,{text:text?`echo: ${text}`:'received.'});
      }
    }catch(e){logger.warn({e,type},'messages.upsert error');}
  });

  sock.ev.on('messages.update', async (updates)=>{
    for(const u of updates||[]){
      try{
        const rjid=u?.key?.remoteJid; if(rjid==='status@broadcast') continue;
        const needsResync=u.update?.retry||u.update?.status===409||u.update?.status===410;
        if(needsResync){try{await sock.resyncAppState?.(['critical_unblock_low']);}catch(e){logger.warn({e},'resyncAppState failed');}}
      }catch(e){logger.warn({e,u},'messages.update error');}
    }
  });

  registerSelfHeal(sock,{messageStore});
  return sock;
}

let wipedOnce=false;
async function startWhatsApp({telegram}={}){
  if(!MONGO_URI) throw new Error('MONGODB_URI required');
  await acquireLockOrExit();
  if(!wipedOnce){try{await maybeWipeDatabase();}catch(e){logger.warn({e},'maybeWipeDatabase error');}wipedOnce=true;}
  if(currentSock) return currentSock;
  currentSock=await createSingleSocket({telegram});
  const shutdown=()=>{logger.warn('SIGTERM/SIGINT: closing WA socket');safeCloseSock(currentSock);currentSock=null;releaseLock();};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  return currentSock;
}

module.exports={ startWhatsApp };
