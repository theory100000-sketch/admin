require("dotenv").config();

const fs = require("fs");
const express = require("express");

const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const app = express();

const WEB_SESSION_SECRET = process.env.WEB_SESSION_SECRET || 'thunder_elite_league_cambiar_en_env';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/auth/discord/callback';

const AUTH_DB_PATH = path.join(__dirname, 'web_accounts.json');


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

app.use(session({
  secret: WEB_SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
}));

app.use(express.static(path.join(__dirname, "public")));
app.use("/escudos", express.static(path.join(__dirname, "public", "escudos")));

const PORT = process.env.PORT || 3000;

const DATA_FILE = path.join(__dirname, "data.json");
const COMMANDS_FILE = path.join(__dirname, "commands.json");

app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));

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
    club.escudoUrl, club.logoUrl, club.logo, club.escudo,
    club.imagen, club.imagenUrl, club.image, club.imageUrl,
    club.avatar, club.avatarUrl, club.icon, club.iconUrl,
    club.attachmentUrl, club.archivoUrl, club.escudoPath, club.escudoFilename
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

function normalizeClubForWeb(club, data) {
  const jugadores = Array.isArray(data.jugadores) ? data.jugadores : [];
  const nombre = club.nombre || club.name || "Club sin nombre";
  const nombreVisual = club.nombreVisual || club.displayName || `${club.emoji || ""} ${nombre}`.trim();
  return {
    id: club.id || club._id || nombre,
    nombre,
    nombreVisual,
    emoji: club.emoji || "⚡",
    escudoUrl: pickLogoUrl(club),
    colorHex: club.colorHex || club.color || "",
    presupuesto: club.presupuesto || club.budget || 0,
    presidenteId: club.presidenteId || null,
    presidenteTag: club.presidenteTag || club.presidente || "",
    ligaId: club.ligaId || club.liga || club.competicionId || club.competicion || club.conferencia || "",
    conferencia: club.conferencia || club.liga || club.competicion || "TEL",
    jugadores: jugadores.filter(j => normalizeText(j.club || j.equipo || j.clubNombre) === normalizeText(nombre)).length
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    name: "Thunder Elite League",
    guildId: process.env.GUILD_ID || null,
    clientId: process.env.CLIENT_ID || null
  });
});

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

  res.json(data);
});

app.get("/api/ligas", (req, res) => {
  res.set("Cache-Control", "no-store");
  const data = readJson(DATA_FILE, {});
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
    .map(club => normalizeClubForWeb(club, data));

  res.json(clubes);
});

app.get("/api/competiciones", (req, res) => {
  res.set("Cache-Control", "no-store");
  const data = readJson(DATA_FILE, { competiciones: [] });
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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

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

  res.json({ok:true, admin:true, email:ADMIN_EMAIL});
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
  res.sendFile(telFinalAdminDataPath());
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
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  if(email !== adminEmail) return res.status(403).json({ok:false,message:'Ese correo no es admin.'});
  if(password !== adminPassword) return res.status(403).json({ok:false,message:'Contraseña admin incorrecta.'});

  req.session.isAdmin = true;
  req.session.adminEmail = adminEmail;
  req.session.webAccountId = 'admin-local';
  res.json({ok:true,admin:true,email:adminEmail});
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
  return pass === String(process.env.ADMIN_PASSWORD || 'admin123') || (req.session && req.session.isAdmin === true);
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
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  if(email !== adminEmail) return res.status(403).json({ok:false,message:'Ese correo no es la cuenta admin.'});
  if(password !== adminPassword) return res.status(403).json({ok:false,message:'Contraseña admin incorrecta.'});

  req.session.isAdmin = true;
  req.session.adminEmail = adminEmail;
  req.session.webAccountId = 'admin-local';
  res.json({ok:true,admin:true,email:adminEmail});
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
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  if(email !== adminEmail) return res.status(403).json({ok:false,message:'Ese correo no es admin.'});
  if(password !== adminPassword) return res.status(403).json({ok:false,message:'Contraseña admin incorrecta.'});
  req.session.isAdmin = true;
  req.session.adminEmail = adminEmail;
  req.session.webAccountId = 'admin-local';
  res.json({ok:true,admin:true,email:adminEmail});
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
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

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
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
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
  return t?.escudoUrl || t?.logoUrl || t?.escudo || t?.logo || t?.escudoPath || '';
}
function telPanelTeam(comp,slot){
  if(!slot) return null;
  return (comp.equipos || []).find((t,i)=>telPanelSlot(t,i) === String(slot)) || null;
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
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
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
        const local=telPanelTeam(comp,m.localSlotId);
        const away=telPanelTeam(comp,m.visitanteSlotId);
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
          localNombre: telPanelName(local,m.localSlotId || 'Por definir'),
          visitanteNombre: telPanelName(away,m.visitanteSlotId || 'Por definir'),
          localLogo: telPanelLogo(local),
          visitanteLogo: telPanelLogo(away),
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
    if(!compId || !matchId) return res.status(400).json({ok:false,message:'Falta partido.'});

    const data=telPanelRead();
    telPanelEnsureIds(data);
    const comp=telPanelComps(data).find((c,i)=>telPanelCompId(c,i) === compId);
    if(!comp) return res.status(404).json({ok:false,message:'Competición no encontrada.'});
    const match=(comp.partidos || []).find((m,i)=>telPanelMatchId(comp,m,i) === matchId);
    if(!match) return res.status(404).json({ok:false,message:'Partido no encontrado.'});

    if(clear){
      telPanelReset(match);
    }else{
      const lg=Number(lgRaw);
      const vg=Number(vgRaw);
      if(!Number.isInteger(lg) || !Number.isInteger(vg) || lg<0 || vg<0) return res.status(400).json({ok:false,message:'Pon goles válidos.'});
      if(telPanelIsCup(comp) && lg === vg) return res.status(400).json({ok:false,message:'En copas no puede haber empate.'});
      match.localGoles=lg; match.visitanteGoles=vg; match.golesLocal=lg; match.golesVisitante=vg;
      match.resultado=`${lg}-${vg}`; match.estado='finalizado'; match.finalizado=true;
    }
    if(fecha) { match.fecha=fecha; match.date=fecha; }
    if(hora) { match.hora=hora; match.time=hora; }
    match.actualizadoPor='admin-panel'; match.actualizadoEn=new Date().toISOString();

    telPanelRecalcAll(data);
    telPanelWrite(data);
    res.set('Cache-Control','no-store');
    res.json({ok:true,message:clear?'Resultado borrado.':'Resultado guardado.',data});
  }catch(e){
    console.error('[tel-panel/save]',e);
    res.status(500).json({ok:false,message:String(e.message || e)});
  }
});



/* TEL PANEL COPAS LOCALHOST SYNC */
function telSyncNorm(v){return String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,' ').trim();}
function telSyncDataPath(){return path.join(__dirname,'data.json');}
function telSyncRead(){return JSON.parse(fs.readFileSync(telSyncDataPath(),'utf8'));}
function telSyncWrite(data){fs.writeFileSync(telSyncDataPath(),JSON.stringify(data,null,2),'utf8');}
function telSyncComps(data){return data.competiciones || data.ligas || data.torneos || [];}
function telSyncCompId(c,i){
  if(!c.id){c.id=String(c.nombre||c.name||`competicion-${i+1}`).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');}
  return String(c.id);
}
function telSyncMatchId(c,m,i){
  if(!m.id){const cid=String(c.id||c.nombre||'comp').toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');m.id=`${cid}-partido-${i+1}`;}
  return String(m.id);
}
function telSyncSlot(t,i){return String(t?.slotId || t?.id || t?.clubId || t?.nombre || t?.clubNombre || `slot-${i+1}`);}
function telSyncName(t,fallback){return String(t?.nombre || t?.clubNombre || t?.nombreVisual || t?.name || fallback || 'Por definir').replace(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic}|\s)+/u,'').trim();}
function telSyncLogo(t){return t?.escudoUrl || t?.logoUrl || t?.escudo || t?.logo || t?.escudoPath || '';}
function telSyncTeam(c,slot){return (c.equipos||[]).find((t,i)=>telSyncSlot(t,i)===String(slot)) || null;}
function telSyncIsCup(c){
  const txt=telSyncNorm(`${c.tipo||''} ${c.formato||''} ${c.formatoNombre||''} ${c.formatoDescripcion||''} ${c.nombre||''}`);
  return txt.includes('copa') || txt.includes('elimin') || txt.includes('torneo') || (c.partidos||[]).some(p=>{
    const r=telSyncNorm(`${p.rondaNombre||''} ${p.fase||''}`);
    return r.includes('cuarto') || r.includes('semi') || r.includes('final');
  });
}
function telSyncRound(m){
  const txt=telSyncNorm(`${m.rondaNombre||''} ${m.fase||''} ${m.nombreRonda||''}`);
  const r=Number(m.ronda || m.round || 0);
  if(txt.includes('cuarto') || r===1) return 1;
  if(txt.includes('semi') || r===2) return 2;
  if(txt.includes('final') || r>=3) return 3;
  return 1;
}
function telSyncPlayed(m){return !!m && (m.estado==='finalizado' || m.estado==='jugado' || m.finalizado===true || (m.localGoles!==null && m.localGoles!==undefined && m.visitanteGoles!==null && m.visitanteGoles!==undefined));}
function telSyncWinner(m){
  if(!telSyncPlayed(m)) return null;
  const a=Number(m.localGoles??0), b=Number(m.visitanteGoles??0);
  if(a===b) return null;
  return String(a>b ? m.localSlotId : m.visitanteSlotId);
}
function telSyncReset(m){if(!m)return;m.localGoles=null;m.visitanteGoles=null;m.golesLocal=null;m.golesVisitante=null;m.resultado='';m.estado='pendiente';m.finalizado=false;}
function telSyncEnsureIds(data){
  telSyncComps(data).forEach((c,ci)=>{telSyncCompId(c,ci);(c.partidos||[]).forEach((m,mi)=>telSyncMatchId(c,m,mi));});
}
function telSyncEnsureCup(c){
  c.partidos=c.partidos||[];
  const qf=c.partidos.filter(m=>telSyncRound(m)===1), sf=c.partidos.filter(m=>telSyncRound(m)===2), fi=c.partidos.filter(m=>telSyncRound(m)===3);
  const cid=String(c.id||c.nombre||'copa').toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');
  while(qf.length>=4 && sf.length<2){const n=sf.length+1; const m={id:`${cid}-semifinal-${n}`,jornada:2,ronda:2,rondaNombre:'Semifinales',fase:'Semifinales',localSlotId:'',visitanteSlotId:'',localGoles:null,visitanteGoles:null,estado:'pendiente',finalizado:false}; c.partidos.push(m); sf.push(m);}
  while(sf.length>=2 && fi.length<1){const m={id:`${cid}-final-1`,jornada:3,ronda:3,rondaNombre:'Final',fase:'Final',localSlotId:'',visitanteSlotId:'',localGoles:null,visitanteGoles:null,estado:'pendiente',finalizado:false}; c.partidos.push(m); fi.push(m);}
}
function telSyncAdvanceCup(c){
  telSyncEnsureCup(c);
  const by={qf:[],sf:[],final:[]};
  (c.partidos||[]).forEach((m,i)=>{m.__i=i; const r=telSyncRound(m); if(r===1)by.qf.push(m); else if(r===2)by.sf.push(m); else by.final.push(m);});
  Object.values(by).forEach(a=>a.sort((x,y)=>Number(x.orden??x.order??x.posicion??x.__i)-Number(y.orden??y.order??y.posicion??y.__i)));
  const qfw=by.qf.map(telSyncWinner), sfw=by.sf.map(telSyncWinner);
  const setTeams=(m,a,b)=>{if(!m)return; let ch=false; if(String(m.localSlotId||'')!==String(a||'')){m.localSlotId=a||'';ch=true;} if(String(m.visitanteSlotId||'')!==String(b||'')){m.visitanteSlotId=b||'';ch=true;} if(ch) telSyncReset(m);};
  if(by.sf[0]) setTeams(by.sf[0], qfw[0]||'', qfw[1]||'');
  if(by.sf[1]) setTeams(by.sf[1], qfw[2]||'', qfw[3]||'');
  if(by.final[0]) setTeams(by.final[0], sfw[0]||'', sfw[1]||'');
  (c.partidos||[]).forEach(m=>delete m.__i);
}
function telSyncRecalcLeague(c){
  const rows=new Map();
  (c.equipos||[]).forEach((t,i)=>{const s=telSyncSlot(t,i); rows.set(s,{...t,slotId:s,nombre:telSyncName(t,`Equipo ${i+1}`),pj:0,pg:0,pe:0,pp:0,gf:0,gc:0,dg:0,pts:0,puntos:0});});
  (c.partidos||[]).forEach(m=>{
    if(!telSyncPlayed(m))return;
    const l=rows.get(String(m.localSlotId||'')), v=rows.get(String(m.visitanteSlotId||'')); if(!l||!v)return;
    const a=Number(m.localGoles??0), b=Number(m.visitanteGoles??0);
    l.pj++;v.pj++;l.gf+=a;l.gc+=b;v.gf+=b;v.gc+=a;l.dg=l.gf-l.gc;v.dg=v.gf-v.gc;
    l.golesFavor=l.gf;l.golesContra=l.gc;v.golesFavor=v.gf;v.golesContra=v.gc;
    if(a>b){l.pg++;l.pts+=3;l.puntos=l.pts;v.pp++;v.puntos=v.pts;}
    else if(a<b){v.pg++;v.pts+=3;v.puntos=v.pts;l.pp++;l.puntos=l.pts;}
    else{l.pe++;v.pe++;l.pts++;v.pts++;l.puntos=l.pts;v.puntos=v.pts;}
  });
  c.clasificacion=Array.from(rows.values()).sort((a,b)=>(Number(b.pts||0)-Number(a.pts||0))||(Number(b.dg||0)-Number(a.dg||0))||(Number(b.gf||0)-Number(a.gf||0)));
}
function telSyncRecalcAll(data){telSyncEnsureIds(data); telSyncComps(data).forEach(c=>telSyncIsCup(c)?telSyncAdvanceCup(c):telSyncRecalcLeague(c));}

app.get('/api/tel-panel/matches',(req,res)=>{
  try{
    const data=telSyncRead(); telSyncRecalcAll(data); telSyncWrite(data);
    const competiciones=telSyncComps(data).map((c,ci)=>({id:telSyncCompId(c,ci),nombre:c.nombre||c.name||telSyncCompId(c,ci),isCup:telSyncIsCup(c)}));
    const matches=[];
    telSyncComps(data).forEach((c,ci)=>{
      const compId=telSyncCompId(c,ci), isCup=telSyncIsCup(c);
      (c.partidos||[]).forEach((m,mi)=>{
        const id=telSyncMatchId(c,m,mi), l=telSyncTeam(c,m.localSlotId), v=telSyncTeam(c,m.visitanteSlotId);
        matches.push({compId,compNombre:c.nombre||c.name||compId,isCup,id,jornada:m.jornada||'',ronda:m.rondaNombre||m.fase||'',rondaRaw:m.ronda||m.round||'',rondaNombre:m.rondaNombre||'',fase:m.fase||'',nombreRonda:m.nombreRonda||'',localNombre:telSyncName(l,m.localSlotId||'Por definir'),visitanteNombre:telSyncName(v,m.visitanteSlotId||'Por definir'),localLogo:telSyncLogo(l),visitanteLogo:telSyncLogo(v),localGoles:m.localGoles??m.golesLocal??null,visitanteGoles:m.visitanteGoles??m.golesVisitante??null,finalizado:telSyncPlayed(m),estado:telSyncPlayed(m)?'finalizado':'pendiente',fecha:m.fecha||m.date||'',hora:m.hora||m.time||'',localSlotId:m.localSlotId||'',visitanteSlotId:m.visitanteSlotId||''});
      });
    });
    res.set('Cache-Control','no-store'); res.json({ok:true,competiciones,matches});
  }catch(e){console.error(e);res.status(500).json({ok:false,message:String(e.message||e)});}
});
app.post('/api/tel-panel/login', express.json(), (req,res)=>res.json({ok:true,admin:true,email:'roleplayserver007@gmail.com'}));
app.post('/api/tel-panel/save', express.json(), (req,res)=>{
  try{
    const compId=String(req.body?.compId||''), matchId=String(req.body?.matchId||''), clear=req.body?.clear===true;
    const data=telSyncRead(); telSyncEnsureIds(data);
    const comp=telSyncComps(data).find((c,i)=>telSyncCompId(c,i)===compId); if(!comp) return res.status(404).json({ok:false,message:'Competición no encontrada'});
    const match=(comp.partidos||[]).find((m,i)=>telSyncMatchId(comp,m,i)===matchId); if(!match) return res.status(404).json({ok:false,message:'Partido no encontrado'});
    if(clear){ telSyncReset(match); }
    else{
      const lg=Number(req.body?.localGoles), vg=Number(req.body?.visitanteGoles);
      if(!Number.isInteger(lg)||!Number.isInteger(vg)||lg<0||vg<0) return res.status(400).json({ok:false,message:'Pon goles válidos'});
      if(telSyncIsCup(comp) && lg===vg) return res.status(400).json({ok:false,message:'En copas no puede haber empate'});
      match.localGoles=lg; match.visitanteGoles=vg; match.golesLocal=lg; match.golesVisitante=vg; match.resultado=`${lg}-${vg}`; match.estado='finalizado'; match.finalizado=true;
    }
    if(req.body?.fecha){match.fecha=String(req.body.fecha);match.date=String(req.body.fecha);}
    if(req.body?.hora){match.hora=String(req.body.hora);match.time=String(req.body.hora);}
    telSyncRecalcAll(data); telSyncWrite(data);
    res.set('Cache-Control','no-store'); res.json({ok:true,message:clear?'Resultado borrado':'Resultado guardado'});
  }catch(e){console.error(e);res.status(500).json({ok:false,message:String(e.message||e)});}
});



/* TEL ROUTE FALLBACK LOCALHOST */
app.get('/', (req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.get('/panel-copas', (req,res)=>res.sendFile(path.join(__dirname,'panel-copas.html')));
app.get('/panel-resultados', (req,res)=>res.sendFile(path.join(__dirname,'panel-resultados.html')));



/* TEL CAMBIO EQUIPO HISTORIAL */
function ceNorm(v){return String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,' ').trim();}
function ceSlug(v){return String(v||'equipo').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'')||'equipo';}
function ceRead(){return JSON.parse(fs.readFileSync(path.join(__dirname,'data.json'),'utf8'));}
function ceWrite(d){fs.writeFileSync(path.join(__dirname,'data.json'),JSON.stringify(d,null,2),'utf8');}
function ceComps(d){return d.competiciones||d.ligas||d.torneos||[];}
function ceName(t){return String(t?.nombre||t?.clubNombre||t?.name||t?.nombreVisual||'').trim();}
function ceSlot(t){if(!t.slotId)t.slotId=String(t.id||t.clubId||ceSlug(ceName(t)));return String(t.slotId);}
function cePlayed(m){return m&&(m.finalizado===true||m.estado==='finalizado'||m.estado==='jugado'||(m.localGoles!==null&&m.localGoles!==undefined&&m.visitanteGoles!==null&&m.visitanteGoles!==undefined));}
function ceFindTeam(d,name){
  const n=ceNorm(name);
  for(const k of ['clubes','equipos','teams']) for(const t of (d[k]||[])) if(ceNorm(ceName(t))===n) return JSON.parse(JSON.stringify(t));
  for(const c of ceComps(d)) for(const t of (c.equipos||[])) if(ceNorm(ceName(t))===n) return JSON.parse(JSON.stringify(t));
  return null;
}
function ceMakeTeam(d,name){
  let t=ceFindTeam(d,name)||{id:ceSlug(name),slotId:ceSlug(name),nombre:name,clubNombre:name,escudoUrl:`/escudos/${ceSlug(name)}.png`,escudoPath:`escudos/${ceSlug(name)}.png`,escudoFilename:`${ceSlug(name)}.png`};
  t.nombre=name;t.clubNombre=name;if(!t.id)t.id=ceSlug(name);if(!t.slotId)t.slotId=String(t.id||ceSlug(name));return t;
}
app.post('/api/admin/cambiar-equipo-competicion', express.json(), (req,res)=>{
  try{
    const d=ceRead();
    const compId=String(req.body?.compId||'').trim();
    const sale=String(req.body?.equipoSale||req.body?.sale||'').trim();
    const entra=String(req.body?.equipoEntra||req.body?.entra||'').trim();
    if(!sale||!entra)return res.status(400).json({ok:false,message:'Falta equipo que sale o entra.'});
    const comps=ceComps(d);
    const comp=comps.find((c,i)=>!compId||String(c.id||ceSlug(c.nombre||`competicion-${i+1}`))===compId);
    if(!comp)return res.status(404).json({ok:false,message:'Competición no encontrada.'});
    comp.equipos=comp.equipos||[];comp.partidos=comp.partidos||[];comp.historialCambiosEquipos=comp.historialCambiosEquipos||[];
    const old=comp.equipos.find(t=>ceNorm(ceName(t))===ceNorm(sale));
    if(!old)return res.status(404).json({ok:false,message:'El equipo que sale no está en la competición.'});
    const oldSlot=ceSlot(old);
    const nt=ceMakeTeam(d,entra);
    const oldSnapshot=JSON.parse(JSON.stringify(old));
    old.nombre=entra;old.clubNombre=entra;old.name=entra;old.reemplazaA=sale;old.slotId=oldSlot;old.equipoOriginalHistorico=oldSnapshot;
    for(const k of ['escudoUrl','logoUrl','escudoPath','escudoFilename','logo']) if(nt[k]) old[k]=nt[k];
    let played=0,future=0;
    for(const m of comp.partidos){
      const l=String(m.localSlotId||'')===oldSlot, v=String(m.visitanteSlotId||'')===oldSlot;
      if(!l&&!v)continue;
      if(cePlayed(m)){
        if(l){m.localNombre=sale;m.localEquipoHistorico=sale;}
        if(v){m.visitanteNombre=sale;m.visitanteEquipoHistorico=sale;}
        m.historicoCambioEquipo=true;m.equipoOriginal=sale;m.equipoNuevo=entra;played++;
      }else{
        if(l)m.localNombre=entra;
        if(v)m.visitanteNombre=entra;
        m.equipoReemplazado=sale;m.equipoNuevo=entra;future++;
      }
    }
    const cambio={fecha:new Date().toISOString(),compId:String(comp.id||''),equipoSale:sale,equipoEntra:entra,slotId:oldSlot,partidosJugadosConservados:played,partidosFuturosActualizados:future};
    comp.historialCambiosEquipos.push(cambio);d.historialCambiosEquipos=d.historialCambiosEquipos||[];d.historialCambiosEquipos.push(cambio);
    ceWrite(d);res.json({ok:true,message:'Equipo cambiado sin borrar historial.',cambio});
  }catch(e){console.error(e);res.status(500).json({ok:false,message:String(e.message||e)});}
});


app.listen(PORT, () => {
  console.log(`🌐 Web Thunder Elite League lista en http://localhost:${PORT}`);
});