require("dotenv").config();

const fs = require("fs");
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const express = require("express");
const cookieSession = require('cookie-session');
const app = express();
const TEL_ADMIN_PAGES = require('./admin-pages');

/* ============================================================
   COMPATIBILIDAD CON VERCEL
   - Vercel solo permite escribir de forma temporal dentro de /tmp.
   - Los archivos editables se copian allí al arrancar.
   - Si hay una base Upstash Redis conectada, se cargan y guardan
     automáticamente para que los cambios sean persistentes.
   ============================================================ */
const TEL_IS_VERCEL = Boolean(process.env.VERCEL);
const TEL_MUTABLE_FILE_NAMES = new Set([
  'data.json',
  'web_accounts.json',
  'contact_messages.json'
]);
const TEL_RUNTIME_DIR = TEL_IS_VERCEL
  ? path.join('/tmp', 'thunder-elite-league')
  : __dirname;
const telRequestStorage = new AsyncLocalStorage();
const telNativeFs = {
  readFileSync: fs.readFileSync.bind(fs),
  writeFileSync: fs.writeFileSync.bind(fs),
  existsSync: fs.existsSync.bind(fs),
  statSync: fs.statSync.bind(fs),
  watchFile: fs.watchFile.bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs),
  copyFileSync: fs.copyFileSync.bind(fs)
};

function telMutableFileName(filePath){
  try{
    const absolute = path.resolve(String(filePath || ''));
    if(path.dirname(absolute) !== path.resolve(__dirname)) return '';
    const name = path.basename(absolute);
    return TEL_MUTABLE_FILE_NAMES.has(name) ? name : '';
  }catch(error){
    return '';
  }
}

function telRuntimePath(filePath){
  const mutableName = telMutableFileName(filePath);
  return mutableName ? path.join(TEL_RUNTIME_DIR, mutableName) : filePath;
}

if(TEL_IS_VERCEL){
  telNativeFs.mkdirSync(TEL_RUNTIME_DIR, {recursive:true});
  for(const name of TEL_MUTABLE_FILE_NAMES){
    const source = path.join(__dirname, name);
    const target = path.join(TEL_RUNTIME_DIR, name);
    if(telNativeFs.existsSync(source) && !telNativeFs.existsSync(target)){
      telNativeFs.copyFileSync(source, target);
    }
  }
}

const telRedisUrl = String(
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || ''
).trim();
const telRedisToken = String(
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || ''
).trim();
function telNormalizeRedisPrefix(value){
  let prefix = String(value || 'tel:web:v1:').trim();
  // Corrige automáticamente el error común de guardar la clave completa
  // (tel:web:v1:data:live) en TEL_REDIS_PREFIX. La variable debe ser solo
  // el prefijo (tel:web:v1:), igual que en el bot de Discord.
  prefix = prefix.replace(/(?::)?(?:data:live|data\.json|data)$/i, '');
  return `${prefix.replace(/:+$/, '')}:`;
}
const TEL_REDIS_PREFIX_RAW = String(process.env.TEL_REDIS_PREFIX || 'tel:web:v1:');
const TEL_REDIS_SAFE_PREFIX = telNormalizeRedisPrefix(TEL_REDIS_PREFIX_RAW);
const TEL_REDIS_PREFIX = TEL_REDIS_SAFE_PREFIX;
function telClubLogoRedisKey(clubKey){
  return `${TEL_REDIS_SAFE_PREFIX}club-logo:${String(clubKey || '').trim()}`;
}
let telRedis = null;
if(telRedisUrl && telRedisToken){
  try{
    const { Redis } = require('@upstash/redis');
    telRedis = new Redis({url:telRedisUrl, token:telRedisToken});
  }catch(error){
    console.error('[vercel-storage] No se pudo iniciar Upstash Redis:', error);
  }
}

let telPersistentLoadPromise = null;
let telPersistentStateLoaded = false;
let telPersistentLastCheck = 0;
let telPersistentRemoteVersion = '';
let telPersistQueue = Promise.resolve();
/*
   DATA EN VIVO COMPARTIDA ENTRE DISCORD Y VERCEL
   ------------------------------------------------
   Discord y la web leen y escriben SIEMPRE la misma clave estable. El
   data.json del repositorio solo se usa para inicializar una base vacía.
   Así cualquier comando de Discord aparece automáticamente en la web.
*/
const TEL_REPO_DATA_PATH = path.join(__dirname, 'data.json');
const TEL_REPO_DATA_CONTENT = telNativeFs.existsSync(TEL_REPO_DATA_PATH)
  ? telNativeFs.readFileSync(TEL_REPO_DATA_PATH, 'utf8')
  : '';
const TEL_REPO_DATA_HASH = TEL_REPO_DATA_CONTENT
  ? crypto.createHash('sha256').update(TEL_REPO_DATA_CONTENT).digest('hex')
  : '';
const TEL_REPO_DATA_REVISION = TEL_REPO_DATA_HASH
  ? TEL_REPO_DATA_HASH.slice(0, 24)
  : 'sin-data-repo';
const TEL_LIVE_DATA_KEY = `${TEL_REDIS_SAFE_PREFIX}data:live`;

function telRedisKey(name){
  if(name === 'data.json') return TEL_LIVE_DATA_KEY;
  return `${TEL_REDIS_SAFE_PREFIX}${name}`;
}
function telRedisVersionKey(){
  return `${TEL_REDIS_SAFE_PREFIX}__version`;
}
function telRedisActiveDataKey(){
  return `${TEL_REDIS_SAFE_PREFIX}__active_data_key`;
}
function telRedisRepoDataHashKey(){
  return `${TEL_REDIS_SAFE_PREFIX}__active_repo_data_hash`;
}

async function telLoadPersistentFiles(force=false){
  if(!TEL_IS_VERCEL || !telRedis) return;
  const now = Date.now();
  if(!force && telPersistentStateLoaded && now - telPersistentLastCheck < 2000) return;
  telPersistentLastCheck = now;

  let remoteVersionRaw = await telRedis.get(telRedisVersionKey());
  let remoteVersion = String(remoteVersionRaw || '');
  const currentDataKey = telRedisKey('data.json');

  /* La clave en vivo se inicializa desde GitHub únicamente si está vacía. */
  let storedCurrentData = await telRedis.get(currentDataKey);
  if(storedCurrentData === null || storedCurrentData === undefined){
    if(!TEL_REPO_DATA_CONTENT){
      throw new Error('El despliegue no contiene un data.json válido.');
    }
    const version = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    await telRedis.set(currentDataKey, TEL_REPO_DATA_CONTENT);
    await telRedis.set(telRedisActiveDataKey(), currentDataKey);
    await telRedis.set(telRedisRepoDataHashKey(), TEL_REPO_DATA_HASH);
    await telRedis.set(telRedisVersionKey(), version);
    storedCurrentData = TEL_REPO_DATA_CONTENT;
    remoteVersion = version;
    console.log(`[vercel-storage] Data en vivo inicializada desde GitHub: ${TEL_REPO_DATA_REVISION}`);
  }else{
    /* Publica la clave canónica para que el bot la descubra incluso si usa una versión anterior. */
    await Promise.all([
      telRedis.set(telRedisActiveDataKey(), currentDataKey),
      telRedis.set(telRedisRepoDataHashKey(), TEL_REPO_DATA_HASH)
    ]);
  }

  if(telPersistentStateLoaded && remoteVersion === telPersistentRemoteVersion && !force) return;

  /* La data siempre procede de la clave en vivo compartida con Discord. */
  const dataContent = typeof storedCurrentData === 'string'
    ? storedCurrentData
    : JSON.stringify(storedCurrentData, null, 2);
  telNativeFs.writeFileSync(path.join(TEL_RUNTIME_DIR, 'data.json'), dataContent, 'utf8');

  /* Las cuentas y los mensajes siguen siendo persistentes entre versiones. */
  for(const name of TEL_MUTABLE_FILE_NAMES){
    if(name === 'data.json') continue;
    const stored = await telRedis.get(telRedisKey(name));
    if(stored === null || stored === undefined) continue;
    const content = typeof stored === 'string' ? stored : JSON.stringify(stored, null, 2);
    telNativeFs.writeFileSync(path.join(TEL_RUNTIME_DIR, name), content, 'utf8');
  }

  telPersistentStateLoaded = true;
  telPersistentRemoteVersion = remoteVersion;
  try{
    if(typeof telDataHash === 'function'){
      const hash = telDataHash();
      if(hash) telLastDataHash = hash;
    }
  }catch(error){}
}

function telEnsurePersistentFiles(){
  if(!TEL_IS_VERCEL || !telRedis) return Promise.resolve();
  if(!telPersistentLoadPromise){
    telPersistentLoadPromise = telLoadPersistentFiles().catch(error=>{
      console.error('[vercel-storage] No se pudieron cargar los datos persistentes:', error);
    }).finally(()=>{
      telPersistentLoadPromise = null;
    });
  }
  return telPersistentLoadPromise;
}
function telQueuePersistentWrite(fileName, content){
  if(!TEL_IS_VERCEL || !telRedis || !fileName) return null;
  const payload = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  const version = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  telPersistQueue = telPersistQueue
    .catch(()=>{})
    .then(async()=>{
      await telRedis.set(telRedisKey(fileName), payload);
      await telRedis.set(telRedisVersionKey(), version);
      telPersistentStateLoaded = true;
      telPersistentRemoteVersion = version;
      telPersistentLastCheck = Date.now();
      return version;
    })
    .catch(error=>{
      console.error(`[vercel-storage] No se pudo guardar ${fileName}:`, error);
      throw error;
    });
  const store = telRequestStorage.getStore();
  if(store && Array.isArray(store.pending)) store.pending.push(telPersistQueue);
  return telPersistQueue;
}

if(TEL_IS_VERCEL){
  fs.readFileSync = function(filePath, ...args){
    return telNativeFs.readFileSync(telRuntimePath(filePath), ...args);
  };
  fs.existsSync = function(filePath){
    return telNativeFs.existsSync(telRuntimePath(filePath));
  };
  fs.statSync = function(filePath, ...args){
    return telNativeFs.statSync(telRuntimePath(filePath), ...args);
  };
  fs.watchFile = function(filePath, ...args){
    return telNativeFs.watchFile(telRuntimePath(filePath), ...args);
  };
  fs.writeFileSync = function(filePath, data, ...args){
    const mutableName = telMutableFileName(filePath);
    const result = telNativeFs.writeFileSync(telRuntimePath(filePath), data, ...args);
    if(mutableName) telQueuePersistentWrite(mutableName, data);
    return result;
  };
}

const TEL_ADMIN_PASSWORD_CONFIGURED = Boolean(process.env.ADMIN_PASSWORD || process.env.WEB_ADMIN_PASSWORD);
const TEL_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.WEB_ADMIN_PASSWORD ||
  (TEL_IS_VERCEL ? crypto.randomBytes(32).toString('hex') : 'admin123');
const WEB_SESSION_SECRET = process.env.WEB_SESSION_SECRET ||
  crypto.createHash('sha256')
    .update(`tel-session-v1:${TEL_ADMIN_PASSWORD}:thunder-elite-league`)
    .digest('hex');
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/auth/discord/callback';

const AUTH_DB_PATH = path.join(__dirname, 'web_accounts.json');

/* El acceso de administrador se concede exclusivamente mediante el login por correo.
   Las cuentas de Discord nunca reciben permisos de administrador automáticamente. */
function telNormalizeDiscordAdminValue(value){
  return String(value || '').trim();
}
function telDiscordUserIsAuthorizedAdmin(){
  return false;
}
function telPromoteDiscordAdminSession(req){
  return !!(req && req.session && req.session.isAdmin === true);
}


function discordRedirectUri(req){
  const envUri = process.env.DISCORD_REDIRECT_URI;
  if(envUri && envUri.trim()) return envUri.trim();
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers.host || 'localhost:3000';
  return `${proto}://${host}/auth/discord/callback`;
}

function discordErrorPage(title, detail, extra){
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body{margin:0;background:#060911;color:#fff;font-family:Arial,Helvetica,sans-serif;display:grid;place-items:center;min-height:100vh}
    .card{width:min(760px,calc(100% - 32px));border:1px solid rgba(151,71,255,.35);border-radius:18px;background:linear-gradient(180deg,rgba(12,17,30,.98),rgba(5,8,15,.98));box-shadow:0 24px 80px rgba(0,0,0,.45);padding:28px}
    h1{margin:0 0 10px;font-size:28px}
    p{color:#c7d0df;line-height:1.5}
    code{display:block;white-space:pre-wrap;background:#0a1020;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:14px;color:#dbe7ff}
    a{display:inline-flex;margin-top:18px;padding:12px 18px;border-radius:10px;background:#8a35ff;color:#fff;text-decoration:none;font-weight:900}
    .warn{color:#ffcf4a;font-weight:900}
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${detail}</p>
    ${extra ? `<code>${extra}</code>` : ""}
    <p class="warn">Revisa que el Redirect URI del Discord Developer Portal sea exactamente el mismo que aparece arriba.</p>
    <a href="/auth/discord">Volver a iniciar sesión con Discord</a>
  </div>
</body>
</html>`;
}

function readAuthDb(){
  try{
    if(!fs.existsSync(AUTH_DB_PATH)){
      fs.writeFileSync(AUTH_DB_PATH, JSON.stringify({accounts: [], discordLinks: []}, null, 2));
    }
    const raw = fs.readFileSync(AUTH_DB_PATH, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return {
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      discordLinks: Array.isArray(parsed.discordLinks) ? parsed.discordLinks : []
    };
  }catch(error){
    console.error('[auth] No se pudo leer web_accounts.json:', error);
    return {accounts: [], discordLinks: []};
  }
}

function writeAuthDb(db){
  fs.writeFileSync(AUTH_DB_PATH, JSON.stringify(db, null, 2));
}

function requireWebLogin(req, res, next){
  if(req.session && req.session.isAdmin === true) return next();
  if(req.session && req.session.webAccountId && req.session.discordId) return next();
  return res.status(401).json({
    ok:false,
    error:'discord_login_required',
    message:'Debes iniciar sesión con Discord para usar esta cuenta.'
  });
}

app.set('trust proxy', 1);

/*
   Mantiene la web alineada con la clave que escribe el bot.
   Las rutas que muestran o modifican datos fuerzan una lectura directa de
   Upstash. De este modo una instancia serverless no puede seguir sirviendo
   durante minutos su copia temporal antigua.
*/
function telRequestNeedsFreshLiveData(req){
  const pathname = String(req.path || req.url || '').split('?')[0];
  const method = String(req.method || 'GET').toUpperCase();
  if(pathname === '/data.json') return true;
  if(/^\/api\/(?:data(?:-|$)|clubes$|raw-clubes$|ligas$|sync-status$|sync-debug$|data-version$)/.test(pathname)) return true;
  if(pathname.startsWith('/api/tel-panel/')) return true;
  if(pathname.startsWith('/api/admin/')) return true;
  if(!['GET','HEAD','OPTIONS'].includes(method) && pathname.startsWith('/api/')) return true;
  return false;
}
app.use(async (req,res,next)=>{
  try{
    if(telRequestNeedsFreshLiveData(req)) await telLoadPersistentFiles(true);
    else await telEnsurePersistentFiles();
    next();
  }catch(error){
    console.error('[vercel-storage] Error refrescando la data en vivo:', error);
    if(String(req.path || '').startsWith('/api/')){
      return res.status(503).json({ok:false,message:'No se pudo leer la data en vivo de Upstash.'});
    }
    next();
  }
});

/* Espera los guardados en Redis antes de cerrar la respuesta. */
app.use((req,res,next)=>{
  const store = {pending:[]};
  telRequestStorage.run(store, ()=>{
    const nativeEnd = res.end.bind(res);
    let endScheduled = false;
    res.end = function(...args){
      if(endScheduled) return res;
      const pending = store.pending.splice(0);
      if(!pending.length) return nativeEnd(...args);
      endScheduled = true;
      Promise.allSettled(pending).then(results=>{
        const failed = results.some(item=>item.status === 'rejected');
        if(failed && !res.headersSent){
          const payload = JSON.stringify({
            ok:false,
            message:'No se pudo guardar el cambio de forma persistente. Inténtalo de nuevo.'
          });
          res.statusCode = 503;
          res.setHeader('Content-Type','application/json; charset=utf-8');
          res.setHeader('Content-Length',Buffer.byteLength(payload));
          return nativeEnd(payload);
        }
        return nativeEnd(...args);
      });
      return res;
    };
    next();
  });
});

/* Sesión firmada en cookie: funciona entre distintas instancias serverless. */
app.use(cookieSession({
  name: 'tel_session',
  keys: [WEB_SESSION_SECRET],
  httpOnly: true,
  sameSite: 'lax',
  secure: TEL_IS_VERCEL || process.env.NODE_ENV === 'production',
  maxAge: 1000 * 60 * 60 * 24 * 30
}));

/* Compatibilidad con las llamadas save()/destroy() del código existente. */
app.use((req,res,next)=>{
  if(req.session){
    Object.defineProperty(req.session, 'save', {
      enumerable:false,
      configurable:true,
      value(callback){ if(typeof callback === 'function') callback(); }
    });
    Object.defineProperty(req.session, 'destroy', {
      enumerable:false,
      configurable:true,
      value(callback){
        req.session = null;
        if(typeof callback === 'function') callback();
      }
    });
  }
  next();
});

const telStaticOptions = {
  etag: true,
  lastModified: true,
  maxAge: 0,
  setHeaders(res, filePath){
    const name = path.basename(String(filePath || '')).toLowerCase();
    if(/\.(?:html?|json)$/i.test(filePath) || name === 'tel-live-sync.js' || name === 'tel-public-fixes.js'){
      res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma','no-cache');
      res.setHeader('Expires','0');
    }else if(/\.(?:png|jpe?g|webp|gif|svg|ico|woff2?)$/i.test(filePath)){
      res.setHeader('Cache-Control','public, max-age=2592000, immutable');
    }else if(/\.(?:css|js)$/i.test(filePath)){
      res.setHeader('Cache-Control','public, max-age=300, must-revalidate');
    }
  }
};

app.use(express.static(path.join(__dirname, "public"), telStaticOptions));
app.use("/escudos", express.static(path.join(__dirname, "public", "escudos"), telStaticOptions));

const PORT = process.env.PORT || 3000;

const DATA_FILE = path.join(__dirname, "data.json");
const COMMANDS_FILE = path.join(__dirname, "commands.json");

app.use(express.json({ limit: "2mb" }));

/* PANEL ADMIN PROTEGIDO: los HTML de administración no se sirven sin sesión admin. */
function telHasAdminSession(req){
  const expected = String(process.env.ADMIN_EMAIL || 'roleplayserver007@gmail.com').toLowerCase();
  return !!(req.session && req.session.isAdmin === true && String(req.session.adminEmail || '').toLowerCase() === expected);
}
const telProtectedAdminRoutes = new Set(Object.keys(TEL_ADMIN_PAGES));
app.use((req,res,next)=>{
  if(telProtectedAdminRoutes.has(req.path) && !telHasAdminSession(req)){
    return res.redirect('/?admin_login=1#login');
  }
  next();
});

/*
 * Los HTML privados se envían desde admin-pages.js.
 * Así Vercel los incluye dentro del bundle de Express y no quedan
 * publicados directamente en public/.
 */
app.get([...telProtectedAdminRoutes], (req,res)=>{
  const html = TEL_ADMIN_PAGES[req.path];
  if(!html) return res.status(404).type('text/plain').send('Not Found');
  res.set({
    'Cache-Control':'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma':'no-cache',
    'Expires':'0'
  });
  return res.status(200).type('html').send(html);
});


/* Diagnóstico del despliegue: confirma que Express y los paneles privados están cargados. */
app.get('/api/tel-health', (req,res)=>{
  res.set('Cache-Control','no-store');
  res.json({
    ok:true,
    express:true,
    adminPages:Object.keys(TEL_ADMIN_PAGES),
    adminSession:telHasAdminSession(req),
    redisConnected:Boolean(telRedis),
    dataStorageMode:'repo-hash-versioned-shared-with-discord',
    activeDataKey:telRedisActiveDataKey()
  });
});

/* No se expone la raíz del proyecto: evita publicar código, JSON y configuración. */
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error("Error leyendo JSON:", file, error);
    return fallback;
  }
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function findDataList(data, names) {
  for (const name of names) {
    if (Array.isArray(data[name])) return data[name];
  }
  return [];
}

function getRealLeagues(data) {
  const raw = findDataList(data, ["competiciones", "ligas", "leagues", "competitions", "torneos"]);
  return raw.map((liga, index) => {
    const id = liga.id || liga._id || liga.nombre || liga.name || liga.titulo || `liga-${index + 1}`;
    const nombre = liga.nombre || liga.name || liga.titulo || liga.title || `Liga ${index + 1}`;
    return {
      id: String(id),
      nombre: String(nombre),
      tipo: liga.tipo || liga.type || "",
      emoji: liga.emoji || "🏆",
      equipos: liga.equipos || liga.clubIds || liga.clubes || liga.teams || liga.participantes || []
    };
  });
}

function clubBelongsToLeague(club, liga) {
  if (!liga) return true;

  const leagueId = normalizeText(liga.id);
  const leagueName = normalizeText(liga.nombre);

  const clubLeagueValues = [
    club.ligaId,
    club.liga,
    club.competicionId,
    club.competicion,
    club.conferencia,
    club.division,
    club.torneo
  ].filter(Boolean).map(normalizeText);

  if (clubLeagueValues.includes(leagueId) || clubLeagueValues.includes(leagueName)) return true;

  const members = Array.isArray(liga.equipos) ? liga.equipos : [];
  const clubIds = [
    club.id,
    club._id,
    club.nombre,
    club.name,
    club.nombreVisual
  ].filter(Boolean).map(normalizeText);

  return members.some(member => {
    if (typeof member === "string") {
      const m = normalizeText(member);
      return clubIds.includes(m);
    }
    if (member && typeof member === "object") {
      const mVals = [member.id, member._id, member.nombre, member.name, member.club, member.equipo]
        .filter(Boolean).map(normalizeText);
      return mVals.some(v => clubIds.includes(v));
    }
    return false;
  });
}

function pickLogoUrl(club) {
  const candidates = [
    // La URL original de Discord se prueba antes que una ruta local del ordenador del bot.
    club.escudoDiscordUrl, club.attachmentUrl, club.archivoUrl,
    club.escudoUrl, club.logoUrl, club.logo, club.escudo,
    club.imagen, club.imagenUrl, club.image, club.imageUrl,
    club.avatar, club.avatarUrl, club.icon, club.iconUrl,
    club.escudoPath, club.escudoFilename
  ];

  for (let value of candidates) {
    if (typeof value !== "string" || !value.trim()) continue;
    value = value.trim().replaceAll("\\", "/");
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith("/escudos/")) return value;
    if (value.startsWith("escudos/")) return "/" + value;
    if (/^escudo-.*\.(png|jpg|jpeg|webp|gif)$/i.test(value)) return "/escudos/" + value;
  }

  for (const raw of Object.values(club || {})) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const value = raw.trim().replaceAll("\\", "/");
    if (/^https?:\/\//i.test(value) && /(\.png|\.jpg|\.jpeg|\.webp|\.gif|cdn\.discord|media\.discord|attachments)/i.test(value)) return value;
    if (value.startsWith("escudos/")) return "/" + value;
    if (/^escudo-.*\.(png|jpg|jpeg|webp|gif)$/i.test(value)) return "/escudos/" + value;
  }

  return "";
}


function telLogoSlug(value){
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function telFindClubByKey(data, rawKey){
  const key = String(rawKey || '').trim();
  const wanted = normalizeText(key);
  const clubs = findDataList(data || {}, ['clubes','equipos','teams']);
  let club = clubs.find(item => [item.id,item._id,item.clubId,item.rolId,item.idClub,item.nombre,item.name,item.nombreVisual,item.clubNombre]
    .some(value => value && (String(value) === key || normalizeText(value) === wanted)));
  if(club) return club;

  for(const comp of findDataList(data || {}, ['competiciones','ligas','torneos'])){
    const team = (comp.equipos || []).find(item => [item.slotId,item.id,item._id,item.clubId,item.rolId,item.idClub,item.nombre,item.name,item.nombreVisual,item.clubNombre]
      .some(value => value && (String(value) === key || normalizeText(value) === wanted)));
    if(!team) continue;
    const masterKey = team.clubId || team.idClub || team.clubNombre || team.nombre || team.nombreVisual;
    club = clubs.find(item => [item.id,item._id,item.clubId,item.rolId,item.idClub,item.nombre,item.name,item.nombreVisual,item.clubNombre]
      .some(value => value && normalizeText(value) === normalizeText(masterKey)));
    return club || team;
  }
  return null;
}

function telResolveClubLogo(club){
  if(!club) return null;
  const publicEscudos = path.join(__dirname, 'public', 'escudos');
  const direct = pickLogoUrl(club);
  if(direct){
    if(/^https?:\/\//i.test(direct)) return {type:'remote', value:direct};
    if(direct.startsWith('/api/club-logo')) return null;
    const localName = path.basename(String(direct).replaceAll('\\','/'));
    const localPath = path.join(publicEscudos, localName);
    if(localName && fs.existsSync(localPath)) return {type:'file', value:localPath, filename:localName};
  }

  const slug = telLogoSlug(club.nombre || club.clubNombre || club.nombreVisual || club.name);
  if(slug && fs.existsSync(publicEscudos)){
    try{
      const files = fs.readdirSync(publicEscudos)
        .filter(name => new RegExp(`^escudo-${slug}(?:-|\\.)`, 'i').test(name) && /\.(?:png|jpe?g|webp|gif|svg)$/i.test(name))
        .sort((a,b)=>b.localeCompare(a));
      if(files[0]) return {type:'file', value:path.join(publicEscudos, files[0]), filename:files[0]};
    }catch(error){}
  }
  return null;
}

function telStableClubLogoUrl(club){
  if(!club) return '';
  const key = club.clubId || club.rolId || club.id || club._id || club.idClub || club.nombre || club.clubNombre || club.nombreVisual || club.name;
  /* El fichero puede vivir en el ordenador del bot y no en Vercel. La ruta API
     consulta primero Upstash, por lo que no debemos exigir que exista localmente. */
  return key ? `/api/club-logo?key=${encodeURIComponent(String(key))}` : '';
}

function telClubLogoRedisAliases(club, requestedKey){
  const values = [
    requestedKey,
    club?.id, club?._id, club?.clubId, club?.rolId,
    club?.nombre, club?.nombreVisual, club?.clubNombre, club?.name
  ].filter(Boolean);
  const seen = new Set();
  const aliases = [];
  for(const value of values){
    const raw = String(value).trim();
    const normalized = normalizeText(raw);
    const slug = telLogoSlug(raw);
    for(const alias of [raw, normalized, slug]){
      if(!alias || seen.has(alias)) continue;
      seen.add(alias);
      aliases.push(alias);
    }
  }
  return aliases;
}

function telCanonicalTeam(data, team){
  if(!team || typeof team !== 'object') return team;
  const master = telFindClubByKey(data, team.clubId || team.idClub || team.clubNombre || team.nombre || team.nombreVisual || team.name);
  if(!master || master === team) return team;
  return {
    ...team,
    clubId: master.id || master._id || master.clubId || team.clubId || '',
    clubNombre: master.nombre || master.clubNombre || master.name || team.clubNombre || '',
    nombre: master.nombreVisual || master.nombre || master.name || team.nombre || '',
    nombreVisual: master.nombreVisual || master.nombre || master.name || team.nombreVisual || '',
    emoji: master.emoji || team.emoji || '⚡',
    presidenteTag: master.presidenteTag || master.presidente || team.presidenteTag || '',
    escudoUrl: telStableClubLogoUrl(master) || pickLogoUrl(master) || pickLogoUrl(team) || ''
  };
}

function normalizePlayerForWeb(player, club) {
  const discordId = String(player.usuarioId || player.discordId || player.idJugador || player.id || "");
  const tag = player.usuarioTag || player.discord || player.discordTag || discordId || "Jugador";
  return {
    id: player.id || discordId,
    usuarioId: discordId,
    discordId,
    nombre: player.nombre || player.nombreJugador || String(tag).split("#")[0] || "Jugador",
    nombreJugador: player.nombreJugador || player.nombre || String(tag).split("#")[0] || "Jugador",
    idJugador: player.idJugador || discordId,
    idEaPsn: player.idEaPsn || player.eaPsnId || player.idEA || player.psnId || "",
    eaPsnId: player.eaPsnId || player.idEaPsn || player.idEA || player.psnId || "",
    discord: player.discord || tag,
    usuarioTag: tag,
    avatarUrl: player.avatarUrl || player.avatar || "",
    estado: player.estado || "activo",
    clubId: player.clubId || club?.id || "",
    club: club?.nombre || player.club || player.clubNombre || "",
    agregadoComoDirectiva: player.agregadoComoDirectiva === true,
    registradoEn: player.registradoEn || "",
    actualizadoEn: player.actualizadoEn || ""
  };
}

function normalizeClubForWeb(club, data) {
  const jugadores = Array.isArray(data.jugadores) ? data.jugadores : [];
  const nombre = club.nombre || club.name || "Club sin nombre";
  const nombreVisual = club.nombreVisual || club.displayName || `${club.emoji || ""} ${nombre}`.trim();
  const clubId = String(club.clubId || club.rolId || club.id || club._id || club.idClub || nombre);
  const plantilla = jugadores
    .filter(j => String(j.clubId || "") === clubId || normalizeText(j.club || j.equipo || j.clubNombre) === normalizeText(nombre))
    .map(j => normalizePlayerForWeb(j, club));
  return {
    id: clubId,
    clubId,
    rolId: club.rolId || clubId,
    nombre,
    nombreVisual,
    emoji: club.emoji || "⚡",
    escudoUrl: telStableClubLogoUrl(club) || pickLogoUrl(club),
    colorHex: club.colorHex || club.color || "",
    presupuesto: Number(club.presupuesto || club.budget || 0),
    presidenteId: club.presidenteId || null,
    presidenteTag: club.presidenteTag || club.presidente || "",
    vicepresidentes: Array.isArray(club.vicepresidentes) ? club.vicepresidentes : [],
    ligaId: club.ligaId || club.liga || club.competicionId || club.competicion || club.conferencia || "",
    conferencia: club.conferencia || club.liga || club.competicion || "TEL",
    jugadores: plantilla.length,
    jugadoresRegistrados: plantilla.length,
    maxJugadores: Number(club.maxJugadores || 18),
    plantilla,
    creadoEn: club.creadoEn || "",
    actualizadoEn: club.actualizadoEn || data.sync?.updatedAt || ""
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    name: "Thunder Elite League",
    runtime: TEL_IS_VERCEL ? 'vercel' : 'node',
    persistentStorage: telRedis ? 'upstash-redis' : (TEL_IS_VERCEL ? 'temporary-only' : 'local-files'),
    adminPasswordConfigured: TEL_ADMIN_PASSWORD_CONFIGURED || !TEL_IS_VERCEL,
    sessionSecretConfigured: Boolean(process.env.WEB_SESSION_SECRET) || !TEL_IS_VERCEL,
    dataRevision: TEL_REPO_DATA_REVISION,
    dataStorageMode: 'shared-live-discord-vercel',
    liveDataKey: TEL_LIVE_DATA_KEY,
    guildId: process.env.GUILD_ID || null,
    clientId: process.env.CLIENT_ID || null
  });
});


/* ============================================================
   DATOS OFICIALES CONSISTENTES PARA WEB, CLASIFICACIÓN Y COPAS
   - Completa nombres y escudos usando la lista maestra de clubes.
   - Resuelve participantes por slotId, id, clubId o nombre.
   - Evita que las rondas posteriores pierdan el escudo.
   ============================================================ */
function telClientNorm(value){
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,' ')
    .trim();
}
function telClientCleanName(value){
  return String(value || '')
    .replace(/^(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}|\s)+/u,'')
    .trim();
}
function telClientLogo(item){
  let value = String(
    item?.escudoUrl || item?.logoUrl || item?.escudoPath || item?.escudoFilename ||
    item?.logo || item?.escudo || item?.imagenUrl || item?.imagen || ''
  ).trim().replaceAll('\\','/');
  if(!value) return '';
  if(value.startsWith('/escudos/')) return value;
  if(value.startsWith('escudos/')) return '/' + value;
  if(/^escudo-.*\.(?:png|jpe?g|webp|gif|svg)$/i.test(value)) return '/escudos/' + value;
  return value;
}
function telHydrateDataForClient(rawData){
  const data = rawData && typeof rawData === 'object'
    ? JSON.parse(JSON.stringify(rawData))
    : {clubes:[],competiciones:[]};
  const clubs = Array.isArray(data.clubes) ? data.clubes : (Array.isArray(data.equipos) ? data.equipos : []);
  const clubIndex = new Map();
  function indexObject(map,obj,values){
    values.filter(Boolean).forEach(value=>{
      const raw=String(value);
      const normalized=telClientNorm(raw);
      if(raw && !map.has(raw)) map.set(raw,obj);
      if(normalized && !map.has(normalized)) map.set(normalized,obj);
    });
  }
  clubs.forEach(club=>{
    const logo = telStableClubLogoUrl(club) || telClientLogo(club);
    if(logo) club.escudoUrl=logo;
    indexObject(clubIndex,club,[club.id,club._id,club.clubId,club.nombre,club.nombreVisual,club.clubNombre,club.name]);
  });
  function findClub(source){
    if(!source) return null;
    const values = typeof source === 'string' ? [source] : [
      source.clubId,source.idClub,source.id,source._id,source.slotId,source.clubNombre,
      source.nombre,source.nombreVisual,source.name,source.equipo,source.club
    ];
    for(const value of values){
      if(!value) continue;
      const found=clubIndex.get(String(value)) || clubIndex.get(telClientNorm(value));
      if(found) return found;
    }
    return null;
  }
  function hydrateTeam(source){
    const input = source && typeof source === 'object' ? source : {};
    const base = findClub(input) || (typeof source === 'string' ? findClub(source) : null);
    if(base){
      const canonicalName = base.nombre || base.clubNombre || base.name || telClientCleanName(base.nombreVisual) || 'Equipo';
      const canonicalVisual = base.nombreVisual || base.nombre || base.name || canonicalName;
      return {
        ...input,
        clubId: base.id || base._id || base.clubId || input.clubId || '',
        clubNombre: canonicalName,
        nombre: canonicalVisual,
        nombreVisual: canonicalVisual,
        emoji: base.emoji || input.emoji || '⚡',
        presidenteTag: base.presidenteTag || base.presidente || input.presidenteTag || '',
        escudoUrl: telStableClubLogoUrl(base) || telClientLogo(base) || telClientLogo(input) || ''
      };
    }
    const canonical = telClientCleanName(
      input.clubNombre || input.nombreVisual || input.nombre || input.name ||
      (typeof source === 'string' ? source : '') || 'Equipo'
    ) || 'Equipo';
    return {
      ...input,
      clubNombre: input.clubNombre || canonical,
      nombre: input.nombre || input.nombreVisual || canonical,
      nombreVisual: input.nombreVisual || input.nombre || canonical,
      escudoUrl: telClientLogo(input)
    };
  }
  const comps = Array.isArray(data.competiciones) ? data.competiciones : [];
  comps.forEach(comp=>{
    comp.equipos = Array.isArray(comp.equipos) ? comp.equipos.map(hydrateTeam) : [];
    const teamIndex = new Map();
    comp.equipos.forEach((team,index)=>{
      indexObject(teamIndex,team,[team.slotId,team.id,team._id,team.clubId,team.clubNombre,team.nombre,team.nombreVisual,team.name,`slot-${index+1}`]);
    });
    function resolveParticipant(reference,embeddedName){
      for(const value of [reference,embeddedName]){
        if(!value) continue;
        const found=teamIndex.get(String(value)) || teamIndex.get(telClientNorm(value));
        if(found) return found;
      }
      const club=findClub(embeddedName || reference);
      return club ? hydrateTeam(club) : (embeddedName ? hydrateTeam({clubNombre:embeddedName,nombre:embeddedName}) : null);
    }
    if(Array.isArray(comp.clasificacion)){
      comp.clasificacion = comp.clasificacion.map(row=>{
        const base=resolveParticipant(row?.slotId || row?.clubId || row?.id,row?.clubNombre || row?.nombre || row?.nombreVisual);
        return hydrateTeam({...row,...(base || {}),slotId:row?.slotId || base?.slotId || ''});
      });
    }
    if(Array.isArray(comp.partidos)){
      comp.partidos = comp.partidos.map(match=>{
        const local=resolveParticipant(match.localSlotId || match.localClubId || match.localId,match.localNombre || match.nombreLocal || match.equipoLocal);
        const away=resolveParticipant(match.visitanteSlotId || match.visitanteClubId || match.visitanteId,match.visitanteNombre || match.nombreVisitante || match.equipoVisitante);
        if(local){
          match.localNombre=telClientCleanName(local.clubNombre || local.nombre || local.nombreVisual) || 'Por definir';
          match.localLogo=telClientLogo(local);
          match.localEscudo=match.localLogo;
          match.localClubId=local.clubId || '';
          if(!match.localSlotId) match.localSlotId=local.slotId || local.id || local.clubId || '';
        }
        if(away){
          match.visitanteNombre=telClientCleanName(away.clubNombre || away.nombre || away.nombreVisual) || 'Por definir';
          match.visitanteLogo=telClientLogo(away);
          match.visitanteEscudo=match.visitanteLogo;
          match.visitanteClubId=away.clubId || '';
          if(!match.visitanteSlotId) match.visitanteSlotId=away.slotId || away.id || away.clubId || '';
        }
        return match;
      });
    }
  });
  return data;
}


app.get('/api/sync-status', async (req,res)=>{
  res.set('Cache-Control','no-store');
  let data={clubes:[],jugadores:[],competiciones:[]};
  try{ data=readJson(DATA_FILE,data); }catch(error){}
  let redisHost='';
  try{ redisHost=new URL(telRedisUrl).host; }catch(error){}
  let remoteVersion='';
  let remoteExists=false;
  try{
    if(telRedis){
      remoteVersion=String(await telRedis.get(telRedisVersionKey()) || '');
      remoteExists=(await telRedis.get(TEL_LIVE_DATA_KEY)) !== null;
    }
  }catch(error){}
  res.json({
    ok:true,
    redisConnected:Boolean(telRedis),
    redisHost,
    prefix:TEL_REDIS_SAFE_PREFIX,
    dataKey:TEL_LIVE_DATA_KEY,
    remoteExists,
    remoteVersion,
    source:data?.sync?.source || 'repo',
    updatedAt:data?.sync?.updatedAt || '',
    clubs:Array.isArray(data?.clubes)?data.clubes.length:0,
    players:Array.isArray(data?.jugadores)?data.jugadores.length:0
  });
});


app.get('/api/sync-debug', async (req,res)=>{
  res.set('Cache-Control','no-store');
  let remoteData=null;
  let remoteVersion='';
  let remoteError='';
  try{
    if(telRedis){
      const stored = await telRedis.get(TEL_LIVE_DATA_KEY);
      remoteData = typeof stored === 'string' ? JSON.parse(stored) : stored;
      remoteVersion = String(await telRedis.get(telRedisVersionKey()) || '');
    }
  }catch(error){ remoteError=String(error?.message || error); }
  let runtimeData={};
  try{ runtimeData=readJson(DATA_FILE,{}); }catch(error){}
  const count = value => Array.isArray(value?.clubes) ? value.clubes.length : (Array.isArray(value?.equipos) ? value.equipos.length : 0);
  res.json({
    ok:!remoteError,
    redisConnected:Boolean(telRedis),
    configuredPrefix:TEL_REDIS_PREFIX_RAW,
    normalizedPrefix:TEL_REDIS_SAFE_PREFIX,
    dataKey:TEL_LIVE_DATA_KEY,
    remoteClubs:count(remoteData),
    runtimeClubs:count(runtimeData),
    remoteUpdatedAt:remoteData?._sync?.updatedAt || remoteData?.sync?.updatedAt || '',
    runtimeUpdatedAt:runtimeData?._sync?.updatedAt || runtimeData?.sync?.updatedAt || '',
    remoteVersion,
    remoteError
  });
});



/* === TEL PATCH JORNADAS FOTO 1 Y 2
   Mantiene Jornada 1 y Jornada 2 exactamente como las fotos.
   Si ya hay resultados guardados, NO los borra.
   Si cambias un equipo, partidos jugados conservan antiguo y futuros pasan al nuevo.
*/
function telFotoNorm(v){
  return String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,' ').trim();
}
function telFotoSlug(v){
  return String(v||'equipo').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'') || 'equipo';
}
function telFotoName(t){
  return String(t?.nombre || t?.clubNombre || t?.name || t?.nombreVisual || '').trim();
}
function telFotoSlot(t){
  if(!t.slotId) t.slotId = String(t.id || t.clubId || t.idClub || telFotoSlug(telFotoName(t)));
  return String(t.slotId);
}
function telFotoComps(data){
  return data.competiciones || data.ligas || data.torneos || [];
}
function telFotoIsCup(comp){
  const txt = telFotoNorm(`${comp?.nombre||''} ${comp?.tipo||''} ${comp?.formato||''} ${comp?.formatoNombre||''}`);
  if(txt.includes('copa') || txt.includes('elimin')) return true;
  return (comp?.partidos||[]).some(p=>{
    const r = telFotoNorm(`${p?.rondaNombre||''} ${p?.fase||''}`);
    return r.includes('cuarto') || r.includes('semi') || r.includes('final');
  });
}
function telFotoLeague(data){
  const comps = telFotoComps(data);
  let league = comps.find(c=>{
    if(telFotoIsCup(c)) return false;
    const n = telFotoNorm(c.nombre || c.name || '');
    return n.includes('elite') || n.includes('liga') || n.includes('league');
  }) || comps.find(c=>!telFotoIsCup(c));

  if(!league){
    league = {id:'elite-league', nombre:'Élite League', tipo:'liga', equipos:[], partidos:[]};
    if(!data.competiciones) data.competiciones = comps;
    data.competiciones.push(league);
  }

  if(!league.id) league.id = telFotoSlug(league.nombre || 'elite-league');
  league.tipo = league.tipo || 'liga';
  league.equipos = league.equipos || [];
  league.partidos = league.partidos || [];
  league.partidosHistoricos = league.partidosHistoricos || [];
  return league;
}
function telFotoFindTeam(data, comp, name){
  const want = telFotoNorm(name);
  for(const t of (comp?.equipos||[])){
    const values=[t.slotId,t.id,t.clubId,t.idClub,t.nombre,t.clubNombre,t.name,t.nombreVisual].filter(Boolean);
    if(values.some(v=>String(v)===String(name)||telFotoNorm(v)===want)) return t;
  }
  for(const key of ['clubes','equipos','teams']){
    for(const t of (data[key]||[])){
      const values=[t.slotId,t.id,t.clubId,t.idClub,t.nombre,t.clubNombre,t.name,t.nombreVisual].filter(Boolean);
      if(values.some(v=>String(v)===String(name)||telFotoNorm(v)===want)) return JSON.parse(JSON.stringify(t));
    }
  }
  for(const c of telFotoComps(data)){
    for(const t of (c.equipos||[])){
      const values=[t.slotId,t.id,t.clubId,t.idClub,t.nombre,t.clubNombre,t.name,t.nombreVisual].filter(Boolean);
      if(values.some(v=>String(v)===String(name)||telFotoNorm(v)===want)) return JSON.parse(JSON.stringify(t));
    }
  }
  return null;
}
function telFotoEnsureTeam(data, comp, name){
  let t = telFotoFindTeam(data, comp, name);
  if(!t){
    t = {id:telFotoSlug(name), slotId:telFotoSlug(name), nombre:name, clubNombre:name,
      escudoUrl:`/escudos/${telFotoSlug(name)}.png`,
      escudoPath:`escudos/${telFotoSlug(name)}.png`,
      escudoFilename:`${telFotoSlug(name)}.png`
    };
    comp.equipos.push(t);
  }else if(!(comp.equipos||[]).includes(t)){
    const existing = comp.equipos.find(x=>telFotoNorm(telFotoName(x))===telFotoNorm(name));
    if(existing) t = existing;
    else comp.equipos.push(t);
  }
  t.nombre = name;
  t.clubNombre = name;
  if(!t.id) t.id = telFotoSlug(name);
  if(!t.slotId) t.slotId = String(t.id || telFotoSlug(name));
  return t;
}
function telFotoValidScore(v){
  return v !== null && v !== undefined && v !== '' && !Number.isNaN(Number(v));
}
function telFotoPlayed(m){
  return !!m && (
    m.finalizado === true ||
    ['finalizado','jugado','completado'].includes(String(m.estado||'').toLowerCase()) ||
    (telFotoValidScore(m.localGoles) && telFotoValidScore(m.visitanteGoles)) ||
    (telFotoValidScore(m.golesLocal) && telFotoValidScore(m.golesVisitante)) ||
    /\d+\s*[-:]\s*\d+/.test(String(m.resultado||''))
  );
}
function telFotoGoals(m, side){
  if(!m) return null;
  if(side === 'local'){
    if(telFotoValidScore(m.localGoles)) return Number(m.localGoles);
    if(telFotoValidScore(m.golesLocal)) return Number(m.golesLocal);
  }else{
    if(telFotoValidScore(m.visitanteGoles)) return Number(m.visitanteGoles);
    if(telFotoValidScore(m.golesVisitante)) return Number(m.golesVisitante);
  }
  const r = String(m.resultado||'').match(/(\d+)\s*[-:]\s*(\d+)/);
  if(r) return side === 'local' ? Number(r[1]) : Number(r[2]);
  return null;
}
function telFotoSamePair(match, comp, local, away){
  const a = telFotoNorm(local), b = telFotoNorm(away);
  const localNames = [match.localNombre, match.nombreLocal, match.equipoLocal].filter(Boolean).map(telFotoNorm);
  const awayNames = [match.visitanteNombre, match.nombreVisitante, match.equipoVisitante].filter(Boolean).map(telFotoNorm);

  const localTeam = (comp.equipos||[]).find(t=>String(t.slotId||'')===String(match.localSlotId||''));
  const awayTeam = (comp.equipos||[]).find(t=>String(t.slotId||'')===String(match.visitanteSlotId||''));
  if(localTeam) localNames.push(telFotoNorm(telFotoName(localTeam)));
  if(awayTeam) awayNames.push(telFotoNorm(telFotoName(awayTeam)));

  return localNames.includes(a) && awayNames.includes(b);
}
function telFotoApplyOfficialJornadas(data){
  if(!data || typeof data !== 'object') return data;
  const league = telFotoLeague(data);

  const jornadas = {
    1: [
      ['Catalunya Lliure', 'Ghost Unit'],
      ['Alegria FCA', 'Unió catalana'],
      ['COVAYERS FC', 'BLACK MECANIC'],
      ['Fuzeteam FC B', 'Hamoods CF'],
      ['Billar FC', 'Coral Springs A']
    ],
    2: [
      ['Unió catalana', 'Catalunya Lliure'],
      ['BLACK MECANIC', 'Ghost Unit'],
      ['Hamoods CF', 'Alegria FCA'],
      ['Coral Springs A', 'COVAYERS FC'],
      ['Billar FC', 'Fuzeteam FC B']
    ]
  };

  const allTeams = [...new Set(Object.values(jornadas).flat(2))];
  const teamMap = new Map();
  for(const name of allTeams){
    const t = telFotoEnsureTeam(data, league, name);
    teamMap.set(telFotoNorm(name), t);
  }
  const slotOf = name => telFotoSlot(teamMap.get(telFotoNorm(name)));

  const old = Array.isArray(league.partidos) ? league.partidos : [];
  const used = new Set();
  const fixed = [];

  for(const [jornada, games] of Object.entries(jornadas)){
    games.forEach(([local,away], index)=>{
      const id = `${league.id}-j${jornada}-p${index+1}`;
      let oldIndex = old.findIndex((m,i)=>{
        if(used.has(i)) return false;
        const j = Number(m.jornada || m.round || 0);
        if(j !== Number(jornada)) return false;
        return String(m.id||'') === id || telFotoSamePair(m, league, local, away);
      });
      const m = oldIndex >= 0 ? old[oldIndex] : null;
      if(oldIndex >= 0) used.add(oldIndex);

      const lg = telFotoGoals(m,'local');
      const vg = telFotoGoals(m,'away');
      const played = telFotoPlayed(m);

      fixed.push({
        ...(m || {}),
        id,
        jornada:Number(jornada),
        round:Number(jornada),
        localSlotId: slotOf(local),
        visitanteSlotId: slotOf(away),
        localNombre: local,
        visitanteNombre: away,
        nombreLocal: local,
        nombreVisitante: away,
        localGoles: lg,
        visitanteGoles: vg,
        golesLocal: lg,
        golesVisitante: vg,
        resultado: played && lg !== null && vg !== null ? `${lg}-${vg}` : (m?.resultado || ''),
        estado: played ? 'finalizado' : (m?.estado || 'pendiente'),
        finalizado: played,
        fecha: m?.fecha || m?.date || '',
        hora: m?.hora || m?.time || ''
      });
    });
  }

  const kept = [];
  old.forEach((m,i)=>{
    if(used.has(i)) return;
    const j = Number(m.jornada || m.round || 0);
    if(j === 1 || j === 2){
      if(telFotoPlayed(m)){
        const hist = JSON.parse(JSON.stringify(m));
        hist.historico = true;
        hist.motivoHistorico = 'Archivado al fijar Jornada 1 y Jornada 2 como foto';
        league.partidosHistoricos.push(hist);
      }
      return;
    }
    kept.push(m);
  });

  league.partidos = [...fixed, ...kept];

  if(typeof telReplaceTeamApplyActive === 'function'){
    telReplaceTeamApplyActive(data);
  }

  data.historialCambiosJornadas = data.historialCambiosJornadas || [];
  const last = data.historialCambiosJornadas[data.historialCambiosJornadas.length - 1];
  if(!last || last.accion !== 'jornada-1-2-igual-foto-sin-borrar-resultados'){
    data.historialCambiosJornadas.push({
      fecha:new Date().toISOString(),
      accion:'jornada-1-2-igual-foto-sin-borrar-resultados',
      competicion:league.nombre||league.id,
      partidosFijados:fixed.length
    });
  }
  return data;
}
function telFotoSave(data){
  fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2), 'utf8');
  return data;
}
function telFotoForceAndSave(data){
  telFotoApplyOfficialJornadas(data);
  telFotoSave(data);
  return data;
}

app.get('/api/admin/aplicar-jornadas-foto', requireAdmin, (req,res)=>{
  try{
    const data = readJson(DATA_FILE, {clubes:[], competiciones:[]});
    telFotoForceAndSave(data);
    res.set('Cache-Control','no-store');
    res.json({
      ok:true,
      message:'Jornada 1 y Jornada 2 quedaron igual que la foto y sin borrar resultados.',
      jornada1:[
        ['Catalunya Lliure','Ghost Unit'],
        ['Alegria FCA','Unió catalana'],
        ['COVAYERS FC','BLACK MECANIC'],
        ['Fuzeteam FC B','Hamoods CF'],
        ['Billar FC','Coral Springs A']
      ],
      jornada2:[
        ['Unió catalana','Catalunya Lliure'],
        ['BLACK MECANIC','Ghost Unit'],
        ['Hamoods CF','Alegria FCA'],
        ['Coral Springs A','COVAYERS FC'],
        ['Billar FC','Fuzeteam FC B']
      ]
    });
  }catch(error){
    res.status(500).json({ok:false,message:String(error.message||error)});
  }
});
/* === FIN TEL PATCH JORNADAS FOTO 1 Y 2 */


app.get("/api/data", (req, res) => {
  res.set("Cache-Control", "no-store");
  const data = readJson(DATA_FILE, {
    clubes: [],
    jugadores: [],
    mercado: [],
    ticketsActivos: [],
    sanciones: [],
    config: {}
  });

  telFotoForceAndSave(data);
  res.json(telHydrateDataForClient(data));
});

app.get("/api/ligas", (req, res) => {
  res.set("Cache-Control", "no-store");
  const data = readJson(DATA_FILE, {});
  telFotoForceAndSave(data);
  res.json(getRealLeagues(data));
});

app.get("/api/raw-clubes", (req, res) => {
  res.set("Cache-Control", "no-store");
  const data = readJson(DATA_FILE, {});
  res.json(data.clubes || data.equipos || data.teams || []);
});

app.get("/api/clubes", (req, res) => {
  res.set("Cache-Control", "no-store");
  const data = readJson(DATA_FILE, { clubes: [], jugadores: [], competiciones: [] });
  const rawClubes = findDataList(data, ["clubes", "equipos", "teams"]);
  const ligas = getRealLeagues(data);
  const ligaParam = String(req.query.liga || req.query.competicion || "").trim();

  let selectedLeague = null;
  if (ligaParam && ligaParam !== "all") {
    selectedLeague = ligas.find(l =>
      normalizeText(l.id) === normalizeText(ligaParam) ||
      normalizeText(l.nombre) === normalizeText(ligaParam)
    ) || null;
  }

  const clubes = rawClubes
    .filter(club => clubBelongsToLeague(club, selectedLeague))
    .map(rawClub => {
      const club = normalizeClubForWeb(rawClub, data);
      const calculated = telClubStatsForProfile(rawClub, club, data);
      return {...club, stats:calculated.stats, league:calculated.league};
    });

  res.json(clubes);
});


function telClubStatsIsLeague(comp){
  const raw = normalizeText(`${comp?.tipo || ''} ${comp?.formato || ''} ${comp?.formatoNombre || ''}`);
  if(raw.includes('copa') || raw.includes('torneo') || raw.includes('elimin')) return false;
  if(raw.includes('liga')) return true;
  return !(comp?.partidos || []).some(match => {
    const phase = normalizeText(`${match?.rondaNombre || ''} ${match?.fase || ''}`);
    return phase.includes('cuarto') || phase.includes('semi') || phase.includes('final');
  });
}

function telClubStatsPlayed(match){
  if(!match) return false;
  const hasDirectScores =
    match.localGoles !== null && match.localGoles !== undefined &&
    match.visitanteGoles !== null && match.visitanteGoles !== undefined;
  const hasLegacyScores =
    match.golesLocal !== null && match.golesLocal !== undefined &&
    match.golesVisitante !== null && match.golesVisitante !== undefined;
  return match.finalizado === true ||
    ['finalizado','jugado'].includes(String(match.estado || '').toLowerCase()) ||
    hasDirectScores || hasLegacyScores || /\d+\s*[-:]\s*\d+/.test(String(match.resultado || ''));
}

function telClubStatsGoals(match){
  let local = match?.localGoles ?? match?.golesLocal;
  let away = match?.visitanteGoles ?? match?.golesVisitante;
  if((local === null || local === undefined || away === null || away === undefined) && match?.resultado){
    const parsed = String(match.resultado).match(/(\d+)\s*[-:]\s*(\d+)/);
    if(parsed){ local = Number(parsed[1]); away = Number(parsed[2]); }
  }
  return {local:Number(local ?? 0), away:Number(away ?? 0)};
}

function telClubStatsTeamKey(team, index){
  return String(team?.slotId || team?.id || team?.clubId || team?.nombre || team?.clubNombre || `slot-${index+1}`);
}

function telClubStatsMatchesClub(team, rawClub, normalizedClub){
  if(!team) return false;
  const rawId = String(rawClub?.id || rawClub?._id || '').trim();
  const teamClubId = String(team.clubId || team.idClub || '').trim();
  if(rawId && teamClubId && rawId === teamClubId) return true;
  const candidates = [team.clubNombre, team.nombre, team.nombreVisual, team.name]
    .filter(Boolean).map(normalizeText);
  return candidates.includes(normalizeText(normalizedClub.nombre));
}

function telClubStatsTable(comp){
  const rows = new Map();
  (comp?.equipos || []).forEach((team,index)=>{
    const slotId = telClubStatsTeamKey(team,index);
    rows.set(slotId, {
      slotId,
      clubId:String(team?.clubId || ''),
      nombre:team?.clubNombre || team?.nombre || team?.nombreVisual || `Equipo ${index+1}`,
      pj:0,pg:0,pe:0,pp:0,gf:0,gc:0,dg:0,pts:0
    });
  });

  (comp?.partidos || []).forEach(match=>{
    if(!telClubStatsPlayed(match)) return;
    const local = rows.get(String(match.localSlotId || ''));
    const away = rows.get(String(match.visitanteSlotId || ''));
    if(!local || !away) return;
    const goals = telClubStatsGoals(match);
    local.pj += 1; away.pj += 1;
    local.gf += goals.local; local.gc += goals.away;
    away.gf += goals.away; away.gc += goals.local;
    if(goals.local > goals.away){ local.pg += 1; local.pts += 3; away.pp += 1; }
    else if(goals.local < goals.away){ away.pg += 1; away.pts += 3; local.pp += 1; }
    else { local.pe += 1; away.pe += 1; local.pts += 1; away.pts += 1; }
    local.dg = local.gf - local.gc;
    away.dg = away.gf - away.gc;
  });

  return [...rows.values()].sort((a,b)=>
    (b.pts-a.pts) || (b.dg-a.dg) || (b.gf-a.gf) || String(a.nombre).localeCompare(String(b.nombre),'es')
  );
}

function telClubStatsForProfile(rawClub, normalizedClub, data){
  const competitions = findDataList(data, ['competiciones','ligas','leagues'])
    .filter(telClubStatsIsLeague);
  const candidates = [];

  competitions.forEach((comp,index)=>{
    const teams = comp.equipos || [];
    const team = teams.find(item=>telClubStatsMatchesClub(item,rawClub,normalizedClub));
    if(!team) return;
    const slotId = telClubStatsTeamKey(team,teams.indexOf(team));
    const table = telClubStatsTable(comp);
    const rowIndex = table.findIndex(row=>String(row.slotId) === String(slotId));
    const row = rowIndex >= 0 ? table[rowIndex] : {pj:0,pg:0,pe:0,pp:0,gf:0,gc:0,dg:0,pts:0};
    const state = normalizeText(comp.estado || '');
    candidates.push({
      priority:state.includes('activa') ? 0 : state.includes('final') ? 1 : 2,
      index,
      stats:{
        pj:Number(row.pj || 0), pg:Number(row.pg || 0), pe:Number(row.pe || 0), pp:Number(row.pp || 0),
        gf:Number(row.gf || 0), gc:Number(row.gc || 0), dg:Number(row.dg || 0), pts:Number(row.pts || 0)
      },
      league:{
        id:String(comp.id || comp.nombre || `liga-${index+1}`),
        nombre:String(comp.nombre || 'Liga'),
        posicion:rowIndex >= 0 ? rowIndex + 1 : 0,
        totalEquipos:table.length,
        puntos:Number(row.pts || 0)
      }
    });
  });

  candidates.sort((a,b)=>a.priority-b.priority || a.index-b.index);
  return candidates[0] || {
    stats:{pj:0,pg:0,pe:0,pp:0,gf:0,gc:0,dg:0,pts:0},
    league:{id:'',nombre:'Sin liga',posicion:0,totalEquipos:0,puntos:0}
  };
}

app.get("/api/clubes/:clubId", (req, res) => {
  res.set("Cache-Control", "no-store");
  const data = readJson(DATA_FILE, { clubes: [], jugadores: [], competiciones: [] });
  const rawClubes = findDataList(data, ["clubes", "equipos", "teams"]);
  const wanted = normalizeText(req.params.clubId);
  const rawClub = rawClubes.find(club =>
    normalizeText(club.id || club._id || "") === wanted ||
    normalizeText(club.nombre || club.name || "") === wanted ||
    normalizeText(club.nombreVisual || "") === wanted
  );
  if (!rawClub) return res.status(404).json({ ok:false, message:"Equipo no encontrado." });

  const club = normalizeClubForWeb(rawClub, data);
  const calculated = telClubStatsForProfile(rawClub, club, data);
  let fileUpdatedAt = new Date().toISOString();
  try{ fileUpdatedAt = fs.statSync(DATA_FILE).mtime.toISOString(); }catch(error){}
  res.json({
    ok:true,
    club,
    plantilla:club.plantilla,
    stats:calculated.stats,
    league:calculated.league,
    sync:{...(data.sync || {}), updatedAt:fileUpdatedAt}
  });
});

app.get("/api/competiciones", (req, res) => {
  res.set("Cache-Control", "no-store");
  const data = readJson(DATA_FILE, { competiciones: [] });
  telFotoForceAndSave(data);
  res.json(data.competiciones || []);
});

app.get("/api/jugadores", (req, res) => {
  const data = readJson(DATA_FILE, { jugadores: [] });
  res.json(data.jugadores || []);
});

app.get("/api/sanciones", (req, res) => {
  const data = readJson(DATA_FILE, { sanciones: [] });
  res.json(data.sanciones || []);
});

app.get("/api/comandos", (req, res) => {
  res.json(readJson(COMMANDS_FILE, []));
});

// Escudo estable por ID o nombre del club.
app.get('/api/club-logo', async (req,res)=>{
  try{
    const requestedKey = String(req.query.key || '').trim();
    if(!requestedKey){
      res.set('Cache-Control','no-store');
      return res.status(400).send('Falta la clave del escudo');
    }

    const data = readJson(DATA_FILE, {clubes:[],competiciones:[]});
    const club = telFindClubByKey(data, requestedKey);

    // Consulta primero la clave solicitada directamente. Esto permite mostrar el
    // escudo de un club recién creado incluso durante los segundos en los que la
    // lista de clubes de otra instancia serverless todavía se está actualizando.
    if(telRedis){
      try{
        const aliases = club
          ? telClubLogoRedisAliases(club, requestedKey)
          : [...new Set([requestedKey, normalizeText(requestedKey), telLogoSlug(requestedKey)].filter(Boolean))];

        for(const alias of aliases){
          const stored = await telRedis.get(telClubLogoRedisKey(alias));
          if(stored === null || stored === undefined) continue;
          let payload = stored;
          if(typeof payload === 'string'){
            try{ payload = JSON.parse(payload); }catch(error){ payload = null; }
          }
          if(payload && payload.base64){
            const buffer = Buffer.from(String(payload.base64), 'base64');
            if(buffer.length){
              res.set('Content-Type', String(payload.contentType || 'image/png'));
              res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
              res.set('X-TEL-Logo-Key', String(alias));
              return res.send(buffer);
            }
          }
          if(payload && /^https?:\/\//i.test(String(payload.remoteUrl || ''))){
            res.set('Cache-Control','no-store');
            return res.redirect(302, '/api/logo?url=' + encodeURIComponent(String(payload.remoteUrl)));
          }
        }
      }catch(error){
        console.warn('[club-logo] No se pudo leer el escudo de Upstash:', error.message || error);
      }
    }

    if(club){
      const source = telResolveClubLogo(club);
      if(source){
        res.set('Cache-Control','no-store');
        if(source.type === 'file') return res.sendFile(source.value);
        return res.redirect(302, '/api/logo?url=' + encodeURIComponent(source.value));
      }
    }

    res.set('Cache-Control','no-store');
    return res.status(404).send('Escudo no encontrado');
  }catch(error){
    console.error('[club-logo]',error);
    res.set('Cache-Control','no-store');
    return res.status(404).send('Escudo no encontrado');
  }
});

// Proxy local de escudos/logos.
// Evita problemas de carga directa desde Discord/CDN y permite fallback en la web.
app.get("/api/logo", async (req, res) => {
  try {
    const rawUrl = String(req.query.url || "");
    if (!rawUrl) return res.status(400).send("URL inválida");

    if (rawUrl.startsWith("/escudos/") || rawUrl.startsWith("escudos/")) {
      const safeName = path.basename(rawUrl);
      return res.sendFile(path.join(__dirname, "public", "escudos", safeName));
    }

    if (!/^https?:\/\//i.test(rawUrl)) return res.status(400).send("URL inválida");

    const response = await fetch(rawUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 ThunderEliteLeague",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      }
    });

    if (!response.ok) return res.status(response.status).send("No se pudo cargar el logo");

    const contentType = response.headers.get("content-type") || "image/png";
    const buffer = Buffer.from(await response.arrayBuffer());
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=3600");
    res.send(buffer);
  } catch (error) {
    console.error("Error proxy logo:", error);
    res.status(500).send("Error cargando logo");
  }
});


/* AUTH DISCORD OBLIGATORIO PARA CUENTAS WEB */
app.get('/auth/discord', (req, res) => {
  if(!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET){
    return res.status(500).send(discordErrorPage(
      'Faltan datos de Discord',
      'Debes completar DISCORD_CLIENT_ID y DISCORD_CLIENT_SECRET en el archivo .env.',
      `DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_REDIRECT_URI=http://localhost:3000/auth/discord/callback`
    ));
  }

  const state = crypto.randomBytes(16).toString('hex');
  req.session.discordOAuthState = state;

  const redirectUri = discordRedirectUri(req);

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify email',
    state
  });

  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  try{
    const { code, state, error, error_description } = req.query;

    if(error){
      return res.status(400).send(discordErrorPage(
        'Discord canceló el login',
        'Discord devolvió un error antes de validar la cuenta.',
        `${error}
${error_description || ''}`
      ));
    }

    if(!code || !state || state !== req.session.discordOAuthState){
      return res.status(400).send(discordErrorPage(
        'Estado de Discord inválido',
        'La sesión del login no coincide. Vuelve a iniciar sesión desde el botón de Discord.',
        'Consejo: no recargues la página de callback y no reutilices el mismo enlace.'
      ));
    }

    delete req.session.discordOAuthState;

    const redirectUri = discordRedirectUri(req);

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type':'application/x-www-form-urlencoded',
        'Accept':'application/json'
      },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: redirectUri
      })
    });

    const tokenText = await tokenRes.text();
    let token;
    try{ token = JSON.parse(tokenText); }catch(e){ token = null; }

    if(!tokenRes.ok){
      console.error('[auth] Discord token error:', tokenText);
      return res.status(401).send(discordErrorPage(
        'No se pudo validar Discord',
        'Discord rechazó el código OAuth. Normalmente pasa por una de estas razones: Client Secret incorrecto, Client ID incorrecto, o Redirect URI diferente al configurado en Discord Developer Portal.',
        `Redirect usado por la web:
${redirectUri}

Respuesta de Discord:
${tokenText}`
      ));
    }

    const accessToken = token.access_token;
    const tokenType = token.token_type || 'Bearer';

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `${tokenType} ${accessToken}` }
    });

    const userText = await userRes.text();
    let discordUser;
    try{ discordUser = JSON.parse(userText); }catch(e){ discordUser = null; }

    if(!userRes.ok || !discordUser || !discordUser.id){
      console.error('[auth] Discord user error:', userText);
      return res.status(401).send(discordErrorPage(
        'No se pudo obtener tu usuario de Discord',
        'El token se recibió, pero Discord no devolvió el usuario.',
        userText
      ));
    }

    const discordId = String(discordUser.id);
    const discordUsername = discordUser.global_name || discordUser.username || 'Discord';
    const discordEmail = discordUser.email || '';

    const db = readAuthDb();

    let linked = db.discordLinks.find(x => String(x.discordId) === discordId);
    let account;

    if(linked){
      account = db.accounts.find(x => x.id === linked.webAccountId);
      if(!account) linked = null;
    }

    if(!linked){
      const webAccountId = crypto.randomUUID();
      account = {
        id: webAccountId,
        username: discordUsername,
        email: discordEmail,
        discordId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      db.accounts.push(account);
      db.discordLinks.push({
        discordId,
        webAccountId,
        linkedAt: new Date().toISOString()
      });
      writeAuthDb(db);
    }

    req.session.webAccountId = account.id;
    req.session.discordId = discordId;
    req.session.discordUser = {
      id: discordId,
      username: discordUser.username,
      globalName: discordUser.global_name,
      avatar: discordUser.avatar,
      email: discordEmail
    };

    res.redirect('/?login=discord-ok#mi-cuenta');
  }catch(error){
    console.error('[auth] Discord callback error:', error);
    res.status(500).send(discordErrorPage(
      'Error iniciando sesión con Discord',
      'Ha ocurrido un error interno durante el callback de Discord.',
      String(error && error.stack ? error.stack : error)
    ));
  }
});

app.get('/api/auth/me', (req, res) => {
  if(req.session && req.session.isAdmin === true){
    return res.json({
      ok:true,
      authenticated:true,
      admin:true,
      account:{
        id:'admin-local',
        username:'Administrador',
        email:ADMIN_EMAIL || 'roleplayserver007@gmail.com',
        role:'admin'
      },
      discord:null
    });
  }

  if(!req.session || !req.session.webAccountId || !req.session.discordId){
    return res.json({ok:false, authenticated:false});
  }

  const db = readAuthDb();
  const account = db.accounts.find(x => x.id === req.session.webAccountId);

  res.json({
    ok:true,
    authenticated:true,
    admin:false,
    account: account || null,
    discord: req.session.discordUser || {id:req.session.discordId}
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ok:true});
  });
});

app.get('/api/auth/discord-links', requireWebLogin, (req, res) => {
  const db = readAuthDb();
  const link = db.discordLinks.find(x => x.webAccountId === req.session.webAccountId);
  res.json({ok:true, link});
});



/* ADMIN RESULTADOS MANUALES + CLASIFICACIÓN AUTOMÁTICA */
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'roleplayserver007@gmail.com').toLowerCase();
const ADMIN_PASSWORD = TEL_ADMIN_PASSWORD;

function requireAdmin(req, res, next){
  if(req.session && req.session.isAdmin === true && String(req.session.adminEmail || '').toLowerCase() === ADMIN_EMAIL){
    return next();
  }
  return res.status(403).json({
    ok:false,
    error:'admin_required',
    message:'Solo la cuenta admin puede modificar resultados.'
  });
}

function dataFilePath(){
  return path.join(__dirname, 'data.json');
}

function readLeagueData(){
  const file = dataFilePath();
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function writeLeagueData(data){
  fs.writeFileSync(dataFilePath(), JSON.stringify(data, null, 2), 'utf8');
}

function cleanAdminName(value){
  return String(value || 'Equipo').replace(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic}|\s)+/u, '').trim();
}

function normalizeAdmin(value){
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[^\w]+/g,' ')
    .trim();
}

function getCompetitionsAdmin(data){
  return (data.competiciones || data.ligas || data.torneos || []).map((c, i) => ({
    ...c,
    id: String(c.id || c._id || c.nombre || c.name || `comp-${i+1}`),
    nombre: String(c.nombre || c.name || c.titulo || `Competición ${i+1}`),
    equipos: c.equipos || [],
    partidos: c.partidos || [],
    clasificacion: c.clasificacion || []
  }));
}

function isCupCompetitionAdmin(comp){
  const tipo = normalizeAdmin(comp.tipo || '');
  const formato = normalizeAdmin(comp.formato || comp.formatoNombre || comp.formatoDescripcion || '');
  return (tipo && tipo !== 'liga') || formato.includes('elimin') || formato.includes('torneo') || formato.includes('copa') || (comp.partidos || []).some(p => String(p.fase || '').toLowerCase() === 'eliminatoria' || p.eliminatoria);
}

function teamBySlotAdmin(comp, slotId){
  return (comp.equipos || []).find(t => String(t.slotId) === String(slotId)) || null;
}

function teamLabelAdmin(team){
  return cleanAdminName(team?.nombre || team?.clubNombre || team?.nombreVisual || team?.name || 'Equipo');
}

function recalcLeagueClassificationAdmin(comp){
  const rowsBySlot = new Map();

  (comp.equipos || []).forEach((team, index) => {
    const slotId = String(team.slotId || team.id || team.clubNombre || team.nombre || `slot-${index+1}`);
    rowsBySlot.set(slotId, {
      ...team,
      slotId,
      nombre: team.nombre || team.clubNombre || team.nombreVisual || team.name || `Equipo ${index+1}`,
      clubNombre: team.clubNombre || team.nombre || team.nombreVisual || team.name || `Equipo ${index+1}`,
      pj:0, pg:0, pe:0, pp:0, gf:0, gc:0, dg:0, pts:0
    });
  });

  (comp.partidos || []).forEach(match => {
    const played = match && (
      match.estado === 'finalizado' ||
      match.estado === 'jugado' ||
      match.estado === 'completado' ||
      (match.localGoles !== null && match.localGoles !== undefined && match.visitanteGoles !== null && match.visitanteGoles !== undefined)
    );

    if(!played) return;

    const localSlot = String(match.localSlotId || '');
    const awaySlot = String(match.visitanteSlotId || '');
    if(!rowsBySlot.has(localSlot) || !rowsBySlot.has(awaySlot)) return;

    const local = rowsBySlot.get(localSlot);
    const away = rowsBySlot.get(awaySlot);
    const lg = Number(match.localGoles || 0);
    const vg = Number(match.visitanteGoles || 0);

    local.pj++; away.pj++;
    local.gf += lg; local.gc += vg;
    away.gf += vg; away.gc += lg;
    local.dg = local.gf - local.gc;
    away.dg = away.gf - away.gc;

    if(lg > vg){
      local.pg++; away.pp++;
      local.pts += 3;
    }else if(lg < vg){
      away.pg++; local.pp++;
      away.pts += 3;
    }else{
      local.pe++; away.pe++;
      local.pts += 1;
      away.pts += 1;
    }
  });

  const rows = Array.from(rowsBySlot.values()).sort((a,b) =>
    (Number(b.pts||0) - Number(a.pts||0)) ||
    (Number(b.dg||0) - Number(a.dg||0)) ||
    (Number(b.gf||0) - Number(a.gf||0)) ||
    String(a.nombre || a.clubNombre || '').localeCompare(String(b.nombre || b.clubNombre || ''))
  );

  comp.clasificacion = rows;
}

function roundKeyAdmin(match){
  const txt = normalizeAdmin(match.rondaNombre || match.fase || '');
  if(txt.includes('cuarto')) return 'qf';
  if(txt.includes('semi')) return 'sf';
  if(txt.includes('final')) return 'final';
  const r = Number(match.ronda || 0);
  if(r >= 3) return 'final';
  if(r === 2) return 'sf';
  return 'qf';
}

function winnerSlotAdmin(match){
  if(match.localGoles === null || match.localGoles === undefined || match.visitanteGoles === null || match.visitanteGoles === undefined) return null;
  const lg = Number(match.localGoles);
  const vg = Number(match.visitanteGoles);
  if(lg === vg) return null;
  return lg > vg ? match.localSlotId : match.visitanteSlotId;
}

function loserSlotAdmin(match){
  if(match.localGoles === null || match.localGoles === undefined || match.visitanteGoles === null || match.visitanteGoles === undefined) return null;
  const lg = Number(match.localGoles);
  const vg = Number(match.visitanteGoles);
  if(lg === vg) return null;
  return lg > vg ? match.visitanteSlotId : match.localSlotId;
}

function resetAdvancedMatchesAdmin(comp){
  const byRound = {qf: [], sf: [], final: []};
  (comp.partidos || []).forEach((m, i) => {
    m.__index = i;
    byRound[roundKeyAdmin(m)].push(m);
  });

  byRound.sf.forEach(m => {
    if(!m.__manualSlotLock){
      m.localSlotId = m.localSlotId && String(m.localSlotId).startsWith('W') ? m.localSlotId : '';
      m.visitanteSlotId = m.visitanteSlotId && String(m.visitanteSlotId).startsWith('W') ? m.visitanteSlotId : '';
    }
  });

  byRound.final.forEach(m => {
    if(!m.__manualSlotLock){
      m.localSlotId = m.localSlotId && String(m.localSlotId).startsWith('W') ? m.localSlotId : '';
      m.visitanteSlotId = m.visitanteSlotId && String(m.visitanteSlotId).startsWith('W') ? m.visitanteSlotId : '';
    }
  });
}

function advanceCupAdmin(comp){
  const matches = comp.partidos || [];
  const byRound = {qf: [], sf: [], final: []};

  matches.forEach((m, i) => {
    m.__index = i;
    byRound[roundKeyAdmin(m)].push(m);
  });

  byRound.qf.sort((a,b)=>a.__index-b.__index);
  byRound.sf.sort((a,b)=>a.__index-b.__index);
  byRound.final.sort((a,b)=>a.__index-b.__index);

  // Semifinal 1: ganadores QF 1 y QF 2. Semifinal 2: ganadores QF 3 y QF 4.
  if(byRound.sf[0]){
    const w1 = winnerSlotAdmin(byRound.qf[0]);
    const w2 = winnerSlotAdmin(byRound.qf[1]);
    if(w1) byRound.sf[0].localSlotId = w1;
    if(w2) byRound.sf[0].visitanteSlotId = w2;
  }
  if(byRound.sf[1]){
    const w3 = winnerSlotAdmin(byRound.qf[2]);
    const w4 = winnerSlotAdmin(byRound.qf[3]);
    if(w3) byRound.sf[1].localSlotId = w3;
    if(w4) byRound.sf[1].visitanteSlotId = w4;
  }

  // Final: ganadores de semifinales.
  if(byRound.final[0]){
    const sf1 = winnerSlotAdmin(byRound.sf[0]);
    const sf2 = winnerSlotAdmin(byRound.sf[1]);
    if(sf1) byRound.final[0].localSlotId = sf1;
    if(sf2) byRound.final[0].visitanteSlotId = sf2;
  }

  // Guardar campeón si la final está resuelta.
  const final = byRound.final[0];
  if(final){
    const winnerSlot = winnerSlotAdmin(final);
    const loserSlot = loserSlotAdmin(final);
    const champion = teamBySlotAdmin(comp, winnerSlot);
    const runner = teamBySlotAdmin(comp, loserSlot);
    comp.campeon = champion ? {
      slotId: winnerSlot,
      nombre: teamLabelAdmin(champion),
      escudoUrl: champion.escudoUrl || champion.logoUrl || champion.escudo || ''
    } : null;
    comp.subcampeon = runner ? {
      slotId: loserSlot,
      nombre: teamLabelAdmin(runner),
      escudoUrl: runner.escudoUrl || runner.logoUrl || runner.escudo || ''
    } : null;
  }

  matches.forEach(m => delete m.__index);
}

function recalcAllAdmin(data){
  getCompetitionsAdmin(data).forEach(comp => {
    if(isCupCompetitionAdmin(comp)){
      advanceCupAdmin(comp);
    }else{
      recalcLeagueClassificationAdmin(comp);
    }
  });
}

function findCompetitionMutableAdmin(data, compId){
  const comps = data.competiciones || data.ligas || data.torneos || [];
  return comps.find((c, i) => {
    const id = String(c.id || c._id || c.nombre || c.name || `comp-${i+1}`);
    return id === String(compId) || normalizeAdmin(id) === normalizeAdmin(compId) || normalizeAdmin(c.nombre || c.name || '') === normalizeAdmin(compId);
  });
}

function findMatchMutableAdmin(comp, matchId){
  const partidos = comp.partidos || [];
  return partidos.find((m, i) => {
    const id = String(m.id || m.partidoId || `${comp.id || comp.nombre}-${i}`);
    return id === String(matchId) || String(i) === String(matchId);
  });
}

app.post('/api/admin/login', express.json(), (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if(email !== ADMIN_EMAIL){
    return res.status(403).json({ok:false, error:'not_admin_email', message:'Este correo no es la cuenta admin.'});
  }

  if(password !== ADMIN_PASSWORD){
    return res.status(403).json({ok:false, error:'bad_admin_password', message:'Contraseña admin incorrecta.'});
  }

  req.session.isAdmin = true;
  req.session.adminEmail = ADMIN_EMAIL;
  req.session.webAccountId = 'admin-local';
  req.session.discordId = null;
  req.session.discordUser = null;

  // Guardar la sesión antes de responder evita que el navegador cambie de página
  // antes de que la cookie/sesión de administrador esté persistida.
  req.session.save((error)=>{
    if(error){
      console.error('[admin-login-session-save]', error);
      return res.status(500).json({ok:false,error:'session_save_failed',message:'No se pudo guardar la sesión. Inténtalo de nuevo.'});
    }
    res.set('Cache-Control','no-store');
    res.json({ok:true, admin:true, email:ADMIN_EMAIL});
  });
});

app.post('/api/admin/logout', (req, res) => {
  if(req.session){
    req.session.isAdmin = false;
    delete req.session.adminEmail;
  }
  res.json({ok:true});
});

app.get('/api/admin/status', (req, res) => {
  res.json({
    ok:true,
    admin: !!(req.session && req.session.isAdmin === true && String(req.session.adminEmail || '').toLowerCase() === ADMIN_EMAIL),
    email: req.session?.adminEmail || null
  });
});

app.post('/api/admin/resultado', express.json(), requireAdmin, (req, res) => {
  try{
    const { compId, matchId, localGoles, visitanteGoles } = req.body || {};

    if(compId === undefined || matchId === undefined){
      return res.status(400).json({ok:false, error:'missing_ids', message:'Faltan compId o matchId.'});
    }

    const lg = Number(localGoles);
    const vg = Number(visitanteGoles);

    if(!Number.isInteger(lg) || !Number.isInteger(vg) || lg < 0 || vg < 0){
      return res.status(400).json({ok:false, error:'bad_score', message:'Los goles deben ser números enteros positivos.'});
    }

    const data = readLeagueData();
    const comp = findCompetitionMutableAdmin(data, compId);
    if(!comp) return res.status(404).json({ok:false, error:'competition_not_found', message:'Competición no encontrada.'});

    const match = findMatchMutableAdmin(comp, matchId);
    if(!match) return res.status(404).json({ok:false, error:'match_not_found', message:'Partido no encontrado.'});

    match.localGoles = lg;
    match.visitanteGoles = vg;
    match.estado = 'finalizado';
    match.actualizadoPor = ADMIN_EMAIL;
    match.actualizadoEn = new Date().toISOString();

    if(isCupCompetitionAdmin(comp) && lg === vg){
      return res.status(400).json({ok:false, error:'cup_draw_not_allowed', message:'En copas no puede haber empate. Pon un ganador para avanzar fase.'});
    }

    recalcAllAdmin(data);
    writeLeagueData(data);

    res.json({
      ok:true,
      message:'Resultado guardado correctamente.',
      competition: comp.nombre || comp.name || comp.id,
      match,
      data
    });
  }catch(error){
    console.error('[admin] Error guardando resultado:', error);
    res.status(500).json({ok:false, error:'save_score_failed', message:String(error.message || error)});
  }
});

app.post('/api/admin/resultado/reset', express.json(), requireAdmin, (req, res) => {
  try{
    const { compId, matchId } = req.body || {};
    const data = readLeagueData();
    const comp = findCompetitionMutableAdmin(data, compId);
    if(!comp) return res.status(404).json({ok:false, error:'competition_not_found'});
    const match = findMatchMutableAdmin(comp, matchId);
    if(!match) return res.status(404).json({ok:false, error:'match_not_found'});

    match.localGoles = null;
    match.visitanteGoles = null;
    match.estado = 'pendiente';
    match.actualizadoPor = ADMIN_EMAIL;
    match.actualizadoEn = new Date().toISOString();

    recalcAllAdmin(data);
    writeLeagueData(data);
    res.json({ok:true, message:'Resultado borrado.', data});
  }catch(error){
    console.error('[admin] Error borrando resultado:', error);
    res.status(500).json({ok:false, error:'reset_score_failed', message:String(error.message || error)});
  }
});



/* FIX GLOBAL RESULTADOS + CLASIFICACIÓN + COPAS */
function telSafeId(value){
  return String(value || '').trim();
}

function telFindComps(data){
  return data.competiciones || data.ligas || data.torneos || [];
}

function telCompId(comp, index){
  return String(comp.id || comp._id || comp.nombre || comp.name || `comp-${index+1}`);
}

function telMatchId(comp, match, index){
  return String(match.id || match.partidoId || match.matchId || `${telSafeId(comp.id || comp.nombre)}-${index}`);
}

function telGetMutableComp(data, compId){
  const comps = telFindComps(data);
  return comps.find((c,i)=>{
    const id = telCompId(c,i);
    return id === String(compId) || normalizeAdmin(id) === normalizeAdmin(compId) || normalizeAdmin(c.nombre || c.name || '') === normalizeAdmin(compId);
  });
}

function telGetMutableMatch(comp, matchId){
  const matches = comp.partidos || [];
  return matches.find((m,i)=> telMatchId(comp,m,i) === String(matchId) || String(i) === String(matchId));
}

function telEnsureMatchIds(data){
  telFindComps(data).forEach((comp, ci)=>{
    comp.id = comp.id || telCompId(comp, ci);
    (comp.partidos || []).forEach((m, mi)=>{
      if(!m.id) m.id = `${comp.id}-J${m.jornada || 1}-${mi+1}`;
    });
  });
}

function telSlotKey(team, index){
  return String(team.slotId || team.id || team.clubId || team.nombre || team.clubNombre || team.nombreVisual || `slot-${index+1}`);
}

function telTeamName(team, fallback){
  return String(team?.nombre || team?.clubNombre || team?.nombreVisual || team?.name || fallback || 'Equipo');
}

function telIsPlayed(match){
  return match && (
    match.estado === 'finalizado' ||
    match.estado === 'jugado' ||
    match.estado === 'completado' ||
    (match.localGoles !== null && match.localGoles !== undefined && match.visitanteGoles !== null && match.visitanteGoles !== undefined)
  );
}

function telRecalcLeague(comp){
  const rowsBySlot = new Map();

  (comp.equipos || []).forEach((team, index)=>{
    const slotId = telSlotKey(team, index);
    rowsBySlot.set(slotId, {
      ...team,
      slotId,
      id: team.id || slotId,
      nombre: telTeamName(team, `Equipo ${index+1}`),
      clubNombre: team.clubNombre || telTeamName(team, `Equipo ${index+1}`),
      pj:0, pg:0, pe:0, pp:0,
      v:0, e:0, d:0,
      gf:0, gc:0, golesFavor:0, golesContra:0,
      dg:0, pts:0, puntos:0
    });
  });

  (comp.partidos || []).forEach(match=>{
    if(!telIsPlayed(match)) return;

    const localSlot = String(match.localSlotId || match.local || match.equipoLocalSlotId || '');
    const awaySlot = String(match.visitanteSlotId || match.visitante || match.equipoVisitanteSlotId || '');
    if(!rowsBySlot.has(localSlot) || !rowsBySlot.has(awaySlot)) return;

    const local = rowsBySlot.get(localSlot);
    const away = rowsBySlot.get(awaySlot);
    const lg = Number(match.localGoles || 0);
    const vg = Number(match.visitanteGoles || 0);

    local.pj += 1; away.pj += 1;
    local.gf += lg; local.golesFavor = local.gf;
    local.gc += vg; local.golesContra = local.gc;
    away.gf += vg; away.golesFavor = away.gf;
    away.gc += lg; away.golesContra = away.gc;

    if(lg > vg){
      local.pg += 1; local.v += 1; local.pts += 3; local.puntos = local.pts;
      away.pp += 1; away.d += 1; away.puntos = away.pts;
    }else if(lg < vg){
      away.pg += 1; away.v += 1; away.pts += 3; away.puntos = away.pts;
      local.pp += 1; local.d += 1; local.puntos = local.pts;
    }else{
      local.pe += 1; local.e += 1; local.pts += 1; local.puntos = local.pts;
      away.pe += 1; away.e += 1; away.pts += 1; away.puntos = away.pts;
    }

    local.dg = local.gf - local.gc;
    away.dg = away.gf - away.gc;
  });

  comp.clasificacion = Array.from(rowsBySlot.values()).sort((a,b)=>
    (Number(b.pts || b.puntos || 0) - Number(a.pts || a.puntos || 0)) ||
    (Number(b.dg || 0) - Number(a.dg || 0)) ||
    (Number(b.gf || b.golesFavor || 0) - Number(a.gf || a.golesFavor || 0)) ||
    String(a.nombre || a.clubNombre || '').localeCompare(String(b.nombre || b.clubNombre || ''))
  );
}

function telRoundKey(match){
  const txt = normalizeAdmin(match?.rondaNombre || match?.fase || '');
  if(txt.includes('cuarto')) return 'qf';
  if(txt.includes('semi')) return 'sf';
  if(txt.includes('final')) return 'final';
  const r = Number(match?.ronda || 0);
  if(r >= 3) return 'final';
  if(r === 2) return 'sf';
  return 'qf';
}

function telWinnerSlot(match){
  if(!telIsPlayed(match)) return null;
  const lg = Number(match.localGoles || 0);
  const vg = Number(match.visitanteGoles || 0);
  if(lg === vg) return null;
  return lg > vg ? match.localSlotId : match.visitanteSlotId;
}

function telAdvanceCup(comp){
  const by = {qf:[], sf:[], final:[]};
  (comp.partidos || []).forEach((m,i)=>{
    m.__i = i;
    by[telRoundKey(m)].push(m);
  });
  Object.values(by).forEach(arr=>arr.sort((a,b)=>a.__i-b.__i));

  if(by.sf[0]){
    const w1 = telWinnerSlot(by.qf[0]);
    const w2 = telWinnerSlot(by.qf[1]);
    if(w1) by.sf[0].localSlotId = w1;
    if(w2) by.sf[0].visitanteSlotId = w2;
  }
  if(by.sf[1]){
    const w3 = telWinnerSlot(by.qf[2]);
    const w4 = telWinnerSlot(by.qf[3]);
    if(w3) by.sf[1].localSlotId = w3;
    if(w4) by.sf[1].visitanteSlotId = w4;
  }
  if(by.final[0]){
    const sf1 = telWinnerSlot(by.sf[0]);
    const sf2 = telWinnerSlot(by.sf[1]);
    if(sf1) by.final[0].localSlotId = sf1;
    if(sf2) by.final[0].visitanteSlotId = sf2;

    const champSlot = telWinnerSlot(by.final[0]);
    const champ = (comp.equipos || []).find((t,i)=>telSlotKey(t,i) === String(champSlot));
    comp.campeon = champ ? {
      slotId: champSlot,
      nombre: telTeamName(champ),
      escudoUrl: champ.escudoUrl || champ.logoUrl || champ.escudo || ''
    } : null;
  }

  (comp.partidos || []).forEach(m=>delete m.__i);
}

function telRecalcAll(data){
  telEnsureMatchIds(data);
  telFindComps(data).forEach((comp)=>{
    if(isCupCompetitionAdmin(comp)) telAdvanceCup(comp);
    else telRecalcLeague(comp);
  });
}

app.get('/api/admin/data-fresh', requireAdmin, (req,res)=>{
  try{
    const data = readLeagueData();
    telRecalcAll(data);
    writeLeagueData(data);
    res.json({ok:true,data});
  }catch(error){
    res.status(500).json({ok:false,error:'data_fresh_failed',message:String(error.message || error)});
  }
});

// Reemplazo robusto para guardar resultados en todos los lugares
app.post('/api/admin/resultado-global', express.json(), requireAdmin, (req, res) => {
  try{
    const { compId, matchId, localGoles, visitanteGoles } = req.body || {};
    const lg = Number(localGoles);
    const vg = Number(visitanteGoles);

    if(compId === undefined || matchId === undefined){
      return res.status(400).json({ok:false, error:'missing_ids', message:'Faltan compId o matchId.'});
    }
    if(!Number.isInteger(lg) || !Number.isInteger(vg) || lg < 0 || vg < 0){
      return res.status(400).json({ok:false, error:'bad_score', message:'Los goles deben ser números enteros positivos.'});
    }

    const data = readLeagueData();
    telEnsureMatchIds(data);
    const comp = telGetMutableComp(data, compId);
    if(!comp) return res.status(404).json({ok:false,error:'competition_not_found',message:'Competición no encontrada.'});
    const match = telGetMutableMatch(comp, matchId);
    if(!match) return res.status(404).json({ok:false,error:'match_not_found',message:'Partido no encontrado.'});

    if(isCupCompetitionAdmin(comp) && lg === vg){
      return res.status(400).json({ok:false,error:'cup_draw_not_allowed',message:'En copas no puede haber empate. Pon un ganador para avanzar fase.'});
    }

    match.localGoles = lg;
    match.visitanteGoles = vg;
    match.golesLocal = lg;
    match.golesVisitante = vg;
    match.resultado = `${lg}-${vg}`;
    match.estado = 'finalizado';
    match.finalizado = true;
    match.actualizadoPor = ADMIN_EMAIL;
    match.actualizadoEn = new Date().toISOString();

    telRecalcAll(data);
    writeLeagueData(data);

    res.json({ok:true,message:'Resultado guardado y actualizado en toda la web.',data,match,compId:telCompId(comp,0),matchId:match.id || matchId});
  }catch(error){
    console.error('[admin-global] Error guardando resultado:', error);
    res.status(500).json({ok:false,error:'save_score_failed',message:String(error.message || error)});
  }
});

app.post('/api/admin/resultado-global/reset', express.json(), requireAdmin, (req,res)=>{
  try{
    const { compId, matchId } = req.body || {};
    const data = readLeagueData();
    telEnsureMatchIds(data);
    const comp = telGetMutableComp(data, compId);
    if(!comp) return res.status(404).json({ok:false,error:'competition_not_found'});
    const match = telGetMutableMatch(comp, matchId);
    if(!match) return res.status(404).json({ok:false,error:'match_not_found'});

    match.localGoles = null;
    match.visitanteGoles = null;
    match.golesLocal = null;
    match.golesVisitante = null;
    match.resultado = '';
    match.estado = 'pendiente';
    match.finalizado = false;
    match.actualizadoPor = ADMIN_EMAIL;
    match.actualizadoEn = new Date().toISOString();

    telRecalcAll(data);
    writeLeagueData(data);
    res.json({ok:true,message:'Resultado borrado y clasificación recalculada.',data});
  }catch(error){
    console.error('[admin-global] Error borrando resultado:', error);
    res.status(500).json({ok:false,error:'reset_score_failed',message:String(error.message || error)});
  }
});



/* API PARTIDOS VISIBLES: PROXIMOS SIN FINALIZADOS */
app.get('/api/partidos/proximos', (req, res) => {
  try{
    const data = readLeagueData();
    const comps = telFindComps ? telFindComps(data) : (data.competiciones || []);
    const out = [];

    comps.forEach((comp, ci) => {
      const compId = telCompId ? telCompId(comp, ci) : String(comp.id || comp.nombre || `comp-${ci+1}`);
      (comp.partidos || []).forEach((m, mi) => {
        const played = telIsPlayed ? telIsPlayed(m) : (
          m.estado === 'finalizado' ||
          m.estado === 'jugado' ||
          m.finalizado ||
          (m.localGoles !== null && m.localGoles !== undefined && m.visitanteGoles !== null && m.visitanteGoles !== undefined)
        );
        if(!played){
          out.push({...m, compId, matchId: m.id || `${compId}-${mi}`, compNombre: comp.nombre || comp.name || compId});
        }
      });
    });

    res.json({ok:true, partidos:out});
  }catch(error){
    res.status(500).json({ok:false, error:'proximos_failed', message:String(error.message || error)});
  }
});



/* FIX AVANCE DE COPAS POR PAREJAS DE CUARTOS */
function telSortCupMatchesForAdvanceAdmin(matches){
  return [...(matches || [])].sort((a,b)=>{
    const ai = Number(a.orden ?? a.order ?? a.posicion ?? a.__i ?? 0);
    const bi = Number(b.orden ?? b.order ?? b.posicion ?? b.__i ?? 0);
    if(ai !== bi) return ai - bi;
    return Number(a.__i ?? 0) - Number(b.__i ?? 0);
  });
}

function telClearFutureCupMatchAdmin(match){
  if(!match) return;
  match.localSlotId = "";
  match.visitanteSlotId = "";
  match.localGoles = null;
  match.visitanteGoles = null;
  match.golesLocal = null;
  match.golesVisitante = null;
  match.resultado = "";
  match.estado = "pendiente";
  match.finalizado = false;
}

function telSetCupSideAdmin(match, side, slotId){
  if(!match || !slotId) return;
  if(side === "local") match.localSlotId = slotId;
  else match.visitanteSlotId = slotId;
}

function telWinnerOrNullAdmin(match){
  if(!match) return null;
  const played = (typeof telIsPlayed === "function") ? telIsPlayed(match) : telIsPlayed(match);
  if(!played) return null;
  const lg = Number(match.localGoles ?? match.golesLocal ?? 0);
  const vg = Number(match.visitanteGoles ?? match.golesVisitante ?? 0);
  if(lg === vg) return null;
  return lg > vg ? match.localSlotId : match.visitanteSlotId;
}

/*
  Reglas:
  - QF1 + QF2 => Semifinal 1
  - QF3 + QF4 => Semifinal 2
  - SF1 + SF2 => Final
  - Si falta uno de los dos partidos de una pareja, no se pasa todavía.
*/
function telAdvanceCup(comp){
  const by = {qf:[], sf:[], final:[]};

  (comp.partidos || []).forEach((m,i)=>{
    m.__i = i;
    const key = typeof telRoundKey === "function" ? telRoundKey(m) : "qf";
    if(!by[key]) by[key] = [];
    by[key].push(m);
  });

  by.qf = telSortCupMatchesForAdvanceAdmin(by.qf);
  by.sf = telSortCupMatchesForAdvanceAdmin(by.sf);
  by.final = telSortCupMatchesForAdvanceAdmin(by.final);

  const qfWinners = by.qf.map(m => telWinnerOrNullAdmin(m));
  const sfWinners = by.sf.map(m => telWinnerOrNullAdmin(m));

  // Solo avanza Semifinal 1 si QF1 y QF2 tienen ganador.
  if(by.sf[0]){
    if(qfWinners[0] && qfWinners[1]){
      by.sf[0].localSlotId = qfWinners[0];
      by.sf[0].visitanteSlotId = qfWinners[1];
    }else{
      // Si no están los dos ganadores, no queda mal montada la semi.
      if(!by.sf[0].__manualSlotLock){
        by.sf[0].localSlotId = qfWinners[0] || "";
        by.sf[0].visitanteSlotId = qfWinners[1] || "";
      }
    }
  }

  // Solo avanza Semifinal 2 si QF3 y QF4 tienen ganador.
  if(by.sf[1]){
    if(qfWinners[2] && qfWinners[3]){
      by.sf[1].localSlotId = qfWinners[2];
      by.sf[1].visitanteSlotId = qfWinners[3];
    }else{
      if(!by.sf[1].__manualSlotLock){
        by.sf[1].localSlotId = qfWinners[2] || "";
        by.sf[1].visitanteSlotId = qfWinners[3] || "";
      }
    }
  }

  // Solo avanza Final si las dos semifinales tienen ganador.
  if(by.final[0]){
    if(sfWinners[0] && sfWinners[1]){
      by.final[0].localSlotId = sfWinners[0];
      by.final[0].visitanteSlotId = sfWinners[1];
    }else{
      if(!by.final[0].__manualSlotLock){
        by.final[0].localSlotId = sfWinners[0] || "";
        by.final[0].visitanteSlotId = sfWinners[1] || "";
      }
    }

    const championSlot = telWinnerOrNullAdmin(by.final[0]);
    if(championSlot){
      const champ = (comp.equipos || []).find((t,i)=>String(telSlotKey(t,i)) === String(championSlot));
      comp.campeon = champ ? {
        slotId: championSlot,
        nombre: telTeamName(champ),
        escudoUrl: champ.escudoUrl || champ.logoUrl || champ.escudo || ""
      } : null;
    }else{
      comp.campeon = null;
    }
  }

  (comp.partidos || []).forEach(m=>delete m.__i);
}

// Compatibilidad con la función antigua.
function advanceCupAdmin(comp){
  return telAdvanceCup(comp);
}



/* FIX DEFINITIVO AVANCE COPAS: CUARTOS -> SEMIS -> FINAL */
function telRoundRankDef(match){
  const txt = normalizeAdmin(match?.rondaNombre || match?.fase || match?.nombreRonda || '');
  const r = Number(match?.ronda || match?.round || 0);
  if(txt.includes('cuarto') || txt.includes('quarter') || r === 1) return 1;
  if(txt.includes('semi') || r === 2) return 2;
  if(txt.includes('final') || r >= 3) return 3;
  return 1;
}

function telSortByVisualOrderDef(matches){
  return [...(matches || [])].sort((a,b)=>{
    const ao = Number(a.orden ?? a.order ?? a.posicion ?? a.__i ?? 0);
    const bo = Number(b.orden ?? b.order ?? b.posicion ?? b.__i ?? 0);
    if(ao !== bo) return ao - bo;
    return Number(a.__i ?? 0) - Number(b.__i ?? 0);
  });
}

function telPlayedDef(match){
  return !!match && (
    match.estado === 'finalizado' ||
    match.estado === 'jugado' ||
    match.finalizado === true ||
    (match.localGoles !== null && match.localGoles !== undefined && match.visitanteGoles !== null && match.visitanteGoles !== undefined)
  );
}

function telWinnerDef(match){
  if(!telPlayedDef(match)) return null;
  const lg = Number(match.localGoles ?? match.golesLocal ?? 0);
  const vg = Number(match.visitanteGoles ?? match.golesVisitante ?? 0);
  if(lg === vg) return null;
  return String(lg > vg ? match.localSlotId : match.visitanteSlotId);
}

function telClearMatchScoreDef(match){
  if(!match) return;
  match.localGoles = null;
  match.visitanteGoles = null;
  match.golesLocal = null;
  match.golesVisitante = null;
  match.resultado = '';
  match.estado = 'pendiente';
  match.finalizado = false;
}

function telSetAdvancedTeamsDef(target, localSlot, awaySlot){
  if(!target) return;
  let changed = false;
  if(localSlot && String(target.localSlotId || '') !== String(localSlot)){
    target.localSlotId = String(localSlot);
    changed = true;
  }
  if(awaySlot && String(target.visitanteSlotId || '') !== String(awaySlot)){
    target.visitanteSlotId = String(awaySlot);
    changed = true;
  }

  // Si cambia un equipo de una ronda posterior, limpiar resultado anterior para evitar campeones falsos.
  if(changed){
    telClearMatchScoreDef(target);
  }
}

function telAdvanceCupDef(comp){
  const partidos = comp.partidos || [];
  const by = {qf:[], sf:[], final:[]};

  partidos.forEach((m,i)=>{
    m.__i = i;
    const rank = telRoundRankDef(m);
    if(rank === 1) by.qf.push(m);
    else if(rank === 2) by.sf.push(m);
    else by.final.push(m);
  });

  by.qf = telSortByVisualOrderDef(by.qf);
  by.sf = telSortByVisualOrderDef(by.sf);
  by.final = telSortByVisualOrderDef(by.final);

  const qfw = by.qf.map(telWinnerDef);
  const sfw = by.sf.map(telWinnerDef);

  // IMPORTANTE:
  // Parejas:
  // Cuarto 1 + Cuarto 2 => Semi 1
  // Cuarto 3 + Cuarto 4 => Semi 2
  if(by.sf[0]){
    if(qfw[0] && qfw[1]) telSetAdvancedTeamsDef(by.sf[0], qfw[0], qfw[1]);
    else{
      if(qfw[0]) by.sf[0].localSlotId = qfw[0];
      if(qfw[1]) by.sf[0].visitanteSlotId = qfw[1];
    }
  }

  if(by.sf[1]){
    if(qfw[2] && qfw[3]) telSetAdvancedTeamsDef(by.sf[1], qfw[2], qfw[3]);
    else{
      if(qfw[2]) by.sf[1].localSlotId = qfw[2];
      if(qfw[3]) by.sf[1].visitanteSlotId = qfw[3];
    }
  }

  // Final cuando las 2 semifinales tengan ganador.
  if(by.final[0]){
    if(sfw[0] && sfw[1]) telSetAdvancedTeamsDef(by.final[0], sfw[0], sfw[1]);
    else{
      if(sfw[0]) by.final[0].localSlotId = sfw[0];
      if(sfw[1]) by.final[0].visitanteSlotId = sfw[1];
    }

    const championSlot = telWinnerDef(by.final[0]);
    if(championSlot){
      const champion = (comp.equipos || []).find((t,i)=>String(telSlotKey(t,i)) === String(championSlot));
      comp.campeon = champion ? {
        slotId: championSlot,
        nombre: telTeamName(champion),
        escudoUrl: champion.escudoUrl || champion.logoUrl || champion.escudo || ''
      } : null;
    }else{
      comp.campeon = null;
    }
  }

  partidos.forEach(m=>delete m.__i);
}

function telRecalcAllDef(data){
  telEnsureMatchIds(data);
  telFindComps(data).forEach(comp=>{
    if(isCupCompetitionAdmin(comp)){
      telAdvanceCupDef(comp);
    }else{
      telRecalcLeague(comp);
    }
  });
}

// Sobrescribir todas las funciones anteriores usadas por las rutas.
telAdvanceCup = telAdvanceCupDef;
advanceCupAdmin = telAdvanceCupDef;
telRecalcAll = telRecalcAllDef;
recalcAllAdmin = telRecalcAllDef;

/* Endpoint para forzar recalculo de copa desde admin */
app.post('/api/admin/copas/recalcular', express.json(), requireAdmin, (req,res)=>{
  try{
    const data = readLeagueData();
    telRecalcAllDef(data);
    writeLeagueData(data);
    res.json({ok:true, message:'Copas recalculadas.', data});
  }catch(error){
    res.status(500).json({ok:false, error:'cup_recalc_failed', message:String(error.message || error)});
  }
});



/* FIX EXTRA: CREAR SEMIFINALES Y FINAL SI NO EXISTEN */
function telCupMakeMatchId(comp, round, n){
  const baseId = String(comp.id || comp.nombre || 'copa').toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
  return `${baseId}-${round}-${n}`;
}

function telEnsureCupRoundsExist(comp){
  comp.partidos = comp.partidos || [];

  const all = comp.partidos;
  const qf = [];
  const sf = [];
  const finals = [];

  all.forEach((m,i)=>{
    m.__i = i;
    const rank = telRoundRankDef(m);
    if(rank === 1) qf.push(m);
    else if(rank === 2) sf.push(m);
    else finals.push(m);
  });

  qf.sort((a,b)=>(a.__i||0)-(b.__i||0));
  sf.sort((a,b)=>(a.__i||0)-(b.__i||0));
  finals.sort((a,b)=>(a.__i||0)-(b.__i||0));

  // Si hay 4 cuartos, deben existir 2 semifinales.
  while(qf.length >= 4 && sf.length < 2){
    const index = sf.length + 1;
    const newSf = {
      id: telCupMakeMatchId(comp, 'semifinal', index),
      jornada: 2,
      ronda: 2,
      rondaNombre: 'Semifinales',
      fase: 'Semifinales',
      localSlotId: '',
      visitanteSlotId: '',
      localGoles: null,
      visitanteGoles: null,
      estado: 'pendiente',
      finalizado: false,
      fecha: '',
      hora: ''
    };
    comp.partidos.push(newSf);
    sf.push(newSf);
  }

  // Si hay semifinales, debe existir una final.
  while(sf.length >= 2 && finals.length < 1){
    const newFinal = {
      id: telCupMakeMatchId(comp, 'final', 1),
      jornada: 3,
      ronda: 3,
      rondaNombre: 'Final',
      fase: 'Final',
      localSlotId: '',
      visitanteSlotId: '',
      localGoles: null,
      visitanteGoles: null,
      estado: 'pendiente',
      finalizado: false,
      fecha: '',
      hora: ''
    };
    comp.partidos.push(newFinal);
    finals.push(newFinal);
  }

  comp.partidos.forEach(m=>delete m.__i);
}

function telAdvanceCupDef(comp){
  telEnsureCupRoundsExist(comp);

  const partidos = comp.partidos || [];
  const by = {qf:[], sf:[], final:[]};

  partidos.forEach((m,i)=>{
    m.__i = i;
    const rank = telRoundRankDef(m);
    if(rank === 1) by.qf.push(m);
    else if(rank === 2) by.sf.push(m);
    else by.final.push(m);
  });

  by.qf = telSortByVisualOrderDef(by.qf);
  by.sf = telSortByVisualOrderDef(by.sf);
  by.final = telSortByVisualOrderDef(by.final);

  const qfw = by.qf.map(telWinnerDef);
  const sfw = by.sf.map(telWinnerDef);

  // QF1 + QF2 => SF1
  if(by.sf[0]){
    if(qfw[0] && qfw[1]) telSetAdvancedTeamsDef(by.sf[0], qfw[0], qfw[1]);
    else{
      if(qfw[0]) by.sf[0].localSlotId = qfw[0];
      if(qfw[1]) by.sf[0].visitanteSlotId = qfw[1];
    }
  }

  // QF3 + QF4 => SF2
  if(by.sf[1]){
    if(qfw[2] && qfw[3]) telSetAdvancedTeamsDef(by.sf[1], qfw[2], qfw[3]);
    else{
      if(qfw[2]) by.sf[1].localSlotId = qfw[2];
      if(qfw[3]) by.sf[1].visitanteSlotId = qfw[3];
    }
  }

  // SF1 + SF2 => Final
  if(by.final[0]){
    if(sfw[0] && sfw[1]) telSetAdvancedTeamsDef(by.final[0], sfw[0], sfw[1]);
    else{
      if(sfw[0]) by.final[0].localSlotId = sfw[0];
      if(sfw[1]) by.final[0].visitanteSlotId = sfw[1];
    }

    const championSlot = telWinnerDef(by.final[0]);
    if(championSlot){
      const champion = (comp.equipos || []).find((t,i)=>String(telSlotKey(t,i)) === String(championSlot));
      comp.campeon = champion ? {
        slotId: championSlot,
        nombre: telTeamName(champion),
        escudoUrl: champion.escudoUrl || champion.logoUrl || champion.escudo || ''
      } : null;
    }else{
      comp.campeon = null;
    }
  }

  partidos.forEach(m=>delete m.__i);
}

function telRecalcAllDef(data){
  telEnsureMatchIds(data);
  telFindComps(data).forEach(comp=>{
    if(isCupCompetitionAdmin(comp)){
      telEnsureCupRoundsExist(comp);
      telAdvanceCupDef(comp);
    }else{
      telRecalcLeague(comp);
    }
  });
}

// Sobrescribir de nuevo, esta vez creando semis/final reales.
telAdvanceCup = telAdvanceCupDef;
advanceCupAdmin = telAdvanceCupDef;
telRecalcAll = telRecalcAllDef;
recalcAllAdmin = telRecalcAllDef;



/* FIX FINAL GUARDAR RESULTADO ADMIN */
function telAdminPlayedFinal(match){
  return !!match && (
    match.estado === 'finalizado' ||
    match.estado === 'jugado' ||
    match.finalizado === true ||
    (match.localGoles !== null && match.localGoles !== undefined && match.visitanteGoles !== null && match.visitanteGoles !== undefined)
  );
}

function telAdminFindCompFinal(data, compId){
  const comps = data.competiciones || data.ligas || data.torneos || [];
  return comps.find((c, i)=>{
    const id = String(c.id || c._id || c.nombre || c.name || `comp-${i+1}`);
    return id === String(compId) || normalizeAdmin(id) === normalizeAdmin(compId) || normalizeAdmin(c.nombre || c.name || '') === normalizeAdmin(compId);
  });
}

function telAdminFindMatchFinal(comp, matchId){
  const matches = comp.partidos || [];
  return matches.find((m, i)=>{
    const id = String(m.id || m.partidoId || m.matchId || `${comp.id || comp.nombre}-${i}`);
    return id === String(matchId) || String(i) === String(matchId);
  });
}

function telAdminRecalcOneLeagueFinal(comp){
  const rows = new Map();

  (comp.equipos || []).forEach((team, i)=>{
    const slotId = String(team.slotId || team.id || team.clubId || team.nombre || team.clubNombre || `slot-${i+1}`);
    rows.set(slotId, {
      ...team,
      slotId,
      nombre: team.nombre || team.clubNombre || team.nombreVisual || `Equipo ${i+1}`,
      clubNombre: team.clubNombre || team.nombre || team.nombreVisual || `Equipo ${i+1}`,
      pj:0, pg:0, pe:0, pp:0, v:0, e:0, d:0,
      gf:0, gc:0, golesFavor:0, golesContra:0, dg:0, pts:0, puntos:0
    });
  });

  (comp.partidos || []).forEach(m=>{
    if(!telAdminPlayedFinal(m)) return;
    const ls = String(m.localSlotId || '');
    const vs = String(m.visitanteSlotId || '');
    if(!rows.has(ls) || !rows.has(vs)) return;

    const l = rows.get(ls);
    const v = rows.get(vs);
    const lg = Number(m.localGoles ?? m.golesLocal ?? 0);
    const vg = Number(m.visitanteGoles ?? m.golesVisitante ?? 0);

    l.pj++; v.pj++;
    l.gf += lg; l.gc += vg; l.golesFavor = l.gf; l.golesContra = l.gc;
    v.gf += vg; v.gc += lg; v.golesFavor = v.gf; v.golesContra = v.gc;
    l.dg = l.gf - l.gc; v.dg = v.gf - v.gc;

    if(lg > vg){
      l.pg++; l.v++; l.pts += 3; l.puntos = l.pts;
      v.pp++; v.d++; v.puntos = v.pts;
    }else if(lg < vg){
      v.pg++; v.v++; v.pts += 3; v.puntos = v.pts;
      l.pp++; l.d++; l.puntos = l.pts;
    }else{
      l.pe++; l.e++; l.pts += 1; l.puntos = l.pts;
      v.pe++; v.e++; v.pts += 1; v.puntos = v.pts;
    }
  });

  comp.clasificacion = Array.from(rows.values()).sort((a,b)=>
    (Number(b.pts || b.puntos || 0) - Number(a.pts || a.puntos || 0)) ||
    (Number(b.dg || 0) - Number(a.dg || 0)) ||
    (Number(b.gf || b.golesFavor || 0) - Number(a.gf || a.golesFavor || 0)) ||
    String(a.nombre || a.clubNombre || '').localeCompare(String(b.nombre || b.clubNombre || ''))
  );
}

function telAdminWinnerFinal(match){
  if(!telAdminPlayedFinal(match)) return null;
  const lg = Number(match.localGoles ?? 0);
  const vg = Number(match.visitanteGoles ?? 0);
  if(lg === vg) return null;
  return lg > vg ? String(match.localSlotId) : String(match.visitanteSlotId);
}

function telAdminRoundRankFinal(match){
  const txt = normalizeAdmin(match.rondaNombre || match.fase || match.nombreRonda || '');
  const r = Number(match.ronda || match.round || 0);
  if(txt.includes('cuarto') || r === 1) return 1;
  if(txt.includes('semi') || r === 2) return 2;
  if(txt.includes('final') || r >= 3) return 3;
  return 1;
}

function telAdminEnsureCupRoundsFinal(comp){
  comp.partidos = comp.partidos || [];
  const qf = comp.partidos.filter(m=>telAdminRoundRankFinal(m) === 1);
  const sf = comp.partidos.filter(m=>telAdminRoundRankFinal(m) === 2);
  const fi = comp.partidos.filter(m=>telAdminRoundRankFinal(m) === 3);
  const baseId = String(comp.id || comp.nombre || 'copa').toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');

  while(qf.length >= 4 && sf.length < 2){
    const n = sf.length + 1;
    const m = {
      id: `${baseId}-semifinal-${n}`,
      jornada:2, ronda:2, rondaNombre:'Semifinales', fase:'Semifinales',
      localSlotId:'', visitanteSlotId:'',
      localGoles:null, visitanteGoles:null, estado:'pendiente', finalizado:false
    };
    comp.partidos.push(m); sf.push(m);
  }

  while(sf.length >= 2 && fi.length < 1){
    const m = {
      id: `${baseId}-final-1`,
      jornada:3, ronda:3, rondaNombre:'Final', fase:'Final',
      localSlotId:'', visitanteSlotId:'',
      localGoles:null, visitanteGoles:null, estado:'pendiente', finalizado:false
    };
    comp.partidos.push(m); fi.push(m);
  }
}

function telAdminAdvanceCupFinal(comp){
  telAdminEnsureCupRoundsFinal(comp);

  const by = {qf:[], sf:[], final:[]};
  (comp.partidos || []).forEach((m,i)=>{
    m.__i = i;
    const rank = telAdminRoundRankFinal(m);
    if(rank === 1) by.qf.push(m);
    else if(rank === 2) by.sf.push(m);
    else by.final.push(m);
  });
  Object.values(by).forEach(arr=>arr.sort((a,b)=>(Number(a.orden ?? a.__i) - Number(b.orden ?? b.__i))));

  const qfw = by.qf.map(telAdminWinnerFinal);
  const sfw = by.sf.map(telAdminWinnerFinal);

  function setTeams(target, a, b){
    if(!target) return;
    let changed = false;
    if(a && String(target.localSlotId || '') !== String(a)){ target.localSlotId = a; changed = true; }
    if(b && String(target.visitanteSlotId || '') !== String(b)){ target.visitanteSlotId = b; changed = true; }
    if(changed){
      target.localGoles = null;
      target.visitanteGoles = null;
      target.golesLocal = null;
      target.golesVisitante = null;
      target.resultado = '';
      target.estado = 'pendiente';
      target.finalizado = false;
    }
  }

  if(qfw[0] && qfw[1]) setTeams(by.sf[0], qfw[0], qfw[1]);
  if(qfw[2] && qfw[3]) setTeams(by.sf[1], qfw[2], qfw[3]);
  if(sfw[0] && sfw[1]) setTeams(by.final[0], sfw[0], sfw[1]);

  const champSlot = by.final[0] ? telAdminWinnerFinal(by.final[0]) : null;
  if(champSlot){
    const champ = (comp.equipos || []).find((t,i)=>String(t.slotId || t.id || t.nombre || t.clubNombre || `slot-${i+1}`) === String(champSlot));
    comp.campeon = champ ? {
      slotId: champSlot,
      nombre: champ.nombre || champ.clubNombre || champ.nombreVisual || 'Campeón',
      escudoUrl: champ.escudoUrl || champ.logoUrl || champ.escudo || ''
    } : null;
  }else{
    comp.campeon = null;
  }

  (comp.partidos || []).forEach(m=>delete m.__i);
}

function telAdminRecalcAllFinal(data){
  const comps = data.competiciones || data.ligas || data.torneos || [];
  comps.forEach(comp=>{
    if(isCupCompetitionAdmin(comp)) telAdminAdvanceCupFinal(comp);
    else telAdminRecalcOneLeagueFinal(comp);
  });
}

app.post('/api/admin/guardar-resultado-final', express.json(), requireAdmin, (req,res)=>{
  try{
    const { compId, matchId, localGoles, visitanteGoles } = req.body || {};
    const lg = Number(localGoles);
    const vg = Number(visitanteGoles);

    if(compId === undefined || matchId === undefined){
      return res.status(400).json({ok:false,message:'Faltan compId o matchId.'});
    }
    if(!Number.isInteger(lg) || !Number.isInteger(vg) || lg < 0 || vg < 0){
      return res.status(400).json({ok:false,message:'Los goles deben ser números enteros positivos.'});
    }

    const data = readLeagueData();
    const comp = telAdminFindCompFinal(data, compId);
    if(!comp) return res.status(404).json({ok:false,message:'Competición no encontrada.'});

    const isCup = isCupCompetitionAdmin(comp);
    if(isCup && lg === vg){
      return res.status(400).json({ok:false,message:'En copas no puede haber empate.'});
    }

    const match = telAdminFindMatchFinal(comp, matchId);
    if(!match) return res.status(404).json({ok:false,message:'Partido no encontrado.'});

    match.localGoles = lg;
    match.visitanteGoles = vg;
    match.golesLocal = lg;
    match.golesVisitante = vg;
    match.resultado = `${lg}-${vg}`;
    match.estado = 'finalizado';
    match.finalizado = true;
    match.actualizadoPor = ADMIN_EMAIL;
    match.actualizadoEn = new Date().toISOString();

    telAdminRecalcAllFinal(data);
    writeLeagueData(data);

    res.json({ok:true,message:'Resultado guardado.', data, match});
  }catch(error){
    console.error('[guardar-resultado-final]', error);
    res.status(500).json({ok:false,message:String(error.message || error)});
  }
});

app.post('/api/admin/borrar-resultado-final', express.json(), requireAdmin, (req,res)=>{
  try{
    const { compId, matchId } = req.body || {};
    const data = readLeagueData();
    const comp = telAdminFindCompFinal(data, compId);
    if(!comp) return res.status(404).json({ok:false,message:'Competición no encontrada.'});
    const match = telAdminFindMatchFinal(comp, matchId);
    if(!match) return res.status(404).json({ok:false,message:'Partido no encontrado.'});

    match.localGoles = null;
    match.visitanteGoles = null;
    match.golesLocal = null;
    match.golesVisitante = null;
    match.resultado = '';
    match.estado = 'pendiente';
    match.finalizado = false;

    telAdminRecalcAllFinal(data);
    writeLeagueData(data);

    res.json({ok:true,message:'Resultado borrado.', data, match});
  }catch(error){
    console.error('[borrar-resultado-final]', error);
    res.status(500).json({ok:false,message:String(error.message || error)});
  }
});



/* ADMIN RESULTADOS SIMPLE QUE FUNCIONA */
function telSimpleNormalize(value){
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[^\w]+/g,' ')
    .trim();
}

function telSimpleComps(data){
  return data.competiciones || data.ligas || data.torneos || [];
}

function telSimpleCompId(comp, index){
  if(!comp.id) comp.id = String(comp.nombre || comp.name || `comp-${index+1}`).toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
  return String(comp.id);
}

function telSimpleMatchId(comp, match, index){
  if(!match.id){
    const cid = String(comp.id || comp.nombre || 'comp').toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
    match.id = `${cid}-match-${index+1}`;
  }
  return String(match.id);
}

function telSimpleTeamSlot(team, index){
  return String(team.slotId || team.id || team.clubId || team.nombre || team.clubNombre || `slot-${index+1}`);
}

function telSimpleTeamName(team, fallback){
  return String(team?.nombre || team?.clubNombre || team?.nombreVisual || team?.name || fallback || 'Equipo')
    .replace(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic}|\s)+/u,'')
    .trim();
}

function telSimpleTeamLogo(team){
  return team?.escudoUrl || team?.logoUrl || team?.escudo || team?.logo || '';
}

function telSimpleFindTeam(comp, slotId){
  return (comp.equipos || []).find((t,i)=>telSimpleTeamSlot(t,i) === String(slotId)) || null;
}

function telSimpleIsPlayed(match){
  return !!match && (
    match.estado === 'finalizado' ||
    match.estado === 'jugado' ||
    match.finalizado === true ||
    (match.localGoles !== null && match.localGoles !== undefined && match.visitanteGoles !== null && match.visitanteGoles !== undefined)
  );
}

function telSimpleIsCup(comp){
  const text = telSimpleNormalize(`${comp.tipo||''} ${comp.formato||''} ${comp.formatoNombre||''} ${comp.formatoDescripcion||''} ${comp.nombre||''}`);
  return text.includes('copa') || text.includes('elimin') || text.includes('torneo') || (comp.partidos || []).some(p=>{
    const r = telSimpleNormalize(`${p.fase||''} ${p.rondaNombre||''}`);
    return r.includes('cuarto') || r.includes('semi') || r.includes('final');
  });
}

function telSimpleRound(match){
  const txt = telSimpleNormalize(`${match.rondaNombre||''} ${match.fase||''}`);
  const r = Number(match.ronda || match.round || 0);
  if(txt.includes('cuarto') || r === 1) return 1;
  if(txt.includes('semi') || r === 2) return 2;
  if(txt.includes('final') || r >= 3) return 3;
  return 1;
}

function telSimpleWinner(match){
  if(!telSimpleIsPlayed(match)) return null;
  const lg = Number(match.localGoles ?? 0);
  const vg = Number(match.visitanteGoles ?? 0);
  if(lg === vg) return null;
  return lg > vg ? String(match.localSlotId) : String(match.visitanteSlotId);
}

function telSimpleResetMatch(match){
  match.localGoles = null;
  match.visitanteGoles = null;
  match.golesLocal = null;
  match.golesVisitante = null;
  match.resultado = '';
  match.estado = 'pendiente';
  match.finalizado = false;
}

function telSimpleEnsureIds(data){
  telSimpleComps(data).forEach((comp, ci)=>{
    telSimpleCompId(comp, ci);
    (comp.partidos || []).forEach((match, mi)=>telSimpleMatchId(comp, match, mi));
  });
}

function telSimpleEnsureCupRounds(comp){
  comp.partidos = comp.partidos || [];
  const qf = comp.partidos.filter(m=>telSimpleRound(m) === 1);
  const sf = comp.partidos.filter(m=>telSimpleRound(m) === 2);
  const fi = comp.partidos.filter(m=>telSimpleRound(m) === 3);
  const cid = String(comp.id || comp.nombre || 'copa').toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');

  while(qf.length >= 4 && sf.length < 2){
    const n = sf.length + 1;
    const m = {
      id:`${cid}-semifinal-${n}`,
      jornada:2,
      ronda:2,
      rondaNombre:'Semifinales',
      fase:'Semifinales',
      localSlotId:'',
      visitanteSlotId:'',
      localGoles:null,
      visitanteGoles:null,
      estado:'pendiente',
      finalizado:false
    };
    comp.partidos.push(m);
    sf.push(m);
  }

  while(sf.length >= 2 && fi.length < 1){
    const m = {
      id:`${cid}-final-1`,
      jornada:3,
      ronda:3,
      rondaNombre:'Final',
      fase:'Final',
      localSlotId:'',
      visitanteSlotId:'',
      localGoles:null,
      visitanteGoles:null,
      estado:'pendiente',
      finalizado:false
    };
    comp.partidos.push(m);
    fi.push(m);
  }
}

function telSimpleAdvanceCup(comp){
  telSimpleEnsureCupRounds(comp);
  const by = {qf:[], sf:[], final:[]};

  (comp.partidos || []).forEach((m,i)=>{
    m.__i = i;
    const r = telSimpleRound(m);
    if(r === 1) by.qf.push(m);
    else if(r === 2) by.sf.push(m);
    else by.final.push(m);
  });

  Object.values(by).forEach(arr=>arr.sort((a,b)=>Number(a.orden ?? a.__i) - Number(b.orden ?? b.__i)));

  const qfw = by.qf.map(telSimpleWinner);
  const sfw = by.sf.map(telSimpleWinner);

  function setTeams(match, a, b){
    if(!match) return;
    let changed = false;
    if(a && String(match.localSlotId || '') !== String(a)){ match.localSlotId = a; changed = true; }
    if(b && String(match.visitanteSlotId || '') !== String(b)){ match.visitanteSlotId = b; changed = true; }
    if(changed) telSimpleResetMatch(match);
  }

  if(qfw[0] && qfw[1]) setTeams(by.sf[0], qfw[0], qfw[1]);
  if(qfw[2] && qfw[3]) setTeams(by.sf[1], qfw[2], qfw[3]);
  if(sfw[0] && sfw[1]) setTeams(by.final[0], sfw[0], sfw[1]);

  const championSlot = by.final[0] ? telSimpleWinner(by.final[0]) : null;
  if(championSlot){
    const champ = telSimpleFindTeam(comp, championSlot);
    comp.campeon = champ ? {
      slotId: championSlot,
      nombre: telSimpleTeamName(champ),
      escudoUrl: telSimpleTeamLogo(champ)
    } : null;
  }else{
    comp.campeon = null;
  }

  (comp.partidos || []).forEach(m=>delete m.__i);
}

function telSimpleRecalcLeague(comp){
  const rows = new Map();

  (comp.equipos || []).forEach((team, i)=>{
    const slotId = telSimpleTeamSlot(team, i);
    rows.set(slotId, {
      ...team,
      slotId,
      id:team.id || slotId,
      nombre:telSimpleTeamName(team, `Equipo ${i+1}`),
      clubNombre:team.clubNombre || telSimpleTeamName(team, `Equipo ${i+1}`),
      pj:0, pg:0, pe:0, pp:0, v:0, e:0, d:0,
      gf:0, gc:0, golesFavor:0, golesContra:0, dg:0, pts:0, puntos:0
    });
  });

  (comp.partidos || []).forEach(match=>{
    if(!telSimpleIsPlayed(match)) return;
    const lslot = String(match.localSlotId || '');
    const vslot = String(match.visitanteSlotId || '');
    if(!rows.has(lslot) || !rows.has(vslot)) return;

    const l = rows.get(lslot);
    const v = rows.get(vslot);
    const lg = Number(match.localGoles ?? 0);
    const vg = Number(match.visitanteGoles ?? 0);

    l.pj++; v.pj++;
    l.gf += lg; l.gc += vg; l.golesFavor = l.gf; l.golesContra = l.gc; l.dg = l.gf - l.gc;
    v.gf += vg; v.gc += lg; v.golesFavor = v.gf; v.golesContra = v.gc; v.dg = v.gf - v.gc;

    if(lg > vg){
      l.pg++; l.v++; l.pts += 3; l.puntos = l.pts;
      v.pp++; v.d++; v.puntos = v.pts;
    }else if(lg < vg){
      v.pg++; v.v++; v.pts += 3; v.puntos = v.pts;
      l.pp++; l.d++; l.puntos = l.pts;
    }else{
      l.pe++; l.e++; l.pts += 1; l.puntos = l.pts;
      v.pe++; v.e++; v.pts += 1; v.puntos = v.pts;
    }
  });

  comp.clasificacion = Array.from(rows.values()).sort((a,b)=>
    (Number(b.pts || 0) - Number(a.pts || 0)) ||
    (Number(b.dg || 0) - Number(a.dg || 0)) ||
    (Number(b.gf || 0) - Number(a.gf || 0)) ||
    String(a.nombre || '').localeCompare(String(b.nombre || ''))
  );
}

function telSimpleRecalcAll(data){
  telSimpleEnsureIds(data);
  telSimpleComps(data).forEach(comp=>{
    if(telSimpleIsCup(comp)) telSimpleAdvanceCup(comp);
    else telSimpleRecalcLeague(comp);
  });
}

app.get('/api/admin/resultados/lista', requireAdmin, (req,res)=>{
  try{
    const data = readLeagueData();
    telSimpleRecalcAll(data);
    writeLeagueData(data);

    const competiciones = telSimpleComps(data).map((comp, ci)=>{
      const compId = telSimpleCompId(comp, ci);
      const isCup = telSimpleIsCup(comp);
      return {
        id:compId,
        nombre:comp.nombre || comp.name || compId,
        isCup,
        partidos:(comp.partidos || []).map((m, mi)=>{
          const id = telSimpleMatchId(comp, m, mi);
          const local = telSimpleFindTeam(comp, m.localSlotId);
          const visitante = telSimpleFindTeam(comp, m.visitanteSlotId);
          return {
            id,
            jornada:m.jornada || '',
            ronda:m.rondaNombre || m.fase || (isCup ? 'Copa' : ''),
            localSlotId:m.localSlotId || '',
            visitanteSlotId:m.visitanteSlotId || '',
            localNombre:telSimpleTeamName(local, m.localSlotId || 'Por definir'),
            visitanteNombre:telSimpleTeamName(visitante, m.visitanteSlotId || 'Por definir'),
            localGoles:m.localGoles,
            visitanteGoles:m.visitanteGoles,
            estado:m.estado || 'pendiente',
            finalizado:telSimpleIsPlayed(m)
          };
        })
      };
    });

    res.json({ok:true, competiciones});
  }catch(error){
    console.error('[admin-resultados-lista]', error);
    res.status(500).json({ok:false,message:String(error.message || error)});
  }
});

app.post('/api/admin/resultados/guardar-simple', express.json(), requireAdmin, (req,res)=>{
  try{
    const { compId, matchId, localGoles, visitanteGoles } = req.body || {};
    const lg = Number(localGoles);
    const vg = Number(visitanteGoles);

    if(!compId || !matchId) return res.status(400).json({ok:false,message:'Falta competición o partido.'});
    if(!Number.isInteger(lg) || !Number.isInteger(vg) || lg < 0 || vg < 0){
      return res.status(400).json({ok:false,message:'Los goles deben ser números enteros positivos.'});
    }

    const data = readLeagueData();
    telSimpleEnsureIds(data);

    const comp = telSimpleComps(data).find((c,i)=>telSimpleCompId(c,i) === String(compId));
    if(!comp) return res.status(404).json({ok:false,message:'Competición no encontrada.'});

    if(telSimpleIsCup(comp) && lg === vg){
      return res.status(400).json({ok:false,message:'En copa no puede haber empate.'});
    }

    const match = (comp.partidos || []).find((m,i)=>telSimpleMatchId(comp,m,i) === String(matchId));
    if(!match) return res.status(404).json({ok:false,message:'Partido no encontrado.'});

    match.localGoles = lg;
    match.visitanteGoles = vg;
    match.golesLocal = lg;
    match.golesVisitante = vg;
    match.resultado = `${lg}-${vg}`;
    match.estado = 'finalizado';
    match.finalizado = true;
    match.actualizadoPor = ADMIN_EMAIL;
    match.actualizadoEn = new Date().toISOString();

    telSimpleRecalcAll(data);
    writeLeagueData(data);

    res.json({ok:true,message:'Resultado guardado correctamente.', data});
  }catch(error){
    console.error('[admin-resultados-guardar-simple]', error);
    res.status(500).json({ok:false,message:String(error.message || error)});
  }
});

app.post('/api/admin/resultados/borrar-simple', express.json(), requireAdmin, (req,res)=>{
  try{
    const { compId, matchId } = req.body || {};
    const data = readLeagueData();
    telSimpleEnsureIds(data);

    const comp = telSimpleComps(data).find((c,i)=>telSimpleCompId(c,i) === String(compId));
    if(!comp) return res.status(404).json({ok:false,message:'Competición no encontrada.'});

    const match = (comp.partidos || []).find((m,i)=>telSimpleMatchId(comp,m,i) === String(matchId));
    if(!match) return res.status(404).json({ok:false,message:'Partido no encontrado.'});

    telSimpleResetMatch(match);
    telSimpleRecalcAll(data);
    writeLeagueData(data);

    res.json({ok:true,message:'Resultado borrado correctamente.', data});
  }catch(error){
    console.error('[admin-resultados-borrar-simple]', error);
    res.status(500).json({ok:false,message:String(error.message || error)});
  }
});



/* LIMPIEZA COPAS FINAL */
function telCleanCupBrokenSlots(data){
  const comps = data.competiciones || data.ligas || data.torneos || [];
  const norm = v => String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const isCup = c => norm(`${c.tipo||''} ${c.formato||''} ${c.nombre||''}`).includes('copa') || norm(`${c.tipo||''} ${c.formato||''} ${c.nombre||''}`).includes('elimin') || (c.partidos||[]).some(p=>norm(`${p.rondaNombre||''} ${p.fase||''}`).match(/cuarto|semi|final/));
  const round = m => {
    const t = norm(`${m.rondaNombre||''} ${m.fase||''}`);
    const r = Number(m.ronda||0);
    if(t.includes('cuarto') || r===1) return 1;
    if(t.includes('semi') || r===2) return 2;
    if(t.includes('final') || r>=3) return 3;
    return 1;
  };
  const played = m => m && (m.estado==='finalizado' || m.estado==='jugado' || m.finalizado===true || (m.localGoles!==null && m.localGoles!==undefined && m.visitanteGoles!==null && m.visitanteGoles!==undefined));
  const winner = m => {
    if(!played(m)) return null;
    const lg=Number(m.localGoles??0), vg=Number(m.visitanteGoles??0);
    if(lg===vg) return null;
    return String(lg>vg ? m.localSlotId : m.visitanteSlotId);
  };
  const reset = m => {
    if(!m) return;
    m.localGoles=null; m.visitanteGoles=null; m.golesLocal=null; m.golesVisitante=null;
    m.resultado=''; m.estado='pendiente'; m.finalizado=false;
  };
  const teamExists = (c,slot) => !!slot && (c.equipos||[]).some((t,i)=>String(t.slotId||t.id||t.clubId||t.nombre||t.clubNombre||`slot-${i+1}`)===String(slot));

  comps.forEach(comp=>{
    if(!isCup(comp)) return;
    const by={qf:[],sf:[],final:[]};
    (comp.partidos||[]).forEach((m,i)=>{
      m.__i=i;
      const r=round(m);
      if(r===1) by.qf.push(m); else if(r===2) by.sf.push(m); else by.final.push(m);
    });
    Object.values(by).forEach(a=>a.sort((x,y)=>Number(x.orden??x.__i)-Number(y.orden??y.__i)));
    const qfw=by.qf.map(winner), sfw=by.sf.map(winner);

    if(by.sf[0]){ by.sf[0].localSlotId=qfw[0]||''; by.sf[0].visitanteSlotId=qfw[1]||''; if(!qfw[0]||!qfw[1]) reset(by.sf[0]);}
    if(by.sf[1]){ by.sf[1].localSlotId=qfw[2]||''; by.sf[1].visitanteSlotId=qfw[3]||''; if(!qfw[2]||!qfw[3]) reset(by.sf[1]);}
    if(by.final[0]){ by.final[0].localSlotId=sfw[0]||''; by.final[0].visitanteSlotId=sfw[1]||''; if(!sfw[0]||!sfw[1]) reset(by.final[0]);}

    [...by.sf,...by.final].forEach(m=>{
      const okL=teamExists(comp,m.localSlotId), okV=teamExists(comp,m.visitanteSlotId);
      if(!okL) m.localSlotId='';
      if(!okV) m.visitanteSlotId='';
      if(!okL || !okV) reset(m);
    });
    (comp.partidos||[]).forEach(m=>delete m.__i);
  });
}
app.all('/api/admin/copas/limpiar', requireAdmin, (req,res)=>{
  try{
    const data=readLeagueData();
    telCleanCupBrokenSlots(data);
    writeLeagueData(data);
    res.json({ok:true,message:'Copas limpiadas',data});
  }catch(e){res.status(500).json({ok:false,message:String(e.message||e)});}
});



/* COPAS AVANCE VISIBLE CORRECTO */
function telCupFixNorm(v){
  return String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,' ').trim();
}
function telCupFixIsCup(comp){
  const txt = telCupFixNorm(`${comp.tipo||''} ${comp.formato||''} ${comp.formatoNombre||''} ${comp.formatoDescripcion||''} ${comp.nombre||''}`);
  return txt.includes('copa') || txt.includes('elimin') || txt.includes('torneo') || (comp.partidos||[]).some(p=>{
    const r = telCupFixNorm(`${p.rondaNombre||''} ${p.fase||''}`);
    return r.includes('cuarto') || r.includes('semi') || r.includes('final');
  });
}
function telCupFixRound(match){
  const txt = telCupFixNorm(`${match.rondaNombre||''} ${match.fase||''} ${match.nombreRonda||''}`);
  const r = Number(match.ronda || match.round || 0);
  if(txt.includes('cuarto') || r === 1) return 1;
  if(txt.includes('semi') || r === 2) return 2;
  if(txt.includes('final') || r >= 3) return 3;
  return 1;
}
function telCupFixEnsureId(comp, index){
  if(!comp.id){
    comp.id = String(comp.nombre || comp.name || `copa-${index+1}`).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
  }
  return comp.id;
}
function telCupFixEnsureMatchId(comp, match, index){
  if(!match.id){
    match.id = `${comp.id || 'comp'}-partido-${index+1}`;
  }
  return match.id;
}
function telCupFixTeamSlot(team, index){
  return String(team.slotId || team.id || team.clubId || team.nombre || team.clubNombre || `slot-${index+1}`);
}
function telCupFixTeamExists(comp, slot){
  if(!slot) return false;
  return (comp.equipos || []).some((t,i)=>telCupFixTeamSlot(t,i) === String(slot));
}
function telCupFixPlayed(match){
  return !!match && (
    match.estado === 'finalizado' ||
    match.estado === 'jugado' ||
    match.finalizado === true ||
    match.resultado ||
    (match.localGoles !== null && match.localGoles !== undefined && match.visitanteGoles !== null && match.visitanteGoles !== undefined) ||
    (match.golesLocal !== null && match.golesLocal !== undefined && match.golesVisitante !== null && match.golesVisitante !== undefined)
  );
}
function telCupFixGoals(match){
  let lg = match.localGoles;
  let vg = match.visitanteGoles;
  if(lg === null || lg === undefined) lg = match.golesLocal;
  if(vg === null || vg === undefined) vg = match.golesVisitante;
  if((lg === null || lg === undefined || vg === null || vg === undefined) && match.resultado){
    const m = String(match.resultado).match(/(\d+)\s*[-:]\s*(\d+)/);
    if(m){ lg = Number(m[1]); vg = Number(m[2]); }
  }
  return {lg:Number(lg ?? 0), vg:Number(vg ?? 0)};
}
function telCupFixWinner(match){
  if(!telCupFixPlayed(match)) return null;
  const {lg, vg} = telCupFixGoals(match);
  if(lg === vg) return null;
  return String(lg > vg ? match.localSlotId : match.visitanteSlotId);
}
function telCupFixResetOnlyScore(match){
  if(!match) return;
  match.localGoles = null;
  match.visitanteGoles = null;
  match.golesLocal = null;
  match.golesVisitante = null;
  match.resultado = '';
  match.estado = 'pendiente';
  match.finalizado = false;
}
function telCupFixSetTeams(match, localSlot, awaySlot, clearScoreIfChanged=true){
  if(!match) return;
  let changed = false;
  if(localSlot !== undefined && String(match.localSlotId || '') !== String(localSlot || '')){
    match.localSlotId = localSlot || '';
    changed = true;
  }
  if(awaySlot !== undefined && String(match.visitanteSlotId || '') !== String(awaySlot || '')){
    match.visitanteSlotId = awaySlot || '';
    changed = true;
  }
  if(changed && clearScoreIfChanged) telCupFixResetOnlyScore(match);
}
function telCupFixEnsureRounds(comp){
  comp.partidos = comp.partidos || [];
  const qf = comp.partidos.filter(m=>telCupFixRound(m) === 1);
  const sf = comp.partidos.filter(m=>telCupFixRound(m) === 2);
  const fi = comp.partidos.filter(m=>telCupFixRound(m) === 3);
  const cid = String(comp.id || comp.nombre || 'copa').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');

  while(qf.length >= 4 && sf.length < 2){
    const n = sf.length + 1;
    const m = {
      id:`${cid}-semifinal-${n}`,
      jornada:2,
      ronda:2,
      rondaNombre:'Semifinales',
      fase:'Semifinales',
      localSlotId:'',
      visitanteSlotId:'',
      localGoles:null,
      visitanteGoles:null,
      estado:'pendiente',
      finalizado:false
    };
    comp.partidos.push(m);
    sf.push(m);
  }
  while(sf.length >= 2 && fi.length < 1){
    const m = {
      id:`${cid}-final-1`,
      jornada:3,
      ronda:3,
      rondaNombre:'Final',
      fase:'Final',
      localSlotId:'',
      visitanteSlotId:'',
      localGoles:null,
      visitanteGoles:null,
      estado:'pendiente',
      finalizado:false
    };
    comp.partidos.push(m);
    fi.push(m);
  }
}
function telCupFixAdvanceOne(comp){
  telCupFixEnsureRounds(comp);
  const by = {qf:[], sf:[], final:[]};
  (comp.partidos || []).forEach((m,i)=>{
    m.__i = i;
    telCupFixEnsureMatchId(comp, m, i);
    const r = telCupFixRound(m);
    if(r === 1) by.qf.push(m);
    else if(r === 2) by.sf.push(m);
    else by.final.push(m);
  });
  Object.values(by).forEach(a=>a.sort((x,y)=>{
    const ox = Number(x.orden ?? x.order ?? x.posicion ?? x.__i);
    const oy = Number(y.orden ?? y.order ?? y.posicion ?? y.__i);
    return ox - oy;
  }));

  const qfw = by.qf.map(telCupFixWinner);
  const sfw = by.sf.map(telCupFixWinner);

  // QF1+QF2 => SF1. QF3+QF4 => SF2.
  if(by.sf[0]){
    if(qfw[0] && qfw[1]) telCupFixSetTeams(by.sf[0], qfw[0], qfw[1], true);
    else telCupFixSetTeams(by.sf[0], qfw[0] || '', qfw[1] || '', true);
  }
  if(by.sf[1]){
    if(qfw[2] && qfw[3]) telCupFixSetTeams(by.sf[1], qfw[2], qfw[3], true);
    else telCupFixSetTeams(by.sf[1], qfw[2] || '', qfw[3] || '', true);
  }

  // If semifinal has invalid missing team, score must not appear.
  by.sf.forEach(m=>{
    if(!telCupFixTeamExists(comp, m.localSlotId) || !telCupFixTeamExists(comp, m.visitanteSlotId)){
      telCupFixResetOnlyScore(m);
    }
  });

  // SF1+SF2 => Final.
  if(by.final[0]){
    if(sfw[0] && sfw[1]) telCupFixSetTeams(by.final[0], sfw[0], sfw[1], true);
    else telCupFixSetTeams(by.final[0], sfw[0] || '', sfw[1] || '', true);

    if(!telCupFixTeamExists(comp, by.final[0].localSlotId) || !telCupFixTeamExists(comp, by.final[0].visitanteSlotId)){
      telCupFixResetOnlyScore(by.final[0]);
    }
  }

  const champSlot = by.final[0] ? telCupFixWinner(by.final[0]) : null;
  if(champSlot && telCupFixTeamExists(comp, champSlot)){
    const champ = (comp.equipos || []).find((t,i)=>telCupFixTeamSlot(t,i) === String(champSlot));
    comp.campeon = champ ? {
      slotId: champSlot,
      nombre: champ.nombre || champ.clubNombre || champ.nombreVisual || 'Campeón',
      escudoUrl: champ.escudoUrl || champ.logoUrl || champ.escudo || ''
    } : null;
  }else{
    comp.campeon = null;
  }

  (comp.partidos || []).forEach(m=>delete m.__i);
}
function telCupFixAdvanceAll(data){
  const comps = data.competiciones || data.ligas || data.torneos || [];
  comps.forEach((comp,ci)=>{
    telCupFixEnsureId(comp, ci);
    if(telCupFixIsCup(comp)) telCupFixAdvanceOne(comp);
  });
}
app.all('/api/admin/copas/avance-visible', requireAdmin, (req,res)=>{
  try{
    const data = readLeagueData();
    telCupFixAdvanceAll(data);
    writeLeagueData(data);
    res.json({ok:true,message:'Copas avanzadas correctamente',data});
  }catch(e){
    console.error('[copas-avance-visible]', e);
    res.status(500).json({ok:false,message:String(e.message||e)});
  }
});



/* PANEL DEFINITIVO RESULTADOS ADMIN */
function telFinalAdminNorm(value){
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,' ').trim();
}
function telFinalAdminDataPath(){
  return path.join(__dirname, 'data.json');
}
function telFinalAdminReadData(){
  return JSON.parse(fs.readFileSync(telFinalAdminDataPath(), 'utf8'));
}
function telFinalAdminWriteData(data){
  fs.writeFileSync(telFinalAdminDataPath(), JSON.stringify(data, null, 2), 'utf8');
}
function telFinalAdminComps(data){
  return data.competiciones || data.ligas || data.torneos || [];
}
function telFinalAdminCompId(comp, index){
  if(!comp.id){
    comp.id = String(comp.nombre || comp.name || `competicion-${index+1}`).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
  }
  return String(comp.id);
}
function telFinalAdminMatchId(comp, match, index){
  if(!match.id){
    match.id = `${String(comp.id || comp.nombre || 'comp').toLowerCase().replace(/[^\w]+/g,'-')}-match-${index+1}`;
  }
  return String(match.id);
}
function telFinalAdminTeamSlot(team, index){
  return String(team.slotId || team.id || team.clubId || team.nombre || team.clubNombre || `slot-${index+1}`);
}
function telFinalAdminTeamName(team, fallback){
  return String(team?.nombre || team?.clubNombre || team?.nombreVisual || team?.name || fallback || 'Por definir')
    .replace(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic}|\s)+/u,'')
    .trim();
}
function telFinalAdminFindTeam(comp, slotId){
  if(!slotId) return null;
  return (comp.equipos || []).find((t,i)=>telFinalAdminTeamSlot(t,i) === String(slotId)) || null;
}
function telFinalAdminIsCup(comp){
  const txt = telFinalAdminNorm(`${comp.tipo||''} ${comp.formato||''} ${comp.formatoNombre||''} ${comp.formatoDescripcion||''} ${comp.nombre||''}`);
  return txt.includes('copa') || txt.includes('elimin') || txt.includes('torneo') || (comp.partidos || []).some(p=>{
    const r = telFinalAdminNorm(`${p.rondaNombre||''} ${p.fase||''}`);
    return r.includes('cuarto') || r.includes('semi') || r.includes('final');
  });
}
function telFinalAdminRound(match){
  const txt = telFinalAdminNorm(`${match.rondaNombre||''} ${match.fase||''} ${match.nombreRonda||''}`);
  const r = Number(match.ronda || match.round || 0);
  if(txt.includes('cuarto') || r === 1) return 1;
  if(txt.includes('semi') || r === 2) return 2;
  if(txt.includes('final') || r >= 3) return 3;
  return 1;
}
function telFinalAdminPlayed(match){
  return !!match && (
    match.estado === 'finalizado' ||
    match.estado === 'jugado' ||
    match.finalizado === true ||
    (match.localGoles !== null && match.localGoles !== undefined && match.visitanteGoles !== null && match.visitanteGoles !== undefined) ||
    (match.golesLocal !== null && match.golesLocal !== undefined && match.golesVisitante !== null && match.golesVisitante !== undefined)
  );
}
function telFinalAdminWinner(match){
  if(!telFinalAdminPlayed(match)) return null;
  const lg = Number(match.localGoles ?? match.golesLocal ?? 0);
  const vg = Number(match.visitanteGoles ?? match.golesVisitante ?? 0);
  if(lg === vg) return null;
  return String(lg > vg ? match.localSlotId : match.visitanteSlotId);
}
function telFinalAdminResetScore(match){
  if(!match) return;
  match.localGoles = null;
  match.visitanteGoles = null;
  match.golesLocal = null;
  match.golesVisitante = null;
  match.resultado = '';
  match.estado = 'pendiente';
  match.finalizado = false;
}
function telFinalAdminEnsureIds(data){
  telFinalAdminComps(data).forEach((comp, ci)=>{
    telFinalAdminCompId(comp, ci);
    (comp.partidos || []).forEach((match, mi)=>telFinalAdminMatchId(comp, match, mi));
  });
}
function telFinalAdminEnsureCupRounds(comp){
  comp.partidos = comp.partidos || [];
  const qf = comp.partidos.filter(m=>telFinalAdminRound(m) === 1);
  const sf = comp.partidos.filter(m=>telFinalAdminRound(m) === 2);
  const fi = comp.partidos.filter(m=>telFinalAdminRound(m) === 3);
  const cid = String(comp.id || comp.nombre || 'copa').toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');

  while(qf.length >= 4 && sf.length < 2){
    const n = sf.length + 1;
    const m = {
      id:`${cid}-semifinal-${n}`,
      jornada:2,
      ronda:2,
      rondaNombre:'Semifinales',
      fase:'Semifinales',
      localSlotId:'',
      visitanteSlotId:'',
      localGoles:null,
      visitanteGoles:null,
      estado:'pendiente',
      finalizado:false
    };
    comp.partidos.push(m);
    sf.push(m);
  }

  while(sf.length >= 2 && fi.length < 1){
    const m = {
      id:`${cid}-final-1`,
      jornada:3,
      ronda:3,
      rondaNombre:'Final',
      fase:'Final',
      localSlotId:'',
      visitanteSlotId:'',
      localGoles:null,
      visitanteGoles:null,
      estado:'pendiente',
      finalizado:false
    };
    comp.partidos.push(m);
    fi.push(m);
  }
}
function telFinalAdminAdvanceCup(comp){
  telFinalAdminEnsureCupRounds(comp);
  const by = { qf: [], sf: [], final: [] };

  (comp.partidos || []).forEach((m,i)=>{
    m.__i = i;
    const r = telFinalAdminRound(m);
    if(r === 1) by.qf.push(m);
    else if(r === 2) by.sf.push(m);
    else by.final.push(m);
  });

  Object.values(by).forEach(arr=>arr.sort((a,b)=>Number(a.orden ?? a.order ?? a.posicion ?? a.__i) - Number(b.orden ?? b.order ?? b.posicion ?? b.__i)));

  const qfw = by.qf.map(telFinalAdminWinner);
  const sfw = by.sf.map(telFinalAdminWinner);

  function setTeams(match, a, b){
    if(!match) return;
    let changed = false;
    if(String(match.localSlotId || '') !== String(a || '')){ match.localSlotId = a || ''; changed = true; }
    if(String(match.visitanteSlotId || '') !== String(b || '')){ match.visitanteSlotId = b || ''; changed = true; }
    if(changed) telFinalAdminResetScore(match);
  }

  if(by.sf[0]) setTeams(by.sf[0], qfw[0] || '', qfw[1] || '');
  if(by.sf[1]) setTeams(by.sf[1], qfw[2] || '', qfw[3] || '');
  if(by.final[0]) setTeams(by.final[0], sfw[0] || '', sfw[1] || '');

  const champSlot = by.final[0] ? telFinalAdminWinner(by.final[0]) : null;
  if(champSlot){
    const champ = telFinalAdminFindTeam(comp, champSlot);
    comp.campeon = champ ? {
      slotId: champSlot,
      nombre: telFinalAdminTeamName(champ),
      escudoUrl: champ.escudoUrl || champ.logoUrl || champ.escudo || ''
    } : null;
  }else{
    comp.campeon = null;
  }

  (comp.partidos || []).forEach(m=>delete m.__i);
}
function telFinalAdminRecalcLeague(comp){
  const rows = new Map();

  (comp.equipos || []).forEach((team, i)=>{
    const slot = telFinalAdminTeamSlot(team, i);
    rows.set(slot, {
      ...team,
      slotId: slot,
      nombre: telFinalAdminTeamName(team, `Equipo ${i+1}`),
      clubNombre: team.clubNombre || telFinalAdminTeamName(team, `Equipo ${i+1}`),
      pj:0, pg:0, pe:0, pp:0, v:0, e:0, d:0,
      gf:0, gc:0, golesFavor:0, golesContra:0, dg:0, pts:0, puntos:0
    });
  });

  (comp.partidos || []).forEach(match=>{
    if(!telFinalAdminPlayed(match)) return;
    const ls = String(match.localSlotId || '');
    const vs = String(match.visitanteSlotId || '');
    if(!rows.has(ls) || !rows.has(vs)) return;

    const l = rows.get(ls);
    const v = rows.get(vs);
    const lg = Number(match.localGoles ?? match.golesLocal ?? 0);
    const vg = Number(match.visitanteGoles ?? match.golesVisitante ?? 0);

    l.pj++; v.pj++;
    l.gf += lg; l.gc += vg; l.golesFavor = l.gf; l.golesContra = l.gc; l.dg = l.gf - l.gc;
    v.gf += vg; v.gc += lg; v.golesFavor = v.gf; v.golesContra = v.gc; v.dg = v.gf - v.gc;

    if(lg > vg){
      l.pg++; l.v++; l.pts += 3; l.puntos = l.pts;
      v.pp++; v.d++; v.puntos = v.pts;
    }else if(lg < vg){
      v.pg++; v.v++; v.pts += 3; v.puntos = v.pts;
      l.pp++; l.d++; l.puntos = l.pts;
    }else{
      l.pe++; l.e++; l.pts += 1; l.puntos = l.pts;
      v.pe++; v.e++; v.pts += 1; v.puntos = v.pts;
    }
  });

  comp.clasificacion = Array.from(rows.values()).sort((a,b)=>
    (Number(b.pts || 0) - Number(a.pts || 0)) ||
    (Number(b.dg || 0) - Number(a.dg || 0)) ||
    (Number(b.gf || 0) - Number(a.gf || 0)) ||
    String(a.nombre || '').localeCompare(String(b.nombre || ''))
  );
}
function telFinalAdminRecalcAll(data){
  telFinalAdminEnsureIds(data);
  telFinalAdminComps(data).forEach(comp=>{
    if(telFinalAdminIsCup(comp)) telFinalAdminAdvanceCup(comp);
    else telFinalAdminRecalcLeague(comp);
  });
}
app.get('/data.json', (req,res)=>{
  res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma','no-cache');
  res.set('Expires','0');
  const data = readJson(DATA_FILE, {clubes:[],jugadores:[],competiciones:[]});
  // La web pública recibe los clubes hidratados con su ID y una ruta estable
  // de escudo, igual que /api/data. No se expone la ruta local del ordenador del bot.
  res.json(telHydrateDataForClient(data));
});
app.get('/api/data-live', (req,res)=>{
  try{
    const data = telFinalAdminReadData();
    telFinalAdminRecalcAll(data);
    telFinalAdminWriteData(data);
    res.set('Cache-Control','no-store');
    res.json(data);
  }catch(e){
    res.status(500).json({ok:false,message:String(e.message||e)});
  }
});
app.post('/api/admin/final-login', express.json(), (req,res)=>{
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const adminEmail = String(process.env.ADMIN_EMAIL || 'roleplayserver007@gmail.com').toLowerCase();
  const adminPassword = TEL_ADMIN_PASSWORD;

  if(email !== adminEmail) return res.status(403).json({ok:false,message:'Ese correo no es admin.'});
  if(password !== adminPassword) return res.status(403).json({ok:false,message:'Contraseña admin incorrecta.'});

  req.session.isAdmin = true;
  req.session.adminEmail = adminEmail;
  req.session.webAccountId = 'admin-local';
  req.session.save((error)=>{
    if(error) return res.status(500).json({ok:false,message:'No se pudo guardar la sesión.'});
    res.set('Cache-Control','no-store');
    res.json({ok:true,admin:true,email:adminEmail});
  });
});
app.get('/api/admin/final-lista', requireAdmin, (req,res)=>{
  try{
    const data = telFinalAdminReadData();
    telFinalAdminRecalcAll(data);
    telFinalAdminWriteData(data);

    const competiciones = telFinalAdminComps(data).map((comp, ci)=>{
      const compId = telFinalAdminCompId(comp, ci);
      const isCup = telFinalAdminIsCup(comp);
      return {
        id: compId,
        nombre: comp.nombre || comp.name || compId,
        isCup,
        partidos: (comp.partidos || []).map((m, mi)=>{
          const id = telFinalAdminMatchId(comp, m, mi);
          const local = telFinalAdminFindTeam(comp, m.localSlotId);
          const away = telFinalAdminFindTeam(comp, m.visitanteSlotId);
          return {
            id,
            jornada: m.jornada || '',
            ronda: m.rondaNombre || m.fase || '',
            localNombre: telFinalAdminTeamName(local, m.localSlotId || 'Por definir'),
            visitanteNombre: telFinalAdminTeamName(away, m.visitanteSlotId || 'Por definir'),
            localGoles: m.localGoles,
            visitanteGoles: m.visitanteGoles,
            finalizado: telFinalAdminPlayed(m)
          };
        })
      };
    });

    res.set('Cache-Control','no-store');
    res.json({ok:true,competiciones});
  }catch(e){
    res.status(500).json({ok:false,message:String(e.message||e)});
  }
});
app.post('/api/admin/final-guardar', express.json(), requireAdmin, (req,res)=>{
  try{
    const { compId, matchId, localGoles, visitanteGoles } = req.body || {};
    const lg = Number(localGoles);
    const vg = Number(visitanteGoles);

    if(!compId || !matchId) return res.status(400).json({ok:false,message:'Falta competición o partido.'});
    if(!Number.isInteger(lg) || !Number.isInteger(vg) || lg < 0 || vg < 0){
      return res.status(400).json({ok:false,message:'Los goles deben ser números enteros positivos.'});
    }

    const data = telFinalAdminReadData();
    telFinalAdminEnsureIds(data);

    const comp = telFinalAdminComps(data).find((c,i)=>telFinalAdminCompId(c,i) === String(compId));
    if(!comp) return res.status(404).json({ok:false,message:'Competición no encontrada.'});

    if(telFinalAdminIsCup(comp) && lg === vg){
      return res.status(400).json({ok:false,message:'En copas no puede haber empate.'});
    }

    const match = (comp.partidos || []).find((m,i)=>telFinalAdminMatchId(comp,m,i) === String(matchId));
    if(!match) return res.status(404).json({ok:false,message:'Partido no encontrado.'});

    match.localGoles = lg;
    match.visitanteGoles = vg;
    match.golesLocal = lg;
    match.golesVisitante = vg;
    match.resultado = `${lg}-${vg}`;
    match.estado = 'finalizado';
    match.finalizado = true;
    match.actualizadoPor = process.env.ADMIN_EMAIL || 'roleplayserver007@gmail.com';
    match.actualizadoEn = new Date().toISOString();

    telFinalAdminRecalcAll(data);
    telFinalAdminWriteData(data);

    res.set('Cache-Control','no-store');
    res.json({ok:true,message:'Resultado guardado correctamente.',data});
  }catch(e){
    console.error('[final-guardar]', e);
    res.status(500).json({ok:false,message:String(e.message||e)});
  }
});



/* FIX INPUT RESULTADOS ADMIN - ENDPOINT DIRECTO */
app.post('/api/admin/guardar-directo', express.urlencoded({extended:true}), express.json(), requireAdmin, (req,res)=>{
  try{
    const body = req.body || {};
    const compId = String(body.compId || '').trim();
    const matchId = String(body.matchId || '').trim();
    const localGoles = Number(body.localGoles);
    const visitanteGoles = Number(body.visitanteGoles);

    if(!compId) return res.status(400).json({ok:false,message:'No se recibió la competición.'});
    if(!matchId) return res.status(400).json({ok:false,message:'No se recibió el partido.'});
    if(!Number.isInteger(localGoles) || !Number.isInteger(visitanteGoles) || localGoles < 0 || visitanteGoles < 0){
      return res.status(400).json({ok:false,message:'Escribe goles válidos en los dos campos.'});
    }

    const data = JSON.parse(fs.readFileSync(path.join(__dirname,'data.json'),'utf8'));
    const comps = data.competiciones || data.ligas || data.torneos || [];

    function norm(v){return String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,' ').trim();}
    function compKey(c,i){
      if(!c.id) c.id = String(c.nombre || c.name || `competicion-${i+1}`).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
      return String(c.id);
    }
    function matchKey(comp,m,i){
      if(!m.id) m.id = `${String(comp.id || comp.nombre || 'comp').toLowerCase().replace(/[^\w]+/g,'-')}-match-${i+1}`;
      return String(m.id);
    }
    function isCup(c){
      const txt = norm(`${c.tipo||''} ${c.formato||''} ${c.formatoNombre||''} ${c.formatoDescripcion||''} ${c.nombre||''}`);
      return txt.includes('copa') || txt.includes('elimin') || txt.includes('torneo') || (c.partidos||[]).some(p=>/cuarto|semi|final/i.test(`${p.rondaNombre||''} ${p.fase||''}`));
    }
    function round(m){
      const t = norm(`${m.rondaNombre||''} ${m.fase||''}`);
      const r = Number(m.ronda||0);
      if(t.includes('cuarto') || r===1) return 1;
      if(t.includes('semi') || r===2) return 2;
      if(t.includes('final') || r>=3) return 3;
      return 1;
    }
    function played(m){return m && (m.estado==='finalizado' || m.finalizado===true || (m.localGoles!==null && m.localGoles!==undefined && m.visitanteGoles!==null && m.visitanteGoles!==undefined));}
    function winner(m){
      if(!played(m)) return null;
      const lg = Number(m.localGoles||0), vg = Number(m.visitanteGoles||0);
      if(lg===vg) return null;
      return String(lg>vg ? m.localSlotId : m.visitanteSlotId);
    }
    function reset(m){
      if(!m) return;
      m.localGoles=null; m.visitanteGoles=null; m.golesLocal=null; m.golesVisitante=null;
      m.resultado=''; m.estado='pendiente'; m.finalizado=false;
    }
    function teamSlot(t,i){return String(t.slotId||t.id||t.clubId||t.nombre||t.clubNombre||`slot-${i+1}`);}
    function ensureCupRounds(c){
      c.partidos = c.partidos || [];
      const qf = c.partidos.filter(m=>round(m)===1);
      const sf = c.partidos.filter(m=>round(m)===2);
      const fi = c.partidos.filter(m=>round(m)===3);
      const cid = String(c.id || c.nombre || 'copa').toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
      while(qf.length>=4 && sf.length<2){
        const n=sf.length+1;
        const m={id:`${cid}-semifinal-${n}`,jornada:2,ronda:2,rondaNombre:'Semifinales',fase:'Semifinales',localSlotId:'',visitanteSlotId:'',localGoles:null,visitanteGoles:null,estado:'pendiente',finalizado:false};
        c.partidos.push(m); sf.push(m);
      }
      while(sf.length>=2 && fi.length<1){
        const m={id:`${cid}-final-1`,jornada:3,ronda:3,rondaNombre:'Final',fase:'Final',localSlotId:'',visitanteSlotId:'',localGoles:null,visitanteGoles:null,estado:'pendiente',finalizado:false};
        c.partidos.push(m); fi.push(m);
      }
    }
    function advanceCup(c){
      ensureCupRounds(c);
      const by={qf:[],sf:[],final:[]};
      (c.partidos||[]).forEach((m,i)=>{m.__i=i; const r=round(m); if(r===1) by.qf.push(m); else if(r===2) by.sf.push(m); else by.final.push(m);});
      Object.values(by).forEach(a=>a.sort((x,y)=>Number(x.orden??x.__i)-Number(y.orden??y.__i)));
      const qfw=by.qf.map(winner), sfw=by.sf.map(winner);
      function set(m,a,b){
        if(!m) return;
        let ch=false;
        if(String(m.localSlotId||'')!==String(a||'')){m.localSlotId=a||''; ch=true;}
        if(String(m.visitanteSlotId||'')!==String(b||'')){m.visitanteSlotId=b||''; ch=true;}
        if(ch) reset(m);
      }
      if(by.sf[0]) set(by.sf[0], qfw[0]||'', qfw[1]||'');
      if(by.sf[1]) set(by.sf[1], qfw[2]||'', qfw[3]||'');
      if(by.final[0]) set(by.final[0], sfw[0]||'', sfw[1]||'');
      (c.partidos||[]).forEach(m=>delete m.__i);
    }
    function recalcLeague(c){
      const rows = new Map();
      (c.equipos||[]).forEach((t,i)=>{
        const slot=teamSlot(t,i);
        rows.set(slot,{...t,slotId:slot,pj:0,pg:0,pe:0,pp:0,gf:0,gc:0,dg:0,pts:0,puntos:0});
      });
      (c.partidos||[]).forEach(m=>{
        if(!played(m)) return;
        const l=rows.get(String(m.localSlotId||'')), v=rows.get(String(m.visitanteSlotId||''));
        if(!l||!v) return;
        const lg=Number(m.localGoles||0), vg=Number(m.visitanteGoles||0);
        l.pj++; v.pj++; l.gf+=lg; l.gc+=vg; v.gf+=vg; v.gc+=lg; l.dg=l.gf-l.gc; v.dg=v.gf-v.gc;
        if(lg>vg){l.pg++;v.pp++;l.pts+=3;l.puntos=l.pts;}
        else if(lg<vg){v.pg++;l.pp++;v.pts+=3;v.puntos=v.pts;}
        else{l.pe++;v.pe++;l.pts+=1;v.pts+=1;l.puntos=l.pts;v.puntos=v.pts;}
      });
      c.clasificacion = Array.from(rows.values()).sort((a,b)=>(b.pts||0)-(a.pts||0)||(b.dg||0)-(a.dg||0)||(b.gf||0)-(a.gf||0));
    }

    comps.forEach((c,i)=>{
      compKey(c,i);
      (c.partidos||[]).forEach((m,mi)=>matchKey(c,m,mi));
    });

    const comp = comps.find((c,i)=>compKey(c,i) === compId);
    if(!comp) return res.status(404).json({ok:false,message:'No se encontró esa competición en data.json.'});

    if(isCup(comp) && localGoles === visitanteGoles){
      return res.status(400).json({ok:false,message:'En copas no puede haber empate.'});
    }

    const match = (comp.partidos||[]).find((m,i)=>matchKey(comp,m,i) === matchId);
    if(!match) return res.status(404).json({ok:false,message:'No se encontró ese partido en data.json.'});

    match.localGoles = localGoles;
    match.visitanteGoles = visitanteGoles;
    match.golesLocal = localGoles;
    match.golesVisitante = visitanteGoles;
    match.resultado = `${localGoles}-${visitanteGoles}`;
    match.estado = 'finalizado';
    match.finalizado = true;
    match.actualizadoPor = process.env.ADMIN_EMAIL || 'roleplayserver007@gmail.com';
    match.actualizadoEn = new Date().toISOString();

    comps.forEach(c=> isCup(c) ? advanceCup(c) : recalcLeague(c));

    fs.writeFileSync(path.join(__dirname,'data.json'), JSON.stringify(data,null,2), 'utf8');

    res.set('Cache-Control','no-store');
    res.json({ok:true,message:'Resultado guardado correctamente.', compId, matchId, localGoles, visitanteGoles});
  }catch(e){
    console.error('[guardar-directo]', e);
    res.status(500).json({ok:false,message:String(e.message||e)});
  }
});



/* RESULTADOS DIRECTO SIN SESION - FUNCIONA EN LOCAL */
function telDirectNorm(v){
  return String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,' ').trim();
}
function telDirectDataPath(){
  return path.join(__dirname, 'data.json');
}
function telDirectRead(){
  return JSON.parse(fs.readFileSync(telDirectDataPath(), 'utf8'));
}
function telDirectWrite(data){
  fs.writeFileSync(telDirectDataPath(), JSON.stringify(data, null, 2), 'utf8');
}
function telDirectComps(data){
  return data.competiciones || data.ligas || data.torneos || [];
}
function telDirectCompId(comp, i){
  if(!comp.id){
    comp.id = String(comp.nombre || comp.name || `competicion-${i+1}`)
      .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
  }
  return String(comp.id);
}
function telDirectMatchId(comp, m, i){
  if(!m.id){
    const cid = String(comp.id || comp.nombre || 'comp').toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
    m.id = `${cid}-partido-${i+1}`;
  }
  return String(m.id);
}
function telDirectSlot(t, i){
  return String(t.slotId || t.id || t.clubId || t.nombre || t.clubNombre || `slot-${i+1}`);
}
function telDirectName(t, fallback){
  return String(t?.nombre || t?.clubNombre || t?.nombreVisual || t?.name || fallback || 'Por definir')
    .replace(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic}|\s)+/u,'')
    .trim();
}
function telDirectTeam(comp, slot){
  if(!slot) return null;
  return (comp.equipos || []).find((t,i)=>telDirectSlot(t,i) === String(slot)) || null;
}
function telDirectIsCup(comp){
  const txt = telDirectNorm(`${comp.tipo||''} ${comp.formato||''} ${comp.formatoNombre||''} ${comp.formatoDescripcion||''} ${comp.nombre||''}`);
  return txt.includes('copa') || txt.includes('elimin') || txt.includes('torneo') || (comp.partidos || []).some(p=>{
    const r = telDirectNorm(`${p.rondaNombre||''} ${p.fase||''}`);
    return r.includes('cuarto') || r.includes('semi') || r.includes('final');
  });
}
function telDirectRound(m){
  const txt = telDirectNorm(`${m.rondaNombre||''} ${m.fase||''} ${m.nombreRonda||''}`);
  const r = Number(m.ronda || m.round || 0);
  if(txt.includes('cuarto') || r === 1) return 1;
  if(txt.includes('semi') || r === 2) return 2;
  if(txt.includes('final') || r >= 3) return 3;
  return 1;
}
function telDirectPlayed(m){
  return !!m && (
    m.estado === 'finalizado' ||
    m.estado === 'jugado' ||
    m.finalizado === true ||
    (m.localGoles !== null && m.localGoles !== undefined && m.visitanteGoles !== null && m.visitanteGoles !== undefined)
  );
}
function telDirectWinner(m){
  if(!telDirectPlayed(m)) return null;
  const lg = Number(m.localGoles ?? m.golesLocal ?? 0);
  const vg = Number(m.visitanteGoles ?? m.golesVisitante ?? 0);
  if(lg === vg) return null;
  return String(lg > vg ? m.localSlotId : m.visitanteSlotId);
}
function telDirectReset(m){
  if(!m) return;
  m.localGoles = null;
  m.visitanteGoles = null;
  m.golesLocal = null;
  m.golesVisitante = null;
  m.resultado = '';
  m.estado = 'pendiente';
  m.finalizado = false;
}
function telDirectEnsureIds(data){
  telDirectComps(data).forEach((comp, ci)=>{
    telDirectCompId(comp, ci);
    (comp.partidos || []).forEach((m, mi)=>telDirectMatchId(comp, m, mi));
  });
}
function telDirectEnsureCupRounds(comp){
  comp.partidos = comp.partidos || [];
  const qf = comp.partidos.filter(m=>telDirectRound(m) === 1);
  const sf = comp.partidos.filter(m=>telDirectRound(m) === 2);
  const fi = comp.partidos.filter(m=>telDirectRound(m) === 3);
  const cid = String(comp.id || comp.nombre || 'copa').toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');

  while(qf.length >= 4 && sf.length < 2){
    const n = sf.length + 1;
    const m = {
      id:`${cid}-semifinal-${n}`,
      jornada:2,
      ronda:2,
      rondaNombre:'Semifinales',
      fase:'Semifinales',
      localSlotId:'',
      visitanteSlotId:'',
      localGoles:null,
      visitanteGoles:null,
      estado:'pendiente',
      finalizado:false
    };
    comp.partidos.push(m);
    sf.push(m);
  }
  while(sf.length >= 2 && fi.length < 1){
    const m = {
      id:`${cid}-final-1`,
      jornada:3,
      ronda:3,
      rondaNombre:'Final',
      fase:'Final',
      localSlotId:'',
      visitanteSlotId:'',
      localGoles:null,
      visitanteGoles:null,
      estado:'pendiente',
      finalizado:false
    };
    comp.partidos.push(m);
    fi.push(m);
  }
}
function telDirectAdvanceCup(comp){
  telDirectEnsureCupRounds(comp);
  const by = { qf: [], sf: [], final: [] };

  (comp.partidos || []).forEach((m,i)=>{
    m.__i = i;
    const r = telDirectRound(m);
    if(r === 1) by.qf.push(m);
    else if(r === 2) by.sf.push(m);
    else by.final.push(m);
  });

  Object.values(by).forEach(arr=>arr.sort((a,b)=>Number(a.orden ?? a.order ?? a.posicion ?? a.__i) - Number(b.orden ?? b.order ?? b.posicion ?? b.__i)));

  const qfw = by.qf.map(telDirectWinner);
  const sfw = by.sf.map(telDirectWinner);

  function setTeams(m, a, b){
    if(!m) return;
    let changed = false;
    if(String(m.localSlotId || '') !== String(a || '')){
      m.localSlotId = a || '';
      changed = true;
    }
    if(String(m.visitanteSlotId || '') !== String(b || '')){
      m.visitanteSlotId = b || '';
      changed = true;
    }
    if(changed) telDirectReset(m);
  }

  if(by.sf[0]) setTeams(by.sf[0], qfw[0] || '', qfw[1] || '');
  if(by.sf[1]) setTeams(by.sf[1], qfw[2] || '', qfw[3] || '');
  if(by.final[0]) setTeams(by.final[0], sfw[0] || '', sfw[1] || '');

  const champSlot = by.final[0] ? telDirectWinner(by.final[0]) : null;
  if(champSlot){
    const champ = telDirectTeam(comp, champSlot);
    comp.campeon = champ ? {
      slotId: champSlot,
      nombre: telDirectName(champ),
      escudoUrl: champ.escudoUrl || champ.logoUrl || champ.escudo || ''
    } : null;
  }else{
    comp.campeon = null;
  }

  (comp.partidos || []).forEach(m=>delete m.__i);
}
function telDirectRecalcLeague(comp){
  const rows = new Map();

  (comp.equipos || []).forEach((t,i)=>{
    const slot = telDirectSlot(t,i);
    rows.set(slot, {
      ...t,
      slotId: slot,
      nombre: telDirectName(t, `Equipo ${i+1}`),
      clubNombre: t.clubNombre || telDirectName(t, `Equipo ${i+1}`),
      pj:0, pg:0, pe:0, pp:0,
      v:0, e:0, d:0,
      gf:0, gc:0, golesFavor:0, golesContra:0,
      dg:0, pts:0, puntos:0
    });
  });

  (comp.partidos || []).forEach(m=>{
    if(!telDirectPlayed(m)) return;
    const l = rows.get(String(m.localSlotId || ''));
    const v = rows.get(String(m.visitanteSlotId || ''));
    if(!l || !v) return;

    const lg = Number(m.localGoles ?? 0);
    const vg = Number(m.visitanteGoles ?? 0);

    l.pj++; v.pj++;
    l.gf += lg; l.gc += vg; l.golesFavor = l.gf; l.golesContra = l.gc; l.dg = l.gf - l.gc;
    v.gf += vg; v.gc += lg; v.golesFavor = v.gf; v.golesContra = v.gc; v.dg = v.gf - v.gc;

    if(lg > vg){
      l.pg++; l.v++; l.pts += 3; l.puntos = l.pts;
      v.pp++; v.d++; v.puntos = v.pts;
    }else if(lg < vg){
      v.pg++; v.v++; v.pts += 3; v.puntos = v.pts;
      l.pp++; l.d++; l.puntos = l.pts;
    }else{
      l.pe++; l.e++; l.pts += 1; l.puntos = l.pts;
      v.pe++; v.e++; v.pts += 1; v.puntos = v.pts;
    }
  });

  comp.clasificacion = Array.from(rows.values()).sort((a,b)=>
    (Number(b.pts || 0) - Number(a.pts || 0)) ||
    (Number(b.dg || 0) - Number(a.dg || 0)) ||
    (Number(b.gf || 0) - Number(a.gf || 0)) ||
    String(a.nombre || '').localeCompare(String(b.nombre || ''))
  );
}
function telDirectRecalcAll(data){
  telDirectEnsureIds(data);
  telDirectComps(data).forEach(comp=>{
    if(telDirectIsCup(comp)) telDirectAdvanceCup(comp);
    else telDirectRecalcLeague(comp);
  });
}
function telDirectPasswordOk(req){
  const pass = String(req.body?.adminPassword || req.query?.adminPassword || '');
  return pass === String(TEL_ADMIN_PASSWORD) || (req.session && req.session.isAdmin === true);
}
app.get('/api/admin/direct-lista', (req,res)=>{
  try{
    const data = telDirectRead();
    telDirectRecalcAll(data);
    telDirectWrite(data);

    const competiciones = telDirectComps(data).map((comp, ci)=>{
      const compId = telDirectCompId(comp, ci);
      const isCup = telDirectIsCup(comp);

      return {
        id: compId,
        nombre: comp.nombre || comp.name || compId,
        isCup,
        partidos: (comp.partidos || []).map((m, mi)=>{
          const id = telDirectMatchId(comp, m, mi);
          const local = telDirectTeam(comp, m.localSlotId);
          const visitante = telDirectTeam(comp, m.visitanteSlotId);

          return {
            id,
            jornada: m.jornada || '',
            ronda: m.rondaNombre || m.fase || '',
            localNombre: telDirectName(local, m.localSlotId || 'Por definir'),
            visitanteNombre: telDirectName(visitante, m.visitanteSlotId || 'Por definir'),
            localGoles: m.localGoles,
            visitanteGoles: m.visitanteGoles,
            finalizado: telDirectPlayed(m)
          };
        })
      };
    });

    res.set('Cache-Control','no-store');
    res.json({ok:true, competiciones});
  }catch(e){
    console.error('[direct-lista]', e);
    res.status(500).json({ok:false,message:String(e.message || e)});
  }
});
app.post('/api/admin/direct-guardar', express.json(), (req,res)=>{
  try{
    if(!telDirectPasswordOk(req)){
      return res.status(403).json({ok:false,message:'Contraseña admin incorrecta.'});
    }

    const compId = String(req.body?.compId || '').trim();
    const matchId = String(req.body?.matchId || '').trim();
    const lg = Number(req.body?.localGoles);
    const vg = Number(req.body?.visitanteGoles);

    if(!compId) return res.status(400).json({ok:false,message:'Falta competición.'});
    if(!matchId) return res.status(400).json({ok:false,message:'Falta partido.'});
    if(!Number.isInteger(lg) || !Number.isInteger(vg) || lg < 0 || vg < 0){
      return res.status(400).json({ok:false,message:'Pon goles válidos.'});
    }

    const data = telDirectRead();
    telDirectEnsureIds(data);

    const comp = telDirectComps(data).find((c,i)=>telDirectCompId(c,i) === compId);
    if(!comp) return res.status(404).json({ok:false,message:'Competición no encontrada.'});

    if(telDirectIsCup(comp) && lg === vg){
      return res.status(400).json({ok:false,message:'En copas no puede haber empate.'});
    }

    const match = (comp.partidos || []).find((m,i)=>telDirectMatchId(comp,m,i) === matchId);
    if(!match) return res.status(404).json({ok:false,message:'Partido no encontrado.'});

    match.localGoles = lg;
    match.visitanteGoles = vg;
    match.golesLocal = lg;
    match.golesVisitante = vg;
    match.resultado = `${lg}-${vg}`;
    match.estado = 'finalizado';
    match.finalizado = true;
    match.actualizadoPor = process.env.ADMIN_EMAIL || 'roleplayserver007@gmail.com';
    match.actualizadoEn = new Date().toISOString();

    telDirectRecalcAll(data);
    telDirectWrite(data);

    res.set('Cache-Control','no-store');
    res.json({ok:true,message:'Resultado guardado.', data});
  }catch(e){
    console.error('[direct-guardar]', e);
    res.status(500).json({ok:false,message:String(e.message || e)});
  }
});



/* ADMIN NORMAL LOGIN + RESULTADOS INTEGRADOS */
function telAdminNorm2(v){
  return String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,' ').trim();
}
function telAdminDataPath2(){
  return path.join(__dirname, 'data.json');
}
function telAdminRead2(){
  return JSON.parse(fs.readFileSync(telAdminDataPath2(), 'utf8'));
}
function telAdminWrite2(data){
  fs.writeFileSync(telAdminDataPath2(), JSON.stringify(data, null, 2), 'utf8');
}
function telAdminComps2(data){
  return data.competiciones || data.ligas || data.torneos || [];
}
function telAdminCompId2(comp, i){
  if(!comp.id){
    comp.id = String(comp.nombre || comp.name || `competicion-${i+1}`)
      .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
  }
  return String(comp.id);
}
function telAdminMatchId2(comp, m, i){
  if(!m.id){
    const cid = String(comp.id || comp.nombre || 'comp').toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
    m.id = `${cid}-partido-${i+1}`;
  }
  return String(m.id);
}
function telAdminSlot2(t, i){
  return String(t.slotId || t.id || t.clubId || t.nombre || t.clubNombre || `slot-${i+1}`);
}
function telAdminName2(t, fallback){
  return String(t?.nombre || t?.clubNombre || t?.nombreVisual || t?.name || fallback || 'Por definir')
    .replace(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic}|\s)+/u,'')
    .trim();
}
function telAdminTeam2(comp, slot){
  if(!slot) return null;
  return (comp.equipos || []).find((t,i)=>telAdminSlot2(t,i) === String(slot)) || null;
}
function telAdminIsCup2(comp){
  const txt = telAdminNorm2(`${comp.tipo||''} ${comp.formato||''} ${comp.formatoNombre||''} ${comp.formatoDescripcion||''} ${comp.nombre||''}`);
  return txt.includes('copa') || txt.includes('elimin') || txt.includes('torneo') || (comp.partidos || []).some(p=>{
    const r = telAdminNorm2(`${p.rondaNombre||''} ${p.fase||''}`);
    return r.includes('cuarto') || r.includes('semi') || r.includes('final');
  });
}
function telAdminRound2(m){
  const txt = telAdminNorm2(`${m.rondaNombre||''} ${m.fase||''} ${m.nombreRonda||''}`);
  const r = Number(m.ronda || m.round || 0);
  if(txt.includes('cuarto') || r === 1) return 1;
  if(txt.includes('semi') || r === 2) return 2;
  if(txt.includes('final') || r >= 3) return 3;
  return 1;
}
function telAdminPlayed2(m){
  return !!m && (
    m.estado === 'finalizado' ||
    m.estado === 'jugado' ||
    m.finalizado === true ||
    (m.localGoles !== null && m.localGoles !== undefined && m.visitanteGoles !== null && m.visitanteGoles !== undefined)
  );
}
function telAdminWinner2(m){
  if(!telAdminPlayed2(m)) return null;
  const lg = Number(m.localGoles ?? m.golesLocal ?? 0);
  const vg = Number(m.visitanteGoles ?? m.golesVisitante ?? 0);
  if(lg === vg) return null;
  return String(lg > vg ? m.localSlotId : m.visitanteSlotId);
}
function telAdminResetScore2(m){
  if(!m) return;
  m.localGoles = null;
  m.visitanteGoles = null;
  m.golesLocal = null;
  m.golesVisitante = null;
  m.resultado = '';
  m.estado = 'pendiente';
  m.finalizado = false;
}
function telAdminEnsureIds2(data){
  telAdminComps2(data).forEach((comp, ci)=>{
    telAdminCompId2(comp, ci);
    (comp.partidos || []).forEach((m, mi)=>telAdminMatchId2(comp, m, mi));
  });
}
function telAdminEnsureCupRounds2(comp){
  comp.partidos = comp.partidos || [];
  const qf = comp.partidos.filter(m=>telAdminRound2(m) === 1);
  const sf = comp.partidos.filter(m=>telAdminRound2(m) === 2);
  const fi = comp.partidos.filter(m=>telAdminRound2(m) === 3);
  const cid = String(comp.id || comp.nombre || 'copa').toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');

  while(qf.length >= 4 && sf.length < 2){
    const n = sf.length + 1;
    const m = {
      id:`${cid}-semifinal-${n}`,
      jornada:2,
      ronda:2,
      rondaNombre:'Semifinales',
      fase:'Semifinales',
      localSlotId:'',
      visitanteSlotId:'',
      localGoles:null,
      visitanteGoles:null,
      estado:'pendiente',
      finalizado:false
    };
    comp.partidos.push(m);
    sf.push(m);
  }
  while(sf.length >= 2 && fi.length < 1){
    const m = {
      id:`${cid}-final-1`,
      jornada:3,
      ronda:3,
      rondaNombre:'Final',
      fase:'Final',
      localSlotId:'',
      visitanteSlotId:'',
      localGoles:null,
      visitanteGoles:null,
      estado:'pendiente',
      finalizado:false
    };
    comp.partidos.push(m);
    fi.push(m);
  }
}
function telAdminAdvanceCup2(comp){
  telAdminEnsureCupRounds2(comp);
  const by = { qf: [], sf: [], final: [] };

  (comp.partidos || []).forEach((m,i)=>{
    m.__i = i;
    const r = telAdminRound2(m);
    if(r === 1) by.qf.push(m);
    else if(r === 2) by.sf.push(m);
    else by.final.push(m);
  });

  Object.values(by).forEach(arr=>arr.sort((a,b)=>
    Number(a.orden ?? a.order ?? a.posicion ?? a.__i) - Number(b.orden ?? b.order ?? b.posicion ?? b.__i)
  ));

  const qfw = by.qf.map(telAdminWinner2);
  const sfw = by.sf.map(telAdminWinner2);

  function setTeams(m, a, b){
    if(!m) return;
    let changed = false;
    if(String(m.localSlotId || '') !== String(a || '')){
      m.localSlotId = a || '';
      changed = true;
    }
    if(String(m.visitanteSlotId || '') !== String(b || '')){
      m.visitanteSlotId = b || '';
      changed = true;
    }
    if(changed) telAdminResetScore2(m);
  }

  if(by.sf[0]) setTeams(by.sf[0], qfw[0] || '', qfw[1] || '');
  if(by.sf[1]) setTeams(by.sf[1], qfw[2] || '', qfw[3] || '');
  if(by.final[0]) setTeams(by.final[0], sfw[0] || '', sfw[1] || '');

  const champSlot = by.final[0] ? telAdminWinner2(by.final[0]) : null;
  if(champSlot){
    const champ = telAdminTeam2(comp, champSlot);
    comp.campeon = champ ? {
      slotId: champSlot,
      nombre: telAdminName2(champ),
      escudoUrl: champ.escudoUrl || champ.logoUrl || champ.escudo || ''
    } : null;
  }else{
    comp.campeon = null;
  }

  (comp.partidos || []).forEach(m=>delete m.__i);
}
function telAdminRecalcLeague2(comp){
  const rows = new Map();

  (comp.equipos || []).forEach((t,i)=>{
    const slot = telAdminSlot2(t,i);
    rows.set(slot, {
      ...t,
      slotId: slot,
      nombre: telAdminName2(t, `Equipo ${i+1}`),
      clubNombre: t.clubNombre || telAdminName2(t, `Equipo ${i+1}`),
      pj:0, pg:0, pe:0, pp:0,
      v:0, e:0, d:0,
      gf:0, gc:0, golesFavor:0, golesContra:0,
      dg:0, pts:0, puntos:0
    });
  });

  (comp.partidos || []).forEach(m=>{
    if(!telAdminPlayed2(m)) return;
    const l = rows.get(String(m.localSlotId || ''));
    const v = rows.get(String(m.visitanteSlotId || ''));
    if(!l || !v) return;

    const lg = Number(m.localGoles ?? 0);
    const vg = Number(m.visitanteGoles ?? 0);

    l.pj++; v.pj++;
    l.gf += lg; l.gc += vg; l.golesFavor = l.gf; l.golesContra = l.gc; l.dg = l.gf - l.gc;
    v.gf += vg; v.gc += lg; v.golesFavor = v.gf; v.golesContra = v.gc; v.dg = v.gf - v.gc;

    if(lg > vg){
      l.pg++; l.v++; l.pts += 3; l.puntos = l.pts;
      v.pp++; v.d++; v.puntos = v.pts;
    }else if(lg < vg){
      v.pg++; v.v++; v.pts += 3; v.puntos = v.pts;
      l.pp++; l.d++; l.puntos = l.pts;
    }else{
      l.pe++; l.e++; l.pts += 1; l.puntos = l.pts;
      v.pe++; v.e++; v.pts += 1; v.puntos = v.pts;
    }
  });

  comp.clasificacion = Array.from(rows.values()).sort((a,b)=>
    (Number(b.pts || 0) - Number(a.pts || 0)) ||
    (Number(b.dg || 0) - Number(a.dg || 0)) ||
    (Number(b.gf || 0) - Number(a.gf || 0)) ||
    String(a.nombre || '').localeCompare(String(b.nombre || ''))
  );
}
function telAdminRecalcAll2(data){
  telAdminEnsureIds2(data);
  telAdminComps2(data).forEach(comp=>{
    if(telAdminIsCup2(comp)) telAdminAdvanceCup2(comp);
    else telAdminRecalcLeague2(comp);
  });
}
function telAdminRequire(req,res,next){
  if(req.session && req.session.isAdmin === true) return next();
  return res.status(403).json({ok:false,message:'Entra con la cuenta admin en Login.'});
}
app.post('/api/admin/login-normal', express.json(), (req,res)=>{
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const adminEmail = String(process.env.ADMIN_EMAIL || 'roleplayserver007@gmail.com').toLowerCase();
  const adminPassword = TEL_ADMIN_PASSWORD;

  if(email !== adminEmail) return res.status(403).json({ok:false,message:'Ese correo no es la cuenta admin.'});
  if(password !== adminPassword) return res.status(403).json({ok:false,message:'Contraseña admin incorrecta.'});

  req.session.isAdmin = true;
  req.session.adminEmail = adminEmail;
  req.session.webAccountId = 'admin-local';
  req.session.save((error)=>{
    if(error) return res.status(500).json({ok:false,message:'No se pudo guardar la sesión.'});
    res.set('Cache-Control','no-store');
    res.json({ok:true,admin:true,email:adminEmail});
  });
});
app.get('/api/admin/resultados-normal-lista', telAdminRequire, (req,res)=>{
  try{
    const data = telAdminRead2();
    telAdminRecalcAll2(data);
    telAdminWrite2(data);

    const competiciones = telAdminComps2(data).map((comp, ci)=>{
      const compId = telAdminCompId2(comp, ci);
      const isCup = telAdminIsCup2(comp);

      return {
        id: compId,
        nombre: comp.nombre || comp.name || compId,
        isCup,
        partidos: (comp.partidos || []).map((m, mi)=>{
          const id = telAdminMatchId2(comp, m, mi);
          const local = telAdminTeam2(comp, m.localSlotId);
          const visitante = telAdminTeam2(comp, m.visitanteSlotId);

          return {
            id,
            jornada: m.jornada || '',
            ronda: m.rondaNombre || m.fase || '',
            localNombre: telAdminName2(local, m.localSlotId || 'Por definir'),
            visitanteNombre: telAdminName2(visitante, m.visitanteSlotId || 'Por definir'),
            localGoles: m.localGoles,
            visitanteGoles: m.visitanteGoles,
            finalizado: telAdminPlayed2(m)
          };
        })
      };
    });

    res.set('Cache-Control','no-store');
    res.json({ok:true,competiciones});
  }catch(e){
    console.error('[resultados-normal-lista]', e);
    res.status(500).json({ok:false,message:String(e.message || e)});
  }
});
app.post('/api/admin/resultados-normal-guardar', express.json(), telAdminRequire, (req,res)=>{
  try{
    const compId = String(req.body?.compId || '').trim();
    const matchId = String(req.body?.matchId || '').trim();
    const lg = Number(req.body?.localGoles);
    const vg = Number(req.body?.visitanteGoles);

    if(!compId) return res.status(400).json({ok:false,message:'Falta competición.'});
    if(!matchId) return res.status(400).json({ok:false,message:'Falta partido.'});
    if(!Number.isInteger(lg) || !Number.isInteger(vg) || lg < 0 || vg < 0){
      return res.status(400).json({ok:false,message:'Pon goles válidos.'});
    }

    const data = telAdminRead2();
    telAdminEnsureIds2(data);

    const comp = telAdminComps2(data).find((c,i)=>telAdminCompId2(c,i) === compId);
    if(!comp) return res.status(404).json({ok:false,message:'Competición no encontrada.'});

    if(telAdminIsCup2(comp) && lg === vg){
      return res.status(400).json({ok:false,message:'En copas no puede haber empate.'});
    }

    const match = (comp.partidos || []).find((m,i)=>telAdminMatchId2(comp,m,i) === matchId);
    if(!match) return res.status(404).json({ok:false,message:'Partido no encontrado.'});

    match.localGoles = lg;
    match.visitanteGoles = vg;
    match.golesLocal = lg;
    match.golesVisitante = vg;
    match.resultado = `${lg}-${vg}`;
    match.estado = 'finalizado';
    match.finalizado = true;
    match.actualizadoPor = req.session.adminEmail || process.env.ADMIN_EMAIL || 'roleplayserver007@gmail.com';
    match.actualizadoEn = new Date().toISOString();

    telAdminRecalcAll2(data);
    telAdminWrite2(data);

    res.set('Cache-Control','no-store');
    res.json({ok:true,message:'Resultado guardado.',data});
  }catch(e){
    console.error('[resultados-normal-guardar]', e);
    res.status(500).json({ok:false,message:String(e.message || e)});
  }
});
app.get('/api/data-live-normal', (req,res)=>{
  try{
    const data = telAdminRead2();
    telAdminRecalcAll2(data);
    telAdminWrite2(data);
    res.set('Cache-Control','no-store');
    res.json(data);
  }catch(e){
    res.status(500).json({ok:false,message:String(e.message||e)});
  }
});



/* ADMIN INLINE PARTIDOS SIMPLE */
function telInlineNorm(v){
  return String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,' ').trim();
}
function telInlineDataPath(){ return path.join(__dirname, 'data.json'); }
function telInlineRead(){ return JSON.parse(fs.readFileSync(telInlineDataPath(), 'utf8')); }
function telInlineWrite(data){ fs.writeFileSync(telInlineDataPath(), JSON.stringify(data, null, 2), 'utf8'); }
function telInlineComps(data){ return data.competiciones || data.ligas || data.torneos || []; }
function telInlineCompId(comp,i){
  if(!comp.id){
    comp.id = String(comp.nombre || comp.name || `competicion-${i+1}`)
      .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
  }
  return String(comp.id);
}
function telInlineMatchId(comp,m,i){
  if(!m.id){
    const cid = String(comp.id || comp.nombre || 'comp').toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
    m.id = `${cid}-partido-${i+1}`;
  }
  return String(m.id);
}
function telInlineSlot(t,i){ return String(t.slotId || t.id || t.clubId || t.nombre || t.clubNombre || `slot-${i+1}`); }
function telInlineName(t,fallback){
  return String(t?.nombre || t?.clubNombre || t?.nombreVisual || t?.name || fallback || 'Por definir')
    .replace(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic}|\s)+/u,'')
    .trim();
}
function telInlineTeam(comp,slot){
  if(!slot) return null;
  return (comp.equipos || []).find((t,i)=>telInlineSlot(t,i) === String(slot)) || null;
}
function telInlineIsCup(comp){
  const txt = telInlineNorm(`${comp.tipo||''} ${comp.formato||''} ${comp.formatoNombre||''} ${comp.formatoDescripcion||''} ${comp.nombre||''}`);
  return txt.includes('copa') || txt.includes('elimin') || txt.includes('torneo') || (comp.partidos || []).some(p=>{
    const r = telInlineNorm(`${p.rondaNombre||''} ${p.fase||''}`);
    return r.includes('cuarto') || r.includes('semi') || r.includes('final');
  });
}
function telInlineRound(m){
  const txt = telInlineNorm(`${m.rondaNombre||''} ${m.fase||''} ${m.nombreRonda||''}`);
  const r = Number(m.ronda || m.round || 0);
  if(txt.includes('cuarto') || r === 1) return 1;
  if(txt.includes('semi') || r === 2) return 2;
  if(txt.includes('final') || r >= 3) return 3;
  return 1;
}
function telInlinePlayed(m){
  return !!m && (
    m.estado === 'finalizado' ||
    m.estado === 'jugado' ||
    m.finalizado === true ||
    (m.localGoles !== null && m.localGoles !== undefined && m.visitanteGoles !== null && m.visitanteGoles !== undefined)
  );
}
function telInlineWinner(m){
  if(!telInlinePlayed(m)) return null;
  const lg = Number(m.localGoles ?? m.golesLocal ?? 0);
  const vg = Number(m.visitanteGoles ?? m.golesVisitante ?? 0);
  if(lg === vg) return null;
  return String(lg > vg ? m.localSlotId : m.visitanteSlotId);
}
function telInlineReset(m){
  if(!m) return;
  m.localGoles=null; m.visitanteGoles=null; m.golesLocal=null; m.golesVisitante=null;
  m.resultado=''; m.estado='pendiente'; m.finalizado=false;
}
function telInlineEnsureIds(data){
  telInlineComps(data).forEach((comp,ci)=>{
    telInlineCompId(comp,ci);
    (comp.partidos || []).forEach((m,mi)=>telInlineMatchId(comp,m,mi));
  });
}
function telInlineEnsureCupRounds(comp){
  comp.partidos = comp.partidos || [];
  const qf = comp.partidos.filter(m=>telInlineRound(m) === 1);
  const sf = comp.partidos.filter(m=>telInlineRound(m) === 2);
  const fi = comp.partidos.filter(m=>telInlineRound(m) === 3);
  const cid = String(comp.id || comp.nombre || 'copa').toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
  while(qf.length >= 4 && sf.length < 2){
    const n=sf.length+1;
    const m={id:`${cid}-semifinal-${n}`,jornada:2,ronda:2,rondaNombre:'Semifinales',fase:'Semifinales',localSlotId:'',visitanteSlotId:'',localGoles:null,visitanteGoles:null,estado:'pendiente',finalizado:false};
    comp.partidos.push(m); sf.push(m);
  }
  while(sf.length >= 2 && fi.length < 1){
    const m={id:`${cid}-final-1`,jornada:3,ronda:3,rondaNombre:'Final',fase:'Final',localSlotId:'',visitanteSlotId:'',localGoles:null,visitanteGoles:null,estado:'pendiente',finalizado:false};
    comp.partidos.push(m); fi.push(m);
  }
}
function telInlineAdvanceCup(comp){
  telInlineEnsureCupRounds(comp);
  const by={qf:[],sf:[],final:[]};
  (comp.partidos || []).forEach((m,i)=>{
    m.__i=i;
    const r=telInlineRound(m);
    if(r===1) by.qf.push(m); else if(r===2) by.sf.push(m); else by.final.push(m);
  });
  Object.values(by).forEach(arr=>arr.sort((a,b)=>Number(a.orden ?? a.order ?? a.posicion ?? a.__i) - Number(b.orden ?? b.order ?? b.posicion ?? b.__i)));
  const qfw=by.qf.map(telInlineWinner);
  const sfw=by.sf.map(telInlineWinner);
  function setTeams(m,a,b){
    if(!m) return;
    let changed=false;
    if(String(m.localSlotId || '') !== String(a || '')){ m.localSlotId = a || ''; changed=true; }
    if(String(m.visitanteSlotId || '') !== String(b || '')){ m.visitanteSlotId = b || ''; changed=true; }
    if(changed) telInlineReset(m);
  }
  if(by.sf[0]) setTeams(by.sf[0], qfw[0] || '', qfw[1] || '');
  if(by.sf[1]) setTeams(by.sf[1], qfw[2] || '', qfw[3] || '');
  if(by.final[0]) setTeams(by.final[0], sfw[0] || '', sfw[1] || '');
  (comp.partidos || []).forEach(m=>delete m.__i);
}
function telInlineRecalcLeague(comp){
  const rows = new Map();
  (comp.equipos || []).forEach((t,i)=>{
    const slot=telInlineSlot(t,i);
    rows.set(slot,{...t,slotId:slot,nombre:telInlineName(t,`Equipo ${i+1}`),clubNombre:t.clubNombre||telInlineName(t,`Equipo ${i+1}`),pj:0,pg:0,pe:0,pp:0,v:0,e:0,d:0,gf:0,gc:0,golesFavor:0,golesContra:0,dg:0,pts:0,puntos:0});
  });
  (comp.partidos || []).forEach(m=>{
    if(!telInlinePlayed(m)) return;
    const l=rows.get(String(m.localSlotId || ''));
    const v=rows.get(String(m.visitanteSlotId || ''));
    if(!l || !v) return;
    const lg=Number(m.localGoles ?? 0);
    const vg=Number(m.visitanteGoles ?? 0);
    l.pj++; v.pj++;
    l.gf+=lg; l.gc+=vg; l.golesFavor=l.gf; l.golesContra=l.gc; l.dg=l.gf-l.gc;
    v.gf+=vg; v.gc+=lg; v.golesFavor=v.gf; v.golesContra=v.gc; v.dg=v.gf-v.gc;
    if(lg>vg){l.pg++;l.v++;l.pts+=3;l.puntos=l.pts;v.pp++;v.d++;v.puntos=v.pts;}
    else if(lg<vg){v.pg++;v.v++;v.pts+=3;v.puntos=v.pts;l.pp++;l.d++;l.puntos=l.pts;}
    else{l.pe++;l.e++;l.pts+=1;l.puntos=l.pts;v.pe++;v.e++;v.pts+=1;v.puntos=v.pts;}
  });
  comp.clasificacion = Array.from(rows.values()).sort((a,b)=>(Number(b.pts||0)-Number(a.pts||0))||(Number(b.dg||0)-Number(a.dg||0))||(Number(b.gf||0)-Number(a.gf||0))||String(a.nombre||'').localeCompare(String(b.nombre||'')));
}
function telInlineRecalcAll(data){
  telInlineEnsureIds(data);
  telInlineComps(data).forEach(comp=>{
    if(telInlineIsCup(comp)) telInlineAdvanceCup(comp);
    else telInlineRecalcLeague(comp);
  });
}
function telInlineRequire(req,res,next){
  if(req.session && req.session.isAdmin === true) return next();
  return res.status(403).json({ok:false,message:'Entra con la cuenta admin.'});
}
app.post('/api/admin/inline-login', express.json(), (req,res)=>{
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const adminEmail = String(process.env.ADMIN_EMAIL || 'roleplayserver007@gmail.com').toLowerCase();
  const adminPassword = TEL_ADMIN_PASSWORD;
  if(email !== adminEmail) return res.status(403).json({ok:false,message:'Ese correo no es admin.'});
  if(password !== adminPassword) return res.status(403).json({ok:false,message:'Contraseña admin incorrecta.'});
  req.session.isAdmin = true;
  req.session.adminEmail = adminEmail;
  req.session.webAccountId = 'admin-local';
  req.session.save((error)=>{
    if(error) return res.status(500).json({ok:false,message:'No se pudo guardar la sesión.'});
    res.set('Cache-Control','no-store');
    res.json({ok:true,admin:true,email:adminEmail});
  });
});
app.get('/api/admin/inline-lista', telInlineRequire, (req,res)=>{
  try{
    const data=telInlineRead();
    telInlineRecalcAll(data);
    telInlineWrite(data);
    const partidos=[];
    telInlineComps(data).forEach((comp,ci)=>{
      const compId=telInlineCompId(comp,ci);
      const isCup=telInlineIsCup(comp);
      (comp.partidos || []).forEach((m,mi)=>{
        const id=telInlineMatchId(comp,m,mi);
        const local=telInlineTeam(comp,m.localSlotId);
        const away=telInlineTeam(comp,m.visitanteSlotId);
        partidos.push({
          compId,
          compNombre: comp.nombre || comp.name || compId,
          isCup,
          id,
          jornada:m.jornada || '',
          ronda:m.rondaNombre || m.fase || '',
          localNombre:telInlineName(local,m.localSlotId || 'Por definir'),
          visitanteNombre:telInlineName(away,m.visitanteSlotId || 'Por definir'),
          localGoles:m.localGoles,
          visitanteGoles:m.visitanteGoles,
          finalizado:telInlinePlayed(m)
        });
      });
    });
    res.set('Cache-Control','no-store');
    res.json({ok:true,partidos});
  }catch(e){res.status(500).json({ok:false,message:String(e.message||e)});}
});
app.post('/api/admin/inline-guardar', express.json(), telInlineRequire, (req,res)=>{
  try{
    const compId=String(req.body?.compId || '').trim();
    const matchId=String(req.body?.matchId || '').trim();
    const lg=Number(req.body?.localGoles);
    const vg=Number(req.body?.visitanteGoles);
    if(!compId || !matchId) return res.status(400).json({ok:false,message:'Falta partido.'});
    if(!Number.isInteger(lg) || !Number.isInteger(vg) || lg<0 || vg<0) return res.status(400).json({ok:false,message:'Pon goles válidos.'});
    const data=telInlineRead();
    telInlineEnsureIds(data);
    const comp=telInlineComps(data).find((c,i)=>telInlineCompId(c,i) === compId);
    if(!comp) return res.status(404).json({ok:false,message:'Competición no encontrada.'});
    if(telInlineIsCup(comp) && lg === vg) return res.status(400).json({ok:false,message:'En copas no puede haber empate.'});
    const match=(comp.partidos || []).find((m,i)=>telInlineMatchId(comp,m,i) === matchId);
    if(!match) return res.status(404).json({ok:false,message:'Partido no encontrado.'});
    match.localGoles=lg; match.visitanteGoles=vg; match.golesLocal=lg; match.golesVisitante=vg; match.resultado=`${lg}-${vg}`; match.estado='finalizado'; match.finalizado=true; match.actualizadoPor=req.session.adminEmail || 'admin'; match.actualizadoEn=new Date().toISOString();
    telInlineRecalcAll(data);
    telInlineWrite(data);
    res.set('Cache-Control','no-store');
    res.json({ok:true,message:'Resultado guardado.',data});
  }catch(e){res.status(500).json({ok:false,message:String(e.message||e)});}
});



/* ADMIN LOGIN DESBLOQUEO TOTAL */
app.post('/api/admin/desbloqueo-login', express.json(), (req,res)=>{
  try{
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const adminEmail = String(process.env.ADMIN_EMAIL || 'roleplayserver007@gmail.com').toLowerCase();
    const adminPassword = TEL_ADMIN_PASSWORD;

    if(email !== adminEmail){
      return res.status(403).json({ok:false,message:'Ese correo no es la cuenta admin.'});
    }
    if(password !== adminPassword){
      return res.status(403).json({ok:false,message:'Contraseña admin incorrecta.'});
    }

    req.session.isAdmin = true;
    req.session.adminEmail = adminEmail;
    req.session.user = {
      email: adminEmail,
      nombre: 'Administrador',
      role: 'admin',
      isAdmin: true
    };
    req.session.webAccountId = 'admin-local';

    res.json({
      ok:true,
      admin:true,
      user:{
        email:adminEmail,
        nombre:'Administrador',
        role:'admin',
        isAdmin:true
      }
    });
  }catch(error){
    res.status(500).json({ok:false,message:String(error.message || error)});
  }
});

app.get('/api/admin/desbloqueo-status', (req,res)=>{
  res.set('Cache-Control','no-store');
  res.json({
    ok:true,
    admin: !!(req.session && req.session.isAdmin),
    email: req.session?.adminEmail || req.session?.user?.email || null,
    user: req.session?.user || null
  });
});



/* TEL FIX FINAL LOGIN Y RESULTADOS */
function telFinalFixNorm(v){
  return String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,' ').trim();
}
function telFinalFixDataPath(){ return path.join(__dirname, 'data.json'); }
function telFinalFixRead(){ return JSON.parse(fs.readFileSync(telFinalFixDataPath(), 'utf8')); }
function telFinalFixWrite(data){ fs.writeFileSync(telFinalFixDataPath(), JSON.stringify(data, null, 2), 'utf8'); }
function telFinalFixComps(data){ return data.competiciones || data.ligas || data.torneos || []; }
function telFinalFixCompId(comp, i){
  if(!comp.id){
    comp.id = String(comp.nombre || comp.name || `competicion-${i+1}`)
      .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
  }
  return String(comp.id);
}
function telFinalFixMatchId(comp, m, i){
  if(!m.id){
    const cid = String(comp.id || comp.nombre || 'comp').toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
    m.id = `${cid}-partido-${i+1}`;
  }
  return String(m.id);
}
function telFinalFixSlot(t,i){ return String(t.slotId || t.id || t.clubId || t.nombre || t.clubNombre || `slot-${i+1}`); }
function telFinalFixName(t,fallback){
  return String(t?.nombre || t?.clubNombre || t?.nombreVisual || t?.name || fallback || 'Por definir')
    .replace(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic}|\s)+/u,'')
    .trim();
}
function telFinalFixTeam(comp, slot){
  if(!slot) return null;
  return (comp.equipos || []).find((t,i)=>telFinalFixSlot(t,i) === String(slot)) || null;
}
function telFinalFixIsCup(comp){
  const txt = telFinalFixNorm(`${comp.tipo||''} ${comp.formato||''} ${comp.formatoNombre||''} ${comp.formatoDescripcion||''} ${comp.nombre||''}`);
  return txt.includes('copa') || txt.includes('elimin') || txt.includes('torneo') || (comp.partidos || []).some(p=>{
    const r = telFinalFixNorm(`${p.rondaNombre||''} ${p.fase||''}`);
    return r.includes('cuarto') || r.includes('semi') || r.includes('final');
  });
}
function telFinalFixRound(m){
  const txt = telFinalFixNorm(`${m.rondaNombre||''} ${m.fase||''} ${m.nombreRonda||''}`);
  const r = Number(m.ronda || m.round || 0);
  if(txt.includes('cuarto') || r === 1) return 1;
  if(txt.includes('semi') || r === 2) return 2;
  if(txt.includes('final') || r >= 3) return 3;
  return 1;
}
function telFinalFixPlayed(m){
  return !!m && (
    m.estado === 'finalizado' ||
    m.estado === 'jugado' ||
    m.finalizado === true ||
    (m.localGoles !== null && m.localGoles !== undefined && m.visitanteGoles !== null && m.visitanteGoles !== undefined)
  );
}
function telFinalFixWinner(m){
  if(!telFinalFixPlayed(m)) return null;
  const lg = Number(m.localGoles ?? m.golesLocal ?? 0);
  const vg = Number(m.visitanteGoles ?? m.golesVisitante ?? 0);
  if(lg === vg) return null;
  return String(lg > vg ? m.localSlotId : m.visitanteSlotId);
}
function telFinalFixReset(m){
  if(!m) return;
  m.localGoles = null; m.visitanteGoles = null;
  m.golesLocal = null; m.golesVisitante = null;
  m.resultado = ''; m.estado = 'pendiente'; m.finalizado = false;
}
function telFinalFixEnsureIds(data){
  telFinalFixComps(data).forEach((comp,ci)=>{
    telFinalFixCompId(comp,ci);
    (comp.partidos || []).forEach((m,mi)=>telFinalFixMatchId(comp,m,mi));
  });
}
function telFinalFixEnsureCupRounds(comp){
  comp.partidos = comp.partidos || [];
  const qf = comp.partidos.filter(m=>telFinalFixRound(m) === 1);
  const sf = comp.partidos.filter(m=>telFinalFixRound(m) === 2);
  const fi = comp.partidos.filter(m=>telFinalFixRound(m) === 3);
  const cid = String(comp.id || comp.nombre || 'copa').toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
  while(qf.length >= 4 && sf.length < 2){
    const n=sf.length+1;
    const m={id:`${cid}-semifinal-${n}`,jornada:2,ronda:2,rondaNombre:'Semifinales',fase:'Semifinales',localSlotId:'',visitanteSlotId:'',localGoles:null,visitanteGoles:null,estado:'pendiente',finalizado:false};
    comp.partidos.push(m); sf.push(m);
  }
  while(sf.length >= 2 && fi.length < 1){
    const m={id:`${cid}-final-1`,jornada:3,ronda:3,rondaNombre:'Final',fase:'Final',localSlotId:'',visitanteSlotId:'',localGoles:null,visitanteGoles:null,estado:'pendiente',finalizado:false};
    comp.partidos.push(m); fi.push(m);
  }
}
function telFinalFixAdvanceCup(comp){
  telFinalFixEnsureCupRounds(comp);
  const by={qf:[],sf:[],final:[]};
  (comp.partidos || []).forEach((m,i)=>{
    m.__i=i;
    const r=telFinalFixRound(m);
    if(r===1) by.qf.push(m); else if(r===2) by.sf.push(m); else by.final.push(m);
  });
  Object.values(by).forEach(arr=>arr.sort((a,b)=>Number(a.orden ?? a.order ?? a.posicion ?? a.__i) - Number(b.orden ?? b.order ?? b.posicion ?? b.__i)));
  const qfw=by.qf.map(telFinalFixWinner);
  const sfw=by.sf.map(telFinalFixWinner);
  function setTeams(m,a,b){
    if(!m) return;
    let changed=false;
    if(String(m.localSlotId || '') !== String(a || '')){m.localSlotId=a || ''; changed=true;}
    if(String(m.visitanteSlotId || '') !== String(b || '')){m.visitanteSlotId=b || ''; changed=true;}
    if(changed) telFinalFixReset(m);
  }
  if(by.sf[0]) setTeams(by.sf[0], qfw[0] || '', qfw[1] || '');
  if(by.sf[1]) setTeams(by.sf[1], qfw[2] || '', qfw[3] || '');
  if(by.final[0]) setTeams(by.final[0], sfw[0] || '', sfw[1] || '');
  (comp.partidos || []).forEach(m=>delete m.__i);
}
function telFinalFixRecalcLeague(comp){
  const rows = new Map();
  (comp.equipos || []).forEach((t,i)=>{
    const slot=telFinalFixSlot(t,i);
    rows.set(slot,{...t,slotId:slot,nombre:telFinalFixName(t,`Equipo ${i+1}`),clubNombre:t.clubNombre||telFinalFixName(t,`Equipo ${i+1}`),pj:0,pg:0,pe:0,pp:0,v:0,e:0,d:0,gf:0,gc:0,golesFavor:0,golesContra:0,dg:0,pts:0,puntos:0});
  });
  (comp.partidos || []).forEach(m=>{
    if(!telFinalFixPlayed(m)) return;
    const l=rows.get(String(m.localSlotId || ''));
    const v=rows.get(String(m.visitanteSlotId || ''));
    if(!l || !v) return;
    const lg=Number(m.localGoles ?? 0);
    const vg=Number(m.visitanteGoles ?? 0);
    l.pj++; v.pj++;
    l.gf+=lg; l.gc+=vg; l.golesFavor=l.gf; l.golesContra=l.gc; l.dg=l.gf-l.gc;
    v.gf+=vg; v.gc+=lg; v.golesFavor=v.gf; v.golesContra=v.gc; v.dg=v.gf-v.gc;
    if(lg>vg){l.pg++;l.v++;l.pts+=3;l.puntos=l.pts;v.pp++;v.d++;v.puntos=v.pts;}
    else if(lg<vg){v.pg++;v.v++;v.pts+=3;v.puntos=v.pts;l.pp++;l.d++;l.puntos=l.pts;}
    else{l.pe++;l.e++;l.pts+=1;l.puntos=l.pts;v.pe++;v.e++;v.pts+=1;v.puntos=v.pts;}
  });
  comp.clasificacion=Array.from(rows.values()).sort((a,b)=>(Number(b.pts||0)-Number(a.pts||0))||(Number(b.dg||0)-Number(a.dg||0))||(Number(b.gf||0)-Number(a.gf||0))||String(a.nombre||'').localeCompare(String(b.nombre||'')));
}
function telFinalFixRecalcAll(data){
  telFinalFixEnsureIds(data);
  telFinalFixComps(data).forEach(comp=>{
    if(telFinalFixIsCup(comp)) telFinalFixAdvanceCup(comp);
    else telFinalFixRecalcLeague(comp);
  });
}
app.post('/api/tel-final/admin-login', express.json(), (req,res)=>{
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const adminEmail = String(process.env.ADMIN_EMAIL || 'roleplayserver007@gmail.com').toLowerCase();
  const adminPassword = TEL_ADMIN_PASSWORD;
  if(email !== adminEmail) return res.status(403).json({ok:false,message:'Correo admin incorrecto.'});
  if(password !== adminPassword) return res.status(403).json({ok:false,message:'Contraseña admin incorrecta.'});
  if(req.session){
    req.session.isAdmin=true;
    req.session.adminEmail=adminEmail;
    req.session.user={email:adminEmail,nombre:'Administrador',role:'admin',isAdmin:true};
    req.session.webAccountId='admin-local';
  }
  res.json({ok:true,admin:true,email:adminEmail,user:{email:adminEmail,nombre:'Administrador',role:'admin',isAdmin:true}});
});
app.get('/api/tel-final/admin-status', (req,res)=>{
  res.set('Cache-Control','no-store');
  res.json({ok:true,admin:!!(req.session && req.session.isAdmin),email:req.session?.adminEmail || null});
});
app.get('/api/tel-final/matches', (req,res)=>{
  try{
    const data=telFinalFixRead();
    telFinalFixRecalcAll(data);
    telFinalFixWrite(data);
    const matches=[];
    telFinalFixComps(data).forEach((comp,ci)=>{
      const compId=telFinalFixCompId(comp,ci);
      const isCup=telFinalFixIsCup(comp);
      (comp.partidos || []).forEach((m,mi)=>{
        const id=telFinalFixMatchId(comp,m,mi);
        const local=telFinalFixTeam(comp,m.localSlotId);
        const away=telFinalFixTeam(comp,m.visitanteSlotId);
        matches.push({
          compId,
          compNombre:comp.nombre || comp.name || compId,
          isCup,
          id,
          jornada:m.jornada || '',
          ronda:m.rondaNombre || m.fase || '',
          localNombre:telFinalFixName(local,m.localSlotId || 'Por definir'),
          visitanteNombre:telFinalFixName(away,m.visitanteSlotId || 'Por definir'),
          localGoles:m.localGoles,
          visitanteGoles:m.visitanteGoles,
          finalizado:telFinalFixPlayed(m)
        });
      });
    });
    res.set('Cache-Control','no-store');
    res.json({ok:true,matches});
  }catch(e){res.status(500).json({ok:false,message:String(e.message||e)});}
});
app.post('/api/tel-final/save-result', express.json(), (req,res)=>{
  try{
    const compId=String(req.body?.compId || '').trim();
    const matchId=String(req.body?.matchId || '').trim();
    const lg=Number(req.body?.localGoles);
    const vg=Number(req.body?.visitanteGoles);
    if(!compId || !matchId) return res.status(400).json({ok:false,message:'Falta partido.'});
    if(!Number.isInteger(lg) || !Number.isInteger(vg) || lg<0 || vg<0) return res.status(400).json({ok:false,message:'Pon goles válidos.'});
    const data=telFinalFixRead();
    telFinalFixEnsureIds(data);
    const comp=telFinalFixComps(data).find((c,i)=>telFinalFixCompId(c,i) === compId);
    if(!comp) return res.status(404).json({ok:false,message:'Competición no encontrada.'});
    if(telFinalFixIsCup(comp) && lg === vg) return res.status(400).json({ok:false,message:'En copas no puede haber empate.'});
    const match=(comp.partidos || []).find((m,i)=>telFinalFixMatchId(comp,m,i) === matchId);
    if(!match) return res.status(404).json({ok:false,message:'Partido no encontrado.'});
    match.localGoles=lg; match.visitanteGoles=vg; match.golesLocal=lg; match.golesVisitante=vg;
    match.resultado=`${lg}-${vg}`; match.estado='finalizado'; match.finalizado=true; match.actualizadoPor='admin'; match.actualizadoEn=new Date().toISOString();
    telFinalFixRecalcAll(data);
    telFinalFixWrite(data);
    res.set('Cache-Control','no-store');
    res.json({ok:true,message:'Resultado guardado.',data});
  }catch(e){res.status(500).json({ok:false,message:String(e.message||e)});}
});



/* TEL CLEAN SAVE RESULT FALLBACK */
app.post('/api/tel-clean/save-result', express.json(), (req,res)=>{
  try{
    const compId = String(req.body?.compId || '').trim();
    const matchId = String(req.body?.matchId || '').trim();
    const lg = Number(req.body?.localGoles);
    const vg = Number(req.body?.visitanteGoles);

    if(!compId || !matchId) return res.status(400).json({ok:false,message:'Falta partido.'});
    if(!Number.isInteger(lg) || !Number.isInteger(vg) || lg < 0 || vg < 0){
      return res.status(400).json({ok:false,message:'Pon goles válidos.'});
    }

    const dataPath = path.join(__dirname, 'data.json');
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const comps = data.competiciones || data.ligas || data.torneos || [];

    const norm = v => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,' ').trim();
    const compKey = (c,i) => {
      if(!c.id) c.id = String(c.nombre || c.name || `competicion-${i+1}`).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
      return String(c.id);
    };
    const matchKey = (c,m,i) => {
      if(!m.id){
        const cid = String(c.id || c.nombre || 'comp').toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
        m.id = `${cid}-partido-${i+1}`;
      }
      return String(m.id);
    };
    const slot = (t,i)=>String(t.slotId || t.id || t.clubId || t.nombre || t.clubNombre || `slot-${i+1}`);
    const isCup = c => {
      const txt = norm(`${c.tipo||''} ${c.formato||''} ${c.formatoNombre||''} ${c.formatoDescripcion||''} ${c.nombre||''}`);
      return txt.includes('copa') || txt.includes('elimin') || txt.includes('torneo') || (c.partidos || []).some(p=>{
        const r = norm(`${p.rondaNombre||''} ${p.fase||''}`);
        return r.includes('cuarto') || r.includes('semi') || r.includes('final');
      });
    };
    const round = m => {
      const t = norm(`${m.rondaNombre||''} ${m.fase||''}`);
      const r = Number(m.ronda || m.round || 0);
      if(t.includes('cuarto') || r === 1) return 1;
      if(t.includes('semi') || r === 2) return 2;
      if(t.includes('final') || r >= 3) return 3;
      return 1;
    };
    const played = m => m && (m.estado === 'finalizado' || m.finalizado === true || (m.localGoles !== null && m.localGoles !== undefined && m.visitanteGoles !== null && m.visitanteGoles !== undefined));
    const winner = m => {
      if(!played(m)) return null;
      const a = Number(m.localGoles ?? 0), b = Number(m.visitanteGoles ?? 0);
      if(a === b) return null;
      return String(a > b ? m.localSlotId : m.visitanteSlotId);
    };
    const reset = m => {
      if(!m) return;
      m.localGoles=null; m.visitanteGoles=null; m.golesLocal=null; m.golesVisitante=null; m.resultado=''; m.estado='pendiente'; m.finalizado=false;
    };
    const ensureCup = c => {
      c.partidos = c.partidos || [];
      const qf = c.partidos.filter(m=>round(m)===1);
      const sf = c.partidos.filter(m=>round(m)===2);
      const fi = c.partidos.filter(m=>round(m)===3);
      const cid = String(c.id || c.nombre || 'copa').toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
      while(qf.length >= 4 && sf.length < 2){
        const n = sf.length + 1;
        const m = {id:`${cid}-semifinal-${n}`,jornada:2,ronda:2,rondaNombre:'Semifinales',fase:'Semifinales',localSlotId:'',visitanteSlotId:'',localGoles:null,visitanteGoles:null,estado:'pendiente',finalizado:false};
        c.partidos.push(m); sf.push(m);
      }
      while(sf.length >= 2 && fi.length < 1){
        const m = {id:`${cid}-final-1`,jornada:3,ronda:3,rondaNombre:'Final',fase:'Final',localSlotId:'',visitanteSlotId:'',localGoles:null,visitanteGoles:null,estado:'pendiente',finalizado:false};
        c.partidos.push(m); fi.push(m);
      }
    };
    const advanceCup = c => {
      ensureCup(c);
      const by = {qf:[], sf:[], final:[]};
      (c.partidos || []).forEach((m,i)=>{
        m.__i = i;
        const r = round(m);
        if(r === 1) by.qf.push(m); else if(r === 2) by.sf.push(m); else by.final.push(m);
      });
      Object.values(by).forEach(a=>a.sort((x,y)=>Number(x.orden ?? x.order ?? x.posicion ?? x.__i)-Number(y.orden ?? y.order ?? y.posicion ?? y.__i)));
      const qfw = by.qf.map(winner), sfw = by.sf.map(winner);
      const setTeams = (m,a,b) => {
        if(!m) return;
        let ch = false;
        if(String(m.localSlotId || '') !== String(a || '')){m.localSlotId=a||''; ch=true;}
        if(String(m.visitanteSlotId || '') !== String(b || '')){m.visitanteSlotId=b||''; ch=true;}
        if(ch) reset(m);
      };
      if(by.sf[0]) setTeams(by.sf[0], qfw[0] || '', qfw[1] || '');
      if(by.sf[1]) setTeams(by.sf[1], qfw[2] || '', qfw[3] || '');
      if(by.final[0]) setTeams(by.final[0], sfw[0] || '', sfw[1] || '');
      (c.partidos || []).forEach(m=>delete m.__i);
    };
    const recalcLeague = c => {
      const rows = new Map();
      (c.equipos || []).forEach((t,i)=>{
        const s = slot(t,i);
        rows.set(s,{...t,slotId:s,pj:0,pg:0,pe:0,pp:0,v:0,e:0,d:0,gf:0,gc:0,golesFavor:0,golesContra:0,dg:0,pts:0,puntos:0});
      });
      (c.partidos || []).forEach(m=>{
        if(!played(m)) return;
        const l = rows.get(String(m.localSlotId || '')), v = rows.get(String(m.visitanteSlotId || ''));
        if(!l || !v) return;
        const a = Number(m.localGoles ?? 0), b = Number(m.visitanteGoles ?? 0);
        l.pj++; v.pj++; l.gf += a; l.gc += b; v.gf += b; v.gc += a;
        l.golesFavor=l.gf; l.golesContra=l.gc; v.golesFavor=v.gf; v.golesContra=v.gc;
        l.dg=l.gf-l.gc; v.dg=v.gf-v.gc;
        if(a>b){l.pg++;l.v++;l.pts+=3;l.puntos=l.pts;v.pp++;v.d++;v.puntos=v.pts;}
        else if(a<b){v.pg++;v.v++;v.pts+=3;v.puntos=v.pts;l.pp++;l.d++;l.puntos=l.pts;}
        else{l.pe++;l.e++;v.pe++;v.e++;l.pts+=1;v.pts+=1;l.puntos=l.pts;v.puntos=v.pts;}
      });
      c.clasificacion = Array.from(rows.values()).sort((a,b)=>(Number(b.pts||0)-Number(a.pts||0))||(Number(b.dg||0)-Number(a.dg||0))||(Number(b.gf||0)-Number(a.gf||0)));
    };

    comps.forEach((c,ci)=>{ compKey(c,ci); (c.partidos||[]).forEach((m,mi)=>matchKey(c,m,mi)); });
    const comp = comps.find((c,i)=>compKey(c,i) === compId);
    if(!comp) return res.status(404).json({ok:false,message:'Competición no encontrada.'});
    if(isCup(comp) && lg === vg) return res.status(400).json({ok:false,message:'En copas no puede haber empate.'});
    const match = (comp.partidos || []).find((m,i)=>matchKey(comp,m,i) === matchId);
    if(!match) return res.status(404).json({ok:false,message:'Partido no encontrado.'});

    match.localGoles = lg; match.visitanteGoles = vg; match.golesLocal = lg; match.golesVisitante = vg;
    match.resultado = `${lg}-${vg}`; match.estado = 'finalizado'; match.finalizado = true;
    match.actualizadoPor = 'admin'; match.actualizadoEn = new Date().toISOString();

    comps.forEach(c => isCup(c) ? advanceCup(c) : recalcLeague(c));
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');
    res.set('Cache-Control','no-store');
    res.json({ok:true,message:'Resultado guardado.'});
  }catch(e){
    console.error('[tel-clean/save-result]', e);
    res.status(500).json({ok:false,message:String(e.message || e)});
  }
});



/* PANEL RESULTADOS ESTILO ADMIN */
function telPanelNorm(v){
  return String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,' ').trim();
}
function telPanelDataPath(){ return path.join(__dirname, 'data.json'); }
function telPanelRead(){ return JSON.parse(fs.readFileSync(telPanelDataPath(), 'utf8')); }
function telPanelWrite(data){ fs.writeFileSync(telPanelDataPath(), JSON.stringify(data, null, 2), 'utf8'); }
function telPanelComps(data){ return data.competiciones || data.ligas || data.torneos || []; }
function telPanelCompId(comp,i){
  if(!comp.id){
    comp.id = String(comp.nombre || comp.name || `competicion-${i+1}`)
      .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
  }
  return String(comp.id);
}
function telPanelMatchId(comp,m,i){
  if(!m.id){
    const cid = String(comp.id || comp.nombre || 'comp').toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
    m.id = `${cid}-partido-${i+1}`;
  }
  return String(m.id);
}
function telPanelSlot(t,i){ return String(t.slotId || t.id || t.clubId || t.nombre || t.clubNombre || `slot-${i+1}`); }
function telPanelName(t,fallback){
  return String(t?.nombre || t?.clubNombre || t?.nombreVisual || t?.name || fallback || 'Por definir')
    .replace(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic}|\s)+/u,'')
    .trim();
}
function telPanelLogo(t){
  if(!t) return '';
  const key=t.clubId || t.idClub || t.clubNombre || t.nombre || t.nombreVisual || t.name || t.id;
  return key ? `/api/club-logo?key=${encodeURIComponent(String(key))}` : telClientLogo(t);
}
function telPanelTeam(comp,slot,data,match,side){
  const teams = comp?.equipos || [];
  const raw = String(slot || '').trim();
  const target = telPanelNorm(raw);
  let found = teams.find((t,i)=>telPanelSlot(t,i) === raw) || teams.find((t,i)=>{
    const values=[telPanelSlot(t,i),t.id,t.clubId,t.clubNombre,t.nombre,t.nombreVisual,t.name];
    return values.some(value=>value && telPanelNorm(value) === target);
  }) || null;
  const directName = side === 'local'
    ? (match?.localNombre || match?.nombreLocal || match?.equipoLocal || '')
    : (match?.visitanteNombre || match?.nombreVisitante || match?.equipoVisitante || '');
  if(!found && directName){
    const wanted=telPanelNorm(directName);
    found=teams.find(t=>[t.clubNombre,t.nombre,t.nombreVisual,t.name].some(value=>value && telPanelNorm(value)===wanted)) || null;
  }
  const clubs = data?.clubes || data?.equipos || [];
  if(!found){
    const wanted=telPanelNorm(directName || raw);
    const club=clubs.find(t=>[t.id,t.clubId,t.clubNombre,t.nombre,t.nombreVisual,t.name].some(value=>value && telPanelNorm(value)===wanted));
    if(club) found=club;
  }
  if(found) return telCanonicalTeam(data, found);
  const embeddedLogo = side === 'local'
    ? (match?.localLogo || match?.localEscudo || '')
    : (match?.visitanteLogo || match?.visitanteEscudo || '');
  return directName ? {nombre:directName,clubNombre:directName,escudoUrl:embeddedLogo} : null;
}
function telPanelIsCup(comp){
  const txt = telPanelNorm(`${comp.tipo||''} ${comp.formato||''} ${comp.formatoNombre||''} ${comp.formatoDescripcion||''} ${comp.nombre||''}`);
  return txt.includes('copa') || txt.includes('elimin') || txt.includes('torneo') || (comp.partidos || []).some(p=>{
    const r = telPanelNorm(`${p.rondaNombre||''} ${p.fase||''}`);
    return r.includes('cuarto') || r.includes('semi') || r.includes('final');
  });
}
function telPanelRound(m){
  const txt = telPanelNorm(`${m.rondaNombre||''} ${m.fase||''} ${m.nombreRonda||''}`);
  const r = Number(m.ronda || m.round || 0);
  if(txt.includes('cuarto') || r === 1) return 1;
  if(txt.includes('semi') || r === 2) return 2;
  if(txt.includes('final') || r >= 3) return 3;
  return 1;
}
function telPanelPlayed(m){
  return !!m && (
    m.estado === 'finalizado' ||
    m.estado === 'jugado' ||
    m.finalizado === true ||
    (m.localGoles !== null && m.localGoles !== undefined && m.visitanteGoles !== null && m.visitanteGoles !== undefined)
  );
}
function telPanelWinner(m){
  if(!telPanelPlayed(m)) return null;
  const lg = Number(m.localGoles ?? m.golesLocal ?? 0);
  const vg = Number(m.visitanteGoles ?? m.golesVisitante ?? 0);
  if(lg === vg) return null;
  return String(lg > vg ? m.localSlotId : m.visitanteSlotId);
}
function telPanelReset(m){
  if(!m) return;
  m.localGoles = null; m.visitanteGoles = null;
  m.golesLocal = null; m.golesVisitante = null;
  m.resultado = ''; m.estado = 'pendiente'; m.finalizado = false;
}
function telPanelEnsureIds(data){
  telPanelComps(data).forEach((comp,ci)=>{
    telPanelCompId(comp,ci);
    (comp.partidos || []).forEach((m,mi)=>telPanelMatchId(comp,m,mi));
  });
}
function telPanelEnsureCupRounds(comp){
  comp.partidos = comp.partidos || [];
  const qf = comp.partidos.filter(m=>telPanelRound(m) === 1);
  const sf = comp.partidos.filter(m=>telPanelRound(m) === 2);
  const fi = comp.partidos.filter(m=>telPanelRound(m) === 3);
  const cid = String(comp.id || comp.nombre || 'copa').toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');

  while(qf.length >= 4 && sf.length < 2){
    const n=sf.length+1;
    const m={id:`${cid}-semifinal-${n}`,jornada:2,ronda:2,rondaNombre:'Semifinales',fase:'Semifinales',localSlotId:'',visitanteSlotId:'',localGoles:null,visitanteGoles:null,estado:'pendiente',finalizado:false};
    comp.partidos.push(m); sf.push(m);
  }
  while(sf.length >= 2 && fi.length < 1){
    const m={id:`${cid}-final-1`,jornada:3,ronda:3,rondaNombre:'Final',fase:'Final',localSlotId:'',visitanteSlotId:'',localGoles:null,visitanteGoles:null,estado:'pendiente',finalizado:false};
    comp.partidos.push(m); fi.push(m);
  }
}
function telPanelAdvanceCup(comp){
  telPanelEnsureCupRounds(comp);
  const by={qf:[],sf:[],final:[]};
  (comp.partidos || []).forEach((m,i)=>{
    m.__i=i;
    const r=telPanelRound(m);
    if(r===1) by.qf.push(m); else if(r===2) by.sf.push(m); else by.final.push(m);
  });
  Object.values(by).forEach(arr=>arr.sort((a,b)=>Number(a.orden ?? a.order ?? a.posicion ?? a.__i) - Number(b.orden ?? b.order ?? b.posicion ?? b.__i)));
  const qfw=by.qf.map(telPanelWinner);
  const sfw=by.sf.map(telPanelWinner);

  function setTeams(m,a,b){
    if(!m) return;
    let changed=false;
    if(String(m.localSlotId || '') !== String(a || '')){m.localSlotId=a || ''; changed=true;}
    if(String(m.visitanteSlotId || '') !== String(b || '')){m.visitanteSlotId=b || ''; changed=true;}
    if(changed) telPanelReset(m);
  }
  if(by.sf[0]) setTeams(by.sf[0], qfw[0] || '', qfw[1] || '');
  if(by.sf[1]) setTeams(by.sf[1], qfw[2] || '', qfw[3] || '');
  if(by.final[0]) setTeams(by.final[0], sfw[0] || '', sfw[1] || '');
  (comp.partidos || []).forEach(m=>delete m.__i);
}
function telPanelRecalcLeague(comp){
  const rows = new Map();
  (comp.equipos || []).forEach((t,i)=>{
    const s=telPanelSlot(t,i);
    rows.set(s,{...t,slotId:s,nombre:telPanelName(t,`Equipo ${i+1}`),clubNombre:t.clubNombre||telPanelName(t,`Equipo ${i+1}`),pj:0,pg:0,pe:0,pp:0,v:0,e:0,d:0,gf:0,gc:0,golesFavor:0,golesContra:0,dg:0,pts:0,puntos:0});
  });
  (comp.partidos || []).forEach(m=>{
    if(!telPanelPlayed(m)) return;
    const l=rows.get(String(m.localSlotId || ''));
    const v=rows.get(String(m.visitanteSlotId || ''));
    if(!l || !v) return;
    const lg=Number(m.localGoles ?? 0);
    const vg=Number(m.visitanteGoles ?? 0);
    l.pj++; v.pj++;
    l.gf+=lg; l.gc+=vg; l.golesFavor=l.gf; l.golesContra=l.gc; l.dg=l.gf-l.gc;
    v.gf+=vg; v.gc+=lg; v.golesFavor=v.gf; v.golesContra=v.gc; v.dg=v.gf-v.gc;
    if(lg>vg){l.pg++;l.v++;l.pts+=3;l.puntos=l.pts;v.pp++;v.d++;v.puntos=v.pts;}
    else if(lg<vg){v.pg++;v.v++;v.pts+=3;v.puntos=v.pts;l.pp++;l.d++;l.puntos=l.pts;}
    else{l.pe++;l.e++;l.pts+=1;l.puntos=l.pts;v.pe++;v.e++;v.pts+=1;v.puntos=v.pts;}
  });
  comp.clasificacion = Array.from(rows.values()).sort((a,b)=>(Number(b.pts||0)-Number(a.pts||0))||(Number(b.dg||0)-Number(a.dg||0))||(Number(b.gf||0)-Number(a.gf||0))||String(a.nombre||'').localeCompare(String(b.nombre||'')));
}
function telPanelRecalcAll(data){
  telPanelEnsureIds(data);
  telPanelComps(data).forEach(comp=>{
    if(telPanelIsCup(comp)) telPanelAdvanceCup(comp);
    else telPanelRecalcLeague(comp);
  });
}
function telPanelAdminOk(req){
  return true; // panel local del proyecto
}
app.post('/api/tel-panel/login', express.json(), (req,res)=>{
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const adminEmail = String(process.env.ADMIN_EMAIL || 'roleplayserver007@gmail.com').toLowerCase();
  const adminPassword = TEL_ADMIN_PASSWORD;
  if(email !== adminEmail) return res.status(403).json({ok:false,message:'Correo admin incorrecto.'});
  if(password !== adminPassword) return res.status(403).json({ok:false,message:'Contraseña admin incorrecta.'});
  if(req.session){
    req.session.isAdmin=true;
    req.session.adminEmail=adminEmail;
    req.session.user={email:adminEmail,nombre:'Admin TEL',role:'admin',isAdmin:true};
  }
  res.json({ok:true,admin:true,email:adminEmail});
});
app.get('/api/tel-panel/matches', (req,res)=>{
  try{
    const data=telPanelRead();
    telPanelRecalcAll(data);
    telPanelWrite(data);
    const competiciones = telPanelComps(data).map((comp,ci)=>({
      id: telPanelCompId(comp,ci),
      nombre: comp.nombre || comp.name || telPanelCompId(comp,ci),
      isCup: telPanelIsCup(comp)
    }));
    const matches=[];
    telPanelComps(data).forEach((comp,ci)=>{
      const compId=telPanelCompId(comp,ci);
      const isCup=telPanelIsCup(comp);
      (comp.partidos || []).forEach((m,mi)=>{
        const id=telPanelMatchId(comp,m,mi);
        const local=telPanelTeam(comp,m.localSlotId,data,m,'local');
        const away=telPanelTeam(comp,m.visitanteSlotId,data,m,'away');
        const localG = m.localGoles ?? m.golesLocal ?? null;
        const awayG = m.visitanteGoles ?? m.golesVisitante ?? null;
        const played = telPanelPlayed(m);
        matches.push({
          compId,
          compNombre: comp.nombre || comp.name || compId,
          isCup,
          id,
          jornada: m.jornada || '',
          ronda: m.rondaNombre || m.fase || '',
          localNombre: telPanelName(local,m.localNombre || m.localSlotId || 'Por definir'),
          visitanteNombre: telPanelName(away,m.visitanteNombre || m.visitanteSlotId || 'Por definir'),
          localLogo: telPanelLogo(local) || telClientLogo({escudoUrl:m.localLogo || m.localEscudo || ''}),
          visitanteLogo: telPanelLogo(away) || telClientLogo({escudoUrl:m.visitanteLogo || m.visitanteEscudo || ''}),
          localGoles: localG,
          visitanteGoles: awayG,
          finalizado: played,
          estado: played ? 'finalizado' : 'pendiente',
          fecha: m.fecha || m.date || '',
          hora: m.hora || m.time || '',
          ganador: played ? telPanelWinner(m) : null
        });
      });
    });
    res.set('Cache-Control','no-store');
    res.json({ok:true,competiciones,matches});
  }catch(e){
    console.error('[tel-panel/matches]',e);
    res.status(500).json({ok:false,message:String(e.message || e)});
  }
});
app.post('/api/tel-panel/save', express.json(), (req,res)=>{
  try{
    const compId=String(req.body?.compId || '').trim();
    const matchId=String(req.body?.matchId || '').trim();
    const lgRaw=req.body?.localGoles;
    const vgRaw=req.body?.visitanteGoles;
    const fecha=String(req.body?.fecha || '').trim();
    const hora=String(req.body?.hora || '').trim();
    const clear = req.body?.clear === true;
    const dateOnly = req.body?.dateOnly === true;
    if(!compId || !matchId) return res.status(400).json({ok:false,message:'Falta partido.'});

    const data=telPanelRead();
    telPanelEnsureIds(data);
    const comp=telPanelComps(data).find((c,i)=>telPanelCompId(c,i) === compId);
    if(!comp) return res.status(404).json({ok:false,message:'Competición no encontrada.'});
    const match=(comp.partidos || []).find((m,i)=>telPanelMatchId(comp,m,i) === matchId);
    if(!match) return res.status(404).json({ok:false,message:'Partido no encontrado.'});

    if(clear){
      telPanelReset(match);
    }else if(!dateOnly){
      const lg=Number(lgRaw);
      const vg=Number(vgRaw);
      if(!Number.isInteger(lg) || !Number.isInteger(vg) || lg<0 || vg<0) return res.status(400).json({ok:false,message:'Pon goles válidos.'});
      if(telPanelIsCup(comp) && lg === vg) return res.status(400).json({ok:false,message:'En copas no puede haber empate.'});
      match.localGoles=lg; match.visitanteGoles=vg; match.golesLocal=lg; match.golesVisitante=vg;
      match.resultado=`${lg}-${vg}`; match.estado='finalizado'; match.finalizado=true;
    }
    if(Object.prototype.hasOwnProperty.call(req.body || {},'fecha')) { match.fecha=fecha; match.date=fecha; }
    if(Object.prototype.hasOwnProperty.call(req.body || {},'hora')) { match.hora=hora; match.time=hora; }
    match.actualizadoPor='admin-panel'; match.actualizadoEn=new Date().toISOString();

    telPanelRecalcAll(data);
    telPanelWrite(data);
    res.set('Cache-Control','no-store');
    res.json({ok:true,message:clear?'Resultado borrado.':dateOnly?'Fecha guardada.':'Resultado guardado.',data});
  }catch(e){
    console.error('[tel-panel/save]',e);
    res.status(500).json({ok:false,message:String(e.message || e)});
  }
});




/* ============================================================
   ADMIN TEL · GESTOR DE COMPETICIONES
   ============================================================ */
function telCompManagerNorm(value){
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,' ').trim();
}
function telCompManagerId(comp,index){
  return String(comp?.id || comp?._id || comp?.nombre || `COMP-${index+1}`);
}
function telCompManagerIsCup(comp){
  const text = telCompManagerNorm(`${comp?.tipo || ''} ${comp?.formato || ''} ${comp?.formatoNombre || ''}`);
  return text.includes('copa') || text.includes('elimin');
}
function telCompManagerClubName(item){
  return String(item?.clubNombre || item?.nombre || item?.nombreVisual || '').replace(/^[^\p{L}\p{N}]+/u,'').trim();
}
function telCompManagerClubLogo(item){
  return item?.escudoUrl || item?.logoUrl || item?.escudo || item?.logo || '';
}
function telCompManagerNaturalLeagueRounds(teamCount,idaVuelta){
  let teams=Math.max(2,Number(teamCount||2));
  if(teams%2)teams+=1;
  return Math.max(1,(teams-1)*(idaVuelta?2:1));
}
function telCompManagerConfiguredRounds(comp,teamCount){
  const idaVuelta=comp?.configFormato?.idaVuelta!==false && !String(comp?.formato||'').includes('solo_ida');
  const configured=Number(comp?.numeroJornadas ?? comp?.jornadas ?? comp?.configFormato?.numeroJornadas);
  if(Number.isFinite(configured)&&configured>0)return Math.max(1,Math.min(100,Math.floor(configured)));
  const matchRounds=(comp?.partidos||[]).map(m=>Number(m?.jornada||0)).filter(v=>Number.isFinite(v)&&v>0);
  if(matchRounds.length)return Math.max(...matchRounds);
  return telCompManagerNaturalLeagueRounds(teamCount,idaVuelta);
}
function telCompManagerSummary(comp,index){
  const teams = Array.isArray(comp?.equipos) ? comp.equipos : [];
  const matches = Array.isArray(comp?.partidos) ? comp.partidos : [];
  const finished = matches.filter(m => m?.finalizado === true || m?.estado === 'finalizado' || (m?.localGoles !== null && m?.localGoles !== undefined && m?.visitanteGoles !== null && m?.visitanteGoles !== undefined)).length;
  return {
    id: telCompManagerId(comp,index),
    nombre: comp?.nombre || comp?.name || `Competición ${index+1}`,
    temporada: comp?.temporada || comp?.season || 'Temporada 1',
    tipo: telCompManagerIsCup(comp) ? 'copa' : (telCompManagerNorm(comp?.tipo).includes('grupo') ? 'grupos' : 'liga'),
    estado: comp?.estado || 'activa',
    formato: comp?.formato || (telCompManagerIsCup(comp) ? 'eliminacion_directa' : 'liga_ida_vuelta'),
    idaVuelta: comp?.configFormato?.idaVuelta !== false && !String(comp?.formato || '').includes('solo_ida'),
    maxEquipos: Number(comp?.maxEquipos || comp?.numeroMaxEquipos || Math.max(teams.length, 8)),
    numeroJornadas: telCompManagerIsCup(comp) ? null : telCompManagerConfiguredRounds(comp,teams.length || Number(comp?.maxEquipos || 8)),
    inscripcionesAbiertas: comp?.inscripcionesAbiertas !== false,
    fechaInicio: comp?.fechaInicio || comp?.inicio || '',
    fechaFin: comp?.fechaFin || comp?.fin || '',
    equipos: teams.length,
    participantes: teams.map(t => ({nombre:telCompManagerClubName(t),nombreVisual:t?.nombre || t?.nombreVisual || telCompManagerClubName(t),logo:telCompManagerClubLogo(t)})),
    partidos: matches.length,
    resultados: finished,
    hasResults: finished > 0
  };
}
function telCompManagerFormat(tipo, idaVuelta){
  if(tipo === 'copa') return {
    formato:'eliminacion_directa',
    formatoNombre:'Eliminación directa',
    formatoDescripcion:'Cuartos de final, semifinales y final.',
    configFormato:{idaVuelta:false,generaCalendario:'eliminatoria'}
  };
  if(tipo === 'grupos') return {
    formato:'grupos_playoffs',
    formatoNombre:'Grupos + Playoffs',
    formatoDescripcion:'Fase de grupos y eliminatorias.',
    configFormato:{idaVuelta:!!idaVuelta,generaCalendario:'grupos_playoffs'}
  };
  return {
    formato:idaVuelta ? 'liga_ida_vuelta' : 'liga_solo_ida',
    formatoNombre:idaVuelta ? 'Liga ida y vuelta' : 'Liga solo ida',
    formatoDescripcion:idaVuelta ? 'Todos contra todos, una vez como local y otra como visitante.' : 'Todos contra todos a una sola vuelta.',
    configFormato:{idaVuelta:!!idaVuelta,puntosVictoria:3,puntosEmpate:1,puntosDerrota:0,generaCalendario:'liga'}
  };
}
function telCompManagerSlot(team,index){
  return String(team?.slotId || team?.id || team?.clubId || `EQ-${Date.now()}-${index}-${Math.floor(Math.random()*9000+1000)}`);
}
function telCompManagerTeamFromClub(club,index,existing){
  return {
    ...(existing || {}),
    slotId: existing?.slotId || `EQ-${Date.now()}-${index}-${Math.floor(Math.random()*9000+1000)}`,
    clubNombre: club.nombre,
    nombre: club.nombreVisual || club.nombre,
    escudoUrl: club.escudoUrl || club.logoUrl || club.escudo || '',
    escudoPath: club.escudoPath || existing?.escudoPath || '',
    escudoFilename: club.escudoFilename || existing?.escudoFilename || '',
    activo: true,
    grupo: existing?.grupo ?? null,
    historialSustituciones: existing?.historialSustituciones || [],
    creadoEn: existing?.creadoEn || new Date().toISOString()
  };
}
function telCompManagerEmptyTable(teams){
  return teams.map(t => ({...t,pj:0,pg:0,pe:0,pp:0,v:0,e:0,d:0,gf:0,gc:0,golesFavor:0,golesContra:0,dg:0,pts:0,puntos:0}));
}
function telCompManagerMatch(base,jornada,localSlotId,visitanteSlotId,extra){
  return {
    id:`${base}-partido-${String(jornada).padStart(2,'0')}-${Math.floor(Math.random()*900000+100000)}`,
    jornada,
    ronda:jornada,
    fase:'liga',
    grupo:null,
    fecha:'',
    hora:'',
    localSlotId,
    visitanteSlotId,
    localGoles:null,
    visitanteGoles:null,
    ganadorSlotId:null,
    estado:'pendiente',
    finalizado:false,
    creadoEn:new Date().toISOString(),
    ...(extra || {})
  };
}
function telCompManagerLeagueSchedule(comp){
  const original=(comp.equipos||[]).map((t,i)=>telCompManagerSlot(t,i));
  if(original.length<2)return [];
  const slots=[...original];
  if(slots.length%2)slots.push(null);
  const total=slots.length;
  const baseRounds=[];
  let rotation=[...slots];
  const base=String(comp.id||'competicion').toLowerCase().replace(/[^\w]+/g,'-');

  for(let round=1;round<total;round++){
    const fixtures=[];
    for(let i=0;i<total/2;i++){
      let home=rotation[i];
      let away=rotation[total-1-i];
      if(!home||!away)continue;
      if(round%2===0&&i===0){const temp=home;home=away;away=temp;}
      fixtures.push({home,away});
    }
    baseRounds.push(fixtures);
    rotation=[rotation[0],rotation[total-1],...rotation.slice(1,total-1)];
  }

  const targetRounds=telCompManagerConfiguredRounds(comp,original.length);
  const schedule=[];
  for(let jornada=1;jornada<=targetRounds;jornada++){
    const sourceIndex=(jornada-1)%baseRounds.length;
    const cycle=Math.floor((jornada-1)/baseRounds.length);
    const reverse=cycle%2===1;
    baseRounds[sourceIndex].forEach(pair=>{
      const local=reverse?pair.away:pair.home;
      const visitante=reverse?pair.home:pair.away;
      schedule.push(telCompManagerMatch(base,jornada,local,visitante,{rondaNombre:`Jornada ${jornada}`}));
    });
  }
  return schedule;
}
function telCompManagerCupSchedule(comp){
  const teams = comp.equipos || [];
  if(teams.length !== 8) return [];
  const slots = teams.map((t,i)=>telCompManagerSlot(t,i));
  const pairs = [[0,7],[3,4],[1,6],[2,5]];
  const base = String(comp.id || 'copa').toLowerCase().replace(/[^\w]+/g,'-');
  return pairs.map((pair,index)=>({
    id:`${base}-cuartos-${index+1}`,
    jornada:1,
    ronda:1,
    rondaNombre:'Cuartos de final',
    fase:'eliminatoria',
    eliminatoria:true,
    idaVuelta:false,
    orden:index+1,
    grupo:null,
    fecha:'',
    hora:'',
    localSlotId:slots[pair[0]],
    visitanteSlotId:slots[pair[1]],
    localGoles:null,
    visitanteGoles:null,
    ganadorSlotId:null,
    estado:'pendiente',
    finalizado:false,
    creadoEn:new Date().toISOString()
  }));
}
function telCompManagerGenerate(comp){
  if(telCompManagerIsCup(comp)) return telCompManagerCupSchedule(comp);
  if(telCompManagerNorm(comp.tipo).includes('grupo')) return [];
  return telCompManagerLeagueSchedule(comp);
}

app.get('/api/admin/competitions-manager', requireAdmin, (req,res)=>{
  try{
    const data = telPanelRead();
    const competitions = telPanelComps(data).map(telCompManagerSummary);
    const clubs = (data.clubes || data.equipos || []).map((club,index)=>({
      id:String(club.id || club.clubId || club.nombre || `club-${index+1}`),
      nombre:String(club.nombre || club.clubNombre || `Equipo ${index+1}`),
      nombreVisual:String(club.nombreVisual || club.nombre || club.clubNombre || `Equipo ${index+1}`),
      logo:telCompManagerClubLogo(club)
    }));
    res.set('Cache-Control','no-store');
    res.json({ok:true,competitions,clubs});
  }catch(error){
    res.status(500).json({ok:false,message:String(error.message || error)});
  }
});

app.post('/api/admin/competitions-manager/save', express.json(), requireAdmin, (req,res)=>{
  try{
    const data = telPanelRead();
    data.competiciones = Array.isArray(data.competiciones) ? data.competiciones : telPanelComps(data);
    const id = String(req.body?.id || '').trim();
    const nombre = String(req.body?.nombre || '').trim();
    if(!nombre) return res.status(400).json({ok:false,message:'Escribe el nombre de la competición.'});
    const tipo = ['liga','copa','grupos'].includes(String(req.body?.tipo)) ? String(req.body.tipo) : 'liga';
    const idaVuelta = req.body?.idaVuelta !== false;
    const requestedRounds = tipo==='liga' ? Math.max(1,Math.min(100,Math.floor(Number(req.body?.numeroJornadas||1)))) : null;
    const format = telCompManagerFormat(tipo,idaVuelta);
    let comp = data.competiciones.find((c,i)=>telCompManagerId(c,i) === id);
    const isNew = !comp;
    if(isNew){
      comp = {id:`COMP-${Date.now()}`,equipos:[],sustituciones:[],partidos:[],clasificacion:[],grupos:[],creadaEn:new Date().toISOString()};
      data.competiciones.push(comp);
    }
    const previousType = telCompManagerNorm(`${comp.tipo || ''} ${comp.formato || ''}`);
    const nextType = telCompManagerNorm(`${tipo} ${format.formato}`);
    const previousIdaVuelta = comp?.configFormato?.idaVuelta !== false && !String(comp?.formato || '').includes('solo_ida');
    const previousRounds = telCompManagerIsCup(comp) ? null : telCompManagerConfiguredRounds(comp,(comp.equipos||[]).length || Number(comp.maxEquipos||8));
    const calendarConfigChanged = !isNew && (
      previousType !== nextType ||
      (tipo==='liga' && (previousIdaVuelta !== idaVuelta || Number(previousRounds) !== Number(requestedRounds)))
    );
    const hasResults = (comp.partidos || []).some(m=>m?.finalizado===true || m?.estado==='finalizado' || (m?.localGoles!==null && m?.localGoles!==undefined && m?.visitanteGoles!==null && m?.visitanteGoles!==undefined));
    if(calendarConfigChanged && hasResults && req.body?.force !== true){
      return res.status(409).json({ok:false,needsConfirmation:true,message:'Cambiar el formato o el número de jornadas reiniciará el calendario y los resultados de esta liga.'});
    }
    comp.nombre = nombre;
    comp.temporada = String(req.body?.temporada || 'Temporada 1').trim() || 'Temporada 1';
    comp.tipo = tipo === 'grupos' ? 'grupos_playoffs' : tipo;
    Object.assign(comp,format);
    comp.numeroJornadas = tipo==='liga' ? requestedRounds : null;
    comp.configFormato = {...(comp.configFormato||{}),numeroJornadas:tipo==='liga'?requestedRounds:null};
    comp.estado = String(req.body?.estado || 'activa');
    comp.maxEquipos = Math.max(2,Math.min(32,Number(req.body?.maxEquipos || 8)));
    comp.inscripcionesAbiertas = req.body?.inscripcionesAbiertas !== false;
    comp.fechaInicio = String(req.body?.fechaInicio || '');
    comp.fechaFin = String(req.body?.fechaFin || '');
    comp.actualizadaEn = new Date().toISOString();
    if(calendarConfigChanged){
      comp.clasificacion = telCompManagerEmptyTable(comp.equipos || []);
      comp.partidos = telCompManagerGenerate(comp);
      comp.calendarioGenerado = comp.partidos.length > 0;
      comp.calendarioGeneradoEn = comp.calendarioGenerado ? new Date().toISOString() : null;
      comp.campeon = null;
      telPanelRecalcAll(data);
    }
    telPanelWrite(data);
    res.json({ok:true,id:comp.id,message:isNew?'Competición creada.':'Competición actualizada.'});
  }catch(error){
    res.status(500).json({ok:false,message:String(error.message || error)});
  }
});

app.post('/api/admin/competitions-manager/participants', express.json(), requireAdmin, (req,res)=>{
  try{
    const data = telPanelRead();
    const compId = String(req.body?.compId || '').trim();
    const comp = telPanelComps(data).find((c,i)=>telCompManagerId(c,i) === compId);
    if(!comp) return res.status(404).json({ok:false,message:'Competición no encontrada.'});
    const names = Array.isArray(req.body?.clubNames) ? req.body.clubNames.map(v=>String(v).trim()).filter(Boolean) : [];
    if(names.length > Number(comp.maxEquipos || 32)) return res.status(400).json({ok:false,message:`El máximo es ${comp.maxEquipos} equipos.`});
    const clubs = data.clubes || data.equipos || [];
    const clubMap = new Map(clubs.map(c=>[telCompManagerNorm(c.nombre || c.clubNombre),c]));
    const existingMap = new Map((comp.equipos || []).map(t=>[telCompManagerNorm(telCompManagerClubName(t)),t]));
    const teams = names.map((name,index)=>{
      const club = clubMap.get(telCompManagerNorm(name));
      if(!club) return null;
      return telCompManagerTeamFromClub(club,index,existingMap.get(telCompManagerNorm(name)));
    }).filter(Boolean);
    const oldNames = (comp.equipos || []).map(t=>telCompManagerNorm(telCompManagerClubName(t)));
    const newNames = teams.map(t=>telCompManagerNorm(telCompManagerClubName(t)));
    const changed = JSON.stringify(oldNames) !== JSON.stringify(newNames);
    const hasResults = (comp.partidos || []).some(m=>m?.finalizado === true || m?.estado === 'finalizado');
    if(changed && hasResults && req.body?.force !== true){
      return res.status(409).json({ok:false,needsConfirmation:true,message:'Cambiar los participantes reiniciará el calendario y los resultados de esta competición.'});
    }
    comp.equipos = teams;
    comp.clasificacion = telCompManagerEmptyTable(teams);
    const needsSchedule = changed || (teams.length >= 2 && !(comp.partidos || []).length && !telCompManagerNorm(comp.tipo).includes('grupo'));
    if(needsSchedule){
      comp.partidos = telCompManagerGenerate(comp);
      comp.calendarioGenerado = comp.partidos.length > 0;
      comp.calendarioGeneradoEn = comp.calendarioGenerado ? new Date().toISOString() : null;
      comp.campeon = null;
    }
    telPanelRecalcAll(data);
    telPanelWrite(data);
    let message = 'Participantes guardados.';
    if(telCompManagerIsCup(comp) && teams.length !== 8) message += ' La copa necesita exactamente 8 equipos para generar el cuadro.';
    if(telCompManagerNorm(comp.tipo).includes('grupo')) message += ' El calendario de grupos se configurará desde Partidos.';
    res.json({ok:true,message});
  }catch(error){
    res.status(500).json({ok:false,message:String(error.message || error)});
  }
});

app.post('/api/admin/competitions-manager/delete', express.json(), requireAdmin, (req,res)=>{
  try{
    const data = telPanelRead();
    data.competiciones = Array.isArray(data.competiciones) ? data.competiciones : telPanelComps(data);
    const compId = String(req.body?.compId || '').trim();
    const before = data.competiciones.length;
    data.competiciones = data.competiciones.filter((c,i)=>telCompManagerId(c,i) !== compId);
    if(data.competiciones.length === before) return res.status(404).json({ok:false,message:'Competición no encontrada.'});
    telPanelWrite(data);
    res.json({ok:true,message:'Competición eliminada.'});
  }catch(error){
    res.status(500).json({ok:false,message:String(error.message || error)});
  }
});

/* Fin: gestor de competiciones */

/* ============================================================
   COPAS TEL - AVANCE AUTOMÁTICO AUTORITATIVO
   - QF1 + QF2 -> SF1
   - QF3 + QF4 -> SF2
   - SF1 + SF2 -> Final
   - Si cambia o se borra un resultado anterior, limpia la fase dependiente.
   ============================================================ */
function telCupAutoNorm(value){
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[^\w]+/g,' ')
    .trim();
}
function telCupAutoRound(match){
  const text = telCupAutoNorm(`${match?.rondaNombre || ''} ${match?.fase || ''} ${match?.nombreRonda || ''}`);
  const round = Number(match?.ronda || match?.round || 0);
  if(text.includes('cuarto') || text.includes('quarter') || round === 1) return 1;
  if(text.includes('semi') || round === 2) return 2;
  if(text.includes('final') || round >= 3) return 3;
  return 1;
}
function telCupAutoPlayed(match){
  return !!match && (
    match.estado === 'finalizado' ||
    match.estado === 'jugado' ||
    match.finalizado === true ||
    (match.localGoles !== null && match.localGoles !== undefined &&
     match.visitanteGoles !== null && match.visitanteGoles !== undefined) ||
    (match.golesLocal !== null && match.golesLocal !== undefined &&
     match.golesVisitante !== null && match.golesVisitante !== undefined)
  );
}
function telCupAutoGoals(match){
  let local = match?.localGoles;
  let away = match?.visitanteGoles;
  if(local === null || local === undefined) local = match?.golesLocal;
  if(away === null || away === undefined) away = match?.golesVisitante;
  if((local === null || local === undefined || away === null || away === undefined) && match?.resultado){
    const parsed = String(match.resultado).match(/(\d+)\s*[-:]\s*(\d+)/);
    if(parsed){ local = Number(parsed[1]); away = Number(parsed[2]); }
  }
  return {local:Number(local ?? 0), away:Number(away ?? 0)};
}
function telCupAutoWinner(match){
  if(!telCupAutoPlayed(match)) return '';
  const goals = telCupAutoGoals(match);
  if(goals.local === goals.away) return '';
  return String(goals.local > goals.away ? (match.localSlotId || '') : (match.visitanteSlotId || ''));
}
function telCupAutoResetScore(match){
  if(!match) return;
  match.localGoles = null;
  match.visitanteGoles = null;
  match.golesLocal = null;
  match.golesVisitante = null;
  match.resultado = '';
  match.estado = 'pendiente';
  match.finalizado = false;
  match.ganadorSlotId = null;
}
function telCupAutoBaseId(comp){
  return String(comp?.id || comp?.nombre || 'copa')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[^\w]+/g,'-')
    .replace(/^-+|-+$/g,'');
}
function telCupAutoEnsureRounds(comp){
  comp.partidos = Array.isArray(comp.partidos) ? comp.partidos : [];
  const qf = comp.partidos.filter(m => telCupAutoRound(m) === 1);
  const sf = comp.partidos.filter(m => telCupAutoRound(m) === 2);
  const final = comp.partidos.filter(m => telCupAutoRound(m) === 3);
  const base = telCupAutoBaseId(comp);

  while(qf.length >= 4 && sf.length < 2){
    const number = sf.length + 1;
    const match = {
      id:`${base}-semifinal-${number}`,
      jornada:2,
      ronda:2,
      rondaNombre:'Semifinales',
      fase:'Semifinales',
      orden:number,
      localSlotId:'',
      visitanteSlotId:'',
      localGoles:null,
      visitanteGoles:null,
      estado:'pendiente',
      finalizado:false,
      fecha:'',
      hora:''
    };
    comp.partidos.push(match);
    sf.push(match);
  }

  while(sf.length >= 2 && final.length < 1){
    const match = {
      id:`${base}-final-1`,
      jornada:3,
      ronda:3,
      rondaNombre:'Final',
      fase:'Final',
      orden:1,
      localSlotId:'',
      visitanteSlotId:'',
      localGoles:null,
      visitanteGoles:null,
      estado:'pendiente',
      finalizado:false,
      fecha:'',
      hora:''
    };
    comp.partidos.push(match);
    final.push(match);
  }
}
function telCupAutoSetParticipants(match, localSlotId, visitanteSlotId){
  if(!match) return;
  const nextLocal = String(localSlotId || '');
  const nextAway = String(visitanteSlotId || '');
  const changed = String(match.localSlotId || '') !== nextLocal || String(match.visitanteSlotId || '') !== nextAway;
  if(!changed) return;
  match.localSlotId = nextLocal;
  match.visitanteSlotId = nextAway;
  telCupAutoResetScore(match);
}
function telCupAutoTeamSlot(team, index){
  return String(team?.slotId || team?.id || team?.clubId || team?.nombre || team?.clubNombre || `slot-${index+1}`);
}
function telCupAutoSeedMap(comp){
  const map = new Map();
  const base = Array.isArray(comp?.clasificacion) && comp.clasificacion.length ? comp.clasificacion : (comp?.equipos || []);
  base.forEach((team,index)=>{
    const slotId = telCupAutoTeamSlot(team,index);
    if(slotId && !map.has(slotId)) map.set(slotId, index + 1);
  });
  (comp?.equipos || []).forEach((team,index)=>{
    const slotId = telCupAutoTeamSlot(team,index);
    if(slotId && !map.has(slotId)) map.set(slotId, index + 1);
  });
  return map;
}
function telCupAutoMinSeed(match, seedMap){
  const local = seedMap.get(String(match?.localSlotId || '').trim()) || 999;
  const away = seedMap.get(String(match?.visitanteSlotId || '').trim()) || 999;
  return Math.min(local, away);
}
function telCupAutoSecondSeed(match, seedMap){
  const values = [
    seedMap.get(String(match?.localSlotId || '').trim()) || 999,
    seedMap.get(String(match?.visitanteSlotId || '').trim()) || 999
  ].sort((a,b)=>a-b);
  return values[1] || 999;
}
function telCupAutoSideOrder(match){
  const raw = String(match?.id || match?.matchId || match?.partidoId || '').toLowerCase();
  const order = Number(match?.orden ?? match?.order ?? match?.posicion);
  if(Number.isFinite(order) && order > 0) return order;
  const sem = raw.match(/semifinal-(\d+)/);
  if(sem) return Number(sem[1]);
  const fin = raw.match(/final-(\d+)/);
  if(fin) return Number(fin[1]);
  return 999;
}

function telCupAutoResolveTeam(comp,reference,embeddedName){
  const raw=String(reference || '').trim();
  const target=telClientNorm(raw || embeddedName);
  const teams=comp?.equipos || [];
  return teams.find((team,index)=>{
    const values=[telCupAutoTeamSlot(team,index),team.id,team.clubId,team.clubNombre,team.nombre,team.nombreVisual,team.name];
    return values.some(value=>value && (String(value)===raw || telClientNorm(value)===target));
  }) || null;
}
function telCupAutoDecorateMatch(comp,match){
  if(!match) return;
  const local=telCupAutoResolveTeam(comp,match.localSlotId,match.localNombre);
  const away=telCupAutoResolveTeam(comp,match.visitanteSlotId,match.visitanteNombre);
  if(local){
    match.localNombre=telClientCleanName(local.clubNombre || local.nombre || local.nombreVisual) || 'Por definir';
    match.localLogo=telClientLogo(local);
    match.localEscudo=match.localLogo;
  }
  if(away){
    match.visitanteNombre=telClientCleanName(away.clubNombre || away.nombre || away.nombreVisual) || 'Por definir';
    match.visitanteLogo=telClientLogo(away);
    match.visitanteEscudo=match.visitanteLogo;
  }
}
function telCupAdvanceAuthoritative(comp){
  if(!comp) return;
  telCupAutoEnsureRounds(comp);
  const grouped = {qf:[], sf:[], final:[]};

  (comp.partidos || []).forEach((match,index)=>{
    match.__telAutoIndex = index;
    const rank = telCupAutoRound(match);
    if(rank === 1) grouped.qf.push(match);
    else if(rank === 2) grouped.sf.push(match);
    else grouped.final.push(match);
  });

  const seedMap = telCupAutoSeedMap(comp);

  grouped.qf.sort((a,b)=>{
    const minA = telCupAutoMinSeed(a, seedMap);
    const minB = telCupAutoMinSeed(b, seedMap);
    if(minA !== minB) return minA - minB;
    const secondA = telCupAutoSecondSeed(a, seedMap);
    const secondB = telCupAutoSecondSeed(b, seedMap);
    if(secondA !== secondB) return secondA - secondB;
    return Number(a.__telAutoIndex) - Number(b.__telAutoIndex);
  });

  grouped.sf.sort((a,b)=>{
    const orderA = telCupAutoSideOrder(a);
    const orderB = telCupAutoSideOrder(b);
    if(orderA !== orderB) return orderA - orderB;
    return Number(a.__telAutoIndex) - Number(b.__telAutoIndex);
  });

  grouped.final.sort((a,b)=>{
    const orderA = telCupAutoSideOrder(a);
    const orderB = telCupAutoSideOrder(b);
    if(orderA !== orderB) return orderA - orderB;
    return Number(a.__telAutoIndex) - Number(b.__telAutoIndex);
  });

  if(grouped.sf[0]) grouped.sf[0].orden = 1;
  if(grouped.sf[1]) grouped.sf[1].orden = 2;
  if(grouped.final[0]) grouped.final[0].orden = 1;

  // Guardar ganador explícito en cada partido ya finalizado.
  (comp.partidos || []).forEach(match=>{
    match.ganadorSlotId = telCupAutoWinner(match) || null;
  });

  const qfWinners = grouped.qf.map(telCupAutoWinner);
  telCupAutoSetParticipants(grouped.sf[0], qfWinners[0], qfWinners[1]);
  telCupAutoSetParticipants(grouped.sf[1], qfWinners[2], qfWinners[3]);

  const sfWinners = grouped.sf.map(telCupAutoWinner);
  telCupAutoSetParticipants(grouped.final[0], sfWinners[0], sfWinners[1]);

  const championSlot = grouped.final[0] ? telCupAutoWinner(grouped.final[0]) : '';
  if(championSlot){
    const champion = (comp.equipos || []).find((team,index)=>telCupAutoTeamSlot(team,index) === championSlot);
    comp.campeon = champion ? {
      slotId:championSlot,
      nombre:champion.nombre || champion.clubNombre || champion.nombreVisual || 'Campeón',
      escudoUrl:champion.escudoUrl || champion.logoUrl || champion.escudo || champion.logo || ''
    } : null;
  }else{
    comp.campeon = null;
  }

  (comp.partidos || []).forEach(match=>{
    telCupAutoDecorateMatch(comp,match);
    delete match.__telAutoIndex;
  });
}

// Todas las pantallas de administración usan la misma lógica de avance.
if(typeof telPanelAdvanceCup === 'function') telPanelAdvanceCup = telCupAdvanceAuthoritative;
if(typeof telFinalAdminAdvanceCup === 'function') telFinalAdminAdvanceCup = telCupAdvanceAuthoritative;
if(typeof telDirectAdvanceCup === 'function') telDirectAdvanceCup = telCupAdvanceAuthoritative;
if(typeof telAdminAdvanceCup2 === 'function') telAdminAdvanceCup2 = telCupAdvanceAuthoritative;
if(typeof telSimpleAdvanceCup === 'function') telSimpleAdvanceCup = telCupAdvanceAuthoritative;
if(typeof telInlineAdvanceCup === 'function') telInlineAdvanceCup = telCupAdvanceAuthoritative;
if(typeof telAdvanceCupDef === 'function') telAdvanceCupDef = telCupAdvanceAuthoritative;
if(typeof telAdvanceCup === 'function') telAdvanceCup = telCupAdvanceAuthoritative;
if(typeof advanceCupAdmin === 'function') advanceCupAdmin = telCupAdvanceAuthoritative;

/* Fin: avance automático autoritativo de copas */

/* ============================================================
   SINCRONIZACIÓN EN TIEMPO REAL ENTRE NAVEGADORES
   - Vigila cambios reales en data.json (por contenido, no solo mtime).
   - Avisa a todos los navegadores conectados mediante SSE.
   ============================================================ */
const telLiveClients = new Set();
let telLastDataHash = '';

function telDataHash(){
  try{
    const raw = fs.readFileSync(DATA_FILE);
    return crypto.createHash('sha256').update(raw).digest('hex');
  }catch(error){
    return '';
  }
}

function telBroadcastDataUpdate(version){
  const currentVersion = String(version || telLastDataHash || telDataHash() || Date.now());
  const payload = JSON.stringify({
    type:'data-updated',
    version:currentVersion
  });
  for(const client of [...telLiveClients]){
    try{ client.write(`id: ${currentVersion}\nevent: data-updated\ndata: ${payload}\n\n`); }
    catch(error){ telLiveClients.delete(client); }
  }
}

function telDetectAndBroadcastDataWrite(){
  setImmediate(()=>{
    const nextHash = telDataHash();
    if(!nextHash || nextHash === telLastDataHash) return;
    telLastDataHash = nextHash;
    telBroadcastDataUpdate(nextHash);
  });
}

telLastDataHash = telDataHash();

/* Notificación inmediata para todas las rutas que escriben data.json. */
if(!fs.__telLiveWriteWrapped){
  const telNativeWriteFileSync = fs.writeFileSync.bind(fs);
  fs.writeFileSync = function(filePath, ...args){
    const result = telNativeWriteFileSync(filePath, ...args);
    try{
      if(path.resolve(String(filePath)) === path.resolve(DATA_FILE)) telDetectAndBroadcastDataWrite();
    }catch(error){}
    return result;
  };
  fs.__telLiveWriteWrapped = true;
}

/* Respaldo para modificaciones externas del archivo. */
fs.watchFile(DATA_FILE, {interval:300, persistent:false}, () => {
  const nextHash = telDataHash();
  if(!nextHash || nextHash === telLastDataHash) return;
  telLastDataHash = nextHash;
  telBroadcastDataUpdate(nextHash);
});

app.get('/api/live-updates', (req,res)=>{
  res.set({
    'Content-Type':'text/event-stream',
    'Cache-Control':'no-cache, no-transform',
    'Connection':'keep-alive',
    'X-Accel-Buffering':'no'
  });
  res.flushHeaders?.();
  res.write(`event: connected\ndata: ${JSON.stringify({ok:true,version:Date.now()})}\n\n`);
  telLiveClients.add(res);
  const heartbeat = setInterval(()=>{
    try{ res.write(': keep-alive\n\n'); }catch(error){}
  },25000);
  req.on('close',()=>{
    clearInterval(heartbeat);
    telLiveClients.delete(res);
  });
});

app.get('/api/data-version', async (req,res)=>{
  res.set('Cache-Control','no-store');
  /*
     La versión pública se basa en el contenido real de data.json.
     El bot puede renovar la clave auxiliar de versión aunque los datos no
     cambien; usar ese valor provocaba refrescos visuales periódicos.
  */
  const contentHash = telDataHash();
  if(contentHash) telLastDataHash = contentHash;
  res.json({ok:true,version:contentHash || telLastDataHash || 'sin-datos'});
});

/* ============================================================
   CONTACTO -> DISCORD
   Usa, por orden:
   1) DISCORD_CONTACT_WEBHOOK_URL
   2) TOKEN/DISCORD_BOT_TOKEN + DISCORD_CONTACT_CHANNEL_ID
      (si no se define canal, usa TICKETS_LOGS_CHANNEL_ID)
   ============================================================ */
const TEL_CONTACT_FILE = path.join(__dirname,'contact_messages.json');
const telContactRate = new Map();

function telContactClean(value,max){
  return String(value || '').replace(/\u0000/g,'').trim().slice(0,max);
}
function telContactEscapeDiscord(value){
  return telContactClean(value,1900).replace(/@/g,'@\u200b');
}
function telContactStore(entry){
  let current=[];
  try{
    if(fs.existsSync(TEL_CONTACT_FILE)){
      const parsed=JSON.parse(fs.readFileSync(TEL_CONTACT_FILE,'utf8') || '[]');
      if(Array.isArray(parsed)) current=parsed;
    }
  }catch(error){}
  current.push(entry);
  if(current.length>1000) current=current.slice(-1000);
  fs.writeFileSync(TEL_CONTACT_FILE,JSON.stringify(current,null,2),'utf8');
}
function telContactRateAllowed(ip){
  const now=Date.now();
  const windowMs=15*60*1000;
  const recent=(telContactRate.get(ip)||[]).filter(ts=>now-ts<windowMs);
  if(recent.length>=5){ telContactRate.set(ip,recent); return false; }
  recent.push(now); telContactRate.set(ip,recent); return true;
}
async function telSendContactToDiscord(entry){
  const webhook=String(
    process.env.DISCORD_CONTACT_WEBHOOK_URL ||
    process.env.CONTACT_DISCORD_WEBHOOK_URL ||
    process.env.DISCORD_WEBHOOK_URL ||
    process.env.CONTACT_WEBHOOK_URL ||
    ''
  ).trim();
  const channelId=String(
    process.env.DISCORD_CONTACT_CHANNEL_ID ||
    process.env.CONTACT_DISCORD_CHANNEL_ID ||
    process.env.TICKETS_LOGS_CHANNEL_ID ||
    process.env.TICKETS_LOG_CHANNEL_ID ||
    process.env.DISCORD_CHANNEL_ID ||
    ''
  ).trim();
  const token=String(
    process.env.DISCORD_BOT_TOKEN ||
    process.env.TOKEN ||
    process.env.BOT_TOKEN ||
    ''
  ).trim();
  const embed={
    title:'📩 Nuevo mensaje desde la web TEL',
    color:0x9633ff,
    fields:[
      {name:'Nombre',value:telContactEscapeDiscord(entry.nombre)||'No indicado',inline:true},
      {name:'Correo',value:telContactEscapeDiscord(entry.email)||'No indicado',inline:true},
      {name:'Categoría',value:telContactEscapeDiscord(entry.categoria)||'General',inline:true},
      {name:'Asunto',value:telContactEscapeDiscord(entry.asunto)||'Sin asunto',inline:false},
      {name:'Mensaje',value:telContactEscapeDiscord(entry.mensaje)||'Sin mensaje',inline:false}
    ],
    footer:{text:`TEL Web · ${entry.id}`},
    timestamp:entry.fecha
  };
  let response;
  if(webhook){
    response=await fetch(webhook,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username:'Thunder Elite League · Contacto',embeds:[embed],allowed_mentions:{parse:[]}})
    });
  }else if(token && channelId){
    response=await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bot ${token}`},
      body:JSON.stringify({embeds:[embed],allowed_mentions:{parse:[]}})
    });
  }else{
    const error=new Error('Discord no está configurado en Vercel. Añade DISCORD_CONTACT_WEBHOOK_URL, o bien TOKEN/DISCORD_BOT_TOKEN junto con TICKETS_LOGS_CHANNEL_ID.');
    error.code='discord_not_configured';
    throw error;
  }
  if(!response.ok){
    const detail=(await response.text()).slice(0,600);
    throw new Error(`Discord respondió ${response.status}: ${detail}`);
  }
}

function telContactDiscordConfig(){
  const webhook=String(
    process.env.DISCORD_CONTACT_WEBHOOK_URL || process.env.CONTACT_DISCORD_WEBHOOK_URL ||
    process.env.DISCORD_WEBHOOK_URL || process.env.CONTACT_WEBHOOK_URL || ''
  ).trim();
  const channelId=String(
    process.env.DISCORD_CONTACT_CHANNEL_ID || process.env.CONTACT_DISCORD_CHANNEL_ID ||
    process.env.TICKETS_LOGS_CHANNEL_ID || process.env.TICKETS_LOG_CHANNEL_ID ||
    process.env.DISCORD_CHANNEL_ID || ''
  ).trim();
  const token=String(process.env.DISCORD_BOT_TOKEN || process.env.TOKEN || process.env.BOT_TOKEN || '').trim();
  return {
    configured:Boolean(webhook || (token && channelId)),
    mode:webhook ? 'webhook' : (token && channelId ? 'bot-rest' : 'none'),
    channelConfigured:Boolean(channelId)
  };
}

app.get('/api/contact/status', (req,res)=>{
  const config=telContactDiscordConfig();
  res.set('Cache-Control','no-store');
  res.json({ok:true,...config});
});

app.post('/api/contact', express.json({limit:'100kb'}), async (req,res)=>{
  try{
    const ip=String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    if(!telContactRateAllowed(ip)) return res.status(429).json({ok:false,message:'Has enviado demasiados mensajes. Inténtalo de nuevo en unos minutos.'});
    // Campo trampa para bots.
    if(String(req.body?.website || '').trim()) return res.json({ok:true,message:'Mensaje enviado.'});
    const entry={
      id:`TEL-${Date.now().toString(36).toUpperCase()}`,
      fecha:new Date().toISOString(),
      nombre:telContactClean(req.body?.nombre,100),
      email:telContactClean(req.body?.email,180),
      asunto:telContactClean(req.body?.asunto,180),
      categoria:telContactClean(req.body?.categoria,80) || 'General',
      mensaje:telContactClean(req.body?.mensaje,1800),
      ip
    };
    if(entry.nombre.length<2) return res.status(400).json({ok:false,message:'Escribe tu nombre.'});
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.email)) return res.status(400).json({ok:false,message:'Escribe un correo electrónico válido.'});
    if(entry.asunto.length<3) return res.status(400).json({ok:false,message:'Escribe el asunto.'});
    if(entry.mensaje.length<10) return res.status(400).json({ok:false,message:'El mensaje debe tener al menos 10 caracteres.'});
    await telSendContactToDiscord(entry);
    entry.entregadoDiscord = true;
    entry.entregadoEn = new Date().toISOString();
    telContactStore(entry);
    res.set('Cache-Control','no-store');
    res.json({ok:true,message:'Mensaje enviado correctamente a la administración por Discord.',id:entry.id});
  }catch(error){
    console.error('[contacto-discord]',error);
    const status=error.code==='discord_not_configured'?503:502;
    res.status(status).json({ok:false,message:error.message || 'No se pudo enviar el mensaje a Discord.'});
  }
});


/* ============================================================
   NOTICIAS ADMINISTRABLES
   - La web pública solo muestra noticias guardadas en data.json.
   - Crear, editar y borrar requiere sesión de administrador.
   ============================================================ */
function telNewsClean(value,max=5000){
  return String(value || '').replace(/\u0000/g,'').trim().slice(0,max);
}
function telNewsList(data){
  return Array.isArray(data?.noticias) ? data.noticias : [];
}
function telNewsSort(list){
  return [...list].sort((a,b)=>{
    const da = Date.parse(a.fecha || a.creadoEn || 0) || 0;
    const db = Date.parse(b.fecha || b.creadoEn || 0) || 0;
    return db-da;
  });
}
app.get('/api/noticias',(req,res)=>{
  res.set('Cache-Control','no-store');
  const data=readLeagueData();
  res.json({ok:true,noticias:telNewsSort(telNewsList(data))});
});
app.post('/api/admin/noticias',express.json({limit:'300kb'}),requireAdmin,(req,res)=>{
  try{
    const data=readLeagueData();
    data.noticias=telNewsList(data);
    const id=telNewsClean(req.body?.id,120) || `NOT-${Date.now().toString(36).toUpperCase()}`;
    const titulo=telNewsClean(req.body?.titulo,180);
    const categoria=telNewsClean(req.body?.categoria,60) || 'Anuncios';
    const resumen=telNewsClean(req.body?.resumen,500);
    const contenido=telNewsClean(req.body?.contenido,6000);
    const imagen=telNewsClean(req.body?.imagen,800);
    const fecha=telNewsClean(req.body?.fecha,30) || new Date().toISOString().slice(0,10);
    if(titulo.length<3) return res.status(400).json({ok:false,message:'Escribe un título de al menos 3 caracteres.'});
    if(resumen.length<5) return res.status(400).json({ok:false,message:'Escribe un resumen de al menos 5 caracteres.'});
    const now=new Date().toISOString();
    const index=data.noticias.findIndex(n=>String(n.id)===id);
    const existing=index>=0?data.noticias[index]:null;
    const item={
      id,titulo,categoria,resumen,
      contenido:contenido || resumen,
      imagen,fecha,
      creadoEn:existing?.creadoEn || now,
      actualizadoEn:now,
      autor:String(req.session?.adminEmail || process.env.ADMIN_EMAIL || 'Admin TEL')
    };
    if(index>=0) data.noticias[index]=item; else data.noticias.push(item);
    writeLeagueData(data);
    res.json({ok:true,message:index>=0?'Noticia actualizada.':'Noticia publicada.',noticia:item,noticias:telNewsSort(data.noticias)});
  }catch(error){
    console.error('[admin-noticias-save]',error);
    res.status(500).json({ok:false,message:'No se pudo guardar la noticia.'});
  }
});
app.delete('/api/admin/noticias/:id',requireAdmin,(req,res)=>{
  try{
    const data=readLeagueData();
    const before=telNewsList(data);
    data.noticias=before.filter(n=>String(n.id)!==String(req.params.id));
    if(data.noticias.length===before.length) return res.status(404).json({ok:false,message:'Noticia no encontrada.'});
    writeLeagueData(data);
    res.json({ok:true,message:'Noticia eliminada.'});
  }catch(error){
    console.error('[admin-noticias-delete]',error);
    res.status(500).json({ok:false,message:'No se pudo eliminar la noticia.'});
  }
});

if(require.main === module){
  app.listen(PORT, () => {
    console.log(`🌐 Web Thunder Elite League lista en http://localhost:${PORT}`);
  });
}

module.exports = app;
