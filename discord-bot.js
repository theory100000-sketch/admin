// TEL BOT TOKEN GUARD
process.on("unhandledRejection", (error) => {
  if (error && (error.code === "TokenInvalid" || String(error.message || "").toLowerCase().includes("invalid token"))) {
    console.warn("[bot] Token de Discord inválido. Bot desactivado; la web sigue funcionando.");
    return;
  }
  console.error(error);
});

require("dotenv").config();



function canvasDisponible() {
  return typeof createCanvas === "function" && typeof loadImage === "function";
}
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
let Canvas = null;
try {
  Canvas = require("canvas");
} catch (error) {
  console.warn("Canvas no está instalado. Las imágenes de bienvenida se desactivan, pero el bot seguirá funcionando.");
}
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  ChannelType,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder
} = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

function telDiscordImageUrl(...candidates) {
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (/^https?:\/\/[^\s]+$/i.test(value) || /^attachment:\/\/[^\s]+$/i.test(value)) {
      return value;
    }
  }

  try {
    const botAvatar = client.user?.displayAvatarURL?.({ extension: "png", size: 256 });
    if (botAvatar && /^https?:\/\//i.test(botAvatar)) return botAvatar;
  } catch (error) {}

  return "https://cdn.discordapp.com/embed/avatars/0.png";
}


/* ============================================================
   RESPUESTAS DISCORD SEGURAS PARA TODOS LOS COMANDOS
   Evita que una operación guardada correctamente termine mostrando
   "Ha ocurrido un error" por textos vacíos, URLs locales, embeds
   demasiado largos o un fallo al renderizar la respuesta.
   ============================================================ */
function telDiscordSafeText(value, fallback = "Sin especificar", maxLength = 1024) {
  const normalized = String(value ?? "").trim() || fallback;
  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(1, maxLength - 1))}…`
    : normalized;
}

function telDiscordValidPublicUrl(value, allowAttachment = true) {
  const url = String(value || "").trim();
  if (/^https?:\/\/[^\s]+$/i.test(url)) return url;
  if (allowAttachment && /^attachment:\/\/[^\s]+$/i.test(url)) return url;
  return "";
}

function telDiscordSafeColor(value, fallback = 0x8b2cff) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff) return value;
  const raw = String(value || "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{6}$/i.test(raw)) return Number.parseInt(raw, 16);
  return fallback;
}

function telDiscordSafeField(field = {}) {
  return {
    name: telDiscordSafeText(field.name, "Información", 256),
    value: telDiscordSafeText(field.value, "Sin especificar", 1024),
    inline: Boolean(field.inline)
  };
}

function telDiscordSanitizeEmbedData(embed) {
  let data;
  try {
    data = typeof embed?.toJSON === "function" ? embed.toJSON() : { ...(embed || {}) };
  } catch (error) {
    data = {};
  }

  const safe = {};
  if (data.title !== undefined) safe.title = telDiscordSafeText(data.title, "Thunder Elite League", 256);
  if (data.description !== undefined) safe.description = telDiscordSafeText(data.description, "Operación completada.", 4096);
  if (data.color !== undefined) safe.color = telDiscordSafeColor(data.color);
  if (data.timestamp) safe.timestamp = data.timestamp;

  const url = telDiscordValidPublicUrl(data.url, false);
  if (url) safe.url = url;

  const thumbnailUrl = telDiscordValidPublicUrl(data.thumbnail?.url);
  if (thumbnailUrl) safe.thumbnail = { url: thumbnailUrl };

  const imageUrl = telDiscordValidPublicUrl(data.image?.url);
  if (imageUrl) safe.image = { url: imageUrl };

  if (data.author) {
    safe.author = { name: telDiscordSafeText(data.author.name, "Thunder Elite League", 256) };
    const authorIcon = telDiscordValidPublicUrl(data.author.icon_url || data.author.iconURL);
    const authorUrl = telDiscordValidPublicUrl(data.author.url, false);
    if (authorIcon) safe.author.icon_url = authorIcon;
    if (authorUrl) safe.author.url = authorUrl;
  }

  if (data.footer) {
    safe.footer = { text: telDiscordSafeText(data.footer.text, "Thunder Elite League", 2048) };
    const footerIcon = telDiscordValidPublicUrl(data.footer.icon_url || data.footer.iconURL);
    if (footerIcon) safe.footer.icon_url = footerIcon;
  }

  if (Array.isArray(data.fields)) {
    safe.fields = data.fields.slice(0, 25).map(telDiscordSafeField);
  }

  // Discord limita a 6000 caracteres el contenido textual total de un embed.
  const total = () =>
    (safe.title?.length || 0) +
    (safe.description?.length || 0) +
    (safe.footer?.text?.length || 0) +
    (safe.author?.name?.length || 0) +
    (safe.fields || []).reduce((sum, field) => sum + field.name.length + field.value.length, 0);

  while (total() > 5900 && safe.fields?.length) safe.fields.pop();
  if (total() > 5900 && safe.description) {
    const excess = total() - 5900;
    safe.description = telDiscordSafeText(safe.description, "Operación completada.", Math.max(100, safe.description.length - excess));
  }

  if (!safe.title && !safe.description && !safe.fields?.length && !safe.image && !safe.thumbnail) {
    safe.description = "Operación completada correctamente.";
  }

  return safe;
}

function telDiscordSanitizePayload(payload, commandName = "comando") {
  if (typeof payload === "string") {
    return { content: telDiscordSafeText(payload, `✅ /${commandName} completado.`, 2000) };
  }

  const safe = { ...(payload || {}) };
  if (safe.content !== undefined) {
    safe.content = telDiscordSafeText(safe.content, `✅ /${commandName} completado.`, 2000);
  }
  if (Array.isArray(safe.embeds)) {
    safe.embeds = safe.embeds.slice(0, 10).map(telDiscordSanitizeEmbedData);
  }
  if (Array.isArray(safe.files)) safe.files = safe.files.slice(0, 10);
  if (Array.isArray(safe.components)) safe.components = safe.components.slice(0, 5);

  if (!safe.content && (!safe.embeds || safe.embeds.length === 0) && (!safe.files || safe.files.length === 0)) {
    safe.content = `✅ /${commandName} completado correctamente.`;
  }
  return safe;
}

function telDiscordFallbackPayload(commandName, originalPayload) {
  let summary = "";
  try {
    const firstEmbed = originalPayload?.embeds?.[0];
    const embedData = firstEmbed ? telDiscordSanitizeEmbedData(firstEmbed) : null;
    summary = embedData?.title || embedData?.description || "";
  } catch (error) {}

  return {
    content: telDiscordSafeText(
      summary ? `✅ ${summary}` : `✅ El comando /${commandName} se ha completado correctamente.`,
      `✅ El comando /${commandName} se ha completado correctamente.`,
      2000
    ),
    embeds: [],
    components: []
  };
}

function telInstallSafeInteractionResponses(interaction) {
  if (!interaction || interaction.__telSafeResponsesInstalled) return;
  interaction.__telSafeResponsesInstalled = true;

  for (const methodName of ["reply", "editReply", "followUp", "update"]) {
    if (typeof interaction[methodName] !== "function") continue;
    const original = interaction[methodName].bind(interaction);

    interaction[methodName] = async payload => {
      const sanitized = telDiscordSanitizePayload(payload, interaction.commandName || "comando");
      try {
        return await original(sanitized);
      } catch (error) {
        console.error(`[discord-respuesta:${interaction.commandName || "desconocido"}:${methodName}]`, error?.rawError || error);
        const fallback = telDiscordFallbackPayload(interaction.commandName || "comando", sanitized);
        try {
          return await original(fallback);
        } catch (fallbackError) {
          console.error(`[discord-respuesta-fallback:${interaction.commandName || "desconocido"}:${methodName}]`, fallbackError?.rawError || fallbackError);
          throw fallbackError;
        }
      }
    };
  }
}

// Protección adicional en la construcción de embeds. Así ningún comando falla
// después de guardar los datos por un campo opcional vacío o una URL local.
const telOriginalEmbedMethods = {
  setTitle: EmbedBuilder.prototype.setTitle,
  setDescription: EmbedBuilder.prototype.setDescription,
  addFields: EmbedBuilder.prototype.addFields,
  setFields: EmbedBuilder.prototype.setFields,
  setThumbnail: EmbedBuilder.prototype.setThumbnail,
  setImage: EmbedBuilder.prototype.setImage,
  setURL: EmbedBuilder.prototype.setURL,
  setAuthor: EmbedBuilder.prototype.setAuthor,
  setFooter: EmbedBuilder.prototype.setFooter,
  setColor: EmbedBuilder.prototype.setColor
};

EmbedBuilder.prototype.setTitle = function(value) {
  return telOriginalEmbedMethods.setTitle.call(this, telDiscordSafeText(value, "Thunder Elite League", 256));
};
EmbedBuilder.prototype.setDescription = function(value) {
  return telOriginalEmbedMethods.setDescription.call(this, telDiscordSafeText(value, "Operación completada.", 4096));
};
EmbedBuilder.prototype.addFields = function(...fields) {
  const flattened = fields.length === 1 && Array.isArray(fields[0]) ? fields[0] : fields;
  return telOriginalEmbedMethods.addFields.call(this, flattened.slice(0, 25).map(telDiscordSafeField));
};
EmbedBuilder.prototype.setFields = function(...fields) {
  const flattened = fields.length === 1 && Array.isArray(fields[0]) ? fields[0] : fields;
  return telOriginalEmbedMethods.setFields.call(this, flattened.slice(0, 25).map(telDiscordSafeField));
};
EmbedBuilder.prototype.setThumbnail = function(value) {
  return telOriginalEmbedMethods.setThumbnail.call(this, telDiscordImageUrl(value));
};
EmbedBuilder.prototype.setImage = function(value) {
  return telOriginalEmbedMethods.setImage.call(this, telDiscordImageUrl(value));
};
EmbedBuilder.prototype.setURL = function(value) {
  const url = telDiscordValidPublicUrl(value, false);
  return url ? telOriginalEmbedMethods.setURL.call(this, url) : this;
};
EmbedBuilder.prototype.setAuthor = function(options = {}) {
  const safe = { name: telDiscordSafeText(options.name, "Thunder Elite League", 256) };
  const iconURL = telDiscordValidPublicUrl(options.iconURL || options.icon_url);
  const url = telDiscordValidPublicUrl(options.url, false);
  if (iconURL) safe.iconURL = iconURL;
  if (url) safe.url = url;
  return telOriginalEmbedMethods.setAuthor.call(this, safe);
};
EmbedBuilder.prototype.setFooter = function(options = {}) {
  const safe = { text: telDiscordSafeText(options.text, "Thunder Elite League", 2048) };
  const iconURL = telDiscordValidPublicUrl(options.iconURL || options.icon_url);
  if (iconURL) safe.iconURL = iconURL;
  return telOriginalEmbedMethods.setFooter.call(this, safe);
};
EmbedBuilder.prototype.setColor = function(value) {
  return telOriginalEmbedMethods.setColor.call(this, telDiscordSafeColor(value));
};
/* Fin: respuestas Discord seguras */

const DATA_FILE = "./data.json";
const AGENTE_LIBRE_VALUE = "__AGENTE_LIBRE__";

/* Sincronización opcional con la misma base Upstash usada por la web en Vercel. */
const TEL_REDIS_PREFIX = String(process.env.TEL_REDIS_PREFIX || 'tel:web:v1:');
const telBotRedisUrl = String(
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || ''
).trim();
const telBotRedisToken = String(
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || ''
).trim();
let telBotRedis = null;
if(telBotRedisUrl && telBotRedisToken){
  try{
    const { Redis } = require('@upstash/redis');
    telBotRedis = new Redis({url:telBotRedisUrl, token:telBotRedisToken});
  }catch(error){
    console.warn('[bot-storage] No se pudo iniciar Upstash Redis:', error.message || error);
  }
}
let telBotStorageReady = false;
let telBotRemoteVersion = '';
let telBotActiveDataRedisKey = '';
let telBotPersistQueue = Promise.resolve();
let telBotPreSyncLocalData = null;
const TEL_REDIS_SAFE_PREFIX = TEL_REDIS_PREFIX.endsWith(':') ? TEL_REDIS_PREFIX : `${TEL_REDIS_PREFIX}:`;
const TEL_MAX_LOGO_BYTES = Math.max(100000, Number(process.env.TEL_MAX_LOGO_BYTES || 1500000));
function telBotRedisKey(name){ return `${TEL_REDIS_PREFIX}${name}`; }
function telBotVersionKey(){ return `${TEL_REDIS_PREFIX}__version`; }
function telBotActiveDataKey(){ return `${TEL_REDIS_PREFIX}__active_data_key`; }
function telBotClubLogoKey(clubKey){ return `${TEL_REDIS_SAFE_PREFIX}club-logo:${String(clubKey || '').trim()}`; }
async function telBotResolveDataRedisKey(force=false){
  if(!telBotRedis) return telBotRedisKey('data.json');
  if(!force && telBotActiveDataRedisKey) return telBotActiveDataRedisKey;
  try{
    const raw = await telBotRedis.get(telBotActiveDataKey());
    const candidate = String(raw || '').trim();
    if(candidate && candidate.startsWith(TEL_REDIS_PREFIX)){
      telBotActiveDataRedisKey = candidate;
      return candidate;
    }
  }catch(error){
    console.warn('[bot-storage] No se pudo leer la clave activa de la web:', error.message || error);
  }
  telBotActiveDataRedisKey = telBotRedisKey('data.json');
  return telBotActiveDataRedisKey;
}
async function telBotRefreshFromRedis(force=false){
  if(!telBotRedis) return;
  const previousDataKey = telBotActiveDataRedisKey;
  const dataKey = await telBotResolveDataRedisKey(true);
  const remoteVersionRaw = await telBotRedis.get(telBotVersionKey());
  const remoteVersion = String(remoteVersionRaw || '');
  const activeKeyChanged = Boolean(previousDataKey && previousDataKey !== dataKey);
  if(!force && !activeKeyChanged && remoteVersion === telBotRemoteVersion) return;
  const stored = await telBotRedis.get(dataKey);
  if(stored !== null && stored !== undefined){
    const content = typeof stored === 'string' ? stored : JSON.stringify(stored, null, 2);
    fs.writeFileSync(DATA_FILE, content, 'utf8');
  }
  telBotRemoteVersion = remoteVersion;
}
function telBotPersistData(content){
  if(!telBotRedis || !telBotStorageReady) return;
  const version = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  telBotPersistQueue = telBotPersistQueue
    .catch(()=>{})
    .then(async()=>{
      const dataKey = await telBotResolveDataRedisKey(true);
      await telBotRedis.set(dataKey, String(content));
      // Copia de compatibilidad para instalaciones antiguas. La web nueva usa dataKey.
      const legacyKey = telBotRedisKey('data.json');
      if(legacyKey !== dataKey) await telBotRedis.set(legacyKey, String(content));
      await telBotRedis.set(telBotVersionKey(), version);
      telBotRemoteVersion = version;
      console.log(`[bot-storage] data.json sincronizado con la web en ${dataKey}`);
    })
    .catch(error=>console.error('[bot-storage] No se pudo sincronizar data.json:', error));
}
async function telBotPersistClubLogo(clubKey, logo){
  if(!telBotRedis || !clubKey || !logo?.base64) return false;
  try{
    const payload = JSON.stringify({
      contentType: logo.contentType || 'image/png',
      base64: logo.base64,
      size: Number(logo.size || 0),
      updatedAt: new Date().toISOString()
    });
    await telBotRedis.set(telBotClubLogoKey(clubKey), payload);
    return true;
  }catch(error){
    console.warn('[bot-storage] No se pudo guardar el escudo en Upstash:', error.message || error);
    return false;
  }
}
async function telBotDeleteClubLogo(clubKey){
  if(!telBotRedis || !clubKey) return;
  try{ await telBotRedis.del(telBotClubLogoKey(clubKey)); }catch(error){}
}
async function telBotBackfillClubLogos(data){
  if(!telBotRedis || !Array.isArray(data?.clubes)) return;
  for(const club of data.clubes){
    const clubKey = telClubStableId(club);
    if(!clubKey) continue;
    try{
      const exists = await telBotRedis.exists(telBotClubLogoKey(clubKey));
      if(exists) continue;
      const fileName = club.escudoFilename || (club.escudoPath ? path.basename(String(club.escudoPath)) : '');
      if(!fileName) continue;
      const diskPath = path.join(PUBLIC_ESCUDOS_DIR, path.basename(fileName));
      if(!fs.existsSync(diskPath)) continue;
      const buffer = fs.readFileSync(diskPath);
      if(!buffer.length || buffer.length > TEL_MAX_LOGO_BYTES) continue;
      const ext = path.extname(fileName).toLowerCase();
      const contentType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.webp' ? 'image/webp'
        : ext === '.gif' ? 'image/gif'
        : 'image/png';
      await telBotPersistClubLogo(clubKey, {
        contentType,
        base64: buffer.toString('base64'),
        size: buffer.length
      });
    }catch(error){}
  }
}

async function telBotRecoverRecentLocalClubs(){
  const snapshot = telBotPreSyncLocalData;
  if(!snapshot || !Array.isArray(snapshot.clubes) || !client?.guilds?.cache) return;
  const current = cargarDatos();
  if(!Array.isArray(current.clubes)) current.clubes = [];
  if(!Array.isArray(current.jugadores)) current.jugadores = [];
  const hours = Math.max(1, Number(process.env.TEL_MIGRATION_WINDOW_HOURS || 72));
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const norm = value => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const currentIds = new Set(current.clubes.flatMap(club => [club.id, club.rolId, club.nombre, club.nombreVisual].filter(Boolean).map(norm)));
  const recovered = [];

  for(const club of snapshot.clubes){
    const createdAt = Date.parse(club.creadoEn || club.actualizadoEn || snapshot.sync?.updatedAt || 0);
    if(!Number.isFinite(createdAt) || createdAt < cutoff) continue;
    const keys = [club.id, club.rolId, club.nombre, club.nombreVisual].filter(Boolean).map(norm);
    if(keys.some(key => currentIds.has(key))) continue;
    const roleStillExists = Boolean(club.rolId) && client.guilds.cache.some(guild => guild.roles.cache.has(String(club.rolId)));
    if(!roleStillExists) continue;

    current.clubes.push(JSON.parse(JSON.stringify(club)));
    keys.forEach(key => currentIds.add(key));
    recovered.push(club);

    const relatedPlayers = (snapshot.jugadores || []).filter(player =>
      String(player.clubId || '') === String(club.id || '') ||
      norm(player.club || player.clubNombre) === norm(club.nombre)
    );
    for(const player of relatedPlayers){
      const playerId = String(player.usuarioId || player.discordId || player.id || '');
      const exists = current.jugadores.some(item => String(item.usuarioId || item.discordId || item.id || '') === playerId && playerId);
      if(!exists) current.jugadores.push(JSON.parse(JSON.stringify(player)));
    }
  }

  if(!recovered.length) return;
  guardarDatos(current);
  await telBotPersistQueue;
  await telBotBackfillClubLogos(current);
  console.log(`[bot-storage] Recuperados ${recovered.length} club(es) recientes creados en Discord: ${recovered.map(c=>c.nombre).join(', ')}`);
}

const CANAL_NORMATIVA_ID = "1521946924733698108";
const CANAL_AGENTE_LIBRE_ID = "1522168317404516372";

const TICKET_CATEGORIAS = [
  {
    label: "Dudas",
    value: "dudas",
    emoji: "❓",
    descripcion: "Preguntas o dudas generales"
  },
  {
    label: "+3",
    value: "mas3",
    emoji: "➕",
    descripcion: "Solicitudes o temas relacionados con +3"
  },
  {
    label: "Reporte",
    value: "reporte",
    emoji: "🚨",
    descripcion: "Reportar a un usuario o problema"
  },
  {
    label: "Postulación",
    value: "postulacion",
    emoji: "📝",
    descripcion: "Postulaciones para staff u otros puestos"
  },
  {
    label: "Alianzas",
    value: "alianzas",
    emoji: "🤝",
    descripcion: "Solicitudes de alianza"
  },
  {
    label: "Otros",
    value: "otros",
    emoji: "📌",
    descripcion: "Otros asuntos"
  }
];

function cargarDatos() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(
        {
          clubes: [],
          jugadores: [],
          mercado: [],
          ticketsActivos: [],
          sanciones: [],
          config: {}
        },
        null,
        2
      )
    );
  }

  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

  if (!data.clubes) data.clubes = [];
  if (!data.jugadores) data.jugadores = [];
  if (!data.mercado) data.mercado = [];
  if (!data.ticketsActivos) data.ticketsActivos = [];
  if (!data.sanciones) data.sanciones = [];
  if (!data.config) data.config = {};

  return data;
}

const PUBLIC_ESCUDOS_DIR = path.join(__dirname, "public", "escudos");

function telSlug(value) {
  return String(value || "club")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "club";
}

function telClubStableId(club) {
  if (club?.id) return String(club.id);
  if (club?._id) return String(club._id);
  if (club?.rolId) return `CLUB-${club.rolId}`;
  const seed = `${club?.nombre || "club"}|${club?.creadoEn || ""}`;
  return `CLUB-${telSlug(club?.nombre)}-${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 8)}`;
}

function telDiscordDisplayName(user) {
  return user?.globalName || user?.displayName || user?.username || user?.tag || "Jugador";
}

function crearRegistroJugadorWeb(usuario, club, interaction, extras = {}) {
  const now = new Date().toISOString();
  const discordId = String(usuario?.id || extras.usuarioId || "");
  const discordTag = usuario?.tag || usuario?.username || extras.usuarioTag || discordId;
  let avatarUrl = extras.avatarUrl || "";
  try {
    if (!avatarUrl && usuario && typeof usuario.displayAvatarURL === "function") {
      avatarUrl = usuario.displayAvatarURL({ extension: "png", size: 128 });
    }
  } catch (error) {}

  return {
    id: discordId || `PLAYER-${crypto.randomUUID()}`,
    usuarioId: discordId,
    discordId,
    usuarioTag: discordTag,
    discord: discordTag,
    nombre: extras.nombre || telDiscordDisplayName(usuario),
    nombreJugador: extras.nombre || telDiscordDisplayName(usuario),
    idJugador: extras.idJugador || discordId,
    idEaPsn: extras.idEaPsn || extras.eaPsnId || "",
    eaPsnId: extras.idEaPsn || extras.eaPsnId || "",
    club: club?.nombre || extras.club || "",
    clubNombre: club?.nombre || extras.club || "",
    clubId: club ? telClubStableId(club) : (extras.clubId || ""),
    avatarUrl,
    estado: extras.estado || "activo",
    agregadoComoDirectiva: extras.agregadoComoDirectiva === true,
    registradoPorId: interaction?.user?.id || extras.registradoPorId || "",
    registradoPorTag: interaction?.user?.tag || extras.registradoPorTag || "",
    registradoEn: extras.registradoEn || now,
    actualizadoEn: now
  };
}

function telNormalizarDatosParaWeb(data) {
  const now = new Date().toISOString();
  if (!data || typeof data !== "object") data = {};
  if (!Array.isArray(data.clubes)) data.clubes = [];
  if (!Array.isArray(data.jugadores)) data.jugadores = [];
  if (!Array.isArray(data.competiciones)) data.competiciones = [];
  if (!Array.isArray(data.mercado)) data.mercado = [];

  const clubsById = new Map();
  const clubsByName = new Map();

  data.clubes.forEach(club => {
    club.id = telClubStableId(club);
    club.presupuesto = Number(club.presupuesto || 0);
    club.maxJugadores = Number(club.maxJugadores || process.env.MAX_JUGADORES_CLUB || 18);
    club.nombre = String(club.nombre || club.name || "Club sin nombre");
    club.nombreVisual = club.nombreVisual || crearNombreVisual(club.nombre, club.emoji || "");
    club.estado = club.estado || "activo";
    club.actualizadoEn = now;
    if (club.escudoPath && !club.escudoUrl) {
      const file = path.basename(String(club.escudoPath));
      club.escudoUrl = `/escudos/${file}`;
      club.escudoFilename = file;
    }
    clubsById.set(String(club.id), club);
    clubsByName.set(String(club.nombre).toLowerCase(), club);
    clubsByName.set(String(club.nombreVisual).toLowerCase(), club);
  });

  data.jugadores = data.jugadores.map((player, index) => {
    const discordId = String(player.usuarioId || player.discordId || player.idJugador || player.id || "");
    const club = clubsById.get(String(player.clubId || "")) ||
      clubsByName.get(String(player.club || player.clubNombre || "").toLowerCase()) || null;
    const tag = player.usuarioTag || player.discord || player.discordTag || discordId || `Jugador ${index + 1}`;
    return {
      ...player,
      id: player.id || discordId || `PLAYER-${crypto.randomUUID()}`,
      usuarioId: discordId,
      discordId,
      usuarioTag: tag,
      discord: player.discord || tag,
      nombre: player.nombre || player.nombreJugador || String(tag).split("#")[0] || `Jugador ${index + 1}`,
      nombreJugador: player.nombreJugador || player.nombre || String(tag).split("#")[0] || `Jugador ${index + 1}`,
      idJugador: player.idJugador || discordId,
      idEaPsn: player.idEaPsn || player.eaPsnId || player.idEA || player.psnId || "",
      eaPsnId: player.eaPsnId || player.idEaPsn || player.idEA || player.psnId || "",
      club: club?.nombre || player.club || player.clubNombre || "",
      clubNombre: club?.nombre || player.clubNombre || player.club || "",
      clubId: club?.id || player.clubId || "",
      estado: player.estado || "activo",
      registradoEn: player.registradoEn || now,
      actualizadoEn: now
    };
  });

  const playersByClub = new Map();
  data.jugadores.forEach(player => {
    const key = String(player.clubId || player.club || "").toLowerCase();
    if (!playersByClub.has(key)) playersByClub.set(key, []);
    playersByClub.get(key).push(player);
  });

  data.clubes.forEach(club => {
    const players = playersByClub.get(String(club.id).toLowerCase()) ||
      playersByClub.get(String(club.nombre).toLowerCase()) || [];
    club.jugadoresRegistrados = players.length;
    club.plantillaIds = players.map(player => player.usuarioId).filter(Boolean);
  });

  data.competiciones.forEach(comp => {
    if (!Array.isArray(comp.equipos)) comp.equipos = [];
    const removedSlots = new Set();
    comp.equipos = comp.equipos.filter(slot => {
      const club = clubsById.get(String(slot.clubId || "")) ||
        clubsByName.get(String(slot.clubNombre || slot.nombre || "").toLowerCase());
      if (!club) {
        if (slot.slotId) removedSlots.add(String(slot.slotId));
        return false;
      }
      slot.clubId = club.id;
      slot.clubNombre = club.nombre;
      slot.nombre = club.nombreVisual;
      slot.escudoUrl = club.escudoUrl || "";
      if (club.escudoPath) slot.escudoPath = club.escudoPath;
      if (club.escudoFilename) slot.escudoFilename = club.escudoFilename;
      slot.presupuesto = club.presupuesto;
      slot.actualizadoEn = now;
      return true;
    });

    if (removedSlots.size && Array.isArray(comp.partidos)) {
      comp.partidos = comp.partidos.filter(match => {
        const local = String(match.localSlotId || "");
        const away = String(match.visitanteSlotId || "");
        return !removedSlots.has(local) && !removedSlots.has(away);
      });
    }
    if (removedSlots.size && Array.isArray(comp.clasificacion)) {
      comp.clasificacion = comp.clasificacion.filter(row => !removedSlots.has(String(row.slotId || "")));
    }
    comp.actualizadoEn = now;
  });

  data.sync = {
    ...(data.sync || {}),
    version: Date.now(),
    source: "discord-bot",
    updatedAt: now
  };
  return data;
}

async function guardarEscudoLocal(attachment, clubName) {
  const remoteUrl = String(attachment?.url || attachment || "").trim();
  if (!remoteUrl) return { url: "", remoteUrl: "", path: "", filename: "" };

  try {
    fs.mkdirSync(PUBLIC_ESCUDOS_DIR, { recursive: true });
    const response = await fetch(remoteUrl, {
      headers: { "User-Agent": "ThunderEliteLeagueBot/1.0" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = String(response.headers.get("content-type") || attachment?.contentType || "").toLowerCase();
    let ext = path.extname(String(attachment?.name || "")).toLowerCase();
    if (!/[.](png|jpe?g|webp|gif)$/i.test(ext)) {
      if (contentType.includes("jpeg")) ext = ".jpg";
      else if (contentType.includes("webp")) ext = ".webp";
      else if (contentType.includes("gif")) ext = ".gif";
      else ext = ".png";
    }
    const filename = `escudo-${telSlug(clubName)}-${Date.now()}${ext}`;
    const diskPath = path.join(PUBLIC_ESCUDOS_DIR, filename);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(diskPath, buffer);
    return {
      url: `/escudos/${filename}`,
      remoteUrl,
      path: `public/escudos/${filename}`,
      filename,
      contentType: contentType || 'image/png',
      size: buffer.length,
      base64: buffer.length <= TEL_MAX_LOGO_BYTES ? buffer.toString('base64') : ''
    };
  } catch (error) {
    console.warn(`[web-sync] No se pudo guardar el escudo local de ${clubName}:`, error.message || error);
    return { url: remoteUrl, remoteUrl, path: "", filename: "", contentType: String(attachment?.contentType || "image/png"), size: 0, base64: "" };
  }
}

function guardarDatos(data) {
  const normalized = telNormalizarDatosParaWeb(data);
  const content = JSON.stringify(normalized, null, 2);
  fs.writeFileSync(DATA_FILE, content);
  telBotPersistData(content);
}

async function telPrepareBotStorage(){
  try{
    telBotPreSyncLocalData = cargarDatos();
    if(telBotRedis) await telBotRefreshFromRedis(true);
    telBotStorageReady = true;
    const preparedData = cargarDatos();
    guardarDatos(preparedData);
    await telBotPersistQueue;
    await telBotBackfillClubLogos(preparedData);
    if(telBotRedis){
      const timer = setInterval(()=>{
        telBotRefreshFromRedis(false).catch(error=>{
          console.warn('[bot-storage] No se pudo actualizar desde Upstash:', error.message || error);
        });
      }, 2500);
      timer.unref?.();
      console.log(`[bot-storage] Sincronización Upstash activa. Clave web: ${await telBotResolveDataRedisKey(true)}`);
    }
    console.log("[web-sync] Datos de Discord preparados para la web.");
  }catch(error){
    telBotStorageReady = true;
    console.warn("[web-sync] No se pudo preparar data.json al iniciar:", error.message || error);
  }
}

function limpiarHex(hex) {
  return hex.replace("#", "").trim();
}

function esHexValido(hex) {
  return /^[0-9A-Fa-f]{6}$/.test(limpiarHex(hex));
}

function crearNombreVisual(nombre, emoji) {
  const emojiLimpio = emoji ? emoji.trim() : "";
  return emojiLimpio ? `${emojiLimpio} ${nombre}` : nombre;
}

function buscarClub(data, nombre) {
  if (!nombre) return null;

  const busqueda = nombre.toLowerCase();

  return data.clubes.find(club => {
    const nombreBase = club.nombre?.toLowerCase() || "";
    const nombreVisual = club.nombreVisual?.toLowerCase() || "";
    return nombreBase === busqueda || nombreVisual === busqueda;
  });
}

function usuarioYaTieneClub(data, userId) {
  return data.jugadores.find(jugador => jugador.usuarioId === userId);
}

function esAdmin(interaction) {
  return interaction.member.permissions.has(PermissionFlagsBits.Administrator);
}

function esImagenValida(attachment) {
  if (!attachment) return false;

  if (attachment.contentType && attachment.contentType.startsWith("image/")) {
    return true;
  }

  const nombre = attachment.name || attachment.url || "";
  return /\.(png|jpg|jpeg|gif|webp)$/i.test(nombre);
}

async function obtenerRolObligatorio(guild, roleId) {
  if (!roleId) return null;
  return guild.roles.fetch(roleId).catch(() => null);
}

function formatearDinero(cantidad) {
  const numero = Number(cantidad) || 0;
  return `${numero.toLocaleString("es-ES")}€`;
}

function obtenerPresupuestoInicialClub() {
  const cantidad = Number(process.env.PRESUPUESTO_INICIAL_CLUB);
  if (Number.isNaN(cantidad) || cantidad < 0) return 0;
  return cantidad;
}

function asegurarEconomiaClub(club) {
  if (typeof club.presupuesto !== "number") club.presupuesto = 0;
  if (!Array.isArray(club.historialEconomia)) club.historialEconomia = [];
}

function calcularEconomiaClub(club) {
  asegurarEconomiaClub(club);

  let ingresos = 0;
  let gastos = 0;

  for (const movimiento of club.historialEconomia) {
    if (movimiento.tipo === "ingreso") ingresos += movimiento.cantidad;
    if (movimiento.tipo === "gasto") gastos += movimiento.cantidad;
  }

  return {
    presupuesto: club.presupuesto,
    ingresos,
    gastos,
    balance: ingresos - gastos
  };
}

function crearMovimientoEconomico(interaction, tipo, cantidad, motivo) {
  return {
    tipo,
    cantidad,
    motivo,
    usuarioId: interaction.user.id,
    usuarioTag: interaction.user.tag,
    fecha: new Date().toISOString()
  };
}

function crearCaseSancion(data) {
  if (!data.sanciones) data.sanciones = [];
  const numero = data.sanciones.length + 1;
  return `CASE-${numero.toString().padStart(4, "0")}`;
}

function esAgenteLibre(texto) {
  if (!texto) return false;

  const valor = texto.toLowerCase().trim();

  return (
    texto === AGENTE_LIBRE_VALUE ||
    valor === "agente libre" ||
    valor === "agente-libre" ||
    valor === "libre"
  );
}

function crearOpcionesAutocompleteClubes(data, textoBuscado, incluirAgenteLibre = false) {
  const busqueda = (textoBuscado || "").toLowerCase();
  const opciones = [];

  if (incluirAgenteLibre && "agente libre".includes(busqueda)) {
    opciones.push({
      name: "🟢 Agente Libre",
      value: AGENTE_LIBRE_VALUE
    });
  }

  const clubes = data.clubes
    .filter(club => {
      const nombreBase = club.nombre?.toLowerCase() || "";
      const nombreVisual = club.nombreVisual?.toLowerCase() || "";
      const nombreConEmoji = crearNombreVisual(club.nombre, club.emoji).toLowerCase();

      return (
        nombreBase.includes(busqueda) ||
        nombreVisual.includes(busqueda) ||
        nombreConEmoji.includes(busqueda)
      );
    })
    .slice(0, 25 - opciones.length)
    .map(club => {
      const nombreMostrado = club.nombreVisual || crearNombreVisual(club.nombre, club.emoji);

      return {
        name: nombreMostrado.slice(0, 100),
        value: club.nombre.slice(0, 100)
      };
    });

  return [...opciones, ...clubes].slice(0, 25);
}

function esDirectivaClub(userId, club) {
  if (!club) return false;
  if (club.presidenteId === userId) return true;
  return club.vicepresidentes?.some(vice => vice.id === userId) || false;
}

function puedeGestionarClub(interaction, club) {
  if (esAdmin(interaction)) return true;
  return esDirectivaClub(interaction.user.id, club);
}

function usuarioTieneRelacionConClub(data, clubNombre, userId) {
  const club = buscarClub(data, clubNombre);
  if (!club) return false;

  const esPresidente = club.presidenteId === userId;
  const esVicepresidente = club.vicepresidentes?.some(vice => vice.id === userId);
  const esJugador = data.jugadores.some(
    jugador =>
      jugador.usuarioId === userId &&
      jugador.club.toLowerCase() === club.nombre.toLowerCase()
  );

  return esPresidente || esVicepresidente || esJugador;
}

async function quitarRolClubSiNoPertenece(guild, data, clubNombre, rolId, userId) {
  if (!rolId) return;

  const sigueEnClub = usuarioTieneRelacionConClub(data, clubNombre, userId);
  if (sigueEnClub) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  await member.roles.remove(rolId).catch(() => null);
}

async function quitarRolSiNoLoUsaEnOtroClub(guild, data, userId, roleId, tipo) {
  if (!roleId) return;

  const sigueUsandoRol = data.clubes.some(club => {
    if (tipo === "presidente") return club.presidenteId === userId;
    if (tipo === "vicepresidente") return club.vicepresidentes?.some(vice => vice.id === userId);
    return false;
  });

  if (sigueUsandoRol) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  await member.roles.remove(roleId).catch(() => null);
}

async function quitarRolAgenteLibre(guild, userId) {
  const rolAgenteLibreId = process.env.ROL_AGENTE_LIBRE_ID;
  if (!rolAgenteLibreId) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  await member.roles.remove(rolAgenteLibreId).catch(() => null);
}

async function darRolAgenteLibre(guild, userId) {
  const rolAgenteLibreId = process.env.ROL_AGENTE_LIBRE_ID;
  if (!rolAgenteLibreId) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  await member.roles.add(rolAgenteLibreId).catch(() => null);
}

async function cambiarRolJugador(guild, userId, rolAnteriorId, rolNuevoId) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  if (rolAnteriorId) await member.roles.remove(rolAnteriorId).catch(() => null);
  if (rolNuevoId) await member.roles.add(rolNuevoId).catch(() => null);
}

async function enviarLogClubes(interaction, data, titulo, descripcion, color = 0x3498db) {
  const canalId = data.config?.logsClubesChannelId;
  if (!canalId) return;

  const canal = await interaction.guild.channels.fetch(canalId).catch(() => null);
  if (!canal || !canal.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setTitle(titulo)
    .setDescription(descripcion)
    .setColor(color)
    .setFooter({ text: `Acción realizada por ${interaction.user.tag}` })
    .setTimestamp();

  await canal.send({ embeds: [embed] }).catch(() => null);
}

function cortarTexto(ctx, texto, maxWidth, fontSizeInicial, fontFamily) {
  let fontSize = fontSizeInicial;

  do {
    ctx.font = `bold ${fontSize}px ${fontFamily}`;
    if (ctx.measureText(texto).width <= maxWidth) break;
    fontSize -= 2;
  } while (fontSize > 20);

  return fontSize;
}

async function generarImagenBienvenida(member) {
  const canvas = Canvas.createCanvas(1024, 500);
  const ctx = canvas.getContext("2d");

  const fondoPath = path.join(__dirname, "assets", "welcome-bg.png");
  const fondo = await Canvas.loadImage(fondoPath);

  ctx.drawImage(fondo, 0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const avatarURL = member.user.displayAvatarURL({
    extension: "png",
    size: 512
  });

  const avatar = await Canvas.loadImage(avatarURL);

  const avatarX = canvas.width / 2;
  const avatarY = 120;
  const avatarRadio = 82;

  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarX, avatarY, avatarRadio + 8, 0, Math.PI * 2, true);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.closePath();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarX, avatarY, avatarRadio, 0, Math.PI * 2, true);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(
    avatar,
    avatarX - avatarRadio,
    avatarY - avatarRadio,
    avatarRadio * 2,
    avatarRadio * 2
  );
  ctx.restore();

  ctx.textAlign = "center";

  ctx.font = "bold 76px Arial";
  ctx.fillStyle = "#ffffff";
  ctx.lineWidth = 8;
  ctx.strokeStyle = "#000000";
  ctx.strokeText("BIENVENID@", canvas.width / 2, 275);
  ctx.fillText("BIENVENID@", canvas.width / 2, 275);

  const nombreUsuario = member.user.username.toUpperCase();
  const fontSizeNombre = cortarTexto(ctx, nombreUsuario, 520, 38, "Arial");

  ctx.font = `bold ${fontSizeNombre}px Arial`;
  ctx.fillStyle = "#ffffff";
  ctx.lineWidth = 5;
  ctx.strokeStyle = "#000000";
  ctx.strokeText(nombreUsuario, canvas.width / 2, 325);
  ctx.fillText(nombreUsuario, canvas.width / 2, 325);

  ctx.font = "bold 30px Arial";
  ctx.fillStyle = "#ff2f86";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#000000";
  ctx.strokeText("¡A DEMOSTRAR!", canvas.width / 2, 365);
  ctx.fillText("¡A DEMOSTRAR!", canvas.width / 2, 365);

  return canvas.toBuffer("image/png");
}

function crearMensajeBienvenida(member) {
  return `! ⚡ ¡BIENVENID@ A **${member.guild.name}**! ⚡

¡Hola, ${member} ! Ya formas parte de la élite de Clubes Pro. Estamos encantados de tenerte con nosotros en esta nueva temporada.

Para empezar con buen pie, te recomendamos realizar los siguientes pasos:

**Normativa:** Lee nuestro reglamento en <#${CANAL_NORMATIVA_ID}> para que conozcas cómo funciona nuestra competición.

**Busca equipo:** Si eres agente libre, dirígete a <#${CANAL_AGENTE_LIBRE_ID}> para encontrar tu lugar en algún club.

Si tienes cualquier duda, no dudes en abrir un ticket o preguntar a la administración. ¡Mucha suerte y prepárate para brillar en el campo!`;
}

async function enviarBienvenida(member) {
  const data = cargarDatos();
  const canalId = data.config?.bienvenidasChannelId;
  if (!canalId) return;

  const canal = await member.guild.channels.fetch(canalId).catch(() => null);
  if (!canal || !canal.isTextBased()) return;

  const imagenBuffer = await generarImagenBienvenida(member);
  const attachment = new AttachmentBuilder(imagenBuffer, {
    name: "bienvenida.png"
  });

  await canal.send({
    content: crearMensajeBienvenida(member),
    files: [attachment]
  }).catch(error => {
    console.error("Error enviando bienvenida:", error);
  });
}

function obtenerCategoriaTicket(value) {
  return TICKET_CATEGORIAS.find(categoria => categoria.value === value);
}

function limpiarNombreCanal(texto) {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "usuario";
}

function crearPanelTickets() {
  const embed = new EmbedBuilder()
    .setTitle("🎫 Sistema de Tickets")
    .setDescription(
      "¿Necesitas ayuda?\n\nSelecciona una categoría en el menú de abajo y se abrirá un ticket privado para que el staff pueda atenderte."
    )
    .addFields({
      name: "Categorías disponibles",
      value:
        "❓ **Dudas**\n" +
        "➕ **+3**\n" +
        "🚨 **Reporte**\n" +
        "📝 **Postulación**\n" +
        "🤝 **Alianzas**\n" +
        "📌 **Otros**",
      inline: false
    })
    .setColor(0x5865f2)
    .setFooter({ text: "Selecciona una categoría para abrir tu ticket." });

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ticket_categoria")
    .setPlaceholder("Selecciona el tipo de ticket")
    .addOptions(
      TICKET_CATEGORIAS.map(categoria =>
        new StringSelectMenuOptionBuilder()
          .setLabel(categoria.label)
          .setValue(categoria.value)
          .setEmoji(categoria.emoji)
          .setDescription(categoria.descripcion)
      )
    );

  const row = new ActionRowBuilder().addComponents(menu);

  return {
    embeds: [embed],
    components: [row]
  };
}

function crearBotonesTicket() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_cerrar")
      .setLabel("Cerrar ticket")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Danger)
  );
}

function crearBotonesConfirmacionCierreTicket(canalId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_confirmar_cierre_${canalId}`)
      .setLabel("Confirmar cierre")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("ticket_cancelar_cierre")
      .setLabel("Cancelar")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Secondary)
  );
}

function usuarioPuedeGestionarTicket(interaction, ticket) {
  if (esAdmin(interaction)) return true;

  const staffRoleId = process.env.TICKETS_STAFF_ROLE_ID;

  const esStaff = staffRoleId
    ? interaction.member.roles.cache.has(staffRoleId)
    : false;

  const esCreador = ticket?.usuarioId === interaction.user.id;

  return esStaff || esCreador;
}

async function enviarLogTickets(guild, titulo, descripcion, color = 0x5865f2, files = []) {
  const logsChannelId = process.env.TICKETS_LOGS_CHANNEL_ID;

  if (!logsChannelId) return;

  const canal = await guild.channels.fetch(logsChannelId).catch(() => null);

  if (!canal || !canal.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setTitle(titulo)
    .setDescription(descripcion)
    .setColor(color)
    .setTimestamp();

  await canal.send({
    embeds: [embed],
    files
  }).catch(() => null);
}

async function generarTranscriptTicket(canal, ticket, cerradoPor) {
  let mensajes = [];
  let ultimoId = null;

  while (true) {
    const opciones = { limit: 100 };

    if (ultimoId) {
      opciones.before = ultimoId;
    }

    const fetched = await canal.messages.fetch(opciones).catch(() => null);

    if (!fetched || fetched.size === 0) break;

    mensajes.push(...fetched.values());
    ultimoId = fetched.last().id;

    if (fetched.size < 100) break;
  }

  mensajes = mensajes.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const lineas = [];

  lineas.push("========================================");
  lineas.push("TRANSCRIPT DEL TICKET");
  lineas.push("========================================");
  lineas.push(`Canal: #${canal.name}`);
  lineas.push(`ID canal: ${canal.id}`);
  lineas.push(`Usuario: ${ticket.usuarioTag} (${ticket.usuarioId})`);
  lineas.push(`Categoría: ${ticket.categoriaNombre || ticket.categoria}`);
  lineas.push(`Abierto en: ${ticket.abiertoEn}`);
  lineas.push(`Cerrado por: ${cerradoPor.tag} (${cerradoPor.id})`);
  lineas.push(`Cerrado en: ${new Date().toISOString()}`);
  lineas.push("========================================");
  lineas.push("");

  if (mensajes.length === 0) {
    lineas.push("No se encontraron mensajes en este ticket.");
  }

  for (const mensaje of mensajes) {
    const fecha = new Date(mensaje.createdTimestamp).toLocaleString("es-ES");
    const autor = `${mensaje.author.tag} (${mensaje.author.id})`;

    let contenido = mensaje.content || "";

    if (mensaje.embeds.length > 0) {
      contenido += contenido ? "\n" : "";
      contenido += `[${mensaje.embeds.length} embed(s)]`;
    }

    if (mensaje.attachments.size > 0) {
      const adjuntos = mensaje.attachments
        .map(attachment => `Archivo: ${attachment.name || "sin nombre"} | ${attachment.url}`)
        .join("\n");

      contenido += contenido ? "\n" : "";
      contenido += adjuntos;
    }

    if (!contenido.trim()) {
      contenido = "[Mensaje sin texto]";
    }

    lineas.push(`[${fecha}] ${autor}:`);
    lineas.push(contenido);
    lineas.push("");
  }

  const contenidoTranscript = lineas.join("\n");
  const buffer = Buffer.from(contenidoTranscript, "utf8");

  const nombreArchivo = `transcript-${canal.name}-${Date.now()}.txt`
    .toLowerCase()
    .replace(/[^a-z0-9-.]/g, "-")
    .replace(/-+/g, "-");

  return new AttachmentBuilder(buffer, {
    name: nombreArchivo
  });
}

async function abrirTicket(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const categoryId = process.env.TICKETS_CATEGORY_ID;
  const staffRoleId = process.env.TICKETS_STAFF_ROLE_ID;
  const logsChannelId = process.env.TICKETS_LOGS_CHANNEL_ID;

  if (!categoryId || !staffRoleId || !logsChannelId) {
    return interaction.editReply({
      content:
        "❌ Faltan variables en `.env`.\n\nNecesitas:\n" +
        "`TICKETS_CATEGORY_ID`\n" +
        "`TICKETS_STAFF_ROLE_ID`\n" +
        "`TICKETS_LOGS_CHANNEL_ID`"
    });
  }

  const categoriaValue = interaction.values[0];
  const categoria = obtenerCategoriaTicket(categoriaValue);

  if (!categoria) {
    return interaction.editReply({
      content: "❌ Esa categoría de ticket no existe."
    });
  }

  const data = cargarDatos();

  const ticketExistente = data.ticketsActivos.find(
    ticket => ticket.usuarioId === interaction.user.id
  );

  if (ticketExistente) {
    const canalExistente = await interaction.guild.channels
      .fetch(ticketExistente.canalId)
      .catch(() => null);

    if (canalExistente) {
      return interaction.editReply({
        content: `❌ Ya tienes un ticket abierto: ${canalExistente}`
      });
    }

    data.ticketsActivos = data.ticketsActivos.filter(
      ticket => ticket.usuarioId !== interaction.user.id
    );

    guardarDatos(data);
  }

  const categoriaDiscord = await interaction.guild.channels
    .fetch(categoryId)
    .catch(() => null);

  if (!categoriaDiscord || categoriaDiscord.type !== ChannelType.GuildCategory) {
    return interaction.editReply({
      content: "❌ La categoría configurada en `TICKETS_CATEGORY_ID` no existe o no es una categoría."
    });
  }

  const staffRole = await interaction.guild.roles
    .fetch(staffRoleId)
    .catch(() => null);

  if (!staffRole) {
    return interaction.editReply({
      content: "❌ El rol configurado en `TICKETS_STAFF_ROLE_ID` no existe."
    });
  }

  const nombreUsuario = limpiarNombreCanal(interaction.user.username);
  const nombreCanal = `ticket-${categoria.value}-${nombreUsuario}`.slice(0, 90);

  const canalTicket = await interaction.guild.channels.create({
    name: nombreCanal,
    type: ChannelType.GuildText,
    parent: categoryId,
    topic: `Ticket de ${interaction.user.tag} | ID: ${interaction.user.id} | Categoría: ${categoria.label}`,
    permissionOverwrites: [
      {
        id: interaction.guild.id,
        deny: [PermissionFlagsBits.ViewChannel]
      },
      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks
        ]
      },
      {
        id: staffRoleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageMessages
        ]
      },
      {
        id: interaction.client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks
        ]
      }
    ]
  });

  const ticketData = {
    usuarioId: interaction.user.id,
    usuarioTag: interaction.user.tag,
    canalId: canalTicket.id,
    categoria: categoria.value,
    categoriaNombre: categoria.label,
    abiertoEn: new Date().toISOString()
  };

  data.ticketsActivos.push(ticketData);
  guardarDatos(data);

  const embedTicket = new EmbedBuilder()
    .setTitle(`${categoria.emoji} Ticket abierto`)
    .setDescription(
      `Hola ${interaction.user}, explica tu caso con detalle.\n\nUn miembro del staff te atenderá lo antes posible.`
    )
    .addFields(
      { name: "Usuario", value: `${interaction.user}`, inline: true },
      { name: "Categoría", value: `${categoria.emoji} ${categoria.label}`, inline: true },
      { name: "Staff", value: `<@&${staffRoleId}>`, inline: true }
    )
    .setColor(0x5865f2)
    .setTimestamp();

  await canalTicket.send({
    content: `${interaction.user} <@&${staffRoleId}>`,
    embeds: [embedTicket],
    components: [crearBotonesTicket()]
  });

  await enviarLogTickets(
    interaction.guild,
    "🎫 Ticket abierto",
    `Usuario: ${interaction.user}\nCategoría: **${categoria.label}**\nCanal: ${canalTicket}`,
    0x2ecc71
  );

  return interaction.editReply({
    content: `✅ Ticket creado correctamente: ${canalTicket}`
  });
}

async function solicitarCerrarTicket(interaction) {
  const data = cargarDatos();

  const ticket = data.ticketsActivos.find(
    ticket => ticket.canalId === interaction.channelId
  );

  if (!ticket) {
    return interaction.reply({
      content: "❌ Este canal no parece ser un ticket activo.",
      ephemeral: true
    });
  }

  if (!usuarioPuedeGestionarTicket(interaction, ticket)) {
    return interaction.reply({
      content: "❌ No puedes cerrar este ticket.",
      ephemeral: true
    });
  }

  const embed = new EmbedBuilder()
    .setTitle("🔒 Cerrar ticket")
    .setDescription("¿Seguro que quieres cerrar este ticket?")
    .setColor(0xe74c3c);

  return interaction.reply({
    embeds: [embed],
    components: [crearBotonesConfirmacionCierreTicket(interaction.channelId)],
    ephemeral: true
  });
}

async function confirmarCerrarTicket(interaction) {
  const canalId = interaction.customId.replace("ticket_confirmar_cierre_", "");
  const data = cargarDatos();

  const ticket = data.ticketsActivos.find(
    ticket => ticket.canalId === canalId
  );

  if (!ticket) {
    return interaction.update({
      content: "❌ Este ticket ya no está activo.",
      embeds: [],
      components: []
    });
  }

  if (!usuarioPuedeGestionarTicket(interaction, ticket)) {
    return interaction.update({
      content: "❌ No puedes cerrar este ticket.",
      embeds: [],
      components: []
    });
  }

  const transcript = await generarTranscriptTicket(
    interaction.channel,
    ticket,
    interaction.user
  );

  data.ticketsActivos = data.ticketsActivos.filter(
    ticketActivo => ticketActivo.canalId !== canalId
  );

  guardarDatos(data);

  await interaction.update({
    content: "✅ Ticket cerrado. El canal se eliminará en 5 segundos.",
    embeds: [],
    components: []
  });

  await interaction.channel.send({
    content: `🔒 Ticket cerrado por ${interaction.user}. Este canal se eliminará en 5 segundos.`
  }).catch(() => null);

  await enviarLogTickets(
    interaction.guild,
    "🔒 Ticket cerrado",
    `Usuario: <@${ticket.usuarioId}>\nCategoría: **${ticket.categoriaNombre || ticket.categoria}**\nCerrado por: ${interaction.user}\nCanal: **${interaction.channel.name}**\n\n📄 Transcript adjuntado en este mensaje.`,
    0xe74c3c,
    [transcript]
  );

  setTimeout(() => {
    interaction.channel.delete(`Ticket cerrado por ${interaction.user.tag}`)
      .catch(() => null);
  }, 5000);
}

async function cancelarCerrarTicket(interaction) {
  return interaction.update({
    content: "❌ Cierre cancelado.",
    embeds: [],
    components: []
  });
}

function crearIdFichaje(data) {
  const numero = (data.mercado?.length || 0) + 1;
  const random = Math.floor(Math.random() * 999).toString().padStart(3, "0");
  return `F-${numero}-${random}`;
}

function buscarOferta(data, ofertaId) {
  return data.mercado.find(oferta => oferta.id === ofertaId);
}

function crearBotonesOferta(oferta, desactivados = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`fichaje_aceptar_${oferta.id}`)
      .setLabel("Aceptar oferta")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(desactivados),
    new ButtonBuilder()
      .setCustomId(`fichaje_rechazar_${oferta.id}`)
      .setLabel("Rechazar oferta")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(desactivados)
  );
}

function crearEmbedOfertaFichaje(oferta, data) {
  const clubProcedente = buscarClub(data, oferta.clubProcedente);
  const clubDestino = buscarClub(data, oferta.clubDestino);

  const estadoTexto =
    oferta.estado === "aceptada" ? "✅ Aceptada" :
    oferta.estado === "rechazada" ? "❌ Rechazada" :
    "⏳ Pendiente";

  const color =
    oferta.estado === "aceptada" ? 0x2ecc71 :
    oferta.estado === "rechazada" ? 0xe74c3c :
    0xf1c40f;

  const nombreProcedente = clubProcedente?.nombreVisual || oferta.clubProcedente;
  const nombreDestino = clubDestino?.nombreVisual || oferta.clubDestino;

  const embed = new EmbedBuilder()
    .setTitle("📩 Oferta de fichaje")
    .setDescription(`Oferta **${oferta.id}**`)
    .addFields(
      { name: "Jugador", value: `<@${oferta.jugadorId}>`, inline: true },
      { name: "Club procedente", value: nombreProcedente, inline: true },
      { name: "Club destino", value: nombreDestino, inline: true },
      { name: "Precio", value: formatearDinero(oferta.precio), inline: true },
      { name: "Estado", value: estadoTexto, inline: true },
      { name: "Creada por", value: `<@${oferta.creadaPorId}>`, inline: true }
    )
    .setColor(color)
    .setTimestamp(new Date(oferta.fecha));

  if (oferta.estado === "pendiente") {
    embed.addFields({
      name: "Quién puede responder",
      value: `Solo presidente o vicepresidentes de **${nombreProcedente}**.`,
      inline: false
    });
  }

  if (oferta.estado === "aceptada") {
    embed.addFields({
      name: "Aceptada por",
      value: oferta.resueltaPorId ? `<@${oferta.resueltaPorId}>` : "No guardado",
      inline: false
    });
  }

  if (oferta.estado === "rechazada") {
    embed.addFields({
      name: "Rechazada por",
      value: oferta.resueltaPorId ? `<@${oferta.resueltaPorId}>` : "No guardado",
      inline: false
    });
  }

  return embed;
}

async function completarFichajeAgenteLibre(interaction, data, jugador, clubDestino, precio, idEaPsn = "") {
  asegurarEconomiaClub(clubDestino);

  const jugadorActual = usuarioYaTieneClub(data, jugador.id);

  if (jugadorActual) {
    return interaction.editReply({
      content: `❌ Ese jugador ya está registrado en **${jugadorActual.club}**.`
    });
  }

  if (clubDestino.presupuesto < precio) {
    return interaction.editReply({
      content: `❌ **${clubDestino.nombreVisual || clubDestino.nombre}** no tiene suficiente presupuesto. Tiene **${formatearDinero(clubDestino.presupuesto)}**.`
    });
  }

  clubDestino.presupuesto -= precio;

  if (precio > 0) {
    clubDestino.historialEconomia.push(
      crearMovimientoEconomico(
        interaction,
        "gasto",
        precio,
        `Fichaje de agente libre: ${jugador.tag}`
      )
    );
  }

  data.jugadores.push(crearRegistroJugadorWeb(jugador, clubDestino, interaction, {
    idEaPsn
  }));

  guardarDatos(data);

  await quitarRolAgenteLibre(interaction.guild, jugador.id);
  await cambiarRolJugador(interaction.guild, jugador.id, null, clubDestino.rolId);

  const nombreDestino = clubDestino.nombreVisual || crearNombreVisual(clubDestino.nombre, clubDestino.emoji);

  const embed = new EmbedBuilder()
    .setTitle("✅ Fichaje completado")
    .setDescription(`<@${jugador.id}> ha fichado por **${nombreDestino}**.`)
    .addFields(
      { name: "Procedencia", value: "🟢 Agente Libre", inline: true },
      { name: "Precio", value: formatearDinero(precio), inline: true },
      { name: "Presupuesto actual", value: formatearDinero(clubDestino.presupuesto), inline: true }
    )
    .setThumbnail(telDiscordImageUrl(clubDestino.escudoDiscordUrl, clubDestino.escudoUrl))
    .setColor(0x2ecc71);

  await enviarLogClubes(
    interaction,
    data,
    "✅ Fichaje de agente libre",
    `Jugador: <@${jugador.id}>\nClub destino: **${nombreDestino}**\nPrecio: **${formatearDinero(precio)}**`,
    0x2ecc71
  );

  return interaction.editReply({ embeds: [embed] });
}

async function aceptarOfertaFichaje(interaction, data, oferta) {
  const clubProcedente = buscarClub(data, oferta.clubProcedente);
  const clubDestino = buscarClub(data, oferta.clubDestino);

  if (!clubProcedente || !clubDestino) {
    oferta.estado = "rechazada";
    oferta.resueltaPorId = interaction.user.id;
    oferta.resueltaPorTag = interaction.user.tag;
    oferta.resueltaEn = new Date().toISOString();
    oferta.motivo = "Club procedente o destino no encontrado";

    guardarDatos(data);

    return interaction.update({
      embeds: [crearEmbedOfertaFichaje(oferta, data)],
      components: [crearBotonesOferta(oferta, true)]
    });
  }

  if (!esDirectivaClub(interaction.user.id, clubProcedente)) {
    return interaction.reply({
      content: "❌ No puedes responder a esta oferta. Solo puede hacerlo el presidente o vicepresidente del club procedente.",
      ephemeral: true
    });
  }

  asegurarEconomiaClub(clubProcedente);
  asegurarEconomiaClub(clubDestino);

  const jugadorActual = usuarioYaTieneClub(data, oferta.jugadorId);

  if (!jugadorActual || jugadorActual.club.toLowerCase() !== clubProcedente.nombre.toLowerCase()) {
    return interaction.reply({
      content: "❌ No se puede aceptar. El jugador ya no pertenece al club procedente.",
      ephemeral: true
    });
  }

  if (esDirectivaClub(oferta.jugadorId, clubProcedente)) {
    return interaction.reply({
      content: "❌ No se puede aceptar. Ese jugador es presidente o vicepresidente del club procedente.",
      ephemeral: true
    });
  }

  if (clubDestino.presupuesto < oferta.precio) {
    return interaction.reply({
      content: `❌ No se puede aceptar. El club destino no tiene suficiente presupuesto. Tiene **${formatearDinero(clubDestino.presupuesto)}**.`,
      ephemeral: true
    });
  }

  clubDestino.presupuesto -= oferta.precio;
  clubProcedente.presupuesto += oferta.precio;

  clubDestino.historialEconomia.push(
    crearMovimientoEconomico(
      interaction,
      "gasto",
      oferta.precio,
      `Fichaje de ${oferta.jugadorTag} desde ${clubProcedente.nombre}`
    )
  );

  clubProcedente.historialEconomia.push(
    crearMovimientoEconomico(
      interaction,
      "ingreso",
      oferta.precio,
      `Venta de ${oferta.jugadorTag} a ${clubDestino.nombre}`
    )
  );

  jugadorActual.club = clubDestino.nombre;
  jugadorActual.clubNombre = clubDestino.nombre;
  jugadorActual.clubId = telClubStableId(clubDestino);
  if (oferta.idEaPsn) {
    jugadorActual.idEaPsn = oferta.idEaPsn;
    jugadorActual.eaPsnId = oferta.idEaPsn;
  }
  jugadorActual.actualizadoEn = new Date().toISOString();

  oferta.estado = "aceptada";
  oferta.resueltaPorId = interaction.user.id;
  oferta.resueltaPorTag = interaction.user.tag;
  oferta.resueltaEn = new Date().toISOString();

  guardarDatos(data);

  await cambiarRolJugador(interaction.guild, oferta.jugadorId, clubProcedente.rolId, clubDestino.rolId);

  await interaction.update({
    embeds: [crearEmbedOfertaFichaje(oferta, data)],
    components: [crearBotonesOferta(oferta, true)]
  });

  await enviarLogClubes(
    interaction,
    data,
    "✅ Fichaje aceptado",
    `Jugador: <@${oferta.jugadorId}>\nDe: **${clubProcedente.nombreVisual || clubProcedente.nombre}**\nA: **${clubDestino.nombreVisual || clubDestino.nombre}**\nPrecio: **${formatearDinero(oferta.precio)}**\nAceptado por: <@${interaction.user.id}>`,
    0x2ecc71
  );
}

async function rechazarOfertaFichaje(interaction, data, oferta) {
  const clubProcedente = buscarClub(data, oferta.clubProcedente);

  if (!clubProcedente) {
    return interaction.reply({
      content: "❌ No se puede rechazar. El club procedente ya no existe.",
      ephemeral: true
    });
  }

  if (!esDirectivaClub(interaction.user.id, clubProcedente)) {
    return interaction.reply({
      content: "❌ No puedes responder a esta oferta. Solo puede hacerlo el presidente o vicepresidente del club procedente.",
      ephemeral: true
    });
  }

  oferta.estado = "rechazada";
  oferta.resueltaPorId = interaction.user.id;
  oferta.resueltaPorTag = interaction.user.tag;
  oferta.resueltaEn = new Date().toISOString();

  guardarDatos(data);

  await interaction.update({
    embeds: [crearEmbedOfertaFichaje(oferta, data)],
    components: [crearBotonesOferta(oferta, true)]
  });

  await enviarLogClubes(
    interaction,
    data,
    "❌ Fichaje rechazado",
    `Oferta: **${oferta.id}**\nJugador: <@${oferta.jugadorId}>\nRechazado por: <@${interaction.user.id}>`,
    0xe74c3c
  );
}

client.once("ready", async () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);
  try{
    await telBotRecoverRecentLocalClubs();
  }catch(error){
    console.warn('[bot-storage] No se pudieron recuperar clubes locales recientes:', error.message || error);
  }
});

client.on("guildMemberAdd", async member => {
  try {
    await enviarBienvenida(member);
  } catch (error) {
    console.error("Error en guildMemberAdd:", error);
  }
});

client.on("interactionCreate", async interaction => {
  if (interaction.isAutocomplete()) {
    try {
      const data = cargarDatos();
      const focused = interaction.options.getFocused(true);
      const incluirAgenteLibre = focused.name === "club_procedente";
      const opciones = crearOpcionesAutocompleteClubes(data, focused.value || "", incluirAgenteLibre);

      return interaction.respond(opciones).catch(() => null);
    } catch (error) {
      console.error(error);
      return interaction.respond([]).catch(() => null);
    }
  }

  if (interaction.isStringSelectMenu()) {
    try {
      if (interaction.customId === "ticket_categoria") {
        return abrirTicket(interaction);
      }
    } catch (error) {
      console.error(error);

      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({
          content: "❌ Ha ocurrido un error al abrir el ticket.",
          ephemeral: true
        }).catch(() => null);
      }

      return interaction.editReply({
        content: "❌ Ha ocurrido un error al abrir el ticket."
      }).catch(() => null);
    }
  }

  if (interaction.isButton()) {
    try {
      if (interaction.customId.startsWith("ticket_")) {
        if (interaction.customId === "ticket_cerrar") {
          return solicitarCerrarTicket(interaction);
        }

        if (interaction.customId.startsWith("ticket_confirmar_cierre_")) {
          return confirmarCerrarTicket(interaction);
        }

        if (interaction.customId === "ticket_cancelar_cierre") {
          return cancelarCerrarTicket(interaction);
        }

        return;
      }

      if (!interaction.customId.startsWith("fichaje_")) return;

      const data = cargarDatos();
      const partes = interaction.customId.split("_");
      const accion = partes[1];
      const ofertaId = partes.slice(2).join("_");
      const oferta = buscarOferta(data, ofertaId);

      if (!oferta) {
        return interaction.reply({
          content: "❌ No he encontrado esta oferta.",
          ephemeral: true
        });
      }

      if (oferta.estado !== "pendiente") {
        return interaction.reply({
          content: "❌ Esta oferta ya no está pendiente.",
          ephemeral: true
        });
      }

      if (accion === "aceptar") return aceptarOfertaFichaje(interaction, data, oferta);
      if (accion === "rechazar") return rechazarOfertaFichaje(interaction, data, oferta);
    } catch (error) {
      console.error(error);

      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({
          content: "❌ Ha ocurrido un error con el botón.",
          ephemeral: true
        }).catch(() => null);
      }
    }
  }

  if (!interaction.isChatInputCommand()) return;

  telInstallSafeInteractionResponses(interaction);

  try {
    await interaction.deferReply();
    const data = cargarDatos();

    if (interaction.commandName === "warn") {
      if (!esAdmin(interaction)) {
        return interaction.editReply({
          content: "❌ Solo los administradores pueden sancionar usuarios."
        });
      }

      const usuario = interaction.options.getUser("usuario");
      const motivo = interaction.options.getString("motivo");

      if (!data.sanciones) data.sanciones = [];

      const registroJugador = data.jugadores.find(
        jugador => jugador.usuarioId === usuario.id
      );

      let club = null;
      let nombreClub = "No pertenece a ningún club";

      if (registroJugador) {
        club = buscarClub(data, registroJugador.club);

        if (club) {
          nombreClub = club.nombreVisual || crearNombreVisual(club.nombre, club.emoji);
        } else {
          nombreClub = registroJugador.club;
        }
      }

      const caseId = crearCaseSancion(data);

      const sancion = {
        caseId,
        tipo: "warn",
        usuarioId: usuario.id,
        usuarioTag: usuario.tag,
        club: club ? club.nombre : null,
        clubNombre: nombreClub,
        motivo,
        sancionadoPorId: interaction.user.id,
        sancionadoPorTag: interaction.user.tag,
        fecha: new Date().toISOString()
      };

      data.sanciones.push(sancion);
      guardarDatos(data);

      const embed = new EmbedBuilder()
        .setTitle("⚠️ Usuario sancionado")
        .setDescription(`${usuario} ha recibido una sanción.`)
        .addFields(
          {
            name: "Case",
            value: `\`${caseId}\``,
            inline: true
          },
          {
            name: "Usuario",
            value: `${usuario}`,
            inline: true
          },
          {
            name: "Club",
            value: nombreClub,
            inline: true
          },
          {
            name: "Motivo",
            value: motivo,
            inline: false
          },
          {
            name: "Sancionado por",
            value: `<@${interaction.user.id}>`,
            inline: true
          }
        )
        .setColor(0xe74c3c)
        .setTimestamp();

      if (club?.escudoUrl) {
        embed.setThumbnail(telDiscordImageUrl(club.escudoDiscordUrl, club.escudoUrl));
      } else {
        embed.setThumbnail(usuario.displayAvatarURL({ size: 256 }));
      }

      await enviarLogClubes(
        interaction,
        data,
        "⚠️ Usuario sancionado",
        `Case: **${caseId}**\nUsuario: ${usuario}\nClub: **${nombreClub}**\nMotivo: ${motivo}\nSancionado por: <@${interaction.user.id}>`,
        0xe74c3c
      );

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "historial-sanciones") {
      const usuario = interaction.options.getUser("usuario");

      if (!data.sanciones) data.sanciones = [];

      const sancionesUsuario = data.sanciones
        .filter(sancion => sancion.usuarioId === usuario.id)
        .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

      if (sancionesUsuario.length === 0) {
        const embed = new EmbedBuilder()
          .setTitle("📋 Historial de sanciones")
          .setDescription(`${usuario} no tiene sanciones registradas.`)
          .setThumbnail(usuario.displayAvatarURL({ size: 256 }))
          .setColor(0x2ecc71);

        return interaction.editReply({ embeds: [embed] });
      }

      const texto = sancionesUsuario
        .slice(0, 15)
        .map(sancion => {
          const fecha = new Date(sancion.fecha).toLocaleDateString("es-ES");
          const clubTexto = sancion.clubNombre || sancion.club || "Sin club";

          return `**${sancion.caseId || "CASE-SIN-ID"}**\n` +
            `📌 Motivo: ${sancion.motivo}\n` +
            `🏟️ Club: ${clubTexto}\n` +
            `👮 Staff: <@${sancion.sancionadoPorId}>\n` +
            `📅 Fecha: ${fecha}`;
        })
        .join("\n\n");

      const embed = new EmbedBuilder()
        .setTitle("📋 Historial de sanciones")
        .setDescription(texto.slice(0, 4000))
        .addFields(
          {
            name: "Usuario",
            value: `${usuario}`,
            inline: true
          },
          {
            name: "Total de sanciones",
            value: `${sancionesUsuario.length}`,
            inline: true
          }
        )
        .setThumbnail(usuario.displayAvatarURL({ size: 256 }))
        .setColor(0xf1c40f)
        .setFooter({
          text: "Mostrando las últimas 15 sanciones."
        });

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "crear-club") {
      if (!esAdmin(interaction)) {
        return interaction.editReply({ content: "❌ Solo los administradores pueden crear clubes." });
      }

      const botMember = await interaction.guild.members.fetchMe();

      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return interaction.editReply({ content: "❌ No tengo permiso de **Gestionar roles**. Actívalo en los permisos del bot." });
      }

      const nombre = interaction.options.getString("nombre");
      const presidente = interaction.options.getUser("presidente");
      const colorHexInput = interaction.options.getString("color_hex");
      const escudo = interaction.options.getAttachment("escudo");
      const emoji = interaction.options.getString("emoji") || "";
      const nombreVisual = crearNombreVisual(nombre, emoji);
      const vicepresidente1 = interaction.options.getUser("vicepresidente_1");
      const vicepresidente2 = interaction.options.getUser("vicepresidente_2");
      const vicepresidente3 = interaction.options.getUser("vicepresidente_3");

      if (buscarClub(data, nombre)) {
        return interaction.editReply({ content: "❌ Ya existe un club con ese nombre." });
      }

      if (!esHexValido(colorHexInput)) {
        return interaction.editReply({ content: "❌ El color HEX no es válido. Usa un formato como `#ff0000` o `ff0000`." });
      }

      if (!esImagenValida(escudo)) {
        return interaction.editReply({ content: "❌ El escudo debe ser una imagen: PNG, JPG, JPEG, GIF o WEBP." });
      }

      const rolPresidente = await obtenerRolObligatorio(interaction.guild, process.env.ROL_PRESIDENTE_ID);
      const rolVicepresidente = await obtenerRolObligatorio(interaction.guild, process.env.ROL_VICEPRESIDENTE_ID);

      if (!rolPresidente) {
        return interaction.editReply({ content: "❌ No he encontrado el rol de Presidente. Revisa `ROL_PRESIDENTE_ID` en `.env`." });
      }

      if (!rolVicepresidente) {
        return interaction.editReply({ content: "❌ No he encontrado el rol de Vicepresidente. Revisa `ROL_VICEPRESIDENTE_ID` en `.env`." });
      }

      if (!rolPresidente.editable || !rolVicepresidente.editable) {
        return interaction.editReply({ content: "❌ No puedo asignar el rol de Presidente o Vicepresidente. Pon el rol del bot por encima de esos roles." });
      }

      const vicepresidentes = [vicepresidente1, vicepresidente2, vicepresidente3]
        .filter(Boolean)
        .filter(user => user.id !== presidente.id);

      const vicepresidentesUnicos = [
        ...new Map(vicepresidentes.map(user => [user.id, user])).values()
      ];

      const directivaParaPlantilla = [presidente, ...vicepresidentesUnicos];

      const directivaYaRegistrada = directivaParaPlantilla
        .map(user => ({ user, registro: usuarioYaTieneClub(data, user.id) }))
        .filter(item => item.registro);

      if (directivaYaRegistrada.length > 0) {
        const texto = directivaYaRegistrada
          .map(item => `<@${item.user.id}> ya está registrado en **${item.registro.club}**`)
          .join("\n");

        return interaction.editReply({
          content: `❌ No puedo crear el club porque parte de la directiva ya está inscrita como jugador:\n\n${texto}`
        });
      }

      const colorFinal = `#${limpiarHex(colorHexInput)}`;
      const presupuestoInicial = obtenerPresupuestoInicialClub();
      const escudoGuardado = await guardarEscudoLocal(escudo, nombre);

      const rolClub = await interaction.guild.roles.create({
        name: nombreVisual,
        color: colorFinal,
        reason: `Rol creado automáticamente para el club ${nombreVisual}`
      });

      const presidenteMember = await interaction.guild.members.fetch(presidente.id).catch(() => null);

      if (presidenteMember) {
        await presidenteMember.roles.add(rolClub).catch(() => null);
        await presidenteMember.roles.add(rolPresidente).catch(() => null);
        await quitarRolAgenteLibre(interaction.guild, presidente.id);
      }

      for (const vicepresidente of vicepresidentesUnicos) {
        const member = await interaction.guild.members.fetch(vicepresidente.id).catch(() => null);

        if (member) {
          await member.roles.add(rolClub).catch(() => null);
          await member.roles.add(rolVicepresidente).catch(() => null);
          await quitarRolAgenteLibre(interaction.guild, vicepresidente.id);
        }
      }

      data.clubes.push({
        id: `CLUB-${rolClub.id}`,
        nombre,
        nombreVisual,
        emoji,
        presupuesto: presupuestoInicial,
        historialEconomia: [
          crearMovimientoEconomico(interaction, "ajuste", presupuestoInicial, "Presupuesto inicial del club")
        ],
        presidenteId: presidente.id,
        presidenteTag: presidente.tag,
        vicepresidentes: vicepresidentesUnicos.map(user => ({ id: user.id, tag: user.tag })),
        rolId: rolClub.id,
        rolPresidenteId: rolPresidente.id,
        rolVicepresidenteId: rolVicepresidente.id,
        colorHex: colorFinal,
        escudoUrl: escudoGuardado.url || escudo.url,
        escudoDiscordUrl: escudo.url,
        escudoPath: escudoGuardado.path || "",
        escudoFilename: escudoGuardado.filename || "",
        creadoPorId: interaction.user.id,
        creadoPorTag: interaction.user.tag,
        creadoEn: new Date().toISOString()
      });

      const clubCreado = data.clubes[data.clubes.length - 1];
      await telBotPersistClubLogo(clubCreado.id, escudoGuardado);
      for (const usuarioDirectiva of directivaParaPlantilla) {
        data.jugadores.push(crearRegistroJugadorWeb(usuarioDirectiva, clubCreado, interaction, {
          agregadoComoDirectiva: true
        }));
      }

      guardarDatos(data);

      const vicepresidentesTexto = vicepresidentesUnicos.length > 0
        ? vicepresidentesUnicos.map(user => `<@${user.id}>`).join("\n")
        : "Sin vicepresidentes";

      const embed = new EmbedBuilder()
        .setTitle("🏟️ Club creado")
        .setDescription(`Se ha creado correctamente el club **${nombreVisual}**.`)
        .addFields(
          { name: "Presidente", value: `<@${presidente.id}>`, inline: true },
          { name: "Rol del club", value: `<@&${rolClub.id}>`, inline: true },
          { name: "Color", value: colorFinal, inline: true },
          { name: "Presupuesto inicial", value: formatearDinero(presupuestoInicial), inline: true },
          { name: "Rol presidente", value: `<@&${rolPresidente.id}>`, inline: true },
          { name: "Rol vicepresidente", value: `<@&${rolVicepresidente.id}>`, inline: true },
          { name: "Vicepresidentes", value: vicepresidentesTexto, inline: false },
          { name: "Directiva añadida a plantilla", value: `${directivaParaPlantilla.length}`, inline: true }
        )
        .setThumbnail(telDiscordImageUrl(clubCreado.escudoDiscordUrl, escudo.url, clubCreado.escudoUrl))
        .setColor(colorFinal);

      await enviarLogClubes(
        interaction,
        data,
        "🏟️ Club creado",
        `Se ha creado el club **${nombreVisual}**.\nPresidente: <@${presidente.id}>\nRol: <@&${rolClub.id}>\nPresupuesto inicial: **${formatearDinero(presupuestoInicial)}**`,
        0x2ecc71
      );

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "borrar-club") {
      if (!esAdmin(interaction)) {
        return interaction.editReply({ content: "❌ Solo los administradores pueden borrar clubes." });
      }

      const nombreClub = interaction.options.getString("club");
      const club = buscarClub(data, nombreClub);

      if (!club) {
        return interaction.editReply({ content: "❌ No he encontrado ese club." });
      }

      const jugadoresDelClub = data.jugadores.filter(
        jugador => jugador.club.toLowerCase() === club.nombre.toLowerCase()
      );

      const jugadoresBorrados = jugadoresDelClub.length;

      data.clubes = data.clubes.filter(c => c.nombre.toLowerCase() !== club.nombre.toLowerCase());
      data.jugadores = data.jugadores.filter(jugador => jugador.club.toLowerCase() !== club.nombre.toLowerCase());
      data.mercado = data.mercado.filter(
        oferta =>
          oferta.clubProcedente.toLowerCase() !== club.nombre.toLowerCase() &&
          oferta.clubDestino.toLowerCase() !== club.nombre.toLowerCase()
      );

      guardarDatos(data);

      const directivaIds = [
        club.presidenteId,
        ...(club.vicepresidentes || []).map(vice => vice.id)
      ].filter(Boolean);

      const usuariosUnicosAfectados = [
        ...new Set([
          ...jugadoresDelClub.map(jugador => jugador.usuarioId),
          ...directivaIds
        ].filter(Boolean))
      ];

      for (const userId of usuariosUnicosAfectados) {
        const member = await interaction.guild.members.fetch(userId).catch(() => null);

        if (member && club.rolId) {
          await member.roles.remove(club.rolId).catch(() => null);
        }

        await darRolAgenteLibre(interaction.guild, userId);
      }

      if (club.presidenteId && club.rolPresidenteId) {
        await quitarRolSiNoLoUsaEnOtroClub(interaction.guild, data, club.presidenteId, club.rolPresidenteId, "presidente");
      }

      if (club.vicepresidentes?.length && club.rolVicepresidenteId) {
        for (const vicepresidente of club.vicepresidentes) {
          await quitarRolSiNoLoUsaEnOtroClub(interaction.guild, data, vicepresidente.id, club.rolVicepresidenteId, "vicepresidente");
        }
      }

      let rolTexto = "No se ha podido borrar el rol o no existía.";

      if (club.rolId) {
        const rol = await interaction.guild.roles.fetch(club.rolId).catch(() => null);

        if (rol) {
          await rol.delete(`Club ${club.nombreVisual || club.nombre} eliminado por ${interaction.user.tag}`)
            .then(() => {
              rolTexto = "Rol del club borrado correctamente.";
            })
            .catch(() => {
              rolTexto = "Club borrado, pero no pude borrar el rol. Revisa que mi rol esté por encima.";
            });
        }
      }

      const embed = new EmbedBuilder()
        .setTitle("🗑️ Club borrado")
        .setDescription(`El club **${club.nombreVisual || club.nombre}** ha sido eliminado.`)
        .addFields(
          { name: "Jugadores eliminados de la plantilla", value: `${jugadoresBorrados}`, inline: true },
          { name: "Usuarios enviados a agente libre", value: `${usuariosUnicosAfectados.length}`, inline: true },
          { name: "Rol", value: rolTexto, inline: false }
        )
        .setColor(0xe74c3c);

      await enviarLogClubes(
        interaction,
        data,
        "🗑️ Club borrado",
        `Se ha borrado el club **${club.nombreVisual || club.nombre}**.\nUsuarios enviados a agente libre: **${usuariosUnicosAfectados.length}**`,
        0xe74c3c
      );

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "editar-club") {
      if (!esAdmin(interaction)) {
        return interaction.editReply({ content: "❌ Solo los administradores pueden editar clubes." });
      }

      const nombreClub = interaction.options.getString("club");
      const nuevoNombre = interaction.options.getString("nuevo_nombre");
      const colorHexInput = interaction.options.getString("color_hex");
      const escudo = interaction.options.getAttachment("escudo");
      const club = buscarClub(data, nombreClub);

      if (!club) {
        return interaction.editReply({ content: "❌ No he encontrado ese club." });
      }

      if (!nuevoNombre && !colorHexInput && !escudo) {
        return interaction.editReply({ content: "❌ Debes indicar al menos un cambio: nuevo nombre, color o escudo." });
      }

      if (nuevoNombre && nuevoNombre.toLowerCase() !== club.nombre.toLowerCase() && buscarClub(data, nuevoNombre)) {
        return interaction.editReply({ content: "❌ Ya existe otro club con ese nombre." });
      }

      if (colorHexInput && !esHexValido(colorHexInput)) {
        return interaction.editReply({ content: "❌ El color HEX no es válido. Usa un formato como `#ff0000` o `ff0000`." });
      }

      if (escudo && !esImagenValida(escudo)) {
        return interaction.editReply({ content: "❌ El nuevo escudo debe ser una imagen: PNG, JPG, JPEG, GIF o WEBP." });
      }

      const rolClub = club.rolId ? await interaction.guild.roles.fetch(club.rolId).catch(() => null) : null;

      if ((nuevoNombre || colorHexInput) && rolClub && !rolClub.editable) {
        return interaction.editReply({ content: "❌ No puedo editar el rol del club. Pon el rol del bot por encima del rol del club." });
      }

      const cambios = [];
      const nombreAnterior = club.nombreVisual || club.nombre;

      if (nuevoNombre) {
        const nuevoNombreVisual = crearNombreVisual(nuevoNombre, club.emoji);

        if (rolClub) await rolClub.setName(nuevoNombreVisual).catch(() => null);

        for (const jugador of data.jugadores) {
          if (jugador.club.toLowerCase() === club.nombre.toLowerCase()) {
            jugador.club = nuevoNombre;
          }
        }

        for (const oferta of data.mercado) {
          if (oferta.clubProcedente.toLowerCase() === club.nombre.toLowerCase()) oferta.clubProcedente = nuevoNombre;
          if (oferta.clubDestino.toLowerCase() === club.nombre.toLowerCase()) oferta.clubDestino = nuevoNombre;
        }

        for (const competicion of data.competiciones || []) {
          for (const slot of competicion.equipos || []) {
            if (String(slot.clubId || "") === String(club.id || "") || String(slot.clubNombre || "").toLowerCase() === club.nombre.toLowerCase()) {
              slot.clubId = club.id || telClubStableId(club);
              slot.clubNombre = nuevoNombre;
              slot.nombre = nuevoNombreVisual;
            }
          }
        }

        club.nombre = nuevoNombre;
        club.nombreVisual = nuevoNombreVisual;
        cambios.push(`Nombre: **${nombreAnterior}** → **${nuevoNombreVisual}**`);
      }

      if (colorHexInput) {
        const colorFinal = `#${limpiarHex(colorHexInput)}`;

        if (rolClub) await rolClub.setColor(colorFinal).catch(() => null);

        club.colorHex = colorFinal;
        cambios.push(`Color: **${colorFinal}**`);
      }

      if (escudo) {
        const escudoGuardado = await guardarEscudoLocal(escudo, nuevoNombre || club.nombre);
        club.escudoUrl = escudoGuardado.url || escudo.url;
        club.escudoDiscordUrl = escudo.url;
        club.escudoPath = escudoGuardado.path || club.escudoPath || "";
        club.escudoFilename = escudoGuardado.filename || club.escudoFilename || "";
        await telBotPersistClubLogo(club.id || telClubStableId(club), escudoGuardado);
        cambios.push("Escudo actualizado y sincronizado con la web");
      }

      if (!club.nombreVisual) club.nombreVisual = crearNombreVisual(club.nombre, club.emoji);

      guardarDatos(data);

      const embed = new EmbedBuilder()
        .setTitle("✏️ Club editado")
        .setDescription(`Se ha editado el club **${club.nombreVisual || club.nombre}**.`)
        .addFields({ name: "Cambios realizados", value: cambios.join("\n"), inline: false })
        .setThumbnail(telDiscordImageUrl(club.escudoDiscordUrl, club.escudoUrl))
        .setColor(club.colorHex || 0x3498db);

      await enviarLogClubes(
        interaction,
        data,
        "✏️ Club editado",
        `Se ha editado el club **${club.nombreVisual || club.nombre}**.\n\n${cambios.join("\n")}`,
        0xf1c40f
      );

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "cambiar-presidente") {
      if (!esAdmin(interaction)) {
        return interaction.editReply({ content: "❌ Solo los administradores pueden cambiar presidentes." });
      }

      const nombreClub = interaction.options.getString("club");
      const nuevoPresidente = interaction.options.getUser("usuario");
      const club = buscarClub(data, nombreClub);

      if (!club) return interaction.editReply({ content: "❌ No he encontrado ese club." });
      if (club.presidenteId === nuevoPresidente.id) return interaction.editReply({ content: "❌ Ese usuario ya es el presidente de este club." });

      const registroNuevoPresidente = usuarioYaTieneClub(data, nuevoPresidente.id);

      if (registroNuevoPresidente && registroNuevoPresidente.club.toLowerCase() !== club.nombre.toLowerCase()) {
        return interaction.editReply({ content: `❌ Ese usuario ya está registrado como jugador en **${registroNuevoPresidente.club}**.` });
      }

      const rolPresidente = await obtenerRolObligatorio(interaction.guild, club.rolPresidenteId || process.env.ROL_PRESIDENTE_ID);
      const rolVicepresidente = await obtenerRolObligatorio(interaction.guild, club.rolVicepresidenteId || process.env.ROL_VICEPRESIDENTE_ID);

      if (!rolPresidente) return interaction.editReply({ content: "❌ No he encontrado el rol de Presidente." });

      const anteriorPresidenteId = club.presidenteId;
      const anteriorPresidenteTexto = `<@${anteriorPresidenteId}>`;

      club.presidenteId = nuevoPresidente.id;
      club.presidenteTag = nuevoPresidente.tag;
      club.vicepresidentes = (club.vicepresidentes || []).filter(vice => vice.id !== nuevoPresidente.id);

      if (!registroNuevoPresidente) {
        data.jugadores.push(crearRegistroJugadorWeb(nuevoPresidente, club, interaction, {
          agregadoComoDirectiva: true
        }));
      }

      guardarDatos(data);

      const nuevoMember = await interaction.guild.members.fetch(nuevoPresidente.id).catch(() => null);

      if (nuevoMember) {
        if (club.rolId) await nuevoMember.roles.add(club.rolId).catch(() => null);
        await nuevoMember.roles.add(rolPresidente).catch(() => null);
        await quitarRolAgenteLibre(interaction.guild, nuevoPresidente.id);
      }

      if (rolVicepresidente) {
        await quitarRolSiNoLoUsaEnOtroClub(interaction.guild, data, nuevoPresidente.id, rolVicepresidente.id, "vicepresidente");
      }

      if (anteriorPresidenteId && rolPresidente) {
        await quitarRolSiNoLoUsaEnOtroClub(interaction.guild, data, anteriorPresidenteId, rolPresidente.id, "presidente");
      }

      await quitarRolClubSiNoPertenece(interaction.guild, data, club.nombre, club.rolId, anteriorPresidenteId);

      const embed = new EmbedBuilder()
        .setTitle("👑 Presidente cambiado")
        .setDescription(`Se ha cambiado el presidente de **${club.nombreVisual || club.nombre}**.`)
        .addFields(
          { name: "Presidente anterior", value: anteriorPresidenteTexto, inline: true },
          { name: "Nuevo presidente", value: `<@${nuevoPresidente.id}>`, inline: true }
        )
        .setThumbnail(telDiscordImageUrl(club.escudoDiscordUrl, club.escudoUrl))
        .setColor(club.colorHex || 0x3498db);

      await enviarLogClubes(
        interaction,
        data,
        "👑 Presidente cambiado",
        `Club: **${club.nombreVisual || club.nombre}**\nAnterior: ${anteriorPresidenteTexto}\nNuevo: <@${nuevoPresidente.id}>`,
        0x9b59b6
      );

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "añadir-vicepresidente") {
      if (!esAdmin(interaction)) {
        return interaction.editReply({ content: "❌ Solo los administradores pueden añadir vicepresidentes." });
      }

      const nombreClub = interaction.options.getString("club");
      const usuario = interaction.options.getUser("usuario");
      const club = buscarClub(data, nombreClub);

      if (!club) return interaction.editReply({ content: "❌ No he encontrado ese club." });
      if (club.presidenteId === usuario.id) return interaction.editReply({ content: "❌ El presidente no puede añadirse también como vicepresidente." });

      if (!club.vicepresidentes) club.vicepresidentes = [];

      const yaEsVice = club.vicepresidentes.some(vice => vice.id === usuario.id);

      if (yaEsVice) return interaction.editReply({ content: "❌ Ese usuario ya es vicepresidente de este club." });
      if (club.vicepresidentes.length >= 3) return interaction.editReply({ content: "❌ Este club ya tiene 3 vicepresidentes." });

      const registroJugador = usuarioYaTieneClub(data, usuario.id);

      if (registroJugador && registroJugador.club.toLowerCase() !== club.nombre.toLowerCase()) {
        return interaction.editReply({ content: `❌ Ese usuario ya está registrado como jugador en **${registroJugador.club}**.` });
      }

      const rolVicepresidente = await obtenerRolObligatorio(interaction.guild, club.rolVicepresidenteId || process.env.ROL_VICEPRESIDENTE_ID);

      if (!rolVicepresidente) return interaction.editReply({ content: "❌ No he encontrado el rol de Vicepresidente." });

      club.vicepresidentes.push({ id: usuario.id, tag: usuario.tag });

      if (!registroJugador) {
        data.jugadores.push(crearRegistroJugadorWeb(usuario, club, interaction, {
          agregadoComoDirectiva: true
        }));
      }

      guardarDatos(data);

      const member = await interaction.guild.members.fetch(usuario.id).catch(() => null);

      if (member) {
        if (club.rolId) await member.roles.add(club.rolId).catch(() => null);
        await member.roles.add(rolVicepresidente).catch(() => null);
        await quitarRolAgenteLibre(interaction.guild, usuario.id);
      }

      const embed = new EmbedBuilder()
        .setTitle("➕ Vicepresidente añadido")
        .setDescription(`<@${usuario.id}> ahora es vicepresidente de **${club.nombreVisual || club.nombre}**.`)
        .setThumbnail(telDiscordImageUrl(club.escudoDiscordUrl, club.escudoUrl))
        .setColor(club.colorHex || 0x3498db);

      await enviarLogClubes(
        interaction,
        data,
        "➕ Vicepresidente añadido",
        `Club: **${club.nombreVisual || club.nombre}**\nUsuario: <@${usuario.id}>`,
        0x2ecc71
      );

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "quitar-vicepresidente") {
      if (!esAdmin(interaction)) {
        return interaction.editReply({ content: "❌ Solo los administradores pueden quitar vicepresidentes." });
      }

      const nombreClub = interaction.options.getString("club");
      const usuario = interaction.options.getUser("usuario");
      const club = buscarClub(data, nombreClub);

      if (!club) return interaction.editReply({ content: "❌ No he encontrado ese club." });

      const eraVice = club.vicepresidentes?.some(vice => vice.id === usuario.id);
      if (!eraVice) return interaction.editReply({ content: "❌ Ese usuario no es vicepresidente de este club." });

      club.vicepresidentes = club.vicepresidentes.filter(vice => vice.id !== usuario.id);
      guardarDatos(data);

      await quitarRolSiNoLoUsaEnOtroClub(interaction.guild, data, usuario.id, club.rolVicepresidenteId || process.env.ROL_VICEPRESIDENTE_ID, "vicepresidente");
      await quitarRolClubSiNoPertenece(interaction.guild, data, club.nombre, club.rolId, usuario.id);

      const embed = new EmbedBuilder()
        .setTitle("➖ Vicepresidente quitado")
        .setDescription(`<@${usuario.id}> ya no es vicepresidente de **${club.nombreVisual || club.nombre}**.`)
        .setThumbnail(telDiscordImageUrl(club.escudoDiscordUrl, club.escudoUrl))
        .setColor(0xe74c3c);

      await enviarLogClubes(
        interaction,
        data,
        "➖ Vicepresidente quitado",
        `Club: **${club.nombreVisual || club.nombre}**\nUsuario: <@${usuario.id}>`,
        0xe74c3c
      );

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "ficha-club") {
      const nombreClub = interaction.options.getString("club");
      const club = buscarClub(data, nombreClub);

      if (!club) return interaction.editReply({ content: "❌ No he encontrado ese club." });

      if (!club.nombreVisual) club.nombreVisual = crearNombreVisual(club.nombre, club.emoji);

      asegurarEconomiaClub(club);
      guardarDatos(data);

      const jugadoresClub = data.jugadores.filter(jugador => jugador.club.toLowerCase() === club.nombre.toLowerCase());
      const vicepresidentesTexto = club.vicepresidentes?.length > 0
        ? club.vicepresidentes.map(user => `<@${user.id}>`).join("\n")
        : "Sin vicepresidentes";

      const embed = new EmbedBuilder()
        .setTitle(`🏟️ ${club.nombreVisual || club.nombre}`)
        .addFields(
          { name: "Presidente", value: `<@${club.presidenteId}>`, inline: true },
          { name: "Rol del club", value: `<@&${club.rolId}>`, inline: true },
          { name: "Color", value: club.colorHex || "No guardado", inline: true },
          { name: "Presupuesto", value: formatearDinero(club.presupuesto), inline: true },
          { name: "Rol presidente", value: club.rolPresidenteId ? `<@&${club.rolPresidenteId}>` : "No guardado", inline: true },
          { name: "Rol vicepresidente", value: club.rolVicepresidenteId ? `<@&${club.rolVicepresidenteId}>` : "No guardado", inline: true },
          { name: "Vicepresidentes", value: vicepresidentesTexto, inline: false },
          { name: "Jugadores registrados", value: `${jugadoresClub.length}`, inline: true }
        )
        .setThumbnail(telDiscordImageUrl(club.escudoDiscordUrl, club.escudoUrl))
        .setColor(club.colorHex || 0x3498db);

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "plantilla") {
      const nombreClub = interaction.options.getString("club");
      const club = buscarClub(data, nombreClub);

      if (!club) return interaction.editReply({ content: "❌ No he encontrado ese club." });

      if (!club.nombreVisual) {
        club.nombreVisual = crearNombreVisual(club.nombre, club.emoji);
        guardarDatos(data);
      }

      const jugadoresClub = data.jugadores.filter(jugador => jugador.club.toLowerCase() === club.nombre.toLowerCase());

      if (jugadoresClub.length === 0) {
        const embed = new EmbedBuilder()
          .setTitle(`👥 Plantilla de ${club.nombreVisual || club.nombre}`)
          .setDescription("Este club todavía no tiene jugadores registrados.")
          .setThumbnail(telDiscordImageUrl(club.escudoDiscordUrl, club.escudoUrl))
          .setColor(club.colorHex || 0x3498db);

        return interaction.editReply({ embeds: [embed] });
      }

      const textoJugadores = jugadoresClub
        .map((jugador, index) => `**${index + 1}.** <@${jugador.usuarioId}>`)
        .join("\n");

      const embed = new EmbedBuilder()
        .setTitle(`👥 Plantilla de ${club.nombreVisual || club.nombre}`)
        .setDescription(textoJugadores.slice(0, 4000))
        .setThumbnail(telDiscordImageUrl(club.escudoDiscordUrl, club.escudoUrl))
        .setColor(club.colorHex || 0x3498db);

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "lista-clubes") {
      if (data.clubes.length === 0) {
        return interaction.editReply({ content: "❌ Todavía no hay clubes registrados." });
      }

      const lista = data.clubes.map((club, index) => {
        asegurarEconomiaClub(club);

        const jugadores = data.jugadores.filter(jugador => jugador.club.toLowerCase() === club.nombre.toLowerCase()).length;
        const nombreMostrado = club.nombreVisual || crearNombreVisual(club.nombre, club.emoji);

        return `**${index + 1}. ${nombreMostrado}**\nPresidente: <@${club.presidenteId}>\nJugadores: **${jugadores}**\nPresupuesto: **${formatearDinero(club.presupuesto)}**`;
      }).join("\n\n");

      guardarDatos(data);

      const embed = new EmbedBuilder()
        .setTitle("📋 Lista de clubes")
        .setDescription(lista.slice(0, 4000))
        .setColor(0x3498db);

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "logs-clubes") {
      if (!esAdmin(interaction)) {
        return interaction.editReply({ content: "❌ Solo los administradores pueden configurar los logs." });
      }

      const canal = interaction.options.getChannel("canal");

      if (!canal || !canal.isTextBased()) {
        return interaction.editReply({ content: "❌ Debes indicar un canal de texto válido." });
      }

      data.config.logsClubesChannelId = canal.id;
      guardarDatos(data);

      const embed = new EmbedBuilder()
        .setTitle("✅ Logs configurados")
        .setDescription(`Los logs de clubes se enviarán en ${canal}.`)
        .setColor(0x2ecc71);

      await canal.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("📌 Canal de logs configurado")
            .setDescription("Este canal recibirá los logs de clubes.")
            .setColor(0x2ecc71)
            .setTimestamp()
        ]
      }).catch(() => null);

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "bienvenidas") {
      if (!esAdmin(interaction)) {
        return interaction.editReply({ content: "❌ Solo los administradores pueden configurar las bienvenidas." });
      }

      const canal = interaction.options.getChannel("canal");

      if (!canal || !canal.isTextBased()) {
        return interaction.editReply({ content: "❌ Debes indicar un canal de texto válido." });
      }

      data.config.bienvenidasChannelId = canal.id;
      guardarDatos(data);

      const embed = new EmbedBuilder()
        .setTitle("✅ Bienvenidas configuradas")
        .setDescription(`Las bienvenidas se enviarán en ${canal}.`)
        .setColor(0x2ecc71);

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "probar-bienvenida") {
      if (!esAdmin(interaction)) {
        return interaction.editReply({ content: "❌ Solo los administradores pueden probar las bienvenidas." });
      }

      const canalId = data.config?.bienvenidasChannelId;

      if (!canalId) {
        return interaction.editReply({ content: "❌ Primero configura un canal con `/bienvenidas`." });
      }

      await enviarBienvenida(interaction.member);

      return interaction.editReply({ content: "✅ Bienvenida de prueba enviada correctamente." });
    }

    if (interaction.commandName === "panel-tickets") {
      if (!esAdmin(interaction)) {
        return interaction.editReply({
          content: "❌ Solo los administradores pueden enviar el panel de tickets."
        });
      }

      const categoryId = process.env.TICKETS_CATEGORY_ID;
      const staffRoleId = process.env.TICKETS_STAFF_ROLE_ID;
      const logsChannelId = process.env.TICKETS_LOGS_CHANNEL_ID;

      if (!categoryId || !staffRoleId || !logsChannelId) {
        return interaction.editReply({
          content:
            "❌ Faltan variables en `.env`.\n\nNecesitas:\n" +
            "`TICKETS_CATEGORY_ID`\n" +
            "`TICKETS_STAFF_ROLE_ID`\n" +
            "`TICKETS_LOGS_CHANNEL_ID`"
        });
      }

      const categoriaDiscord = await interaction.guild.channels
        .fetch(categoryId)
        .catch(() => null);

      if (!categoriaDiscord || categoriaDiscord.type !== ChannelType.GuildCategory) {
        return interaction.editReply({
          content: "❌ La categoría configurada en `TICKETS_CATEGORY_ID` no existe o no es una categoría."
        });
      }

      const staffRole = await interaction.guild.roles
        .fetch(staffRoleId)
        .catch(() => null);

      if (!staffRole) {
        return interaction.editReply({
          content: "❌ El rol configurado en `TICKETS_STAFF_ROLE_ID` no existe."
        });
      }

      await interaction.channel.send(crearPanelTickets());

      return interaction.editReply({
        content: "✅ Panel de tickets enviado correctamente."
      });
    }

    if (interaction.commandName === "economia-club") {
      const nombreClub = interaction.options.getString("club");
      const club = buscarClub(data, nombreClub);

      if (!club) return interaction.editReply({ content: "❌ No he encontrado ese club." });

      const economia = calcularEconomiaClub(club);
      guardarDatos(data);

      const embed = new EmbedBuilder()
        .setTitle(`💰 Economía de ${club.nombreVisual || club.nombre}`)
        .addFields(
          { name: "Presupuesto actual", value: formatearDinero(economia.presupuesto), inline: true },
          { name: "Ingresos registrados", value: formatearDinero(economia.ingresos), inline: true },
          { name: "Gastos registrados", value: formatearDinero(economia.gastos), inline: true },
          { name: "Balance histórico", value: formatearDinero(economia.balance), inline: true }
        )
        .setThumbnail(telDiscordImageUrl(club.escudoDiscordUrl, club.escudoUrl))
        .setColor(club.colorHex || 0x2ecc71);

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "asignar-presupuesto") {
      if (!esAdmin(interaction)) {
        return interaction.editReply({ content: "❌ Solo los administradores pueden asignar presupuesto." });
      }

      const nombreClub = interaction.options.getString("club");
      const cantidad = interaction.options.getInteger("cantidad");
      const motivo = interaction.options.getString("motivo") || "Asignación manual de presupuesto";
      const club = buscarClub(data, nombreClub);

      if (!club) return interaction.editReply({ content: "❌ No he encontrado ese club." });

      asegurarEconomiaClub(club);

      const anterior = club.presupuesto;
      club.presupuesto = cantidad;

      club.historialEconomia.push(
        crearMovimientoEconomico(interaction, "ajuste", cantidad, motivo)
      );

      guardarDatos(data);

      const embed = new EmbedBuilder()
        .setTitle("💰 Presupuesto asignado")
        .setDescription(`Se ha actualizado el presupuesto de **${club.nombreVisual || club.nombre}**.`)
        .addFields(
          { name: "Anterior", value: formatearDinero(anterior), inline: true },
          { name: "Nuevo", value: formatearDinero(cantidad), inline: true },
          { name: "Motivo", value: motivo, inline: false }
        )
        .setThumbnail(telDiscordImageUrl(club.escudoDiscordUrl, club.escudoUrl))
        .setColor(0x2ecc71);

      await enviarLogClubes(
        interaction,
        data,
        "💰 Presupuesto asignado",
        `Club: **${club.nombreVisual || club.nombre}**\nAnterior: **${formatearDinero(anterior)}**\nNuevo: **${formatearDinero(cantidad)}**\nMotivo: ${motivo}`,
        0x2ecc71
      );

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "añadir-dinero") {
      if (!esAdmin(interaction)) {
        return interaction.editReply({ content: "❌ Solo los administradores pueden añadir dinero." });
      }

      const nombreClub = interaction.options.getString("club");
      const cantidad = interaction.options.getInteger("cantidad");
      const motivo = interaction.options.getString("motivo");
      const club = buscarClub(data, nombreClub);

      if (!club) return interaction.editReply({ content: "❌ No he encontrado ese club." });

      asegurarEconomiaClub(club);

      club.presupuesto += cantidad;
      club.historialEconomia.push(
        crearMovimientoEconomico(interaction, "ingreso", cantidad, motivo)
      );

      guardarDatos(data);

      const embed = new EmbedBuilder()
        .setTitle("✅ Dinero añadido")
        .setDescription(`Se han añadido **${formatearDinero(cantidad)}** a **${club.nombreVisual || club.nombre}**.`)
        .addFields(
          { name: "Motivo", value: motivo, inline: false },
          { name: "Presupuesto actual", value: formatearDinero(club.presupuesto), inline: true }
        )
        .setThumbnail(telDiscordImageUrl(club.escudoDiscordUrl, club.escudoUrl))
        .setColor(0x2ecc71);

      await enviarLogClubes(
        interaction,
        data,
        "✅ Dinero añadido",
        `Club: **${club.nombreVisual || club.nombre}**\nCantidad: **${formatearDinero(cantidad)}**\nMotivo: ${motivo}`,
        0x2ecc71
      );

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "quitar-dinero") {
      if (!esAdmin(interaction)) {
        return interaction.editReply({ content: "❌ Solo los administradores pueden quitar dinero." });
      }

      const nombreClub = interaction.options.getString("club");
      const cantidad = interaction.options.getInteger("cantidad");
      const motivo = interaction.options.getString("motivo");
      const club = buscarClub(data, nombreClub);

      if (!club) return interaction.editReply({ content: "❌ No he encontrado ese club." });

      asegurarEconomiaClub(club);

      club.presupuesto -= cantidad;
      club.historialEconomia.push(
        crearMovimientoEconomico(interaction, "gasto", cantidad, motivo)
      );

      guardarDatos(data);

      const embed = new EmbedBuilder()
        .setTitle("❌ Dinero retirado")
        .setDescription(`Se han retirado **${formatearDinero(cantidad)}** a **${club.nombreVisual || club.nombre}**.`)
        .addFields(
          { name: "Motivo", value: motivo, inline: false },
          { name: "Presupuesto actual", value: formatearDinero(club.presupuesto), inline: true }
        )
        .setThumbnail(telDiscordImageUrl(club.escudoDiscordUrl, club.escudoUrl))
        .setColor(0xe74c3c);

      await enviarLogClubes(
        interaction,
        data,
        "❌ Dinero retirado",
        `Club: **${club.nombreVisual || club.nombre}**\nCantidad: **-${formatearDinero(cantidad)}**\nMotivo: ${motivo}`,
        0xe74c3c
      );

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "sancionar-club") {
      if (!esAdmin(interaction)) {
        return interaction.editReply({
          content: "❌ Solo los administradores pueden sancionar clubes."
        });
      }

      const nombreClub = interaction.options.getString("club");
      const motivo = interaction.options.getString("motivo");
      const cantidad = interaction.options.getInteger("cantidad");

      const club = buscarClub(data, nombreClub);

      if (!club) {
        return interaction.editReply({
          content: "❌ No he encontrado ese club."
        });
      }

      asegurarEconomiaClub(club);

      const presupuestoAnterior = club.presupuesto;

      club.presupuesto -= cantidad;

      club.historialEconomia.push(
        crearMovimientoEconomico(
          interaction,
          "gasto",
          cantidad,
          `Sanción: ${motivo}`
        )
      );

      guardarDatos(data);

      const nombreMostrado = club.nombreVisual || crearNombreVisual(club.nombre, club.emoji);

      const embed = new EmbedBuilder()
        .setTitle("🚨 Club sancionado")
        .setDescription(`El club **${nombreMostrado}** ha recibido una sanción económica.`)
        .addFields(
          {
            name: "Cantidad",
            value: `-${formatearDinero(cantidad)}`,
            inline: true
          },
          {
            name: "Presupuesto anterior",
            value: formatearDinero(presupuestoAnterior),
            inline: true
          },
          {
            name: "Presupuesto actual",
            value: formatearDinero(club.presupuesto),
            inline: true
          },
          {
            name: "Motivo",
            value: motivo,
            inline: false
          },
          {
            name: "Sancionado por",
            value: `<@${interaction.user.id}>`,
            inline: true
          }
        )
        .setThumbnail(telDiscordImageUrl(club.escudoDiscordUrl, club.escudoUrl))
        .setColor(0xe74c3c)
        .setTimestamp();

      await enviarLogClubes(
        interaction,
        data,
        "🚨 Club sancionado",
        `Club: **${nombreMostrado}**\nCantidad: **-${formatearDinero(cantidad)}**\nPresupuesto anterior: **${formatearDinero(presupuestoAnterior)}**\nPresupuesto actual: **${formatearDinero(club.presupuesto)}**\nMotivo: ${motivo}`,
        0xe74c3c
      );

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "historial-economia") {
      const nombreClub = interaction.options.getString("club");
      const club = buscarClub(data, nombreClub);

      if (!club) return interaction.editReply({ content: "❌ No he encontrado ese club." });

      asegurarEconomiaClub(club);
      guardarDatos(data);

      if (club.historialEconomia.length === 0) {
        return interaction.editReply({ content: "❌ Este club no tiene movimientos económicos." });
      }

      const texto = club.historialEconomia
        .slice(-15)
        .reverse()
        .map(movimiento => {
          const fecha = new Date(movimiento.fecha).toLocaleDateString("es-ES");
          const signo =
            movimiento.tipo === "ingreso" ? "+" :
            movimiento.tipo === "gasto" ? "-" :
            "";

          return `**${fecha}** | ${movimiento.tipo.toUpperCase()}\n${signo}${formatearDinero(movimiento.cantidad)} - ${movimiento.motivo}`;
        })
        .join("\n\n");

      const embed = new EmbedBuilder()
        .setTitle(`📜 Historial económico de ${club.nombreVisual || club.nombre}`)
        .setDescription(texto.slice(0, 4000))
        .setThumbnail(telDiscordImageUrl(club.escudoDiscordUrl, club.escudoUrl))
        .setColor(club.colorHex || 0xf1c40f)
        .setFooter({ text: "Mostrando los últimos 15 movimientos." });

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "ranking-economia") {
      if (data.clubes.length === 0) {
        return interaction.editReply({ content: "❌ Todavía no hay clubes registrados." });
      }

      const ranking = data.clubes
        .map(club => {
          asegurarEconomiaClub(club);
          return club;
        })
        .sort((a, b) => b.presupuesto - a.presupuesto);

      guardarDatos(data);

      const texto = ranking
        .map((club, index) => {
          const nombre = club.nombreVisual || crearNombreVisual(club.nombre, club.emoji);
          return `**${index + 1}. ${nombre}** - ${formatearDinero(club.presupuesto)}`;
        })
        .join("\n");

      const embed = new EmbedBuilder()
        .setTitle("🏆 Ranking económico")
        .setDescription(texto.slice(0, 4000))
        .setColor(0xf1c40f);

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "fichar") {
      const jugador = interaction.options.getUser("jugador");
      const clubProcedenteInput = interaction.options.getString("club_procedente");
      const clubDestinoInput = interaction.options.getString("club_destino");
      const precio = interaction.options.getInteger("precio");
      const idEaPsn = interaction.options.getString("id_ea_psn") || "";

      const clubDestino = buscarClub(data, clubDestinoInput);

      if (!clubDestino) {
        return interaction.editReply({ content: "❌ No he encontrado el club destino." });
      }

      if (!puedeGestionarClub(interaction, clubDestino)) {
        return interaction.editReply({
          content: "❌ Solo la directiva del club destino o un administrador puede hacer esta oferta."
        });
      }

      asegurarEconomiaClub(clubDestino);

      if (clubDestino.presupuesto < precio) {
        return interaction.editReply({
          content: `❌ **${clubDestino.nombreVisual || clubDestino.nombre}** no tiene suficiente presupuesto. Tiene **${formatearDinero(clubDestino.presupuesto)}**.`
        });
      }

      if (esAgenteLibre(clubProcedenteInput)) {
        return completarFichajeAgenteLibre(interaction, data, jugador, clubDestino, precio, idEaPsn);
      }

      const clubProcedente = buscarClub(data, clubProcedenteInput);

      if (!clubProcedente) {
        return interaction.editReply({ content: "❌ No he encontrado el club procedente." });
      }

      if (clubProcedente.nombre.toLowerCase() === clubDestino.nombre.toLowerCase()) {
        return interaction.editReply({ content: "❌ El club procedente y destino no pueden ser el mismo." });
      }

      const jugadorActual = usuarioYaTieneClub(data, jugador.id);

      if (!jugadorActual) {
        return interaction.editReply({ content: "❌ Ese jugador no está registrado en ningún club. Si es agente libre, selecciona `Agente Libre` como club procedente." });
      }

      if (jugadorActual.club.toLowerCase() !== clubProcedente.nombre.toLowerCase()) {
        return interaction.editReply({
          content: `❌ Ese jugador no pertenece a **${clubProcedente.nombreVisual || clubProcedente.nombre}**. Actualmente figura en **${jugadorActual.club}**.`
        });
      }

      if (esDirectivaClub(jugador.id, clubProcedente)) {
        return interaction.editReply({ content: "❌ No puedes fichar a un presidente o vicepresidente. Primero hay que cambiarle o quitarle el cargo." });
      }

      const ofertaDuplicada = data.mercado.some(oferta =>
        oferta.estado === "pendiente" &&
        oferta.jugadorId === jugador.id &&
        oferta.clubProcedente.toLowerCase() === clubProcedente.nombre.toLowerCase() &&
        oferta.clubDestino.toLowerCase() === clubDestino.nombre.toLowerCase()
      );

      if (ofertaDuplicada) {
        return interaction.editReply({ content: "❌ Ya existe una oferta pendiente por ese jugador entre esos clubes." });
      }

      const oferta = {
        id: crearIdFichaje(data),
        jugadorId: jugador.id,
        jugadorTag: jugador.tag,
        clubProcedente: clubProcedente.nombre,
        clubDestino: clubDestino.nombre,
        precio,
        idEaPsn,
        estado: "pendiente",
        creadaPorId: interaction.user.id,
        creadaPorTag: interaction.user.tag,
        fecha: new Date().toISOString(),
        canalId: interaction.channelId,
        mensajeId: null
      };

      data.mercado.push(oferta);
      guardarDatos(data);

      const embed = crearEmbedOfertaFichaje(oferta, data);
      const row = crearBotonesOferta(oferta);

      const mensaje = await interaction.editReply({
        embeds: [embed],
        components: [row]
      });

      oferta.mensajeId = mensaje.id;
      guardarDatos(data);

      await enviarLogClubes(
        interaction,
        data,
        "📩 Nueva oferta de fichaje",
        `Oferta: **${oferta.id}**\nJugador: <@${jugador.id}>\nDe: **${clubProcedente.nombreVisual || clubProcedente.nombre}**\nA: **${clubDestino.nombreVisual || clubDestino.nombre}**\nPrecio: **${formatearDinero(precio)}**`,
        0xf1c40f
      );

      return;
    }

    if (interaction.commandName === "ofertas-fichajes") {
      const clubInput = interaction.options.getString("club");
      let ofertas = data.mercado.filter(oferta => oferta.estado === "pendiente");
      let titulo = "📨 Ofertas de fichajes pendientes";

      if (clubInput) {
        const club = buscarClub(data, clubInput);

        if (!club) return interaction.editReply({ content: "❌ No he encontrado ese club." });

        ofertas = ofertas.filter(oferta =>
          oferta.clubProcedente.toLowerCase() === club.nombre.toLowerCase() ||
          oferta.clubDestino.toLowerCase() === club.nombre.toLowerCase()
        );

        titulo = `📨 Ofertas pendientes de ${club.nombreVisual || club.nombre}`;
      }

      if (ofertas.length === 0) return interaction.editReply({ content: "✅ No hay ofertas de fichajes pendientes." });

      const texto = ofertas
        .slice(0, 15)
        .map(oferta => {
          const clubProcedente = buscarClub(data, oferta.clubProcedente);
          const clubDestino = buscarClub(data, oferta.clubDestino);
          const nombreProcedente = clubProcedente?.nombreVisual || oferta.clubProcedente;
          const nombreDestino = clubDestino?.nombreVisual || oferta.clubDestino;

          return `**${oferta.id}** | <@${oferta.jugadorId}>\n${nombreProcedente} → ${nombreDestino}\nPrecio: **${formatearDinero(oferta.precio)}**`;
        })
        .join("\n\n");

      const embed = new EmbedBuilder()
        .setTitle(titulo)
        .setDescription(texto.slice(0, 4000))
        .setColor(0xf1c40f)
        .setFooter({ text: "Para aceptar o rechazar, usa los botones del mensaje de la oferta." });

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "añadir-jugador") {
      const usuario = interaction.options.getUser("usuario");
      const nombreClub = interaction.options.getString("club");
      const idEaPsn = interaction.options.getString("id_ea_psn") || "";
      const club = buscarClub(data, nombreClub);

      if (!club) return interaction.editReply({ content: "❌ No he encontrado ese club." });

      if (!puedeGestionarClub(interaction, club)) {
        return interaction.editReply({ content: "❌ Solo la directiva del club o un administrador puede añadir jugadores." });
      }

      const jugadorExistente = usuarioYaTieneClub(data, usuario.id);

      if (jugadorExistente) {
        return interaction.editReply({ content: `❌ Ese jugador ya está registrado en **${jugadorExistente.club}**.` });
      }

      data.jugadores.push(crearRegistroJugadorWeb(usuario, club, interaction, {
        idEaPsn
      }));

      guardarDatos(data);

      const member = await interaction.guild.members.fetch(usuario.id).catch(() => null);

      if (member && club.rolId) {
        await member.roles.add(club.rolId).catch(() => null);
        await quitarRolAgenteLibre(interaction.guild, usuario.id);
      }

      const nombreMostrado = club.nombreVisual || crearNombreVisual(club.nombre, club.emoji);

      const embed = new EmbedBuilder()
        .setTitle("✅ Jugador añadido")
        .setDescription(`<@${usuario.id}> ha sido añadido a **${nombreMostrado}**.`)
        .setThumbnail(telDiscordImageUrl(club.escudoDiscordUrl, club.escudoUrl))
        .setColor(club.colorHex || 0x3498db);

      await enviarLogClubes(
        interaction,
        data,
        "✅ Jugador añadido",
        `Jugador: <@${usuario.id}>\nClub: **${nombreMostrado}**`,
        0x2ecc71
      );

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "quitar-jugador") {
      const usuario = interaction.options.getUser("usuario");
      const jugador = data.jugadores.find(j => j.usuarioId === usuario.id);

      if (!jugador) return interaction.editReply({ content: "❌ Ese jugador no está registrado en ningún club." });

      const club = buscarClub(data, jugador.club);
      const nombreMostrado = club ? club.nombreVisual || crearNombreVisual(club.nombre, club.emoji) : jugador.club;

      if (club && !puedeGestionarClub(interaction, club)) {
        return interaction.editReply({ content: "❌ Solo la directiva del club o un administrador puede quitar jugadores." });
      }

      if (club && esDirectivaClub(usuario.id, club)) {
        return interaction.editReply({ content: "❌ No puedes quitar a un presidente o vicepresidente desde este comando. Usa los comandos de directiva." });
      }

      data.jugadores = data.jugadores.filter(j => j.usuarioId !== usuario.id);
      guardarDatos(data);

      if (club?.rolId) {
        await quitarRolClubSiNoPertenece(interaction.guild, data, club.nombre, club.rolId, usuario.id);

        if (!usuarioTieneRelacionConClub(data, club.nombre, usuario.id)) {
          await darRolAgenteLibre(interaction.guild, usuario.id);
        }
      }

      const embed = new EmbedBuilder()
        .setTitle("🗑️ Jugador quitado")
        .setDescription(`<@${usuario.id}> ha sido eliminado de **${nombreMostrado}**.`)
        .setColor(0xe74c3c);

      await enviarLogClubes(
        interaction,
        data,
        "🗑️ Jugador quitado",
        `Jugador: <@${usuario.id}>\nClub: **${nombreMostrado}**`,
        0xe74c3c
      );

      return interaction.editReply({ embeds: [embed] });
    }

    return interaction.editReply({
      content: "❌ Comando no reconocido en el index.js."
    });
  } catch (error) {
    console.error(`[comando:${interaction.commandName || "desconocido"}]`, error);

    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({
        content: "❌ Ha ocurrido un error al completar la respuesta en Discord. Los datos guardados en la web no se han perdido."
      }).catch(() => null);
    }

    return interaction.reply({
      content: "❌ Ha ocurrido un error al ejecutar el comando.",
      ephemeral: true
    }).catch(() => null);
  }
});

async function telStartDiscordBot(){
  await telPrepareBotStorage();
  const token = process.env.TOKEN;
  if(!token || typeof token !== 'string' || token.trim().length < 30 || token.includes('TU_TOKEN')){
    console.warn('[bot] Token de Discord no configurado o inválido. Bot desactivado; web activa.');
    return;
  }
  client.login(token).catch((error) => {
    console.warn('[bot] No se pudo iniciar Discord:', error?.code || error?.message || error);
    console.warn('[bot] La web seguirá funcionando.');
  });
}

telStartDiscordBot().catch(error=>{
  console.error('[bot] Error durante el arranque:', error);
});
