// ============================================================
// Phénix Support v2 — rebuild propre
// Tickets (salons privés) + Stats staff + Logs staff
// Démarrage : npm install puis node index.js (config.json requis)
// ============================================================
const fs = require('fs');
const path = require('path');

// ---------- Charge le fichier .env (natif Node >= 20.12) ----------
try { process.loadEnvFile(); } catch {}

// ---------- Config (chargement sécurisé : jamais de crash obscur) ----------
const CONFIG_PATH = path.join(__dirname, 'config.json');
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error('[CONFIG] ❌ config.json invalide ou introuvable :', e.message);
  console.error('[CONFIG] Vérifie : fichier nommé exactement "config.json" à côté de index.js, virgules, guillemets droits ", pas de virgule après le dernier élément.');
  process.exit(1);
}
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || cfg.token;
if (!DISCORD_TOKEN) {
  console.error('[CONFIG] ❌ Aucun token : mets DISCORD_TOKEN dans .env ou "token" dans config.json — impossible de démarrer.');
  process.exit(1);
}

function liveCfg() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

// ---------- Présence du bot (f!status / f!activite, persistante via config.json) ----------
const ACT_LABELS = {
  0: '🎮 Joue à', 1: '📡 En direct', 2: '🎧 Écoute', 3: '📺 Regarde', 4: '', 5: '🏆 Participe à',
};
function activityLine(pr) {
  if (!pr?.state) return '';
  const lbl = ACT_LABELS[pr.type ?? 4] ?? '';
  return lbl ? `${lbl} ${pr.state}` : pr.state;
}
function getBotPresence() {
  try { const c = liveCfg(); return { status: c.presence?.status || 'online', state: c.presence?.state || '', type: c.presence?.type ?? 'custom' }; }
  catch { return { status: 'online', state: '', type: 'custom' }; }
}
function saveBotPresence(status, state, type) {
  try {
    const c = liveCfg();
    let t = type == null || type === '' ? 'custom' : Number(type);
    if (Number.isNaN(t)) t = 'custom';
    c.presence = { status, state: state || '', type: t };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
  } catch {}
}
async function applyBotPresence(status, state, atype) {
  try {
    let t;
    if (atype == null || atype === '') t = 'custom';
    else { t = Number(atype); if (Number.isNaN(t)) t = 'custom'; }
    const data = { status, activities: [] };
    if (state) data.activities = [
      t === 1 ? { name: String(state).slice(0, 128), type: ActivityType.Streaming, url: 'https://www.twitch.tv/phenix' }
      : t === 'custom' ? { name: 'custom', type: ActivityType.Custom, state: String(state).slice(0, 128) }
      : { name: String(state).slice(0, 128), type: t },
    ];
    client.user.setPresence(data);
  } catch {}
}

// ---------- Discord ----------
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  MessageFlags, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle,
  AuditLogEvent, ActivityType, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} = require('discord.js');

const blacklist = require('./src/database');
const { normalizeType, buildUserStatsEmbed, buildTopEmbed, statsPanelEmbed, statsPanelRows } = require('./src/staffStats');
const {
  TICKET_MODAL_ID, TICKET_REASON_FIELD, TICKET_IDS, buildTicketModal, ticketChannelName, ticketOpenEmbed,
  ticketControlRows, ticketCloseConfirmRows, ticketCloseConfirmEmbed,
  ticketResolutEmbed, ticketResolutRows, isTicketPanelMessage, isActiveResolutPrompt, buildTranscriptText,
} = require('./src/tickets');
const { DEFAULT_STAFF_LOG_ID, getStaffLogId, sendStaffLog } = require('./src/staffLogs');

// ---------- Réglages ----------
const OWNER_IDS = cfg.ownerIds || [];
const GUILD_ID = cfg.guildId || '';
const STAFF_ROLE_ID = cfg.staffRoleId || '';
const PANEL_CHANNEL = cfg.panelChannelId || '';
const STATS_PANEL_CHANNEL = cfg.statsPanelChannelId || '';

const liveStaffRoleId = () => { try { return liveCfg().staffRoleId || STAFF_ROLE_ID; } catch { return STAFF_ROLE_ID; } };
const staffLogChannelId = () => { try { return getStaffLogId(liveCfg, cfg); } catch { return DEFAULT_STAFF_LOG_ID; } };
const ticketLogChannelId = () => {
  try {
    const live = liveCfg();
    return live.ticketLogChannelId || cfg.ticketLogChannelId || staffLogChannelId();
  } catch { return cfg.ticketLogChannelId || ''; }
};
const ticketCategoryId = () => { try { return liveCfg().ticketCategoryId || cfg.ticketCategoryId || ''; } catch { return cfg.ticketCategoryId || ''; } };
const OWNER_LOG_CHANNEL_ID = '1544740971030384830';
const ownerLogChannelId = () => { try { return liveCfg().ownerLogChannelId || cfg.ownerLogChannelId || OWNER_LOG_CHANNEL_ID; } catch { return cfg.ownerLogChannelId || OWNER_LOG_CHANNEL_ID; } };
const MOD_LOG_CHANNEL_ID = '1544740969931345972';
const modLogChannelId = () => { try { return liveCfg().modLogChannelId || cfg.modLogChannelId || MOD_LOG_CHANNEL_ID; } catch { return cfg.modLogChannelId || MOD_LOG_CHANNEL_ID; } };
const maxTicketsPerUser = () => {
  try { const n = parseInt(liveCfg().maxTicketsPerUser ?? cfg.maxTicketsPerUser ?? 1); return Math.max(1, Math.min(5, n || 1)); }
  catch { return 1; }
};
const privilegedRoleIds = () => {
  try { return liveCfg().privilegedRoleIds || cfg.privilegedRoleIds || []; }
  catch { return cfg.privilegedRoleIds || []; }
};

// ---------- Permissions ----------
const isOwner = (id) => OWNER_IDS.includes(id);

// ---------- Rôle requis pour les commandes blacklist (f!bl, f!sbl...) ----------
const BL_ROLE_ID = '1562992180279123998';
function hasBlRole(member) { try { return !!member?.roles?.cache?.has(BL_ROLE_ID); } catch { return false; } }
function blRoleGate(message) {
  if (isOwner(message.author.id) || hasBlRole(message.member)) return null;
  return { content: `❌ Réservé aux owners du bot ou aux membres qui ont le rôle <@${BL_ROLE_ID}>.` };
}
function isStaff(member) {
  if (!member) return false;
  try { if (member.roles?.cache?.has(liveStaffRoleId())) return true; } catch {}
  try { if (STAFF_ROLE_ID && member.roles?.cache?.has(STAFF_ROLE_ID)) return true; } catch {}
  return false;
}
function isAdmin(member, userId) {
  if (isOwner(userId)) return true;
  if (!member) return false;
  try { if (member.id === member.guild?.ownerId) return true; } catch {}
  try { if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true; } catch {}
  return false;
}
function canUseCommands(member, userId) {
  if (isOwner(userId)) return true;
  // ✋ Accès STAFF = uniquement les owners + le staff global (f!staff add). Tout le reste → refusé.
  try { if (blacklist.getGlobalStaff?.(userId)) return true; } catch {}
  return false;
}
function hasPrivileged(member, userId) {
  if (isOwner(userId)) return true;
  if (isAdmin(member, userId)) return true;
  try {
    const ids = privilegedRoleIds() || [];
    if (ids.length && ids.some((id) => member?.roles?.cache?.has(id))) return true;
    if (!ids.length && canUseCommands(member, userId)) return true;
  } catch {}
  return false;
}
// ---------- Hiérarchie à paliers (Modo < Senior < Admin < Owner) ----------
// Niveaux : 0 Membre, 10 Staff, 20 Senior/Privilégié, 50 Admin Discord, 100 Owner bot
// Config optionnelle dans config.json : "hierarchy": [{ "name": "Modo", "roleId": "...", "level": 10 }, ...]
// Si absente, on mappe l'ancien système (staffRoleId=10, privileged=20, admin=50, owner=100).
const LVL = { MEMBER: 0, STAFF: 10, SENIOR: 20, ADMIN: 50, OWNER: 100 };
function getHierarchyConfig() {
  try { return liveCfg().hierarchy || cfg.hierarchy || null; } catch { return cfg.hierarchy || null; }
}
function getLevel(member, userId) {
  if (isOwner(userId)) return LVL.OWNER;
  // ✋ Niveau par rôle supprimé : STAFF = uniquement le staff global (f!staff add)
  try {
    const gs = blacklist.getGlobalStaff?.(userId);
    if (gs) return gs.level === 'admin' ? LVL.ADMIN : LVL.STAFF;
  } catch {}
  return LVL.MEMBER;
}
function getRankName(level) {
  try {
    const h = getHierarchyConfig();
    if (Array.isArray(h) && h.length) {
      const match = h.filter((r) => r && r.level <= level).sort((a, b) => b.level - a.level)[0];
      if (match?.name) return match.name;
    }
  } catch {}
  if (level >= LVL.OWNER) return 'Propriétaire du bot';
  if (level >= LVL.ADMIN) return 'Admin';
  if (level >= LVL.SENIOR) return 'Senior';
  if (level >= LVL.STAFF) return 'Staff';
  return 'Membre';
}
// Tous les grades acquis (pour les certifications f!/x!/st!identite)
function getAllRankNames(level) {
  try {
    const h = getHierarchyConfig();
    if (Array.isArray(h) && h.length) {
      const names = [...h].filter((r) => r && r.name && r.level != null && r.level <= level).sort((a, b) => a.level - b.level).map((r) => String(r.name));
      if (names.length) return names;
    }
  } catch {}
  if (level >= LVL.OWNER) return ['Staff', 'Senior', 'Admin', 'Propriétaire du bot'];
  if (level >= LVL.ADMIN) return ['Staff', 'Senior', 'Admin'];
  if (level >= LVL.SENIOR) return ['Staff', 'Senior'];
  if (level >= LVL.STAFF) return ['Staff'];
  return ['Membre'];
}
// Liste des rôles (grades) détenus sur le serveur support — certifications identite
async function getSupportRoleGrades(userId, fallbackMember) {
  try {
    const gid = liveCfg().guildId || cfg.guildId || '';
    const g = client.guilds.cache.get(gid);
    let m = g ? (g.members.cache.get(userId) || await g.members.fetch(userId).catch(() => null)) : null;
    if (!m && fallbackMember) m = fallbackMember;
    if (!m) return '';
    const mg = m.guild;
    // Uniquement les grades staff (hiérarchie + rôles de permission), pas les rôles cosmétiques/notifications
    const allowed = new Set();
    try { for (const r of (getHierarchyConfig() || [])) if (r?.roleId) allowed.add(String(r.roleId)); } catch {}
    try { const pc = liveCfg(); if (pc.staffRoleId) allowed.add(String(pc.staffRoleId)); } catch {}
    try { const pc = liveCfg(); if (pc.phenixAdminRoleId) allowed.add(String(pc.phenixAdminRoleId)); } catch {}
    try { for (const id of (liveCfg().commandRoleIds || [])) allowed.add(String(id)); } catch {}
    try { for (const id of (liveCfg().privilegedRoleIds || [])) allowed.add(String(id)); } catch {}
    const roles = m.roles.cache.filter((r) => allowed.has(r.id) && r.id !== mg.roles.everyone.id).sort((a, b) => b.position - a.position).map((r) => r.name);
    // Ne garder que les grades à partir de « Équipe Staff Phénix » et enlever les étiquettes génériques
    const EXCLUDE_GRADE = /(^staff$|^haut grade$|equipe staff|staff ph[eé]nix|^membre$|^membre fondation$|^fondateur$)/i;
    const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const boundary = mg.roles.cache.find((r) => /équipe\s*staff\s*ph[eé]nix/i.test(r.name));
    let names = roles;
    if (boundary) {
      const namesFiltered = m.roles.cache.filter((r) => r.id !== mg.roles.everyone.id && r.position >= boundary.position).sort((a, b) => b.position - a.position).map((r) => r.name);
      names = namesFiltered.filter((n) => !EXCLUDE_GRADE.test(norm(n)));
      if (!names.length) names = namesFiltered;
    }
    // Tri préféré : Propriétaire → Développeur → autres par position
    const prio = (n) => /propri[eé]taire|owner|further/i.test(n) ? 0 : /d[eé]veloppeur|dev/i.test(n) ? 1 : 2;
    names = [...names].sort((a, b) => prio(a) - prio(b));
    return names.length ? names.join('\n') : '';
  } catch { return ''; }
}
const requireLevel = (member, userId, min) => getLevel(member, userId) >= min;
// Rangs assignables triés croissant (pour rankup/derank). Exclut Owner (100, non attribuable via rôle).
function getOrderedRanks() {
  try {
    const h = getHierarchyConfig();
    if (Array.isArray(h) && h.length) {
      return [...h].filter((r) => r && r.roleId && r.level && r.level < LVL.OWNER).sort((a, b) => a.level - b.level);
    }
  } catch {}
  const out = [];
  try { if (STAFF_ROLE_ID) out.push({ name: 'Staff', roleId: STAFF_ROLE_ID, level: LVL.STAFF }); } catch {}
  try {
    const ids = privilegedRoleIds() || [];
    if (ids[0]) out.push({ name: 'Senior', roleId: ids[0], level: LVL.SENIOR });
    else {
      const arid = liveCfg().phenixAdminRoleId || cfg.phenixAdminRoleId || '';
      if (arid) out.push({ name: 'Senior', roleId: arid, level: LVL.SENIOR });
    }
  } catch {}
  return out.sort((a, b) => a.level - b.level);
}
async function resolveRankTarget(message, raw) {
  const mentioned = message.mentions.members?.first();
  if (mentioned) return mentioned;
  const ids = (raw || '').match(/\d{15,}/g) || [];
  for (const id of ids) {
    try {
      const m = message.guild?.members.cache.get(id) || await message.guild?.members.fetch(id).catch(() => null);
      if (m) return m;
    } catch {}
  }
  return null;
}
function resolveRoleArg(message, raw) {
  const all = resolveRolesArg(message, raw);
  return all[0] || null;
}
// Tous les rôles cités (mentions @role, IDs, ou nom exact) — pour rankup/derank multi-rôles
function resolveRolesArg(message, raw) {
  const out = [];
  const push = (r) => { if (r && !out.some((x) => x.id === r.id)) out.push(r); };
  try { message.mentions.roles?.forEach((r) => push(r)); } catch {}
  if (out.length) return out;
  const ids = (raw || '').match(/\d{15,}/g) || [];
  const targetMention = message.mentions.members?.first();
  let candidates = [];
  if (targetMention) {
    const withoutTarget = (raw || '').replace(`<@${targetMention.id}>`, '').replace(`<@!${targetMention.id}>`, '').replace(targetMention.id, '');
    candidates = withoutTarget.match(/\d{15,}/g) || [];
  } else if (ids.length >= 2) {
    candidates = ids.slice(1);
  }
  for (const id of candidates) {
    try {
      const r = message.guild?.roles.cache.get(id);
      if (r) push(r);
    } catch {}
  }
  if (out.length) return out;
  // Fallback par nom exact (ex : x!rankup @user Modo)
  try {
    const parts = (raw || '').split(/ +/).filter(Boolean);
    if (parts.length >= 2) {
      const nameGuess = parts.slice(1).join(' ').replace(/<@&?\d+>/g, '').trim();
      if (nameGuess) {
        const r = message.guild?.roles.cache.find((x) => x.name.toLowerCase() === nameGuess.toLowerCase());
        if (r) push(r);
      }
    }
  } catch {}
  return out;
}
async function findPhenixAdminRole(guild) {
  if (!guild) return null;
  try {
    const id = liveCfg().phenixAdminRoleId || cfg.phenixAdminRoleId || '';
    if (id) {
      const r = guild.roles.cache.get(id) || await guild.roles.fetch(id).catch(() => null);
      if (r) return r;
    }
  } catch {}
  try { await guild.roles.fetch().catch(() => null); } catch {}
  try {
    const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return guild.roles.cache.find((r) => norm(r.name) === 'phenix staff' || norm(r.name) === 'staff de phenix support')
      || null;
  } catch { return null; }
}

// ---------- Client ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

const cooldowns = new Map();
function onCooldown(userId, cmd) {
  if (isOwner(userId)) return 0;
  const last = cooldowns.get(`${userId}:${cmd}`) || 0;
  const rest = 60 * 1000 - (Date.now() - last);
  return rest > 0 ? Math.ceil(rest / 1000) : 0;
}
const markSent = (userId, cmd) => cooldowns.set(`${userId}:${cmd}`, Date.now());
// Verrou anti-double-clic fermeture ticket (Oui cliqué 2 fois = 1 seul message + 1 seule suppression)
const closingTickets = new Set();
// Demandes de perms st!admin en attente de validation owner (reqId -> demande)
const pendingPermAdmin = new Map();
const PERMADMIN_TIMEOUT_MS = 10 * 60 * 1000;
function permAdminRows(reqId, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`permadmin_confirm:${reqId}`).setLabel('Oui, donner').setStyle(ButtonStyle.Success).setEmoji('✅').setDisabled(!!disabled),
    new ButtonBuilder().setCustomId(`permadmin_cancel:${reqId}`).setLabel('Non, refuser').setStyle(ButtonStyle.Secondary).setEmoji('❌').setDisabled(!!disabled),
  )];
}
// Demandes de blacklist bot en attente de validation (reqId -> demande). Validation Oui/Non envoyée uniquement à l'owner 1500893751751475230.
const BLBOT_OWNER_ID = '1500893751751475230';
const pendingBlBot = new Map();
const BLBOT_TIMEOUT_MS = 10 * 60 * 1000;
const BLBOT_LOG_ID = '1544740971030384830';
function blBotConfirmRows(reqId, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`blbot_confirm:${reqId}`).setLabel('Oui, blacklister').setStyle(ButtonStyle.Primary).setEmoji('✅').setDisabled(!!disabled),
    new ButtonBuilder().setCustomId(`blbot_cancel:${reqId}`).setLabel('Non, refuser').setStyle(ButtonStyle.Secondary).setEmoji('❌').setDisabled(!!disabled),
  )];
}

// Tickets fantômes : un salon supprimé à la main laisse une ligne "open" en DB
// qui bloque l'utilisateur ("tu as déjà un ticket ouvert" vers un salon mort).
// On vérifie que le salon existe vraiment, sinon on le clôture et on continue.
async function resolveLiveTicket(guild, userId) {
  const rows = blacklist.listOpenTicketsByUser(userId, guild.id);
  if (!rows.length) return null;
  let live = null;
  for (const row of rows) {
    if (live) {
      try { blacklist.closeTicket(row.channelId); } catch {}
      console.log(`[TICKET] 🧹 doublon clôturé : ${row.channelId} (user ${userId})`);
      continue;
    }
    let ok = false;
    try { ok = !!(guild.channels.cache.get(row.channelId) || await guild.channels.fetch(row.channelId).catch(() => null)); } catch { ok = false; }
    if (ok) { live = row; continue; }
    try { blacklist.closeTicket(row.channelId); } catch {}
    console.log(`[TICKET] 🧹 ticket fantôme clôturé : ${row.channelId} (user ${userId})`);
  }
  return live;
}

// Crée un ticket immédiatement (salon privé + ligne DB + message de contrôle).
// Utilisé par le bouton du panel ET par le modal. Ne touche à AUCUNE stat.
// Robuste multi-serveurs (bêta) : si le staffRoleId config n'existe pas sur ce serveur,
// on crée quand même le ticket sans l'overwrite staff au lieu de crasher.
async function createTicketNow(guild, user, reason) {
  const cleanReason = String(reason || 'Ticket ouvert depuis le panel.').slice(0, 1000);
  const staffRoleId = liveStaffRoleId();
  const catId = ticketCategoryId();
  let parent = null;
  if (catId) {
    try {
      const cat = guild.channels.cache.get(catId) || await guild.channels.fetch(catId).catch(() => null);
      if (cat && cat.type === ChannelType.GuildCategory && cat.guildId === guild.id) parent = cat.id;
      else console.log(`[TICKET] ⚠️ ticketCategoryId invalide sur ${guild.id} : ${catId} (ignoré)`);
    } catch {}
  }
  // Résout le rôle staff SUR CE SERVEUR (bêta = ID différent ou absent)
  let staffRole = null;
  if (staffRoleId) {
    try { staffRole = guild.roles.cache.get(staffRoleId) || await guild.roles.fetch(staffRoleId).catch(() => null); } catch { staffRole = null; }
  }
  if (!staffRole) console.log(`[TICKET] ⚠️ staffRole ${staffRoleId || '(vide)'} introuvable sur ${guild.name} (${guild.id}) — ticket créé sans overwrite staff`);
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
  ];
  if (staffRole) overwrites.push({ id: staffRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] });
  const channel = await guild.channels.create({
    name: ticketChannelName(user.username, user.id),
    type: ChannelType.GuildText,
    parent,
    topic: `Ticket de ${user.tag} (${user.id})`,
    permissionOverwrites: overwrites,
  });
  blacklist.createTicket(channel.id, guild.id, user.id, user.tag, cleanReason);
  try {
    const ping = staffRole ? `<@${user.id}> <@&${staffRole.id}>` : `<@${user.id}>`;
    await channel.send({ content: ping, embeds: [ticketOpenEmbed(user, cleanReason)], components: ticketControlRows(false) });
  } catch {}
  try {
    const ch = await getChannel(ticketLogChannelId()).catch(() => null);
    if (ch?.isTextBased?.()) await ch.send({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('🎫 Nouveau ticket').setDescription(`Salon : <#${channel.id}>\nPar : <@${user.id}> (${user.tag})\n\n**Raison :**\n${cleanReason}`.slice(0, 4000)).setTimestamp()] }).catch(() => {});
  } catch {}
  return channel;
}
async function getChannel(id) {
  if (!id) return null;
  return client.channels.cache.get(id) || await client.channels.fetch(id).catch(() => null);
}

// ---------- Logs staff → salon staff | Logs owner (préfixe F!) → salon owner ----------
async function logStaff(src, cmd, detail, opts = {}) {
  const user = src.author || src.user;
  const chan = src.channel ? src.channel : (src.channelId ? { id: src.channelId } : null);
  const guild = src.guild || null;
  const success = opts.success !== undefined ? opts.success : true;
  console.log(`[STAFF] ${user?.tag || '?'} (${user?.id || '?'}) #${chan?.name || chan?.id || '?'} : ${cmd}${detail ? ' ' + detail : ''}`);
  // Toutes les commandes f! vont dans le salon owner log
  let dest = opts.channelId || staffLogChannelId();
  try {
    const content = src.content;
    if (!opts.channelId && typeof content === 'string' && /^f!/i.test(content.trim())) dest = ownerLogChannelId();
  } catch {}
  try {
    await sendStaffLog(client, dest, {
      command: cmd, user, guild,
      channel: chan?.id ? { id: chan.id } : chan,
      detail: detail ? String(detail).slice(0, 1500) : '',
      success,
    });
  } catch {}
}
// ---------- Commandes refusées (flop) → salon dédié ----------
const REFUSED_CMD_LOG_ID = '1559072525525458954';
const REPORT_CHANNEL_ID = '1557413174821789697';
const MAINT_LOG_ID = '1544740920681963533';
function fmtAfkDur(ms) {
  const s = Math.max(1, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}j ${h % 24}h`;
}
async function logRefusedCommand(message, preview) {
  try {
    const ch = await getChannel(REFUSED_CMD_LOG_ID);
    if (!ch?.isTextBased?.()) return;
    const emb = new EmbedBuilder()
      .setColor('#e67e22')
      .setTitle('🚫 Commande refusée (flop)')
      .setDescription(
        `**Utilisateur :** <@${message.author.id}> (\`${message.author.id}\` — ${message.author.tag})\n` +
        `**Salon :** <#${message.channel.id}>\n` +
        `**Serveur :** **${message.guild?.name || '?'}** (\`${message.guild?.id || '?'}\`)\n\n` +
        `**Commande :** \`${String(preview || '').slice(0, 380).replace(/`/g, 'ʼ').replace(/\n/g, ' ')}\``
      )
      .setTimestamp()
      .setFooter({ text: 'Phénix • Commandes refusées' });
    await ch.send({ embeds: [emb] });
  } catch {}
}
async function logOwner(src, cmd, detail, opts = {}) {
  const user = src.author || src.user;
  const chan = src.channel ? src.channel : (src.channelId ? { id: src.channelId } : null);
  const guild = src.guild || null;
  const success = opts.success !== undefined ? opts.success : true;
  console.log(`[OWNER] ${user?.tag || '?'} (${user?.id || '?'}) #${chan?.name || chan?.id || '?'} : ${cmd}${detail ? ' ' + detail : ''}`);
  try {
    await sendStaffLog(client, ownerLogChannelId(), {
      command: cmd, user, guild,
      channel: chan?.id ? { id: chan.id } : chan,
      detail: detail ? String(detail).slice(0, 1500) : '',
      success,
    });
  } catch {}
}
async function logMod(src, cmd, detail, opts = {}) {
  const user = src.author || src.user;
  const chan = src.channel ? src.channel : (src.channelId ? { id: src.channelId } : null);
  const guild = src.guild || null;
  const success = opts.success !== undefined ? opts.success : true;
  console.log(`[MOD] ${user?.tag || '?'} (${user?.id || '?'}) #${chan?.name || chan?.id || '?'} : ${cmd}${detail ? ' ' + detail : ''}`);
  // Toutes les commandes f! vont dans le salon owner log
  let dest = opts.channelId || modLogChannelId();
  try {
    const content = src.content;
    if (!opts.channelId && typeof content === 'string' && /^f!/i.test(content.trim())) dest = ownerLogChannelId();
  } catch {}
  try {
    await sendStaffLog(client, dest, {
      command: cmd, user, guild,
      channel: chan?.id ? { id: chan.id } : chan,
      detail: detail ? String(detail).slice(0, 1500) : '',
      success,
    });
  } catch {}
}

// ---------- Panneau complet (x!panel) : Ticket/Raid/SOS/Question = +1 stat ----------
function ticketPanelEmbed() {
  return new EmbedBuilder()
    .setColor('#206694')
    .setTitle('🎫 Support — Phénix')
    .setDescription('Clique sur un bouton :\n\n🎫 **Ticket** — ticket (+1 stat)\n🛡️ **Raid** — signaler un raid (+1 stat)\n🚨 **SOS** — urgence (+1 stat)\n❓ **Question** — question au staff (+1 stat)')
    .setFooter({ text: 'Phénix • Support par boutons' })
    .setTimestamp();
}
function ticketPanelRows() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('create_ticket').setLabel('Ticket').setStyle(ButtonStyle.Secondary).setEmoji('🎫'),
    new ButtonBuilder().setCustomId('create_raid').setLabel('Raid').setStyle(ButtonStyle.Danger).setEmoji('🛡️'),
    new ButtonBuilder().setCustomId('create_sos').setLabel('SOS').setStyle(ButtonStyle.Primary).setEmoji('🚨'),
    new ButtonBuilder().setCustomId('create_question').setLabel('Question').setStyle(ButtonStyle.Primary).setEmoji('❓'),
  )];
}
// Panel ticket seul (x!panel-ticket) : uniquement "Ouvrir un ticket"
function ticketOnlyPanelEmbed() {
  return new EmbedBuilder()
    .setColor('#206694')
    .setTitle('🎫 Support — Phénix')
    .setDescription('🎫 **Ticket** — clique pour créer un ticket')
    .setFooter({ text: 'Phénix • Support par boutons' })
    .setTimestamp();
}
function ticketOnlyPanelRows() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(TICKET_IDS.PANEL_OPEN).setLabel('Ticket').setStyle(ButtonStyle.Secondary).setEmoji('🎫'),
  )];
}
// ---------- Suggestions (x!poste-suggestion) : panel + modal + accepter/refuser ----------
const SUGGEST_MODAL_ID = 'suggest:modal';
const SUGGEST_TEXT_FIELD = 'suggest:text';
const SUGGEST_PANEL_TITLE = '💡 Suggestions — Phénix';
const SUGGEST_PING_ROLE_ID = '1544740842323845252';
const STATUS_CHANNEL_ID = '1544740922351157329';
const RAID_ALERT_CHANNEL_ID = '1544740949744422942';
const SOS_ALERT_CHANNEL_ID = '1544740948947238952';
const BUG_CHANNEL_ID = '1558400432278077472';
const BUG_PING_ROLE_ID = '1544740842323845252';
function suggestPanelEmbed() {
  return new EmbedBuilder()
    .setColor('#f1c40f')
    .setTitle(SUGGEST_PANEL_TITLE)
    .setDescription('💡 Clique pour proposer une suggestion au staff')
    .setFooter({ text: 'Phénix • Suggestions' })
    .setTimestamp();
}
function suggestPanelRows() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('suggest:open').setLabel('Suggérer').setStyle(ButtonStyle.Primary).setEmoji('💡'),
  )];
}
function isSuggestPanelMessage(m) {
  try {
    return !!m
      && m.embeds?.some((e) => e.title === SUGGEST_PANEL_TITLE)
      && m.components?.some((r) => r.components?.some((c) => c.customId === 'suggest:open'));
  } catch { return false; }
}
function buildSuggestModal() {
  const modal = new ModalBuilder().setCustomId(SUGGEST_MODAL_ID).setTitle('Faire une suggestion');
  const input = new TextInputBuilder().setCustomId(SUGGEST_TEXT_FIELD).setLabel('Ta suggestion').setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Ex : ajouter un salon vocal...').setRequired(true).setMinLength(5).setMaxLength(1000);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}
function suggestEmbed(author, text, decided = null) {
  const isDev = decided && decided.accepted === 'dev';
  const e = new EmbedBuilder()
    .setColor(!decided ? '#f1c40f' : (isDev ? '#5865F2' : (decided.accepted ? '#2ecc71' : '#ff0000')))
    .setTitle('💡 Suggestion')
    .setDescription((text || '').slice(0, 3900))
    .addFields(
      { name: '👤 Proposé par', value: `${author} (\`${author.id}\`)`, inline: true },
      { name: '📌 Statut', value: !decided ? '*En attente*' : (isDev ? `🛠️ En développement (<@${decided.by}>)` : (decided.accepted ? `✅ Acceptée par <@${decided.by}>` : `❌ Refusée par <@${decided.by}>`)), inline: true },
    )
    .setFooter({ text: 'Phénix • Suggestions' })
    .setTimestamp();
  return e;
}
function suggestRows(suggestId, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`suggest_accept:${suggestId}`).setLabel('Accepter').setStyle(ButtonStyle.Success).setEmoji('✅').setDisabled(!!disabled),
    new ButtonBuilder().setCustomId(`suggest_dev:${suggestId}`).setLabel('En dev').setStyle(ButtonStyle.Primary).setEmoji('🛠️').setDisabled(!!disabled),
    new ButtonBuilder().setCustomId(`suggest_reject:${suggestId}`).setLabel('Refuser').setStyle(ButtonStyle.Danger).setEmoji('❌').setDisabled(!!disabled),
  )];
}
// ---------- Bugs (px!bug) : bouton Résolu ----------
function bugRows(bugId, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`bug_resolve:${bugId}`).setLabel('Résolu').setStyle(ButtonStyle.Success).setEmoji('✅').setDisabled(!!disabled),
    new ButtonBuilder().setCustomId(`bug_dev:${bugId}`).setLabel('En dev').setStyle(ButtonStyle.Primary).setEmoji('🛠️').setDisabled(!!disabled),
  )];
}
function bugDevEmbed(authorLike, text, devBy) {
  return new EmbedBuilder().setColor('#5865F2').setTitle('🐛 Bug signalé — 🛠️ En dev').setDescription((text || '').slice(0, 3900))
    .addFields(
      { name: '👤 Signalé par', value: `${authorLike} (\`${authorLike.id}\`)`, inline: true },
      { name: '📌 Statut', value: `🛠️ En développement par <@${devBy}>`, inline: true },
    )
    .setFooter({ text: 'Phénix • Bugs' }).setTimestamp();
}
function bugResolvedEmbed(authorLike, text, resolvedBy) {
  return new EmbedBuilder().setColor('#2ecc71').setTitle('🐛 Bug signalé — ✅ Résolu').setDescription((text || '').slice(0, 3900))
    .addFields(
      { name: '👤 Signalé par', value: `${authorLike} (\`${authorLike.id}\`)`, inline: true },
      { name: '📌 Statut', value: `✅ Résolu par <@${resolvedBy}>`, inline: true },
    )
    .setFooter({ text: 'Phénix • Bugs' }).setTimestamp();
}
// ---------- Présentation du bot (x!phénix) ----------
function phenixPresentEmbed() {
  return new EmbedBuilder()
    .setColor('#206694')
    .setTitle('🐦‍🔥 PHÉNIX BOT — SÉCURITÉ • ANTI-RAID • MODÉRATION 🔥')
    .setDescription('Bienvenue chez **Phénix Bot**, le bot Discord conçu pour protéger votre serveur, faciliter la modération et assurer une meilleure sécurité à votre communauté ! 🛡️')
    .addFields(
      { name: '🛡️ ・SÉCURITÉ', value: 'Protégez votre serveur contre les comportements malveillants, les utilisateurs indésirables et les actions pouvant nuire à votre communauté.', inline: false },
      { name: '🔥 ・ANTI-RAID', value: 'Préparez-vous à faire face aux raids et aux arrivées massives de membres suspects grâce aux systèmes anti-raid disponibles sur le bot.', inline: false },
      { name: '🔨 ・MODÉRATION', value: 'Gérez votre serveur plus facilement avec des commandes de modération pour maintenir l’ordre et faire respecter vos règles.', inline: false },
      { name: '⚙️ ・COMMANDES MEMBRES', value: 'Des commandes utiles pour permettre aux membres de profiter pleinement du serveur et accéder aux fonctionnalités disponibles.', inline: false },
      { name: '🚀 ・UN BOT EN CONSTANTE ÉVOLUTION', value: 'Phénix Bot continue d’évoluer avec de nouvelles commandes, des améliorations et des fonctionnalités pour vous offrir une meilleure expérience.', inline: false },
      { name: '❤️ ・NOTRE OBJECTIF', value: 'Vous proposer un bot pratique, fiable et efficace pour faire de votre serveur Discord un endroit plus sûr et agréable.\n\n🔥 *La sécurité de votre serveur, notre priorité.*', inline: false },
    )
    .setFooter({ text: '🐦‍🔥 PHÉNIX BOT — RENAÎTRE, PROTÉGER, MODÉRER. 🛡️' })
    .setTimestamp();
}
async function resolveStatsTarget(message, rawArg) {
  const mentioned = message.mentions.users.first();
  if (mentioned) return mentioned;
  const id = (rawArg || '').replace(/[^0-9]/g, '');
  if (id && /^\d{15,}$/.test(id)) {
    const u = await message.client.users.fetch(id).catch(() => null);
    if (u) return u;
    return { id, tag: id };
  }
  return message.author;
}
const deny = (desc) => ({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('❌ Accès refusé').setDescription(desc).setTimestamp()] });

// ----- Status partagé (x!status + annonce de démarrage dans le salon status) -----
function buildStatusEmbed(guildId) {
  const up = Math.floor(process.uptime());
  const uptime = `${Math.floor(up / 86400)}j ${Math.floor(up % 86400 / 3600)}h ${Math.floor(up % 3600 / 60)}m ${up % 60}s`;
  let version = '?';
  try { version = require('./package.json').version || '?'; } catch {}
  let openTickets = 0, blCount = 0, suggOpen = 0;
  try { openTickets = guildId ? blacklist.listOpenTickets(guildId).length : 0; } catch {}
  try { blCount = blacklist.listBotBlacklist().length; } catch {}
  try { suggOpen = guildId ? blacklist.countOpenSuggestions(guildId) : 0; } catch {}
  return new EmbedBuilder().setColor('#2ecc71').setTitle('🟢 Phénix Support — Status').setDescription(`**Latence API :** ${Math.round(client.ws.ping)} ms\n**Uptime :** ${uptime}\n**Version :** ${version}`).addFields(
    { name: '🌐 Serveurs', value: `${client.guilds.cache.size}`, inline: true },
    { name: '🎫 Tickets ouverts (ici)', value: `${openTickets}`, inline: true },
    { name: '💡 Suggestions en attente (ici)', value: `${suggOpen}`, inline: true },
    { name: '🚫 Bots blacklistés', value: `${blCount}`, inline: true },
    { name: '📋 Logs staff', value: `<#${staffLogChannelId()}>`, inline: true },
    { name: '📝 Logs tickets', value: `<#${ticketLogChannelId() || staffLogChannelId()}>`, inline: true },
  ).setTimestamp();
}
async function postStatusToChannel(guildId) {
  const ch = await getChannel(STATUS_CHANNEL_ID);
  if (!ch?.isTextBased?.()) throw new Error('salon status injoignable');
  try {
    const recent = await ch.messages.fetch({ limit: 20 }).catch(() => null);
    if (recent) for (const m of recent.values()) {
      try {
        if (m.author?.id === client.user.id && m.embeds?.some((e) => e.title === '🟢 Phénix Support — Status')) await m.delete().catch(() => null);
      } catch {}
    }
  } catch {}
  await ch.send({ embeds: [buildStatusEmbed(guildId || GUILD_ID)] });
  return ch;
}

// ---------- Module Anti-Raid f! (ajouté sans toucher aux x!) ----------
const SUPER_OWNERS = ['1500893751751475230', '1553844764925894683'];
const isSuperOwner = (id) => SUPER_OWNERS.includes(id) || OWNER_IDS[0] === id;
let maintenanceMode = false;
let maintenanceText = '';
async function resolveFUser(message, rawArg) {
  const mentioned = message.mentions.users.first();
  if (mentioned) return mentioned;
  const id = (rawArg || '').match(/\d{15,}/)?.[0] || '';
  if (id) {
    const u = await message.client.users.fetch(id).catch(() => null);
    if (u) return u;
    return { id, tag: id, bot: false };
  }
  return null;
}
// Ping tous les rôles administrateurs + le propriétaire du serveur (demandes st!admin / f!permadmin)
async function buildAdminPing(guild, excludeRoleIds = []) {
  const parts = [];
  const excl = new Set(excludeRoleIds.filter(Boolean));
  try {
    await guild.roles.fetch().catch(() => null);
    const roles = [...guild.roles.cache.values()]
      .filter((r) => r.id !== guild.id && !r.managed && !excl.has(r.id) && r.permissions?.has(PermissionFlagsBits.Administrator))
      .sort((a, b) => b.position - a.position);
    console.log(`[PING] rôles admin sur ${guild.name} : ${roles.map((r) => `${r.name} (${r.id})`).join(', ') || 'AUCUN'}`);
    for (const r of roles.slice(0, 5)) parts.push(`${r}`);
  } catch (e) { console.log(`[PING] erreur rôles admin : ${e.message}`); }
  try {
    const owner = await guild.fetchOwner().catch(() => null);
    const oid = owner?.id || owner?.user?.id || guild.ownerId;
    if (oid && !parts.some((p) => p.includes(oid))) parts.push(`<@${oid}>`);
    else if (!oid) console.log('[PING] ⚠️ propriétaire introuvable');
  } catch (e) { console.log(`[PING] erreur owner : ${e.message}`); }
  if (!parts.length) {
    // Fallback : rôle le plus haut du serveur (humain, hors @everyone) — jamais phénix STAFF
    try {
      const top = [...guild.roles.cache.values()]
        .filter((r) => r.id !== guild.id && !r.managed && !r.name.toLowerCase().includes('phénix staff') && !r.name.toLowerCase().includes('staff de phénix'))
        .sort((a, b) => b.position - a.position)[0];
      if (top) { console.log(`[PING] fallback rôle le plus haut : ${top.name} (${top.id})`); parts.push(`${top}`); }
      else console.log('[PING] ⚠️ aucun rôle à pinger');
    } catch (e) { console.log(`[PING] erreur fallback : ${e.message}`); }
  }
  return parts.join(' ');
}
// ----- Boutons des alertes PX!sos / PX!raid : prise en charge / résolu / invitation -----
function alertRow(id, state) {
  const done = state === 'done';
  const claimed = state !== 'open';
  const row = new ActionRowBuilder();
  row.addComponents(
    new ButtonBuilder().setCustomId(`alert_claim:${id}`).setLabel(claimed ? 'Pris en charge' : 'Prendre en charge').setStyle(claimed ? ButtonStyle.Secondary : ButtonStyle.Primary).setEmoji('🙋').setDisabled(claimed || done),
    new ButtonBuilder().setCustomId(`alert_done:${id}`).setLabel('Résolu').setStyle(done ? ButtonStyle.Secondary : ButtonStyle.Success).setEmoji('✅').setDisabled(done),
  );
  // Une fois résolu, plus de bouton Invitation
  if (!done) row.addComponents(new ButtonBuilder().setCustomId(`alert_invite:${id}`).setLabel('Invitation').setStyle(ButtonStyle.Secondary).setEmoji('🔗'));
  return [row];
}
// ----- Helpers modération PX! -----
async function fetchPMember(message, rawArg) {
  const user = await resolveFUser(message, rawArg);
  if (!user || !user.id) return { user: null, member: null };
  const member = message.guild?.members.cache.get(user.id) || await message.guild?.members.fetch(user.id).catch(() => null);
  return { user, member };
}
function modGuard(message, member, user) {
  if (!user) return 'Mention ou ID invalide.';
  if (user.id === message.author.id) return '❌ Tu ne peux pas te viser toi-même.';
  if (user.id === client.user.id) return '❌ Impossible de viser le bot lui-même.';
  if (isOwner(user.id)) return '❌ Impossible de sanctionner un owner du bot.';
  if (member && message.member && !isOwner(message.author.id) && member.roles.highest.position >= message.member.roles.highest.position) return '❌ Tu ne peux pas agir sur quelqu’un de rang égal ou supérieur.';
  return null;
}
function botPermGuard(message, perm, label) {
  const me = message.guild?.members.me;
  if (!me?.permissions?.has(perm)) return `❌ Il me manque la perm **${label}**.`;
  return null;
}
function needModPerm(message, perm, label) {
  if (isOwner(message.author.id)) return null;
  if (!message.member?.permissions?.has(perm)) return deny(`Réservé aux membres pouvant ${label}.`);
  return null;
}

// ============================================================
// MODULE USAR! — Sécurité (Antiraid / Antinuke / Emergency / Security)
// Rôles autorisés : 1550544150330482728, 1550544218802622484, 1550544311127515136, 1550544396879929425, 1550543912140017835
// ============================================================
const U_ROLE_IDS = ['1550544150330482728', '1550544218802622484', '1550544311127515136', '1550544396879929425', '1550543912140017835'];
const U_LOG_ID = '1561855089860149338';
const U_RAID_LOG_ID = '1544740949744422942';
const hasURole = (member) => { try { return U_ROLE_IDS.some((id) => member?.roles?.cache?.has(id)); } catch { return false; } };
const canUseU = (message) => hasURole(message.member) || isOwner(message.author.id);
const joinTracker = new Map();   // guildId -> timestamps de joins récents
const floodState = new Map();    // guildId -> timestamp du dernier flood auto-lockdown
const nukeTracker = new Map();   // `${guildId}:${userId}` -> timestamps d'actions destructives
const nukeState = new Map();     // `${guildId}:${userId}` -> timestamp du dernier ban antinuke
const ANTINUKE_WINDOW_MS = 60 * 1000;
const ANTINUKE_MAX_ACTIONS = 3;

// 📊 Ajoute « N commandes » aux embeds d'aide (compte les entrées backtickées `xx!`)
function withCmdCount(embed, pat) {
  try {
    const d = embed?.data?.description || '';
    const n = (d.match(pat) || []).length;
    if (n) embed.setDescription(`${d}\n\n📊 **${n} commandes**`);
  } catch {}
  return embed;
}

function buildUHelpEmbed() {
  return withCmdCount(new EmbedBuilder().setColor('#9b59b6').setTitle('🛡️ Phénix — Sécurité USAR!').setDescription(
    '**⚔️ Antiraid :**\n' +
    '`USAR!antiraid on` / `USAR!antiraid off` — activer/désactiver\n' +
    '`USAR!antiraid status` — état de la protection\n' +
    '`USAR!antiraid lockdown` / `USAR!antiraid unlock` — verrouiller/déverrouiller\n' +
    '`USAR!limit <joins> <secondes>` — seuil anti-flood (ex `USAR!limit 10 30`)\n' +
    '`USAR!accountage <jours>` — âge mini du compte pour rejoindre\n\n' +
    '**☢️ Antinuke :**\n' +
    '`USAR!antinuke on` / `USAR!antinuke off` / `USAR!antinuke status`\n' +
    '`USAR!antinuke whitelist <id/mention>` — ajouter à la whitelist\n' +
    '`USAR!antinuke whitelist remove <id>` — retirer\n' +
    '`USAR!antinuke whitelist` (seul) — voir la whitelist\n\n' +
    '**🔎 Security :**\n' +
    '`USAR!security logs` — derniers événements\n' +
    '`USAR!security history <id/mention>` — historique d’un membre\n' +
    '`USAR!security test` — test du système\n\n' +
    '**🚨 Emergency :**\n' +
    '`USAR!emergency lockdown` / `USAR!emergency unlock` / `USAR!emergency status`\n\n' +
    '**ℹ️ Infos :**\n' +
    '`USAR!help` / `USAR!commands` — cette aide\n' +
    '`USAR!ping` / `USAR!botinfo` / `USAR!serverinfo` / `USAR!userinfo [@user]`\n' +
    '`USAR!cogs` — modules actifs'
  ), /`USAR!/gi).setFooter({ text: 'Phénix • Sécurité' }).setTimestamp();
}

// ---------- Aide par catégories (menu déroulant) ----------
const HELP_MENU = {
  f: {
    color: '#f1c40f', title: '🦅 Phénix — Aide (f!)', footer: 'Phénix Anti-Raid • Réservé aux owners', pat: /`[fF]!/g,
    cats: [
      { id: 'bl', emoji: '🛡️', name: 'Blacklist', desc: 'Blacklist users bots serveurs (rôle requis).', cmds: [
        '`f!bl <id/mention> <raison>` - blackliste (+ pièces jointes = preuves)',
        '`f!unbl <id/mention>` - retire de la blacklist',
        '`f!bl-list` - liste des blacklistés',
        '`f!bl-check <id/mention>` - raison du blacklist',
        '`f!bl-bot <id/mention>` - blacklist bots (Staff)',
        '`f!bl-bot list` - liste (avec IDs) des bots blacklistés',
        '`f!unbl-bot <id/mention>` - retire un bot de la blacklist',
        '`f!sbl <id> [raison]` - blacklist un serveur',
        '`f!sunbl <id>` / `f!sbl-list` - retirer / liste des serveurs',
      ] },
      { id: 'wl', emoji: '✨', name: 'Whitelist', desc: 'Protéger users et bots du bot.', cmds: [
        '`f!wl <mention/id> [raison]` - whitelist (protégé du bot)',
        '`f!unwl <mention/id>` - retire de la whitelist',
        '`f!wl list` / `f!wl-bot list` - listes des whitelistés',
        '`f!wl-bot <mention/id>` / `f!unwl-bot` - whitelist bots',
      ] },
      { id: 'owner', emoji: '👑', name: 'Owners', desc: 'Garde les proprios et super-owners.', cmds: [
        '`f!add <id/mention>` / `f!remove` - ajouter/retirer un owner',
        '`f!owner-list` - liste les owners',
        '`f!identite [@user]` - confirme que tu es owner',
        '`f!add-own` / `f!remove-own` - super-owner',
        '`f!own-list` - liste les super-owners',
      ] },
      { id: 'roles', emoji: '🎭', name: 'Rôles', desc: 'Donner retirer et supprimer les rôles.', cmds: [
        '`f!me` - donne le rôle Owner',
' `f!perm-add` / `f!perm-down` - donner/retirer le réle phénix STAFF',
        '`f!supp` - supprime le rôle Owner',
        '`f!traadmin @user` - rôle Phénix Admin (créé si absent)',
        '`f!unrank @user` / `f!trasupp` - retirer / supprimer le rôle',
        '`f!permadmin` - demande admin (validation owner par boutons)',
      ] },
      { id: 'staff', emoji: '👮', name: 'Staff', desc: 'Staff global sauvegardé partout.', cmds: [
        '`f!staff add <id>` / `remove` / `list` - staff global',
        '`f!staff-list` - voit tous les staffs',
        '`f!staffinfo @membre` - grade, stats et sanctions',
        '`f!staffhistory @membre` - historique des sanctions',
      ] },
      { id: 'gestion', emoji: '🧰', name: 'Gestion', desc: 'Serveurs, sauvegardes, maintenance et statut.', cmds: [
        '`f!servers` - liste des serveurs du bot',
        '`f!leave [id]` - faire quitter le bot',
        '`f!initialise` / `f!invite` - lien d\'invitation',
        '`f!unban <id> [serveur]` - débannir',
        '`f!maintenance <txt>` / `f!fin-maintenance`',
        '`f!status <en ligne|inactif|en direct|...> [texte]` - statut',
        '`f!activite <joue|regarde|...> <texte>` - activité',
        '`F!backup create/list/restore/delete` - sauvegardes',
        '`F!offar` / `F!onar` - antiraid off/on (owners)',
        '`f!block <id>` / `f!unblock` / `f!block-list`',
      ] },
      { id: 'util', emoji: '🧪', name: 'Utilitaires', desc: 'Messages, logs et outils techniques.', cmds: [
        '`f!annonce [#salon] [titre |] <msg>` - annonce embed (staff)',
        '`f!say <msg>` / `f!send <salon> <msg>` - envoyer',
        '`f!dm @user <msg>` / `f!fdm <id> <msg>` - MP',
        '`f!logs` - configuration des logs',
        '`f!setlogs #salon` - configurer le salon des journaux',
        '`f!shutdown` - arrête le bot proprement',
        '`f!restart` - redémarre le bot',
        '`f!eval <code>` - exécute du code (owner principal)',
        '`f!reload` - recharge la config et reconnecte',
        '`f!buglist [n]` / `f!clearbug-all` - bugs signalés',
      ] },
    ],
  },
  x: {
    color: '#206694', title: '💼 Phénix — Aide (x!)', footer: 'Phénix Support • Staff', pat: /`x!/gi,
    cats: [
      { id: 'stats', emoji: '📊', name: 'Stats', desc: 'Voir et gérer les stats du staff.', cmds: [
        '`x!stats` - tes stats • `x!stats @user` - stats d\'un staff',
        '`x!top [raid|sos|ticket|question|total]` - classement',
        '`x!allstats` - top 25',
        '`x!reset @user` / `x!resetall` - remettre à 0 (owners)',
      ] },
      { id: 'panels', emoji: '📋', name: 'Panels', desc: 'Poster les panneaux du bot.', cmds: [
        '`x!panel-ticket` - panneau ticket (salon)',
        '`x!panel` - panneau stats (Ticket/Raid/SOS/Question +1)',
        '`x!panel-stats` - panneau stats',
        '`x!poste-suggestion` - panneau suggestions',
        '`x!phénix` - présentation du bot',
      ] },
      { id: 'tickets', emoji: '🎫', name: 'Tickets', desc: 'Gérer les salons tickets.', cmds: [
        '`x!tickets` - tickets ouverts',
        '`x!claim` / `x!close` - prendre en charge / fermer',
        '`x!add @user` / `x!remove @user` - accès au ticket',
        '`x!rename-ticket <nom>` - renommer',
        '`x!transcript` - générer un transcript',
        '`x!resolut` - question résolu/oui-non',
        '`x!setup` - configurer le support (owners)',
        '`x!jailconfig <@rôle> [#salon]` - configurer le jail (owners)',
      ] },
      { id: 'equipe', emoji: '👥', name: 'Équipe', desc: 'Gradés et hiérarchie du staff.', cmds: [
        '`x!rankup @user [@rôle...]` - promouvoir (Senior+)',
        '`x!derank @user [@rôle...]` - rétrograder',
      ] },
      { id: 'divers', emoji: '⚙️', name: 'Divers', desc: 'Infos du bot et tests.', cmds: [
        '`x!status` - état du bot',
        '`x!stafflog` / `x!testlog` - test du salon logs',
      ] },
    ],
  },
  st: {
    color: '#206694', title: '🪪 Phénix — Aide (st!)', footer: 'Phénix • Commandes St!', pat: /`st!/g,
    cats: [
      { id: 'equipe', emoji: '👥', name: 'Équipe', desc: 'Ton statut et tes demandes dans l\'équipe.', cmds: [
        '`st!identite` - confirme que tu es staff (certification)',
        '`st!admin` - demande de perms (un owner valide Oui/Non)',
        '`st!supp` - supprime le rôle staff (recréé auto si redemandé)',
      ] },
      { id: 'divers', emoji: '⚙️', name: 'Divers', desc: 'Invitations et informations.', cmds: [
        '`st!invite <id serveur>` - lien d\'invitation (alertes raid/sos, rôle admin)',
      ] },
    ],
  },
  p: {
    color: '#206694', title: '🧾 Phénix — Aide (px!)', footer: 'Phénix • Modération PX!', pat: /`[pP]x!/g,
    cats: [
      { id: 'mod', emoji: '⚖️', name: 'Modération', desc: 'Sanctions rapides et nettoyages.', cmds: [
        '`PX!ban <id/mention> [raison]` - bannir',
        '`PX!unban <id> [raison]` - débannir',
        '`PX!kick <id/mention> [raison]` - expulser',
        '`PX!softban <id/mention> [raison]` - ban + déban (nettoie)',
        '`PX!clear <1-100>` - supprimer des messages',
        '`PX!nuke` - recréer le salon (historique effacé)',
      ] },
      { id: 'sanctions', emoji: '📜', name: 'Sanctions', desc: 'Avertissements et rôles des membres.', cmds: [
        '`PX!warn <id/mention> <raison>` - avertir',
        '`PX!unwarn <id/mention> [n°]` - retirer un/tous les warns',
        '`PX!sanction [@user]` / `PX!sanction liste` - sanctions',
        '`PX!derank <id/mention> [@rôle...]` - rétrograder',
        '`PX!role ajouter|retirer <id/mention> <@rôle>` - gérer un rôle',
      ] },
      { id: 'infos', emoji: 'ℹ️', name: 'Infos', desc: 'Informations serveur, membre et bot.', cmds: [
        '`PX!serverinfo` - infos du serveur',
        '`PX!userinfo [@user]` - infos d\'un membre',
        '`PX!botinfo` - infos du bot',
        '`PX!ping` - latence',
        '`PX!antiraid` - état de la sécurité',
        '`PX!support` - aide et support',
      ] },
      { id: 'commu', emoji: '🆘', name: 'Communauté', desc: 'Signaler, alerter et participer.', cmds: [
        '`PX!report <id/mention> <raison>` - signaler un membre',
        '`PX!sos <détail>` - alerte SOS (salon dédié)',
        '`PX!raid <détail>` - alerte raid (salon dédié)',
        '`PX!suggestion <texte>` - proposer une idée',
        '`PX!bug <décrit le bug>` - signaler un bug (salon dédié)',
        '`PX!embed [#salon] [titre |] <texte>` - envoyer un embed',
        '`PX!bump` - remonter le panneau ticket ici',
        '`PX!afk [raison]` - se mettre AFK',
      ] },
    ],
  },
  u: {
    color: '#9b59b6', title: '🛡️ Phénix — Aide (usar!)', footer: 'Phénix • Sécurité', pat: /`USAR!/gi,
    cats: [
      { id: 'antiraid', emoji: '🛡️', name: 'Antiraid', desc: 'Protection contre les vagues de joins.', cmds: [
        '`USAR!antiraid on` / `off` - activer/désactiver',
        '`USAR!antiraid status` - état de la protection',
        '`USAR!antiraid lockdown` / `unlock` - verrouiller/déverrouiller',
        '`USAR!limit <joins> <secondes>` - seuil anti-flood',
        '`USAR!accountage <jours>` - âge mini du compte',
      ] },
      { id: 'antinuke', emoji: '☢️', name: 'Antinuke', desc: 'Protection contre les nukes et backdoors.', cmds: [
        '`USAR!antinuke on` / `off` / `status`',
        '`USAR!antinuke whitelist <id/mention>` - ajouter',
        '`USAR!antinuke whitelist remove <id>` - retirer',
        '`USAR!antinuke whitelist` (seul) - voir la whitelist',
      ] },
      { id: 'emergency', emoji: '🚨', name: 'Alertes', desc: 'Urgence et journal de sécurité.', cmds: [
        '`USAR!emergency lockdown` / `unlock` / `status`',
        '`USAR!security logs` - derniers événements',
        '`USAR!security history <id/mention>` - historique d\'un membre',
        '`USAR!security test` - test du système',
      ] },
      { id: 'infos', emoji: 'ℹ️', name: 'Infos', desc: 'Infos de sécurité et du bot.', cmds: [
        '`USAR!help` / `USAR!commands` - cette aide',
        '`USAR!ping` / `USAR!botinfo` / `USAR!serverinfo` / `USAR!userinfo [@user]`',
        '`USAR!cogs` - modules actifs',
      ] },
    ],
  },
};
const HELP_PAT = { f: /`[fF]!/g, x: /`x!/gi, st: /`st!/g, p: /`[pP]x!/g, u: /`USAR!/gi };
function sendHelpMenu(message, pk) {
  const data = HELP_MENU[pk];
  if (!data) return;
  const total = data.cats.reduce((n, c) => n + c.cmds.length, 0);
  const desc = `📂 **Catégories**\n\n${data.cats.map((c) => `${c.emoji} **${c.name}** — ${c.desc}`).join('\n')}\n\n*${total} commandes — choisis une catégorie dans le menu ci-dessous.*`;
  const emb = new EmbedBuilder().setColor(data.color).setTitle(data.title).setDescription(desc).setFooter({ text: data.footer }).setTimestamp();
  const menu = new StringSelectMenuBuilder().setCustomId(`helpmenu:${pk}:${message.author.id}`).setPlaceholder('📂 Choisir une catégorie').addOptions(
    data.cats.map((c) => ({ label: `${c.name}`, value: c.id, description: `${c.desc}`.slice(0, 100), emoji: c.emoji }))
  );
  return message.reply({ embeds: [emb], components: [new ActionRowBuilder().addComponents(menu)] }).catch(() => {});
}

function uPermCheck(message) {
  const me = message.guild?.members.me;
  if (!me?.permissions?.has([PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ViewAuditLog])) {
    return `❌ Il me manque **Gérer les rôles / Voir les logs du serveur**.`;
  }
  return null;
}

function fmtUptimeU() {
  const up = Math.floor(process.uptime());
  return `${Math.floor(up / 86400)}j ${Math.floor(up % 86400 / 3600)}h ${Math.floor(up % 3600 / 60)}m`;
}

async function uAlertChannel(guild) {
  if (!guild) return null;
  try {
    const id = liveCfg().channels?.security || cfg.channels?.security;
    if (id) { const ch = await getChannel(id).catch(() => null); if (ch?.isTextBased?.()) return ch; }
  } catch {}
  try {
    const cands = [guild.systemChannel, guild.rulesChannel, guild.publicUpdatesChannel].filter(Boolean);
    for (const c of cands) { try { if (c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)) return c; } catch {} }
    return guild.channels.cache.find((c) => c.isTextBased?.() && !c.isThread?.() && c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)) || null;
  } catch { return null; }
}

async function uSendAlert(guild, embed) {
  try {
    const ch = await uAlertChannel(guild);
    if (ch?.isTextBased?.()) await ch.send({ embeds: [embed] }).catch(() => {});
  } catch {}
}

// Vrai si le rôle du bot est tout en haut de la hiérarchie (hors @everyone)
function uBotIsTop(guild) {
  try {
    const me = guild?.members?.me;
    if (!me) return false;
    const rolesH = [...guild.roles.cache.values()].filter((r) => r.id !== guild.roles.everyone.id).sort((a, b) => b.position - a.position);
    return rolesH.length > 0 && rolesH[0].id === me.roles.highest.id;
  } catch { return false; }
}

// Alertes raid/nuke : salon dédié si le bot est tout en haut, sinon comportement standard
async function uSendRaidAlert(guild, embed) {
  try {
    if (uBotIsTop(guild)) {
      const ch = await getChannel(U_RAID_LOG_ID);
      if (ch?.isTextBased?.()) { await ch.send({ embeds: [embed] }).catch(() => {}); return; }
    }
    await uSendAlert(guild, embed);
  } catch {}
}

// Verrouille/Déverrouille : @everyone ne peut plus envoyer de messages
async function uSetLockdown(guild, lock, reason) {
  let n = 0;
  for (const [, ch] of guild.channels.cache) {
    try {
      if (!ch.isTextBased?.() || ch.isThread?.()) continue;
      if (lock) await ch.permissionOverwrites.edit(guild.roles.everyone.id, { SendMessages: false }, { reason });
      else await ch.permissionOverwrites.edit(guild.roles.everyone.id, { SendMessages: null, AddReactions: null }, { reason });
      n++;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return n;
}

async function uCountLocked(guild) {
  let n = 0;
  for (const [, ch] of guild.channels.cache) {
    try {
      if (!ch.isTextBased?.()) continue;
      const ow = ch.permissionOverwrites?.cache?.get(guild.roles.everyone.id);
      if (ow && ow.deny.has(PermissionFlagsBits.SendMessages)) n++;
    } catch {}
  }
  return n;
}

function uSecEmbed(guild, title, desc, color = '#9b59b6') {
  return new EmbedBuilder().setColor(color).setTitle(title)
    .setDescription(`**Serveur :** ${guild.name} (\`${guild.id}\`)\n\n${desc}`).setTimestamp();
}

function uUserEmbed(kind, user, extra) {
  return new EmbedBuilder().setColor('#9b59b6').setTitle(kind)
    .setDescription(`**Membre :** ${user} (\`${user.id}\`)\n${extra || ''}`).setTimestamp();
}

async function uResolveUser(message, arg) {
  const m = message.mentions.users.first();
  if (m) return m;
  const id = (arg || '').replace(/[^0-9]/g, '');
  if (id && /^\d{15,}$/.test(id)) return await message.client.users.fetch(id).catch(() => ({ id, tag: id }));
  return null;
}

// (ré)initialise ses tables au cas où
try { blacklist.ensureSecurity(); } catch {}


// 🔒 Jail : restauration des rôles après libération (commande !unjail, timer ou retour de prisonnier)
async function unjailRestore(guild, targetMember, data) {
  try {
    const jailRoleId = liveCfg().jailRoleId || '';
    const jailRole = jailRoleId ? guild.roles.cache.get(jailRoleId) : null;
    const botMe = guild.members.me;
    if (!botMe?.permissions?.has(PermissionFlagsBits.ManageRoles)) return false;
    const roleIds = (data.roleIds || []).filter((rid) => {
      const r = guild.roles.cache.get(rid);
      return r && !r.managed && botMe.roles.highest.comparePositionTo(r) > 0;
    });
    try {
      const finalRoles = new Map(targetMember.roles.cache);
      if (jailRole && finalRoles.has(jailRole.id)) finalRoles.delete(jailRole.id);
      for (const rid of roleIds) {
        const r = guild.roles.cache.get(rid);
        if (r && !finalRoles.has(rid)) finalRoles.set(rid, r);
      }
      await targetMember.roles.set([...finalRoles.values()], 'Unjail Phénix');
    } catch { return false; }
    blacklist.unjailUser(guild.id, targetMember.id);
    const jailChId = liveCfg().jailChannelId || '';
    if (jailChId) {
      const jc = guild.channels.cache.get(jailChId);
      if (jc?.isTextBased?.()) { try { await jc.permissionOverwrites.delete(targetMember.id, 'Unjail Phénix').catch(() => {}); } catch {} }
    }
    return true;
  } catch { return false; }
}
// 🔒 Planification de la libération automatique (f!config jail temp)
const jailTimers = new Map();
function scheduleJailTimer(guildId, userId, msRemaining) {
  const key = `${guildId}:${userId}`;
  if (jailTimers.has(key)) clearTimeout(jailTimers.get(key));
  const t = setTimeout(async () => {
    jailTimers.delete(key);
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return;
      const j = blacklist.getJail(guildId, userId);
      if (!j || (j.until && Date.now() < j.until)) return;
      const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
      if (member) {
        const ok = await unjailRestore(guild, member, j);
        try { await member.send({ embeds: [new EmbedBuilder().setColor('#2ecc71').setTitle('🔓 Tu es libéré').setDescription(`**Serveur :** ${guild.name}\nTa durée de prison est terminée, tes rôles ont été restaurés.`).setTimestamp()] }).catch(() => {}); } catch {}
        const ch = await getChannel(staffLogChannelId()).catch(() => null);
        if (ch?.isTextBased?.()) await ch.send({ embeds: [new EmbedBuilder().setColor('#2ecc71').setTitle('🔓 Jail terminé (auto)').setDescription(`**Membre :** <@${userId}>\n**Serveur :** ${guild.name}${ok ? '' : '\n⚠️ Restauration partielle (rôle trop bas)'}`).setTimestamp()] }).catch(() => {});
      } else {
        blacklist.unjailUser(guildId, userId);
      }
    } catch {}
  }, Math.max(1000, msRemaining));
  jailTimers.set(key, t);
}
// Au boot : reprendre les timers des jails encore actifs
async function resumeJailTimers() {
  try {
    for (const guild of client.guilds.cache.values()) {
      for (const j of blacklist.listJailed(guild.id)) {
        const left = (j.until || 0) - Date.now();
        if (left > 0) scheduleJailTimer(guild.id, j.userId, left);
        else {
          const member = guild.members.cache.get(j.userId) || await guild.members.fetch(j.userId).catch(() => null);
          if (member) await unjailRestore(guild, member, j);
          else blacklist.unjailUser(guild.id, j.userId);
        }
      }
    }
  } catch {}
}
// Vérifie régulièrement les jails arrivés à terme (UN SEUL interval, au niveau module)
setInterval(() => { try { for (const g of client.guilds.cache.values()) { for (const j of blacklist.dueJails()) { if (j.guildId !== g.id) continue; const m = g.members.cache.get(j.userId) || null; if (m) unjailRestore(g, m, j); else blacklist.unjailUser(g.id, j.userId); } } } catch {} }, 60000).unref?.();

// ============================================================
// COMMANDES MESSAGES
// ============================================================
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  const raw = message.content.trim();
  const low = raw.toLowerCase();

  // ----- Log commandes refusées (flop) → salon REFUSED_CMD_LOG_ID -----
  if (low.startsWith('f!') || low.startsWith('x!') || low.startsWith('st!') || low.startsWith('px!') || low.startsWith('usar!')) {
    const origReply = message.reply.bind(message);
    message.reply = (payload) => {
      try {
        const embArr = Array.isArray(payload?.embeds) ? payload.embeds : [];
        const c = typeof payload?.content === 'string' ? payload.content : '';
        const isRefused =
          embArr.some((e) => String(e?.data?.title || '').includes('Accès refusé')) ||
          /^🚫 Tu es blacklisté|^⛔ Commandes bloquées|^❌ Réservé|^❌ Accès refusé/.test(c);
        if (isRefused) logRefusedCommand(message, raw);
      } catch {}
      return origReply(payload);
    };
  }

  // ----- Enforcement global Anti-Raid f! (blacklist + block + maintenance) -----
  try {
    if (!isOwner(message.author.id)) {
      const isCmd = (low.startsWith('x!') || low.startsWith('f!') || low.startsWith('st!') || low.startsWith('px!') || low.startsWith('usar!'));
      const blk = isCmd ? blacklist.isCommandBlocked?.(message.author.id) : null;
      if (blk) return message.reply({ content: `⛔ Commandes bloquées : ${blk.reason || 'Aucune raison'} (par <@${blk.blockedBy}>).` }).catch(() => {});
      if (isCmd && blacklist.isUserBlacklisted?.(message.author.id)) {
        return message.reply({ content: '🚫 Tu es blacklisté du bot Phénix.' }).catch(() => {});
      }
      if (maintenanceMode && (low.startsWith('x!') || low.startsWith('f!') || low.startsWith('st!') || low.startsWith('px!'))) {
        const openCmds = ['x!bug', 'px!support', 'px!ping', 'px!bug', 'px!mes-donnees', 'px!mydata', 'px!data', 'px!exporter-mes-donnees', 'px!export-mydata', 'px!export', 'px!supprimer-mes-donnees', 'px!delete-mydata', 'px!delete', 'px!politique-confidentialite', 'px!privacy', 'px!rgpd', 'px!gdpr'];
        if (!openCmds.some((c) => low === c || low.startsWith(c + ' '))) {
          return message.reply({ content: `🛠️ Maintenance en cours : ${maintenanceText || 'bot en maintenance, réessaie plus tard.'}` }).catch(() => {});
        }
      }
    }
  } catch {}

  // ----- Gate F! : réservé au propriétaire du bot (sauf commandes à gate staff interne) -----
  const F_STAFF_EXCEPTIONS = [
    'f!bl-bot', 'f!blbot', 'f!unbl-bot', 'f!unblbot',
    'f!own-list', 'f!ownlist', 'f!owners', 'f!list-own',
    'f!staff-list', 'f!stafflist', 'f!staffs', 'f!list-staff',
    'f!buglist', 'f!bugs', 'f!staff', 'f!permadmin', 'f!permadm', 'f!annonce',
  ];
  if (low.startsWith('f!') && !F_STAFF_EXCEPTIONS.some((c) => low === c || low.startsWith(c + ' '))) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé au propriétaire du bot.'));
  }

  // ============================================================
  // MODULE USAR! — Sécurité (Antiraid / Antinuke / Emergency / Security)
  // ============================================================
  if (low.startsWith('usar!')) {
    // Log central TOUTES commandes USAR! → salon dédié
    logStaff(message, 'USAR!command', raw.slice(0, 200), { channelId: U_LOG_ID });
if (low === 'usar!help' || low === 'usar!commands' || low === 'usar!h' || low.startsWith('usar!help ') || low.startsWith('usar!commands ') || low.startsWith('usar!h ')) {
  return sendHelpMenu(message, 'u');
    }
    const tokens = low.split(/ +/).filter(Boolean);
    const cmd = ((tokens[0] || '').replace(/^usar!/, '') || '').toLowerCase();
    const infoCmds = ['ping', 'botinfo', 'serverinfo', 'userinfo', 'cogs'];
    const isInfo = infoCmds.includes(cmd) && (cmd === 'userinfo' || tokens.length <= 2);
    if (!isInfo && !canUseU(message)) {
      return message.reply(deny(`Réservé aux membres sécurités (<@&1550544150330482728>…).`)).catch(() => {});
    }

    // ----- USAR!antiraid on/off/status/lockdown/unlock -----
    if (cmd === 'antiraid' || low.startsWith('usar!limit') || low.startsWith('usar!accountage')) {
      const argTxt = low.startsWith('usar!limit') ? raw.slice('usar!limit'.length).trim()
        : low.startsWith('usar!accountage') ? raw.slice('usar!accountage'.length).trim()
        : raw.slice('usar!antiraid'.length).trim();
      if (low.startsWith('usar!limit')) {
        if (!canUseU(message)) return message.reply(deny('Réservé aux membres sécurités.')).catch(() => {});
        const parts = argTxt.split(/ +/).filter(Boolean).map(Number);
        const jl = parts[0], jw = parts[1];
        if (!jl || !jw || jl < 1 || jw < 5) return message.reply({ content: 'Usage : `USAR!limit <joins> <secondes>` (ex `USAR!limit 10 30`)' }).catch(() => {});
        blacklist.setAntiraidLimit(message.guild.id, Math.min(100, Math.floor(jl)), Math.min(300, Math.max(5, Math.floor(jw))));
        const c = blacklist.getAntiraidCfg(message.guild.id);
        logStaff(message, 'USAR!limit', `<@${message.author.id}> → ${c.joinsLimit} joins/${c.joinsWindow}s`);
        return message.reply({ embeds: [uSecEmbed(message.guild, '⚙️ Seuil anti-flood', `Autorisé : **${c.joinsLimit} joins** / **${c.joinsWindow}s**`)] }).catch(() => {});
      }
      if (low.startsWith('usar!accountage')) {
        if (!canUseU(message)) return message.reply(deny('Réservé aux membres sécurités.')).catch(() => {});
        const d = parseInt(argTxt.split(/ +/).filter(Boolean)[0] || '', 10);
        if (isNaN(d) || d < 0 || d > 365) return message.reply({ content: 'Usage : `USAR!accountage <jours>` (0 = désactivé, ex `USAR!accountage 7`)' }).catch(() => {});
        blacklist.setAntiraidAccountAge(message.guild.id, d);
        logStaff(message, 'USAR!accountage', `<@${message.author.id}> → ${d}j`);
        return message.reply({ embeds: [uSecEmbed(message.guild, '🎂 Âge mini des comptes', d ? `Les comptes de **moins de ${d} jour(s)** seront **kickés** à l’arrivée.` : 'Désactivé.')] }).catch(() => {});
      }
      const gate = uPermCheck(message);
      const action = argTxt.split(/ +/).filter(Boolean)[0]?.toLowerCase() || '';
      if (action === 'on') {
        if (!canUseU(message)) return message.reply(deny('Réservé aux membres sécurités.')).catch(() => {});
        if (gate) return message.reply({ content: gate }).catch(() => {});
        blacklist.setAntiraidOn(message.guild.id);
        const c = blacklist.getAntiraidCfg(message.guild.id);
        logStaff(message, 'USAR!antiraid', `ON par <@${message.author.id}>`);
        return message.reply({ embeds: [uSecEmbed(message.guild, '⚔️ Antiraid activé', `Flood → **lockdown auto** : ${c.joinsLimit} joins/${c.joinsWindow}s\nÂge mini : **${c.minAccountAge || 0}j**`)] }).catch(() => {});
      }
      if (action === 'off') {
        if (!canUseU(message)) return message.reply(deny('Réservé aux membres sécurités.')).catch(() => {});
        blacklist.setAntiraidOff(message.guild.id);
        logStaff(message, 'USAR!antiraid', `OFF par <@${message.author.id}>`);
        return message.reply({ embeds: [uSecEmbed(message.guild, '⚔️ Antiraid désactivé', 'La protection anti-flood est **éteinte**.', '#ff4d4d')] }).catch(() => {});
      }
      if (action === 'lockdown' || action === 'unlock') {
        if (!canUseU(message)) return message.reply(deny('Réservé aux membres sécurités.')).catch(() => {});
        if (gate) return message.reply({ content: gate }).catch(() => {});
        const lock = action === 'lockdown';
        await message.reply({ content: lock ? '🔒 Verrouillage en cours...' : '🔓 Déverrouillage en cours...' }).catch(() => {});
        const n = await uSetLockdown(message.guild, lock, `USAR!antiraid ${action} par ${message.author.tag}`);
        blacklist.addSecurityLog(message.guild.id, message.author.id, lock ? 'LOCKDOWN' : 'UNLOCK', `Antiraid ${action} par ${message.author.tag} — ${n} salon(s)`);
        logStaff(message, 'USAR!antiraid', `${action} par <@${message.author.id}> (${n} salons)`);
        return message.reply({ embeds: [uSecEmbed(message.guild, lock ? '🔒 Serveur verrouillé' : '🔓 Serveur déverrouillé', `${action} par ${message.author} — **${n} salon(s)** ${lock ? 'verrouillé(s)' : 'rouvert(s)'}.`, lock ? '#ff4d4d' : '#2ecc71')] }).catch(() => {});
      }
      // status (défaut)
      const c = blacklist.getAntiraidCfg(message.guild.id);
      const locked = await uCountLocked(message.guild);
      return message.reply({ embeds: [uSecEmbed(message.guild, '⚔️ Antiraid — Status', [
        `**Protection :** ${c.enabled ? '🟢 Activée' : '🔴 Désactivée'}`,
        `**Flood :** ${c.joinsLimit} joins / ${c.joinsWindow}s → lockdown auto`,
        `**Âge mini :** ${c.minAccountAge || 0} jour(s)`,
        `**Salons verrouillés :** ${locked}`,
      ].join('\n'))] }).catch(() => {});
    }

    // ----- USAR!antinuke on/off/status/whitelist -----
    if (cmd === 'antinuke') {
      const argTxt = raw.slice(raw.toLowerCase().split(/ +/).slice(0, 2).join(' ').length).trim();
      const act = argTxt.split(/ +/).filter(Boolean)[0]?.toLowerCase() || '';
      if (act === 'on' || act === 'off') {
        if (!canUseU(message)) return message.reply(deny('Réservé aux membres sécurités.')).catch(() => {});
        const gate = uPermCheck(message);
        if (gate) return message.reply({ content: gate }).catch(() => {});
        try {
          const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
          c.antinukeEnabled = act === 'on';
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
        } catch {}
        logStaff(message, 'USAR!antinuke', `${act.toUpperCase()} par <@${message.author.id}>`);
        return message.reply({ embeds: [uSecEmbed(message.guild, `☢️ Antinuke ${act === 'on' ? 'activé' : 'désactivé'}`, act === 'on' ? `Surveillance des suppressions de salons/rôles : **${ANTINUKE_MAX_ACTIONS}** max / **60s**\nAu-delà → **ban automatique** (sauf whitelist).` : 'Surveillance éteinte.', act === 'on' ? '#9b59b6' : '#ff4d4d')] }).catch(() => {});
      }
      if (act === 'whitelist') {
        if (!canUseU(message)) return message.reply(deny('Réservé aux membres sécurités.')).catch(() => {});
        const wl = blacklist.listAntinukeWhitelist(message.guild.id);
        const rest = argTxt.slice('whitelist'.length).trim();
        const subAct = rest.split(/ +/).filter(Boolean)[0]?.toLowerCase() || '';
        if (subAct === 'remove') {
          const u = await uResolveUser(message, rest.slice('remove'.length).trim());
          if (!u) return message.reply({ content: 'Usage : `USAR!antinuke whitelist remove <id/mention>`' }).catch(() => {});
          const ok = blacklist.removeAntinukeWhitelist(message.guild.id, u.id);
          logStaff(message, 'USAR!antinuke', `whitelist remove <@${u.id}> par <@${message.author.id}>`);
          return message.reply({ content: ok ? `➖ <@${u.id}> retiré de la whitelist antinuke.` : `📭 <@${u.id}> n’était pas whitelist.` }).catch(() => {});
        }
        // add (ou liste seule)
        if (rest) {
          const u = await uResolveUser(message, rest);
          if (!u) return message.reply({ content: 'Usage : `USAR!antinuke whitelist <id/mention> | remove <id> | (seul = liste)`' }).catch(() => {});
          blacklist.addAntinukeWhitelist(message.guild.id, u.id, message.author.id);
          blacklist.addSecurityLog(message.guild.id, message.author.id, 'WHITELIST+', `Antinuke whitelist + ${u.tag || u.id} par ${message.author.tag}`);
          logStaff(message, 'USAR!antinuke', `whitelist + <@${u.id}> par <@${message.author.id}>`);
          return message.reply({ content: `➕ <@${u.id}> ajouté à la whitelist antinuke.` }).catch(() => {});
        }
        return message.reply({ embeds: [uSecEmbed(message.guild, `☢️ Whitelist antinuke (${wl.length})`, wl.length ? wl.map((r) => `<@${r.userId}> — rajouté ${r.addedBy ? `<@${r.addedBy}>` : '?'} <t:${Math.floor((r.addedAt || Date.now()) / 1000)}:R>`).join('\n') : '*vide*', '#9b59b6')] }).catch(() => {});
      }
      // status
      const en = liveCfg().antinukeEnabled;
      const wl = blacklist.listAntinukeWhitelist(message.guild.id);
      return message.reply({ embeds: [uSecEmbed(message.guild, '☢️ Antinuke — Status', [
        `**Protection :** ${en ? '🟢 Activée' : '🔴 Désactivée'}`,
        `**Détection :** ${ANTINUKE_MAX_ACTIONS} suppressions / 60s → ban auto`,
        `**Whitelist :** ${wl.length} membre(s)`,
      ].join('\n'))] }).catch(() => {});
    }

    // ----- USAR!security logs/history/test -----
    if (cmd === 'security') {
      const argTxt = raw.slice((raw.toLowerCase().split(/ +/).slice(0, 2).join(' ') + ' ').length).trim();
      const act = argTxt.split(/ +/).filter(Boolean)[0]?.toLowerCase() || '';
      if (!canUseU(message)) return message.reply(deny('Réservé aux membres sécurités.')).catch(() => {});
      if (act === 'logs' || !act) {
        const list = blacklist.listSecurityLogs(message.guild.id, 15);
        if (!list.length) return message.reply({ content: '📭 Aucun événement sécurité.' }).catch(() => {});
        const lines = list.map((r) => `• \`${r.action}\` — ${r.userId ? `<@${r.userId}>` : '*système*'}${r.detail ? ` — ${String(r.detail).slice(0, 90)}` : ''} — <t:${Math.floor((r.createdAt || 0) / 1000)}:R>`).join('\n').slice(0, 3900);
        logStaff(message, 'USAR!security', `logs (${list.length})`);
        return message.reply({ embeds: [new EmbedBuilder().setColor('#9b59b6').setTitle('🔎 Sécurité — Logs').setDescription(lines).setTimestamp()] }).catch(() => {});
      }
      if (act === 'history') {
        const u = await uResolveUser(message, argTxt.slice('history'.length).trim());
        if (!u) return message.reply({ content: 'Usage : `USAR!security history <id/mention>`' }).catch(() => {});
        const list = blacklist.listSecurityLogsByUser(message.guild.id, u.id, 15);
        if (!list.length) return message.reply({ content: `📭 Aucun événement pour <@${u.id}>.` }).catch(() => {});
        const lines = list.map((r) => `• \`${r.action}\`${r.detail ? ` — ${String(r.detail).slice(0, 110)}` : ''} — <t:${Math.floor((r.createdAt || 0) / 1000)}:R>`).join('\n').slice(0, 3900);
        logStaff(message, 'USAR!security', `history <@${u.id}> (${list.length})`);
        return message.reply({ embeds: [uUserEmbed('🔎 Historique sécurité', u, lines)] }).catch(() => {});
      }
      if (act === 'test') {
        blacklist.addSecurityLog(message.guild.id, message.author.id, 'TEST', `Test du système sécurité par ${message.author.tag}`);
        logStaff(message, 'USAR!security', `test par <@${message.author.id}>`);
        return message.reply({ embeds: [uSecEmbed(message.guild, '🧪 Test sécurité', `✅ Système **opérationnel** — antiraid ${blacklist.getAntiraidCfg(message.guild.id).enabled ? '🟢 on' : '🔴 off'}, antinuke ${liveCfg().antinukeEnabled ? '🟢 on' : '🔴 off'}.`, '#2ecc71')] }).catch(() => {});
      }
      return message.reply({ content: 'Usage : `USAR!security logs | history <user> | test`' }).catch(() => {});
    }

    // ----- USAR!emergency lockdown/unlock/status -----
    if (cmd === 'emergency') {
      if (!canUseU(message)) return message.reply(deny('Réservé aux membres sécurités.')).catch(() => {});
      const gate = uPermCheck(message);
      const act = raw.slice(raw.toLowerCase().split(/ +/).slice(0, 2).join(' ').length).trim().split(/ +/).filter(Boolean)[0]?.toLowerCase() || '';
      if (act === 'lockdown' || act === 'unlock') {
        if (gate) return message.reply({ content: gate }).catch(() => {});
        const lock = act === 'lockdown';
        await message.reply({ content: lock ? '🚨 Verrouillage d’urgence en cours...' : '🔓 Déverrouillage en cours...' }).catch(() => {});
        const n = await uSetLockdown(message.guild, lock, `USAR!emergency ${act} par ${message.author.tag}`);
        blacklist.addSecurityLog(message.guild.id, message.author.id, lock ? 'EMERGENCY LOCKDOWN' : 'EMERGENCY UNLOCK', `par ${message.author.tag} — ${n} salon(s)`);
        logStaff(message, 'USAR!emergency', `${act} par <@${message.author.id}> (${n} salons)`);
        return message.reply({ embeds: [uSecEmbed(message.guild, lock ? '🚨 Verrouillage d’urgence actif' : '🔓 Déverrouillage effectué', `${lock ? 'Verrouillé' : 'Déverrouillé'} par ${message.author} — **${n} salon(s)**.`, lock ? '#ff0000' : '#2ecc71')] }).catch(() => {});
      }
      const locked = await uCountLocked(message.guild);
      return message.reply({ embeds: [uSecEmbed(message.guild, '🚨 Emergency — Status', `**Salons verrouillés :** ${locked}\n${locked ? '*Utilise `USAR!emergency unlock` pour rouvrir.*' : '*Rien à signaler.*'}`, locked ? '#ff4d4d' : '#2ecc71')] }).catch(() => {});
    }

    // ----- USAR!ping (ouvert à tous) -----
    if (cmd === 'ping') {
      return message.reply({ embeds: [new EmbedBuilder().setColor('#9b59b6').setTitle('🏓 Pong !').setDescription(`**Latence API :** ${Math.round(client.ws.ping)} ms`).setTimestamp()] }).catch(() => {});
    }
    // ----- USAR!botinfo -----
    if (cmd === 'botinfo') {
      let version = '?';
      try { version = require('./package.json').version || '?'; } catch {}
      return message.reply({ embeds: [new EmbedBuilder().setColor('#9b59b6').setTitle('🤖 Phénix — Bot Info').setDescription(`**Nom :** ${client.user.tag}\n**Latence API :** ${Math.round(client.ws.ping)} ms\n**Uptime :** ${fmtUptimeU()}\n**Version :** ${version}`).addFields(
        { name: '🌐 Serveurs', value: `${client.guilds.cache.size}`, inline: true },
        { name: '👥 Utilisateurs', value: `${client.users.cache.size}`, inline: true },
        { name: '📺 Salons', value: `${client.channels.cache.size}`, inline: true },
      ).setTimestamp()] }).catch(() => {});
    }
    // ----- USAR!serverinfo -----
    if (cmd === 'serverinfo') {
      const g = message.guild;
      return message.reply({ embeds: [new EmbedBuilder().setColor('#9b59b6').setTitle(`🏰 ${g.name}`).setDescription(`**ID :** \`${g.id}\`\n**Propriétaire :** <@${g.ownerId}>\n**Créé le :** <t:${Math.floor(g.createdTimestamp / 1000)}:D>`).addFields(
        { name: '👥 Membres', value: `${g.memberCount}`, inline: true },
        { name: '📺 Salons', value: `${g.channels.cache.size}`, inline: true },
        { name: '🎭 Rôles', value: `${g.roles.cache.size}`, inline: true },
      ).setThumbnail(g.iconURL({ size: 128 }) || null).setTimestamp()] }).catch(() => {});
    }
    // ----- USAR!userinfo -----
    if (cmd === 'userinfo') {
      const u = await uResolveUser(message, raw.slice('usar!userinfo'.length).trim()) || message.author;
      const member = message.guild.members.cache.get(u.id) || await message.guild.members.fetch(u.id).catch(() => null);
      const emb = new EmbedBuilder().setColor('#9b59b6').setTitle('👤 Informations').setDescription(`**Tag :** ${u.tag || u.id}\n**ID :** \`${u.id}\`\n**Créé le :** ${u.createdTimestamp ? `<t:${Math.floor(u.createdTimestamp / 1000)}:D>` : '?'}
${member ? `**A rejoint :** <t:${Math.floor((member.joinedTimestamp || 0) / 1000)}:D>\n**Rôles :** ${member.roles.cache.size - 1}\n**Plus haut rôle :** ${member.roles.highest}` : ''}`)
        .setThumbnail(u.displayAvatarURL ? u.displayAvatarURL({ size: 128 }) : null).setTimestamp();
      return message.reply({ embeds: [emb] }).catch(() => {});
    }
    // ----- USAR!cogs -----
    if (cmd === 'cogs') {
      const c = blacklist.getAntiraidCfg(message.guild.id);
      const en = liveCfg().antinukeEnabled;
      const locked = await uCountLocked(message.guild);
      return message.reply({ embeds: [uSecEmbed(message.guild, '⚙️ Modules', [
        `**⚔️ Antiraid :** ${c.enabled ? '🟢' : '🔴'} (${c.joinsLimit} joins/${c.joinsWindow}s, ${c.minAccountAge}j)`,
        `**☢️ Antinuke :** ${en ? '🟢' : '🔴'} (${ANTINUKE_MAX_ACTIONS}/60s)`,
        `**🚨 Emergency :** ${locked ? `🔴 ${locked} salon(s) verrouillé(s)` : '🟢 normal'}`,
        `**🎫 Tickets :** 🟢`,
        `**💬 AFK :** 🟢`,
        `**✍️ Support staff (x!) :** 🟢`,
      ].join('\n'))] }).catch(() => {});
    }

    return message.reply({ content: 'Commande USAR! inconnue — `USAR!help` pour la liste.' }).catch(() => {});
  }

  // ----- AFK (px!afk) : se mettre AFK, prévenir les pings, revenir dès un message -----
  try {
    const cmdIsAfk = low === 'px!afk' || low.startsWith('px!afk ');
    const meAfk = blacklist.getAfk(message.author.id);
    if (cmdIsAfk) {
      const reason = raw.slice('px!afk'.length).trim() || 'Aucune raison';
      blacklist.setAfk(message.author.id, reason);
      logStaff(message, 'px!afk', `<@${message.author.id}> — ${reason.slice(0, 150)}`);
      const emb = new EmbedBuilder().setColor('#f1c40f').setTitle('⛅ AFK activé')
        .setDescription(`<@${message.author.id}> est maintenant **AFK**.\n**Raison :** ${reason.slice(0, 200)}\n\n*Ceux qui le pingent recevront la notification jusqu'à son retour.*`)
        .setTimestamp();
      return message.reply({ embeds: [emb] }).catch(() => {});
    }
    if (meAfk) {
      const row = blacklist.clearAfk(message.author.id);
      await message.reply({ content: `✅ Re-bonjour <@${message.author.id}> ! Tu étais AFK pendant **${fmtAfkDur(Date.now() - Number(row?.since || Date.now()))}**${row?.pings ? ` — ${row.pings} ping(s) reçus.` : '.'}` }).catch(() => {});
    } else if (message.mentions.users.size) {
      for (const m of message.mentions.users.values()) {
        if (m.id === message.author.id || m.bot) continue;
        const af = blacklist.getAfk(m.id);
        if (af) {
          blacklist.incAfkPings(m.id);
          await message.reply({ content: `⏰ <@${m.id}> est **AFK** depuis **${fmtAfkDur(Date.now() - Number(af.since))}** — *${String(af.reason || 'sans raison').slice(0, 150)}*` }).catch(() => {});
          break;
        }
      }
    }
  } catch {}

  // ----- x!stats -----
  if (low === 'x!stats' || low.startsWith('x!stats ')) {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé au staff.'));
    const arg = raw.slice('x!stats'.length).trim().split(/ +/).filter(Boolean)[0] || '';
    const target = await resolveStatsTarget(message, arg);
    logStaff(message, 'x!stats', `<@${target.id}>`);
    return message.reply({ embeds: [buildUserStatsEmbed(target, blacklist.getStaffStats(target.id))] });
  }

  // ----- x!top -----
  if (low === 'x!top' || low.startsWith('x!top ')) {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé au staff.'));
    const arg = low.slice('x!top'.length).trim().split(/ +/).filter(Boolean)[0] || 'total';
    const type = normalizeType(arg);
    logStaff(message, 'x!top', type);
    const fetchUser = (id) => message.guild?.members.cache.get(id)?.user || client.users.cache.get(id) || null;
    return message.reply({ embeds: [buildTopEmbed(blacklist.getStaffTop(type, 10), type, fetchUser)], components: statsPanelRows() });
  }

  // ----- x!allstats -----
  if (low === 'x!allstats') {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé au staff.'));
    logStaff(message, 'x!allstats', '');
    const fetchUser = (id) => message.guild?.members.cache.get(id)?.user || client.users.cache.get(id) || null;
    return message.reply({ embeds: [buildTopEmbed(blacklist.getStaffTop('total', 25), 'total', fetchUser)] });
  }

  // ----- x!panel / x!panel-stats -----
  if (low === 'x!panel-stats' || low === 'x!panelstats') {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé au staff.'));
    logStaff(message, 'x!panel-stats', `#${message.channel?.name || message.channel.id}`);
    await message.channel.send({ embeds: [statsPanelEmbed()], components: statsPanelRows() }).catch(() => null);
    return message.reply({ content: '✅ Panneau stats posté.' }).catch(() => {});
  }
  if (low === 'x!panel-ticket' || low === 'x!ticket-panel' || low === 'x!ticketpanel' || low === 'x!panelticket' || low.startsWith('x!panel-ticket ') || low.startsWith('x!ticket-panel ')) {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé aux rôles autorisés.'));
    logStaff(message, 'x!panel-ticket', `#${message.channel?.name || message.channel.id}`);
    // Pré-check : panel déjà posté juste avant → on ne reposte pas
    try {
      const recent = await message.channel.messages.fetch({ limit: 10 }).catch(() => null);
      if (recent) {
        const fresh = [...recent.values()].find((m) => isTicketPanelMessage(m, TICKET_IDS.PANEL_OPEN) && Date.now() - m.createdTimestamp < 60000);
        if (fresh) return message.reply({ content: '⚠️ Panneau déjà posté juste au-dessus 👆' }).catch(() => {});
      }
    } catch {}
    let sent = null;
    try {
      sent = await message.channel.send({ embeds: [ticketOnlyPanelEmbed()], components: ticketOnlyPanelRows() });
    } catch (e) { return message.reply({ content: `❌ Impossible de poster ici : \`${e.message}\`` }).catch(() => {}); }
    // Post-cleanup anti-doublon (2 instances) : on garde le panel le plus ancien, on supprime le nôtre si doublon
    setTimeout(async () => {
      try {
        const check = await message.channel.messages.fetch({ limit: 10 }).catch(() => null);
        if (!check || !sent) return;
        const panels = [...check.values()].filter((m) => isTicketPanelMessage(m, TICKET_IDS.PANEL_OPEN) && Date.now() - m.createdTimestamp < 60000).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        if (panels.length > 1 && panels[0].id !== sent.id) await sent.delete().catch(() => {});
      } catch {}
    }, 3000);
    try { await message.delete().catch(() => null); } catch {}
    return;
  }
  if (low === 'x!panel' || low.startsWith('x!panel ')) {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé aux rôles autorisés.'));
    logStaff(message, 'x!panel', `#${message.channel?.name || message.channel.id}`);
    // Pré-check : panel déjà posté juste avant → on ne reposte pas
    try {
      const recent = await message.channel.messages.fetch({ limit: 10 }).catch(() => null);
      if (recent) {
        const fresh = [...recent.values()].find((m) => isTicketPanelMessage(m, 'create_ticket') && Date.now() - m.createdTimestamp < 60000);
        if (fresh) return message.reply({ content: '⚠️ Panneau déjà posté juste au-dessus 👆' }).catch(() => {});
      }
    } catch {}
    let sent = null;
    try {
      sent = await message.channel.send({ embeds: [ticketPanelEmbed()], components: ticketPanelRows() });
    } catch (e) { return message.reply({ content: `❌ Impossible de poster ici : \`${e.message}\`` }).catch(() => {}); }
    // Post-cleanup anti-doublon (2 instances) : on garde le panel le plus ancien, on supprime le nôtre si doublon
    setTimeout(async () => {
      try {
        const check = await message.channel.messages.fetch({ limit: 10 }).catch(() => null);
        if (!check || !sent) return;
        const panels = [...check.values()].filter((m) => isTicketPanelMessage(m, 'create_ticket') && Date.now() - m.createdTimestamp < 60000).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        if (panels.length > 1 && panels[0].id !== sent.id) await sent.delete().catch(() => {});
      } catch {}
    }, 3000);
    try { await message.delete().catch(() => null); } catch {}
    return;
  }

  // ----- x!poste-suggestion (panel suggestions, silencieux comme x!panel-ticket) -----
  if (low === 'x!poste-suggestion' || low.startsWith('x!poste-suggestion ') || low === 'x!poste-sugg' || low.startsWith('x!poste-sugg ') || low === 'x!suggestion-panel' || low.startsWith('x!suggestion-panel ')) {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé aux rôles autorisés.'));
    logStaff(message, 'x!poste-suggestion', `#${message.channel?.name || message.channel.id}`);
    try {
      const recent = await message.channel.messages.fetch({ limit: 10 }).catch(() => null);
      if (recent) {
        const fresh = [...recent.values()].find((m) => isSuggestPanelMessage(m) && Date.now() - m.createdTimestamp < 60000);
        if (fresh) return message.reply({ content: '⚠️ Panneau déjà posté juste au-dessus 👆' }).catch(() => {});
      }
    } catch {}
    try {
      await message.channel.send({ embeds: [suggestPanelEmbed()], components: suggestPanelRows() });
    } catch (e) { return message.reply({ content: `❌ Impossible de poster ici : \`${e.message}\`` }).catch(() => {}); }
    try { await message.delete().catch(() => null); } catch {}
    return;
  }

  // ----- x!phénix (présentation du bot support, silencieux comme les panels) -----
  if (low === 'x!phénix' || low.startsWith('x!phénix ') || low === 'x!phenix' || low.startsWith('x!phenix ')) {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé aux rôles autorisés.'));
    logStaff(message, 'x!phénix', `#${message.channel?.name || message.channel.id}`);
    try {
      await message.channel.send({ embeds: [phenixPresentEmbed()] });
    } catch (e) { return message.reply({ content: `❌ Impossible de poster ici : \`${e.message}\`` }).catch(() => {}); }
    try { await message.delete().catch(() => null); } catch {}
    return;
  }

  // ----- x!stats-reset / x!reset / x!resetall (owners) -----
  if (low === 'x!stats-reset' || low.startsWith('x!stats-reset ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const rest = raw.slice('x!stats-reset'.length).trim();
    if (!rest || rest.toLowerCase() === 'all') { blacklist.resetStaffStats(); logStaff(message, 'x!stats-reset', 'all'); return message.reply({ content: '♻️ Toutes les stats reset.' }); }
    const t = message.mentions.users.first();
    const id = t?.id || rest.replace(/[^0-9]/g, '');
    blacklist.resetStaffStats(id);
    logStaff(message, 'x!stats-reset', `<@${id}>`);
    return message.reply({ content: `♻️ Stats de <@${id}> reset.` });
  }
  if (low === 'x!reset' || low.startsWith('x!reset ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const usage = 'Usage : `x!reset <raid|sos|ticket|question|total> <@user/id>`.\nEx : `x!reset raid @pseudo`';
    const args = raw.slice('x!reset'.length).trim().split(/ +/).filter(Boolean);
    const typeRaw = (args.shift() || '').toLowerCase();
    if (!['raid', 'sos', 'ticket', 'question', 'total'].includes(typeRaw)) return message.reply({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('❌ Erreur').setDescription(usage).setTimestamp()] });
    const mentioned = message.mentions.users.first();
    const targetId = mentioned?.id || (args.join(' ').replace(/[^0-9]/g, '') || '');
    if (!/^\d{15,}$/.test(targetId)) return message.reply({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('❌ Erreur').setDescription(usage).setTimestamp()] });
    blacklist.resetStaffStatType(targetId, typeRaw);
    const s = blacklist.getStaffStats(targetId);
    logStaff(message, 'x!reset', `${typeRaw} <@${targetId}>`);
    return message.reply({ embeds: [new EmbedBuilder().setColor('#00ff00').setTitle(`♻️ Reset ${typeRaw.toUpperCase()} — <@${targetId}>`).setDescription(`🛡️ RAID : **${s.raid}**\n🚨 SOS : **${s.sos}**\n🎫 TICKET : **${s.ticket}**\n❓ QUESTION : **${s.question}**\n🏆 TOTAL : **${s.total}**`).setTimestamp()] });
  }
  if (low === 'x!resetall') {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const before = blacklist.getStaffTop('total', 25);
    blacklist.resetStaffStats();
    logStaff(message, 'x!resetall', `${before.length} staff(s) reset`);
    const lines = before.length === 0 ? 'Aucune stat à reset.' : before.map((r, i) => `**${i + 1}.** <@${r.userId}> — **${r.total}** \`[🛡️${r.raid} 🚨${r.sos} 🎫${r.ticket} ❓${r.question || 0}]\``).join('\n');
    return message.reply({ embeds: [new EmbedBuilder().setColor('#00ff00').setTitle('♻️ Reset réunion — stats remises à zéro').setDescription(`**${before.length}** staff(s) reset.\n\n${lines}`.slice(0, 4000)).setFooter({ text: 'Phénix • Reset réunion' }).setTimestamp()] });
  }

  // ----- x!setup (configurer le support, owners — appliqué immédiatement, sans restart) -----
  if (low === 'x!setup' || low.startsWith('x!setup ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const args = raw.slice('x!setup'.length).trim().split(/ +/).filter(Boolean);
    const sub = (args.shift() || '').toLowerCase();
    const usage = 'Usage : `x!setup` (= voir)\n`x!setup staffrole @rôle`\n`x!setup panel #salon`\n`x!setup statspanel #salon|off`\n`x!setup stafflogs #salon`\n`x!setup ticketlogs #salon|off`\n`x!setup category <id>|off`\n`x!setup invite <lien>`\n`x!setup maxtickets <1-5>`';
    const readCfg = () => { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return null; } };
    const setupView = (c) => new EmbedBuilder().setColor('#206694').setTitle('⚙️ Setup — Phénix Support').setDescription(
      `**Rôle staff :** ${c.staffRoleId ? `<@&${c.staffRoleId}>` : '*non défini*'}\n` +
      `**Panel support :** ${c.panelChannelId ? `<#${c.panelChannelId}>` : '*non défini*'}\n` +
      `**Panel stats :** ${c.statsPanelChannelId ? `<#${c.statsPanelChannelId}>` : '*non défini*'}\n` +
      `**Logs staff :** ${c.staffLogChannelId ? `<#${c.staffLogChannelId}>` : '*non défini*'}\n` +
      `**Logs tickets :** ${c.ticketLogChannelId ? `<#${c.ticketLogChannelId}>` : '*suit les logs staff*'}\n` +
      `**Catégorie tickets :** ${c.ticketCategoryId ? `\`${c.ticketCategoryId}\`` : '*non définie*'}\n` +
      `**Lien support :** ${c.supportInvite || '*défaut*'}\n` +
      `**Max tickets/membre :** ${c.maxTicketsPerUser ?? 1}`
    ).setFooter({ text: 'Phénix • Setup (appliqué sans restart)' }).setTimestamp();
    if (!sub || sub === 'view' || sub === 'voir') {
      const c = readCfg();
      if (!c) return message.reply({ content: '❌ config.json illisible.' }).catch(() => {});
      logStaff(message, 'x!setup', 'view');
      return message.reply({ embeds: [setupView(c)] }).catch(() => {});
    }
    const c = readCfg();
    if (!c) return message.reply({ content: '❌ config.json illisible.' }).catch(() => {});
    const save = () => fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
    const idArg = (args.join(' ').match(/\d{15,}/g) || [])[0] || '';
    const wordArg = (args.join(' ').toLowerCase());
    const isOff = wordArg === 'off' || wordArg === 'none' || wordArg === 'aucun';
    if (sub === 'staffrole' || sub === 'staff-role' || sub === 'role-staff') {
      const rid = message.mentions.roles.first()?.id || idArg;
      if (!rid) return message.reply({ content: usage }).catch(() => {});
      const role = message.guild?.roles.cache.get(rid) || await message.guild?.roles.fetch(rid).catch(() => null);
      if (!role) return message.reply({ content: '❌ Rôle introuvable sur ce serveur.' }).catch(() => {});
      c.staffRoleId = role.id; save();
      logStaff(message, 'x!setup', `staffRoleId → ${role} (${role.id})`);
      return message.reply({ content: `✅ Rôle staff : ${role}` }).catch(() => {});
    }
    if (sub === 'panel' || sub === 'panel-support') {
      const cid = message.mentions.channels.first()?.id || idArg;
      if (!cid) return message.reply({ content: usage }).catch(() => {});
      const ch = message.guild?.channels.cache.get(cid) || await message.guild?.channels.fetch(cid).catch(() => null);
      if (!ch?.isTextBased?.()) return message.reply({ content: '❌ Salon texte introuvable sur ce serveur.' }).catch(() => {});
      c.panelChannelId = ch.id; save();
      logStaff(message, 'x!setup', `panelChannelId → <#${ch.id}>`);
      return message.reply({ content: `✅ Panel support : <#${ch.id}>` }).catch(() => {});
    }
    if (sub === 'statspanel' || sub === 'stats-panel' || sub === 'panel-stats') {
      if (isOff) { c.statsPanelChannelId = ''; save(); logStaff(message, 'x!setup', 'statsPanelChannelId → vidé'); return message.reply({ content: '✅ Panel stats désactivé.' }).catch(() => {}); }
      const cid = message.mentions.channels.first()?.id || idArg;
      if (!cid) return message.reply({ content: usage }).catch(() => {});
      const ch = message.guild?.channels.cache.get(cid) || await message.guild?.channels.fetch(cid).catch(() => null);
      if (!ch?.isTextBased?.()) return message.reply({ content: '❌ Salon texte introuvable sur ce serveur.' }).catch(() => {});
      c.statsPanelChannelId = ch.id; save();
      logStaff(message, 'x!setup', `statsPanelChannelId → <#${ch.id}>`);
      return message.reply({ content: `✅ Panel stats : <#${ch.id}>` }).catch(() => {});
    }
    if (sub === 'stafflogs' || sub === 'staff-logs' || sub === 'logs') {
      const cid = message.mentions.channels.first()?.id || idArg;
      if (!cid) return message.reply({ content: usage }).catch(() => {});
      const ch = message.guild?.channels.cache.get(cid) || await message.guild?.channels.fetch(cid).catch(() => null);
      if (!ch?.isTextBased?.()) return message.reply({ content: '❌ Salon texte introuvable sur ce serveur.' }).catch(() => {});
      c.staffLogChannelId = ch.id; c.logChannelId = ch.id; save();
      logStaff(message, 'x!setup', `staffLogChannelId → <#${ch.id}>`);
      return message.reply({ content: `✅ Logs staff : <#${ch.id}>` }).catch(() => {});
    }
    if (sub === 'ticketlogs' || sub === 'ticket-logs') {
      if (isOff) { c.ticketLogChannelId = ''; save(); logStaff(message, 'x!setup', 'ticketLogChannelId → vidé (suit staff)'); return message.reply({ content: '✅ Logs tickets : suit les logs staff.' }).catch(() => {}); }
      const cid = message.mentions.channels.first()?.id || idArg;
      if (!cid) return message.reply({ content: usage }).catch(() => {});
      const ch = message.guild?.channels.cache.get(cid) || await message.guild?.channels.fetch(cid).catch(() => null);
      if (!ch?.isTextBased?.()) return message.reply({ content: '❌ Salon texte introuvable sur ce serveur.' }).catch(() => {});
      c.ticketLogChannelId = ch.id; save();
      logStaff(message, 'x!setup', `ticketLogChannelId → <#${ch.id}>`);
      return message.reply({ content: `✅ Logs tickets : <#${ch.id}>` }).catch(() => {});
    }
    if (sub === 'category' || sub === 'categorie' || sub === 'cat') {
      if (isOff) { c.ticketCategoryId = ''; save(); logStaff(message, 'x!setup', 'ticketCategoryId → vidé'); return message.reply({ content: '✅ Catégorie tickets retirée (salons à la racine).' }).catch(() => {}); }
      if (!idArg) return message.reply({ content: usage }).catch(() => {});
      const cat = message.guild?.channels.cache.get(idArg) || await message.guild?.channels.fetch(idArg).catch(() => null);
      if (!cat || cat.type !== ChannelType.GuildCategory) return message.reply({ content: '❌ Catégorie introuvable (clic droit sur la catégorie → Copier l’identifiant).' }).catch(() => {});
      c.ticketCategoryId = cat.id; save();
      logStaff(message, 'x!setup', `ticketCategoryId → ${cat.name} (${cat.id})`);
      return message.reply({ content: `✅ Catégorie tickets : **${cat.name}**` }).catch(() => {});
    }
    if (sub === 'invite' || sub === 'lien' || sub === 'support-invite') {
      const link = args.join(' ').trim();
      if (!/^https?:\/\/(www\.)?(discord\.gg|discord\.com\/invite)\/\S+$/i.test(link)) return message.reply({ content: 'Usage : `x!setup invite <lien discord.gg>`\nEx : `x!setup invite https://discord.gg/XXXX`' }).catch(() => {});
      c.supportInvite = link; save();
      logStaff(message, 'x!setup', `supportInvite → ${link}`);
      return message.reply({ content: `✅ Lien support : ${link}` }).catch(() => {});
    }
    if (sub === 'maxtickets' || sub === 'max-tickets' || sub === 'max') {
      const n = parseInt(args[0], 10);
      if (!Number.isFinite(n) || n < 1 || n > 5) return message.reply({ content: 'Usage : `x!setup maxtickets <1-5>`' }).catch(() => {});
      c.maxTicketsPerUser = n; save();
      logStaff(message, 'x!setup', `maxTicketsPerUser → ${n}`);
      return message.reply({ content: `✅ Max tickets/membre : **${n}**` }).catch(() => {});
    }
    return message.reply({ content: usage }).catch(() => {});
  }

  // ----- Tickets : x!close / x!add / x!remove / x!claim / x!transcript / x!tickets / x!resolut -----
  if (low === 'x!close' || low.startsWith('x!close ')) {
    const t = blacklist.getTicket(message.channel.id);
    if (!t) return message.reply({ content: '❌ Cette commande ne peut être utilisée que dans un salon ticket.' }).catch(() => {});
    if (t.status && t.status !== 'open') return message.reply({ content: '⚠️ Fermeture déjà en cours...' }).catch(() => {});
    if (closingTickets.has(message.channel.id)) return message.reply({ content: '⚠️ Fermeture déjà en cours...' }).catch(() => {});
    closingTickets.add(message.channel.id);
    const staff = canUseCommands(message.member, message.author.id);
    if (t.ownerId !== message.author.id && !staff) { closingTickets.delete(message.channel.id); return message.reply(deny('Réservé au staff ou au créateur du ticket.')); }
    logStaff(message, 'x!close', `<#${message.channel.id}>`);
    await message.reply({ content: '🔒 Fermeture du ticket dans **5 secondes**...' }).catch(() => {});
    try {
      const txt = await buildTranscriptText(message.channel, 100);
      const ch = await getChannel(ticketLogChannelId()).catch(() => null);
      if (ch?.isTextBased?.()) await ch.send({ content: `📝 Transcript — ticket <#${message.channel.id}> (${t.ownerTag || t.ownerId}) fermé par ${message.author.tag}`, files: [{ attachment: Buffer.from(txt, 'utf8'), name: `transcript-${message.channel.name}.txt` }] }).catch(() => {});
    } catch {}
    try { if (staff && !t.claimedBy) { blacklist.claimTicket(message.channel.id, message.author.id); } } catch {}
    blacklist.closeTicket(message.channel.id);
    setTimeout(() => { closingTickets.delete(message.channel.id); message.channel.delete().catch(() => {}); }, 5000);
    return;
  }
  if (low.startsWith('x!add ')) {
    const t = blacklist.getTicket(message.channel.id);
    if (!t) return message.reply({ content: '❌ Uniquement dans un salon ticket.' }).catch(() => {});
    if (!canUseCommands(message.member, message.author.id)) return message.reply({ content: '❌ Réservé au staff.' }).catch(() => {});
    const target = message.mentions.users.first();
    if (!target) return message.reply({ content: 'Usage : `x!add @user`' }).catch(() => {});
    try { await message.channel.permissionOverwrites.edit(target.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }); } catch (e) { return message.reply({ content: `❌ Impossible d'ajouter : \`${e.message}\`` }).catch(() => {}); }
    logStaff(message, 'x!add', `<@${target.id}> dans <#${message.channel.id}>`);
    return message.reply({ content: `✅ ${target} ajouté au ticket.` }).catch(() => {});
  }
  if (low.startsWith('x!remove ')) {
    const t = blacklist.getTicket(message.channel.id);
    if (!t) return message.reply({ content: '❌ Uniquement dans un salon ticket.' }).catch(() => {});
    if (!canUseCommands(message.member, message.author.id)) return message.reply({ content: '❌ Réservé au staff.' }).catch(() => {});
    const target = message.mentions.users.first();
    const targetId = target?.id || raw.slice('x!remove'.length).trim().replace(/[^0-9]/g, '');
    if (!targetId) return message.reply({ content: 'Usage : `x!remove @user`' }).catch(() => {});
    if (targetId === t.ownerId) return message.reply({ content: '❌ On ne retire pas le créateur du ticket.' }).catch(() => {});
    try { await message.channel.permissionOverwrites.delete(targetId).catch(() => message.channel.permissionOverwrites.edit(targetId, { ViewChannel: false, SendMessages: false })); } catch (e) { return message.reply({ content: `❌ Impossible de retirer : \`${e.message}\`` }).catch(() => {}); }
    logStaff(message, 'x!remove', `<@${targetId}> de <#${message.channel.id}>`);
    return message.reply({ content: `✅ <@${targetId}> retiré du ticket.` }).catch(() => {});
  }
  if (low === 'x!claim' || low === 'x!prendre') {
    const t = blacklist.getTicket(message.channel.id);
    if (!t) return message.reply({ content: '❌ Uniquement dans un salon ticket.' }).catch(() => {});
    if (!canUseCommands(message.member, message.author.id)) return message.reply({ content: '❌ Réservé au staff.' }).catch(() => {});
    if (t.claimedBy) return message.reply({ content: `⚠️ Déjà pris en charge par <@${t.claimedBy}>.` }).catch(() => {});
    blacklist.claimTicket(message.channel.id, message.author.id);
    logStaff(message, 'x!claim', `<#${message.channel.id}>`);
    return message.reply({ content: `🙋 <@${message.author.id}> a pris le ticket en charge.` }).catch(() => {});
  }
  if (low === 'x!rename-ticket' || low.startsWith('x!rename-ticket ')) {
    const t = blacklist.getTicket(message.channel.id);
    if (!t) return message.reply({ content: '❌ Uniquement dans un salon ticket.' }).catch(() => {});
    if (!canUseCommands(message.member, message.author.id)) return message.reply({ content: '❌ Réservé au staff.' }).catch(() => {});
    const wanted = raw.slice('x!rename-ticket'.length).trim();
    if (!wanted) return message.reply({ content: 'Usage : `x!rename-ticket <nouveau nom>`' }).catch(() => {});
    const clean = wanted.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '').replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 90);
    if (!clean) return message.reply({ content: '❌ Nom invalide (lettres/chiffres uniquement).' }).catch(() => {});
    const oldName = message.channel.name;
    try { await message.channel.setName(clean); } catch (e) { return message.reply({ content: `❌ Rename impossible : \`${e.message}\` (vérifie ma perm Gérer les salons).` }).catch(() => {}); }
    logStaff(message, 'x!rename-ticket', `<#${message.channel.id}> : \`${oldName}\` → \`${clean}\``);
    return message.reply({ content: `✏️ Ticket renommé : \`${oldName}\` → <#${message.channel.id}>` }).catch(() => {});
  }
  if (low === 'x!transcript') {
    const t = blacklist.getTicket(message.channel.id);
    if (!t) return message.reply({ content: '❌ Uniquement dans un salon ticket.' }).catch(() => {});
    const staff = canUseCommands(message.member, message.author.id);
    if (t.ownerId !== message.author.id && !staff) return message.reply({ content: '❌ Réservé au staff ou au créateur.' }).catch(() => {});
    const txt = await buildTranscriptText(message.channel, 100).catch(() => 'Transcript indisponible.');
    logStaff(message, 'x!transcript', `<#${message.channel.id}>`);
    return message.reply({ content: '📝 Transcript :', files: [{ attachment: Buffer.from(txt, 'utf8'), name: `transcript-${message.channel.name}.txt` }] }).catch(() => {});
  }
  if (low === 'x!tickets') {
    if (!canUseCommands(message.member, message.author.id)) return message.reply({ content: '❌ Réservé au staff.' }).catch(() => {});
    const list = blacklist.listOpenTickets(message.guild.id);
    logStaff(message, 'x!tickets', `${list.length} ticket(s) ouvert(s)`);
    if (!list.length) return message.reply({ content: '📭 Aucun ticket ouvert.' }).catch(() => {});
    const lines = list.map((r) => `<#${r.channelId}> — <@${r.ownerId}> (${r.ownerTag || r.ownerId}) — pris par ${r.claimedBy ? `<@${r.claimedBy}>` : '*personne*'} — <t:${Math.floor((r.createdAt || Date.now()) / 1000)}:R>`).join('\n').slice(0, 4000);
    return message.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle(`🎫 Tickets ouverts (${list.length})`).setDescription(lines).setTimestamp()] }).catch(() => {});
  }
  if (low === 'x!resolut' || low.startsWith('x!resolut ') || low === 'x!resolu' || low.startsWith('x!resolu ') || low === 'x!resolve' || low.startsWith('x!resolve ')) {
    const t = blacklist.getTicket(message.channel.id);
    if (!t) return message.reply({ content: '❌ Uniquement dans un salon ticket.' }).catch(() => {});
    if (!canUseCommands(message.member, message.author.id)) return message.reply({ content: '❌ Réservé au staff.' }).catch(() => {});
    // Anti-doublon : si la question est déjà posée juste au-dessus, on ne renvoie pas
    try {
      const recent = await message.channel.messages.fetch({ limit: 10 }).catch(() => null);
      if (recent) {
        const dup = [...recent.values()].find((m) => m.author?.id === client.user.id && isActiveResolutPrompt(m));
        if (dup) return message.reply({ content: '⚠️ Question déjà envoyée juste au-dessus 👆' }).catch(() => {});
      }
    } catch {}
    logStaff(message, 'x!resolut', `<#${message.channel.id}> -> <@${t.ownerId}>`);
    try {
      await message.channel.send({ content: `<@${t.ownerId}>`, embeds: [ticketResolutEmbed(t.ownerId)], components: ticketResolutRows(false) });
    } catch (e) { await message.reply({ content: `❌ Envoi impossible : \`${e.message}\`` }).catch(() => {}); }
    return;
  }

  // ----- x!rankup : palier suivant OU rôle choisi (x!rankup @user [@role]) -----
  if (low === 'x!rankup' || low.startsWith('x!rankup ') || low === 'x!rank-up' || low.startsWith('x!rank-up ') || low === 'x!promote' || low.startsWith('x!promote ')) {
    const execLvl = getLevel(message.member, message.author.id);
    if (!requireLevel(message.member, message.author.id, LVL.SENIOR)) return message.reply(deny('Réservé aux Seniors (niveau 20+).'));
    const arg = raw.slice(raw.toLowerCase().startsWith('x!rank-up') ? 'x!rank-up'.length : raw.toLowerCase().startsWith('x!promote') ? 'x!promote'.length : 'x!rankup'.length).trim();
    const target = await resolveRankTarget(message, arg);
    if (!target) return message.reply({ content: 'Usage : `x!rankup @user [@rôle1 @rôle2 ...]`' }).catch(() => {});
    if (target.id === message.author.id) return message.reply({ content: '❌ Tu ne peux pas te rankup toi-même.' }).catch(() => {});
    if (target.id === message.guild?.ownerId || isOwner(target.id)) return message.reply({ content: '❌ Impossible de modifier un Owner.' }).catch(() => {});
    const ranks = getOrderedRanks();
    const isExecOwner = isOwner(message.author.id);
    const targetLvl = getLevel(target, target.id);
    if (!isExecOwner && execLvl <= targetLvl) return message.reply(deny('Tu ne peux pas modifier quelqu’un de ton niveau ou supérieur.'));
    const botMe = message.guild?.members.me;
    if (!botMe?.permissions?.has(PermissionFlagsBits.ManageRoles)) return message.reply({ content: '❌ Il me manque la perm **Gérer les rôles**.' }).catch(() => {});
    // Cas 1 : rôle(s) précisé(s) → on donne ces rôles (ex : x!rankup @user @rôle1 @rôle2)
    const chosenRoles = resolveRolesArg(message, arg);
    if (chosenRoles.length) {
      const added = [];
      const skipped = [];
      const denied = [];
      for (const chosen of chosenRoles) {
        if (chosen.id === message.guild?.id) { skipped.push(`${chosen.name} (@everyone impossible)`); continue; }
        if (chosen.managed) { skipped.push(`${chosen.name} (géré par intégration)`); continue; }
        const rankEntry = ranks.find((r) => r.roleId === chosen.id);
        if (rankEntry && !isExecOwner && execLvl <= rankEntry.level) { denied.push(`${chosen.name} (niveau ${execLvl} insuffisant)`); continue; }
        if (!rankEntry) {
          try { if (chosen.permissions?.has(PermissionFlagsBits.Administrator) && !isExecOwner && execLvl < LVL.ADMIN) { denied.push(`${chosen.name} (Admin requis)`); continue; } } catch {}
          try { if (chosen.position >= message.member?.roles.highest.position && !isExecOwner) { denied.push(`${chosen.name} (au-dessus de toi)`); continue; } } catch {}
        }
        if (chosen.position >= botMe.roles.highest.position) { denied.push(`${chosen.name} (mon rôle trop bas)`); continue; }
        if (target.roles.cache.has(chosen.id)) { skipped.push(`${chosen.name} (déjà possédé)`); continue; }
        try {
          await target.roles.add(chosen.id);
          added.push(`${chosen}`);
        } catch (e) { denied.push(`${chosen.name} (${e.message})`); }
      }
      if (!added.length) return message.reply({ content: `❌ Aucun rôle ajouté.${skipped.length ? `\nIgnorés : ${skipped.join(', ')}` : ''}${denied.length ? `\nRefusés : ${denied.join(', ')}` : ''}`.slice(0, 1900) }).catch(() => {});
      await logStaff(message, 'x!rankup', `<@${message.author.id}> → <@${target.id}> : +${added.join(' +')}`);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#2ecc71').setTitle('⬆️ Rank up').setDescription(`<@${target.id}> a reçu ${added.join(' ')} par <@${message.author.id}>.${skipped.length ? `\n\nIgnorés : ${skipped.join(', ')}` : ''}${denied.length ? `\nRefusés : ${denied.join(', ')}` : ''}`.slice(0, 3900)).setTimestamp()] }).catch(() => {});
    }
    // Cas 2 : sans rôle → palier suivant (comportement d'origine)
    if (!ranks.length) return message.reply({ content: '❌ Aucune hiérarchie configurée (ajoute `hierarchy` dans config.json ou précise un rôle : `x!rankup @user @role`).' }).catch(() => {});
    let curIdx = -1;
    ranks.forEach((r, i) => { try { if (target.roles.cache.has(r.roleId)) curIdx = i; } catch {} });
    const nextIdx = curIdx + 1;
    if (nextIdx >= ranks.length) return message.reply({ content: `⚠️ <@${target.id}> est déjà au max (**${ranks[curIdx]?.name || 'max'}**).` }).catch(() => {});
    const next = ranks[nextIdx];
    if (!isExecOwner && execLvl <= next.level) return message.reply(deny(`Tu ne peux pas promouvoir au niveau **${next.name} (${next.level})** — ton niveau (${execLvl}) est insuffisant.`));
    try {
      const role = message.guild?.roles.cache.get(next.roleId);
      if (!role) return message.reply({ content: `❌ Rôle introuvable : \`${next.roleId}\` (${next.name}).` }).catch(() => {});
      if (role.position >= botMe.roles.highest.position) return message.reply({ content: `❌ Mon rôle est trop bas pour donner ${role} (remonte mon rôle au-dessus).` }).catch(() => {});
      for (const r of ranks) { if (r.roleId !== next.roleId) { try { if (target.roles.cache.has(r.roleId)) await target.roles.remove(r.roleId).catch(() => null); } catch {} } }
      await target.roles.add(next.roleId);
      await logStaff(message, 'x!rankup', `<@${message.author.id}> → <@${target.id}> : **${next.name}** (${next.level})`);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#2ecc71').setTitle('⬆️ Rank up').setDescription(`<@${target.id}> promu à **${next.name}** (niveau **${next.level}**) par <@${message.author.id}>.`).setTimestamp()] }).catch(() => {});
    } catch (e) { return message.reply({ content: `❌ Rankup impossible : \`${e.message}\`` }).catch(() => {}); }
  }
  if (low === 'x!derank' || low.startsWith('x!derank ') || low === 'x!derank-up' || low.startsWith('x!derank-up ') || low === 'x!demote' || low.startsWith('x!demote ') || low === 'x!rankdown' || low.startsWith('x!rankdown ')) {
    const execLvl = getLevel(message.member, message.author.id);
    if (!requireLevel(message.member, message.author.id, LVL.SENIOR)) return message.reply(deny('Réservé aux Seniors (niveau 20+).'));
    const arg = raw.slice(raw.toLowerCase().split(' ')[0].length).trim();
    const target = await resolveRankTarget(message, arg);
    if (!target) return message.reply({ content: 'Usage : `x!derank @user [@rôle1 @rôle2 ...]`' }).catch(() => {});
    if (target.id === message.guild?.ownerId || isOwner(target.id)) return message.reply({ content: '❌ Impossible de modifier un Owner.' }).catch(() => {});
    const ranks = getOrderedRanks();
    const targetLvl = getLevel(target, target.id);
    const isExecOwner = isOwner(message.author.id);
    if (!isExecOwner && execLvl <= targetLvl) return message.reply(deny('Tu ne peux pas modifier quelqu’un de ton niveau ou supérieur.'));
    const botMe = message.guild?.members.me;
    if (!botMe?.permissions?.has(PermissionFlagsBits.ManageRoles)) return message.reply({ content: '❌ Il me manque la perm **Gérer les rôles**.' }).catch(() => {});
    // Cas 1 : rôle(s) précisé(s) → on retire ces rôles (ex : x!derank @user @rôle1 @rôle2)
    const chosenRoles = resolveRolesArg(message, arg);
    if (chosenRoles.length) {
      const removed = [];
      const skipped = [];
      for (const chosen of chosenRoles) {
        if (!target.roles.cache.has(chosen.id)) { skipped.push(`${chosen.name} (non possédé)`); continue; }
        try { if (chosen.position >= botMe.roles.highest.position) { skipped.push(`${chosen.name} (mon rôle trop bas)`); continue; } } catch {}
        try {
          await target.roles.remove(chosen.id);
          removed.push(`${chosen}`);
        } catch (e) { skipped.push(`${chosen.name} (${e.message})`); }
      }
      if (!removed.length) return message.reply({ content: `❌ Aucun rôle retiré.\nIgnorés : ${skipped.join(', ')}`.slice(0, 1900) }).catch(() => {});
      await logStaff(message, 'x!derank', `<@${message.author.id}> → <@${target.id}> : -${removed.join(' -')}`);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle('⬇️ Derank').setDescription(`<@${target.id}> : ${removed.join(' ')} retiré(s) par <@${message.author.id}>.${skipped.length ? `\n\nIgnorés : ${skipped.join(', ')}` : ''}`.slice(0, 3900)).setTimestamp()] }).catch(() => {});
    }
    // Cas 2 : sans rôle → palier inférieur (comportement d'origine)
    if (!ranks.length) return message.reply({ content: '❌ Aucune hiérarchie configurée (ajoute `hierarchy` dans config.json ou précise un rôle : `x!derank @user @role`).' }).catch(() => {});
    let curIdx = -1;
    ranks.forEach((r, i) => { try { if (target.roles.cache.has(r.roleId)) curIdx = i; } catch {} });
    if (curIdx < 0) return message.reply({ content: `📭 <@${target.id}> n’a aucun rang (déjà Membre).` }).catch(() => {});
    const cur = ranks[curIdx];
    const nextIdx = curIdx - 1;
    try {
      await target.roles.remove(cur.roleId).catch(() => null);
      if (nextIdx < 0) {
        await logStaff(message, 'x!derank', `<@${message.author.id}> → <@${target.id}> : **${cur.name}** retiré → Membre`);
        return message.reply({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle('⬇️ Derank').setDescription(`<@${target.id}> rétrogradé de **${cur.name}** → **Membre** par <@${message.author.id}>.`).setTimestamp()] }).catch(() => {});
      }
      const next = ranks[nextIdx];
      if (!isExecOwner && execLvl <= next.level && execLvl <= cur.level) return message.reply(deny('Niveau insuffisant pour cette rétrogradation.'));
      const role = message.guild?.roles.cache.get(next.roleId);
      if (!role) return message.reply({ content: `❌ Rôle introuvable : \`${next.roleId}\` (${next.name}).` }).catch(() => {});
      if (role.position >= botMe.roles.highest.position) return message.reply({ content: `❌ Mon rôle est trop bas pour donner ${role}.` }).catch(() => {});
      for (const r of ranks) { if (r.roleId !== next.roleId) { try { if (target.roles.cache.has(r.roleId)) await target.roles.remove(r.roleId).catch(() => null); } catch {} } }
      await target.roles.add(next.roleId);
      await logStaff(message, 'x!derank', `<@${message.author.id}> → <@${target.id}> : **${cur.name}** → **${next.name}**`);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle('⬇️ Derank').setDescription(`<@${target.id}> rétrogradé de **${cur.name}** → **${next.name}** par <@${message.author.id}>.`).setTimestamp()] }).catch(() => {});
    } catch (e) { return message.reply({ content: `❌ Derank impossible : \`${e.message}\`` }).catch(() => {}); }
  }

  // ----- f!bl-bot (blacklist bots, Staff — déplacé depuis x!) -----
  if (low === 'f!bl-bot' || low.startsWith('f!bl-bot ') || low === 'f!blbot' || low.startsWith('f!blbot ')) {
  const _blg = blRoleGate(message); if (_blg) return message.reply(_blg);
    const arg = raw.slice(raw.toLowerCase().startsWith('f!bl-bot') ? 'f!bl-bot'.length : 'f!blbot'.length).trim();
    const sub = (arg.split(/ +/).filter(Boolean)[0] || '').toLowerCase();
    const usage = 'Usage : `f!bl-bot <id/mention> [raison]`';
    if (sub === 'list') {
      const list = blacklist.listBotBlacklist();
      logStaff(message, 'f!bl-bot', `list (${list.length})`, { channelId: BLBOT_LOG_ID });
      if (!list.length) return message.reply({ content: '📭 Blacklist bots vide.' }).catch(() => {});
      const lines = list.map((r) => `<@${r.userId}> — \`${r.userId}\` (${r.tag || 'sans tag'}) — ${r.reason || '*sans raison*'} — par ${r.addedBy ? `<@${r.addedBy}>` : '?'} — <t:${Math.floor((r.createdAt || Date.now()) / 1000)}:R>`).join('\n').slice(0, 3900);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle(`🚫 Bots blacklistés (${list.length})`).setDescription(lines).setTimestamp()] }).catch(() => {});
    }
    const isRemove = ['remove', 'del', 'delete', 'unban', 'retirer'].includes(sub);
    const isAdd = ['add', 'ajouter', 'ban'].includes(sub);
    // Cible = mention ou ID (le reste = raison pour add)
    let targetUser = message.mentions.users.first();
    let reason = '';
    if (isAdd || isRemove) {
      const rest = arg.slice(sub.length).trim();
      if (!targetUser) {
        const id = (rest.match(/\d{15,}/g) || [])[0] || '';
        if (id) targetUser = await message.client.users.fetch(id).catch(() => null);
      }
      reason = rest.replace(/<@!?\d+>/g, '').replace(/\d{15,}/, '').trim().slice(0, 500);
      if (!targetUser) return message.reply({ content: usage }).catch(() => {});
    } else {
      // Sans sous-commande : f!bl-bot @bot [raison] = add
      if (!targetUser) {
        const id = (arg.match(/\d{15,}/g) || [])[0] || '';
        if (id) targetUser = await message.client.users.fetch(id).catch(() => null);
      }
      if (!targetUser) return message.reply({ content: usage }).catch(() => {});
      reason = arg.replace(/<@!?\d+>/g, '').replace(/\d{15,}/, '').trim().slice(0, 500);
    }
    if (!targetUser.bot) return message.reply({ content: `❌ <@${targetUser.id}> n’est pas un bot.` }).catch(() => {});
    if (targetUser.id === message.client.user.id) return message.reply({ content: '❌ Impossible de blacklister le bot lui-même.' }).catch(() => {});
    if (isRemove) {
      const was = blacklist.removeBotBlacklist(targetUser.id);
      await logStaff(message, 'f!bl-bot', `➖ <@${targetUser.id}> retiré par <@${message.author.id}>`, { channelId: BLBOT_LOG_ID });
      return message.reply({ content: was ? `✅ <@${targetUser.id}> retiré de la blacklist bots.` : `📭 <@${targetUser.id}> n’était pas blacklisté.` }).catch(() => {});
    }
    // Validation Oui/Non envoyée uniquement à l'owner 1500893751751475230 (même pour un owner).
    const reqId = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`;
    pendingBlBot.set(reqId, { targetId: targetUser.id, tag: targetUser.tag, reason, requesterId: message.author.id, requesterTag: message.author.tag, guildName: message.guild.name, channelId: message.channel.id, createdAt: Date.now() });
    setTimeout(() => pendingBlBot.delete(reqId), BLBOT_TIMEOUT_MS).unref?.();
    await logStaff(message, 'f!bl-bot', `⏳ demande de blacklist : <@${targetUser.id}> (${targetUser.tag}) par <@${message.author.id}>${reason ? ` — ${reason}` : ''} (attente validation)`, { channelId: BLBOT_LOG_ID });
    const confirmEmbed = new EmbedBuilder().setColor('#ffa500').setTitle('🚫 Demande de blacklist bot').setDescription(`**Demandé par :** ${message.author.tag} (<@${message.author.id}>)\n**Serveur :** ${message.guild.name}\n\n**Bot :** ${targetUser.tag} (<@${targetUser.id}>)\n**ID :** \`${targetUser.id}\`\n**Raison :** ${reason || '*aucune*'}\n\nConfirmer le blacklist ? (10 min)`).setTimestamp();
    let sentOk = false;
    try {
      const owner = await message.client.users.fetch(BLBOT_OWNER_ID).catch(() => null);
      if (owner) {
        await owner.send({ embeds: [confirmEmbed], components: blBotConfirmRows(reqId, false) }).catch(() => null);
        sentOk = true;
      }
    } catch {}
    if (!sentOk) { pendingBlBot.delete(reqId); return message.reply({ content: '❌ Owner injoignable en MP (demande annulée).' }).catch(() => {}); }
    return message.reply({ content: `⏳ Demande envoyée — <@${targetUser.id}> sera blacklisté après validation Oui/Non.` }).catch(() => {});
  }

  // ----- f!unbl-bot (retirer un bot de la blacklist bots, Staff) -----
  if (low === 'f!unbl-bot' || low.startsWith('f!unbl-bot ') || low === 'f!unblbot' || low.startsWith('f!unblbot ')) {
  const _blg = blRoleGate(message); if (_blg) return message.reply(_blg);
    const arg = raw.slice(raw.toLowerCase().startsWith('f!unbl-bot') ? 'f!unbl-bot'.length : 'f!unblbot'.length).trim();
    let targetUser = message.mentions.users.first();
    if (!targetUser) {
      const id = (arg.match(/\d{15,}/g) || [])[0] || '';
      if (id) targetUser = await message.client.users.fetch(id).catch(() => null);
    }
    if (!targetUser) return message.reply({ content: 'Usage : `f!unbl-bot <id/mention>`' }).catch(() => {});
    const was = blacklist.removeBotBlacklist(targetUser.id);
    await logStaff(message, 'f!unbl-bot', `➖ <@${targetUser.id}> (${targetUser.tag}) retiré par <@${message.author.id}>`, { channelId: BLBOT_LOG_ID });
    return message.reply({ content: was ? `✅ <@${targetUser.id}> retiré de la blacklist bots.` : `📭 <@${targetUser.id}> n’était pas blacklisté.` }).catch(() => {});
  }

  // ----- F!dm (envoyer un MP à @/id, owners) -----
  if (low === 'f!dm' || low.startsWith('f!dm ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const arg = raw.slice('f!dm'.length).trim();
    let target = message.mentions.users.first();
    let text = '';
    if (target) {
      text = arg.replace(/<@!?\d+>/g, '').trim();
    } else {
      const id = (arg.match(/\d{15,}/g) || [])[0] || '';
      if (id) target = await message.client.users.fetch(id).catch(() => null);
      text = arg.replace(/<@!?\d+>/g, '').replace(/\d{15,}/, '').trim();
    }
    if (!target) return message.reply({ content: 'Usage : `F!dm @user <message>`' }).catch(() => {});
    if (!text) return message.reply({ content: 'Usage : `F!dm @user <message>` (message vide).' }).catch(() => {});
    if (target.bot) return message.reply({ content: '❌ Impossible d’envoyer un MP à un bot.' }).catch(() => {});
    if (target.id === message.client.user.id) return message.reply({ content: '❌ Impossible.' }).catch(() => {});
    try {
      await target.send({ embeds: [new EmbedBuilder().setColor('#5865F2').setAuthor({ name: 'Phénix • Équipe officielle', iconURL: message.guild.iconURL({ size: 64 }) || undefined }).setTitle('📩 Message officiel').setDescription(`>>> ${text.slice(0, 3800)}`).setThumbnail(client.user.displayAvatarURL({ size: 128 })).addFields(
        { name: '👤 Expéditeur', value: `${message.author.tag}`, inline: true },
        { name: '🏰 Serveur', value: `${message.guild.name}`, inline: true },
      ).setFooter({ text: `Phénix Support • ID ${message.author.id}` }).setTimestamp()] });
      await logOwner(message, 'F!dm', `<@${message.author.id}> → <@${target.id}> : ${text.slice(0, 200)}`);
      return message.reply({ content: `✅ MP envoyé à <@${target.id}>.` }).catch(() => {});
    } catch (e) {
      await logOwner(message, 'F!dm', `❌ <@${message.author.id}> → <@${target.id}> : \`${e.message}\``, { success: false });
      return message.reply({ content: `❌ MP impossible (MPs fermés ou bot bloqué) : \`${e.message}\`` }).catch(() => {});
    }
  }
  // ----- f!shutdown / f!restart / f!eval / f!reload / f!logs / f!setlogs / f!staffinfo / f!staffhistory (owners) -----
  if (low === 'f!shutdown' || low === 'f!stop') {
    await logOwner(message, 'F!shutdown', 'demandé');
    await message.reply({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('⏹️ Arrêt du bot').setDescription(`Arrêt demandé par <@${message.author.id}> — le bot s\'éteint dans 3 secondes.`).setTimestamp()] }).catch(() => {});
    setTimeout(() => { try { client.destroy(); } catch {} process.exit(0); }, 3000);
    return;
  }
  if (low === 'f!restart' || low === 'f!reboot') {
    await logOwner(message, 'F!restart', 'demandé');
    await message.reply({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle('🔄 Redémarrage du bot').setDescription(`Redémarrage demandé par <@${message.author.id}> — le processus se relance dans 3 secondes (le panel le relance automatiquement).`).setTimestamp()] }).catch(() => {});
    setTimeout(() => { try { client.destroy(); } catch {} process.exit(1); }, 3000);
    return;
  }
  if (low.startsWith('f!eval ') || low === 'f!eval') {
    const mainOwner = (OWNER_IDS[0] || '').toString();
    if (message.author.id !== mainOwner) return message.reply(deny('Réservé au propriétaire principal du bot.')).catch(() => {});
    const code = (raw || '').slice('f!eval'.length).trim().replace(/^```(?:js|javascript)?\n?|```$/g, '');
    if (!code) return message.reply({ content: 'Usage : `f!eval <code js>` — ⚠️ exécute du code réel sur le serveur hôte.' }).catch(() => {});
    await logOwner(message, 'F!eval', code.slice(0, 1000));
    let result;
    try {
      result = await (async () => eval(code))();
      if (typeof result !== 'string') result = require('util').inspect(result, { depth: 1 });
    } catch (e) { result = `❌ ${e && e.stack ? e.stack : e}`; }
    return message.reply({ embeds: [new EmbedBuilder().setColor(result && String(result).startsWith('❌') ? '#ff0000' : '#2ecc71').setTitle('🧪 f!eval').addFields({ name: '📥 Code', value: `\`\`\`js\n${String(code).slice(0, 1000)}\n\`\`\`` }, { name: '📤 Résultat', value: `\`\`\`js\n${String(result).slice(0, 1000)}\n\`\`\`` }).setTimestamp()] }).catch(() => {});
  }
  if (low === 'f!reload' || low.startsWith('f!reload ')) {
    await logOwner(message, 'F!reload', (raw || '').slice('f!reload'.length).trim().slice(0, 200));
    try {
      await message.reply({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle('♻️ Rechargement...').setDescription('Recharge de la configuration et reconnexion en cours.').setTimestamp()] }).catch(() => {});
      client.destroy();
      await client.login(DISCORD_TOKEN);
      try { const pc = getBotPresence(); if (pc) await applyBotPresence(pc.status || 'online', pc.state || '', pc.type != null && pc.type !== 'custom' ? String(pc.type) : 'custom'); } catch {}
      return message.channel.send({ embeds: [new EmbedBuilder().setColor('#2ecc71').setTitle('♻️ Bot rechargé').setDescription(`Config relue + reconnexion réussie par <@${message.author.id}>.\n*ℹ️ Le code des commandes est dans un seul fichier : un vrai rechargement de commande passe par \`f!restart\`.*`).setTimestamp()] }).catch(() => {});
    } catch (e) {
      return message.channel.send({ content: `❌ Reload échoué : \`${e.message}\` — utilise \`f!restart\`.` }).catch(() => {});
    }
  }
  if (low === 'f!logs' || low.startsWith('f!logs ')) {
    await logOwner(message, 'F!logs', '');
    const fmt = (id) => (id ? `<#${id}> (\`${id}\`)` : '*non configuré*');
    return message.reply({ embeds: [new EmbedBuilder().setColor('#3498db').setTitle('📜 Configuration des logs').addFields(
      { name: '👑 Logs owners (f!)', value: fmt(ownerLogChannelId()), inline: true },
      { name: '🛡️ Logs staff (x!/st!)', value: fmt(staffLogChannelId()), inline: true },
      { name: '⚖️ Logs modération (px!)', value: fmt(modLogChannelId()), inline: true },
      { name: '🎫 Logs tickets', value: fmt(ticketLogChannelId()), inline: true },
      { name: '💡 Cfg actuelle', value: `Modifiable avec \`f!setlogs #salon\` (modération + général). Le reste s\'édite dans \`config.json\` (ownerLogChannelId, staffLogChannelId, ticketLogChannelId).`, inline: false },
    ).setFooter({ text: 'Phénix • Logs' }).setTimestamp()] }).catch(() => {});
  }
  if (low === 'f!setlogs' || low.startsWith('f!setlogs ')) {
    const arg = (raw || '').slice('f!setlogs'.length).trim();
    const ch = message.mentions.channels.first() || message.guild.channels.cache.get(arg.replace(/[<#>]/g, ''));
    if (!ch?.isTextBased?.()) return message.reply({ content: 'Usage : `f!setlogs #salon` — configure le salon des journaux (modération/général).' }).catch(() => {});
    try {
      const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      c.modLogChannelId = ch.id; c.logChannelId = ch.id;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
    } catch (e) { return message.reply({ content: `❌ Écriture config impossible : \`${e.message}\`` }).catch(() => {}); }
    await logOwner(message, 'F!setlogs', `<#${ch.id}> par <@${message.author.id}>`);
    return message.reply({ embeds: [new EmbedBuilder().setColor('#2ecc71').setTitle('📜 Salon des logs configuré').setDescription(`Journaux (modération/général) → <#${ch.id}>\n*Pris en compte immédiatement (lecture live de config.json).*`).setTimestamp()] }).catch(() => {});
  }
  if (low === 'f!staffinfo' || low.startsWith('f!staffinfo ') || low === 'f!staff-info' || low.startsWith('f!staff-info ')) {
    const arg = (raw || '').slice(low.startsWith('f!staff-info') ? 'f!staff-info'.length : 'f!staffinfo'.length).trim();
    const { user, member } = await fetchPMember(message, arg || message.author.id);
    if (!user) return message.reply({ content: 'Usage : `f!staffinfo @membre`' }).catch(() => {});
    await logOwner(message, 'F!staffinfo', `<@${user.id}> par <@${message.author.id}>`);
    const gs = blacklist.getGlobalStaff(user.id);
    const st = blacklist.getStaffStats(user.id);
    const warnCount = blacklist.countWarns(user.id, message.guild.id);
    const jail = blacklist.getJail(message.guild.id, user.id);
    const blocked = blacklist.isCommandBlocked(user.id);
    const emb = blacklist.getUserBlacklist(user.id);
    const desc = [
      `**Membre :** <@${user.id}> (\`${user.id}\`)`,
      `**Grade staff global :** ${gs ? `🟢 \`${gs.level}\` (ajouté par ${gs.addedBy ? `<@${gs.addedBy}>` : '?'} <t:${Math.floor(gs.addedAt / 1000)}:R>)` : '⚪ Aucun (pas staff global)'}`,
      `**Sanctions actives :** ${warnCount} warn(s)${jail ? ` • 🔒 jail (jusqu'à <t:${Math.floor((jail.until || 0) / 1000)}:f>)` : ''}${blocked ? ' • ⛔ commandes bloquées' : ''}${emb ? ' • 🚫 blacklisté' : ''}`,
    ].join('\n');
    return message.reply({ embeds: [new EmbedBuilder().setColor(gs ? '#2ecc71' : '#95a5a6').setTitle('🛡️ Staffinfo').setDescription(desc).addFields(
      { name: '📊 Interventions staff', value: `⚔️ Raid : **${st.raid}** • 🆘 SOS : **${st.sos}** • 🎫 Ticket : **${st.ticket}** • ❓ Question : **${st.question}** — total **${st.total}**`, inline: false },
    ).setTimestamp()] }).catch(() => {});
  }
  if (low === 'f!staffhistory' || low.startsWith('f!staffhistory ') || low === 'f!staff-history' || low.startsWith('f!staff-history ')) {
    const arg = (raw || '').slice(low.startsWith('f!staff-history') ? 'f!staff-history'.length : 'f!staffhistory'.length).trim();
    const { user, member } = await fetchPMember(message, arg || message.author.id);
    if (!user) return message.reply({ content: 'Usage : `f!staffhistory @membre`' }).catch(() => {});
    await logOwner(message, 'F!staffhistory', `<@${user.id}> par <@${message.author.id}>`);
    const warns = blacklist.listWarns(user.id, message.guild.id);
    const lines = warns.slice(0, 10).map((w, i) => `**#${w.id}** — ${w.reason || '*sans raison*'} — par ${w.warnedBy ? `<@${w.warnedBy}>` : '?'} — <t:${Math.floor(w.warnedAt / 1000)}:R>`).join('\n') || '*aucun warn*';
    const emb = blacklist.getUserBlacklist(user.id);
    const jail = blacklist.getJail(message.guild.id, user.id);
    const blocked = blacklist.isCommandBlocked(user.id);
    const embDesc = [
      `**📋 Historique des warns (${warns.length})**`,
      lines,
      '',
      `**⚖️ Sanctions en cours**`,
      jail ? `🔒 **Jail** — ${jail.reason || '*sans raison*'} — par ${jail.jailedBy ? `<@${jail.jailedBy}>` : '?'} — jusqu\'à <t:${Math.floor((jail.until || 0) / 1000)}:f>` : '🔒 Jail : aucun',
      blocked ? `⛔ **Commandes bloquées** — ${blocked.reason || '*sans raison*'} — par ${blocked.blockedBy ? `<@${blocked.blockedBy}>` : '?'}` : '⛔ Blocage : aucun',
      emb ? `🚫 **Blacklisté** — ${emb.reason || '*sans raison*'} — par ${emb.addedBy ? `<@${emb.addedBy}>` : '?'} — preuves : ${(JSON.parse(emb.proofs || '[]').length)} pièce(s)` : '🚫 Blacklist : non',
    ].join('\n').slice(0, 3900);
    return message.reply({ embeds: [new EmbedBuilder().setColor(warns.length ? '#e67e22' : '#2ecc71').setTitle(`📚 Staffhistory — <@${user.id}>`).setDescription(embDesc).setTimestamp()] }).catch(() => {});
  }

  // ----- F!status (modifier le statut du bot, owners) -----
  if (low === 'f!status' || low.startsWith('f!status ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const arg = raw.slice('f!status'.length).trim();
    const names = { online: '🟢 En ligne', idle: '🟡 Inactif', dnd: '🔴 Ne pas déranger', invisible: '⚫ Hors ligne' };
    if (!arg) {
      const cur = getBotPresence();
      return message.reply({ embeds: [new EmbedBuilder().setColor('#f1c40f').setTitle('📊 Statut du bot').setDescription(
        `${names[cur.status] || '🟢 En ligne'}${cur.state ? `\n💬 ${activityLine(cur)}` : ''}\n\n` +
        '*Usage :* `f!status <en ligne | inactif | hors ligne | ne pas déranger> [texte d’activité]`\n' +
        '`f!status en direct [texte]` — affiche le bot comme en direct\n' +
        '`f!activite <joue | regarde | écoute | participe | stream | texte> <texte>` — change le type d’activité\n' +
        '`f!activite off` — retire l’activité • `f!status reset` — remet 🟢 En ligne sans activité.') ] }).catch(() => {});
    }
    if (low === 'f!status reset') {
      logOwner(message, 'F!status', '🔧 reset du statut');
      saveBotPresence('online', '');
      await applyBotPresence('online', '');
      return message.reply('✅ Statut réinitialisé : 🟢 **En ligne**.').catch(() => {});
    }
    const m = arg.match(/^(en direct|streaming|stream|en ligne|inactif|idle|online|hors ligne|invisible|offline|ne pas d[ée]ranger|dnd|npd)\s*(.*)$/i);
    if (!m) return message.reply({ content: 'Usage : `f!status <en ligne | inactif | hors ligne | ne pas déranger> [texte d’activité]`, `f!status en direct [texte]` ou `f!status reset`' }).catch(() => {});
    const kw = m[1].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const isStreaming = kw === 'en direct' || kw === 'streaming' || kw === 'stream';
    const status = isStreaming || kw.startsWith('en ligne') || kw === 'online' ? 'online'
      : kw.startsWith('inactif') || kw === 'idle' ? 'idle'
      : kw.startsWith('hors ligne') || kw === 'invisible' || kw === 'offline' ? 'invisible'
      : 'dnd';
    const state = (m[2] || '').trim() || (isStreaming ? 'En direct' : '');
    const activityType = isStreaming ? '1' : 'custom';
    logOwner(message, 'F!status', `📊 ${names[status]}${state ? ` — ${state.slice(0, 100)}` : ''}`);
    saveBotPresence(status, state, activityType);
    await applyBotPresence(status, state, activityType);
    return message.reply({ content: `✅ Statut mis à jour : ${names[status]}${state ? `\n💬 ${activityLine({ state, type: isStreaming ? 1 : 'custom' })}` : ''}` }).catch(() => {});
  }

  // ----- F!activite (changer l'activité du bot : joue / regarde / écoute..., owners) -----
  if (low === 'f!activite' || low.startsWith('f!activite ') || low === 'f!activité' || low.startsWith('f!activité ') || low === 'f!act' || low.startsWith('f!act ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const arg = raw.slice(raw.toLowerCase().startsWith('f!activite') ? 'f!activite'.length : raw.toLowerCase().startsWith('f!act') ? 'f!act'.length : 'f!activité'.length).trim();
    const map = {
      'joue': '0', 'joue à': '0', 'playing': '0', 'game': '0',
      'regarde': '3', 'watching': '3', 'regard': '3',
      'écoute': '2', 'ecoute': '2', 'listening': '2',
      'participe': '5', 'participe à': '5', 'competing': '5', 'competition': '5',
      'stream': '1', 'streaming': '1',
      'texte': '4', 'custom': '4',
    };
    if (!arg) {
      const cur = getBotPresence();
      const menu = new StringSelectMenuBuilder().setCustomId(`factiv:${message.author.id}`).setPlaceholder('🎬 Choisir une activité…').addOptions(
        new StringSelectMenuOptionBuilder().setLabel('💬 Texte libre').setValue('custom').setDescription('Simple texte affiché sur le bot'),
        new StringSelectMenuOptionBuilder().setLabel('🎮 Joue à…').setValue('0').setDescription('le bot « joue à » quelque chose'),
        new StringSelectMenuOptionBuilder().setLabel('📺 Regarde…').setValue('3').setDescription('le bot « regarde » quelque chose'),
        new StringSelectMenuOptionBuilder().setLabel('🎧 Écoute…').setValue('2').setDescription('le bot « écoute » quelque chose'),
        new StringSelectMenuOptionBuilder().setLabel('🏆 Participe à…').setValue('5').setDescription('le bot « participe à » quelque chose'),
        new StringSelectMenuOptionBuilder().setLabel('📡 Stream…').setValue('1').setDescription('le bot est en stream'),
        new StringSelectMenuOptionBuilder().setLabel('🚫 Retirer l’activité').setValue('off').setDescription('aucune activité affichée'),
      );
      return message.reply({
        embeds: [new EmbedBuilder().setColor('#f1c40f').setTitle('🎬 Activité du bot').setDescription(cur.state ? `**Actuel :** ${activityLine(cur)}` : '**Actuel :** (aucune activité)')],
        components: [new ActionRowBuilder().addComponents(menu)],
      }).catch(() => {});
    }
    if (low === 'f!activite off' || low === 'f!activité off' || low === 'f!act off') {
      const cur = getBotPresence();
      logOwner(message, 'F!activite', '🚫 activité retirée');
      saveBotPresence(cur.status, '', 'custom');
      await applyBotPresence(cur.status, '', '');
      return message.reply('✅ Activité retirée.').catch(() => {});
    }
    const m = arg.match(/^(\S+)\s*([\s\S]*)$/i);
    const first = (m[1] || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const cur = getBotPresence();
    const key = Object.keys(map).find((k) => k.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') === first);
    if (!key) {
      logOwner(message, 'F!activite', `💬 texte — ${arg.slice(0, 100)}`);
      saveBotPresence(cur.status, arg, 'custom');
      await applyBotPresence(cur.status, arg, 'custom');
      return message.reply(`✅ Activité : 💬 ${arg.slice(0, 128)}`).catch(() => {});
    }
    const t = map[key];
    const text = (m[2] || '').trim();
    if (!text) return message.reply({ content: 'Usage : `f!activite <joue | regarde | écoute | participe | stream | texte> <texte>`' }).catch(() => {});
    logOwner(message, 'F!activite', `🎬 ${key} — ${text.slice(0, 100)}`);
    saveBotPresence(cur.status, text, t === '4' ? 'custom' : t);
    await applyBotPresence(cur.status, text, t === '4' ? 'custom' : t);
    return message.reply(`✅ Activité : ${activityLine({ state: text, type: t === '4' ? 4 : Number(t) })}`).catch(() => {});
  }

  // ----- F!help (aide des commandes F! — Anti-Raid + Support) -----
  if (low === 'f!help' || low.startsWith('f!help ') || low === 'f!h' || low.startsWith('f!h ')) {
    logOwner(message, 'F!help', '');
    return sendHelpMenu(message, 'f');
  }
  if (false) { // ancien aide f! (desactive)
    logOwner(message, 'F!help', '');
    return message.reply({ embeds: [withCmdCount(new EmbedBuilder().setColor('#f1c40f').setTitle('⚡ Phénix — Aide').setDescription('**🚫 Blacklist :**\n`f!bl <id/mention> <raison>` — blackliste (+ pièces jointes = preuves)\n`f!unbl <id/mention>` — retire de la blacklist\n`f!bl-list` — liste des blacklistés\n`f!bl-check <id/mention>` — raison du blacklist\n`f!bl-bot <id/mention>` — blacklist bots (Staff)\n`f!bl-bot list` — liste des bots blacklistés (Staff)\n`f!unbl-bot <id/mention>` — retire un bot de la blacklist (Staff)\n\n**🐛 Bugs :**\n`f!buglist [n]` — voir les bugs signalés (Staff)\n`f!clearbug-all` — supprimer tous les bugs (Owners)\n\n**👑 Owners :**\n`f!add <id/mention>` / `f!remove <id/mention>` — ajouter/retirer un owner (super-owner)\n`f!owner-list` — liste les owners\n`f!identite [@user]` — confirme que tu es owner\n\n**🎖️ Rôles :**\n`f!me` — donne le rôle Owner\n`f!perm-add` / `f!perm-down` — donner/retirer le rôle\n`f!supp` — supprime le rôle Owner\n`f!traadmin @user` — donne le rôle Phénix Admin (créé si inexistant)\n`f!unrank @user` — retire le rôle Phénix Admin\n`f!trasupp` — supprime le rôle Phénix Admin\n`f!permadmin` — demande le rôle administrateur (validation owner)\n\n**🎖️ Staff global :**\n`f!staff add <id>` / `f!staff remove <id>` / `f!staff list` — staff sauvegardé (partout)\n\n**🛠️ Gestion :**\n`f!servers` — liste des serveurs du bot\n`f!leave [id serveur]` — faire quitter le bot\n`f!fdm <id> <msg>` — MP au nom d’un owner\n`f!maintenance <txt>` / `f!fin-maintenance` — annonces maintenance\n`f!status <en ligne | inactif | hors ligne | ne pas déranger> [texte]` — statut du bot (owners)\n`f!activite <joue | regarde | écoute | participe | stream | texte> <texte>` — activité du bot (owners)\n`f!initialise [id]` — lien d’invitation\n`f!unban <id> [serveur]` — débannir\n`f!sbl <id> [raison]` / `f!sunbl <id>` / `f!sbl-list` — serveurs blacklistés\n`f!block <id>` / `f!unblock <id>` / `f!block-list` — bloque les commandes\n`F!backup create/list/restore/delete` — sauvegardes (owners)\n`F!offar` / `F!onar` — désactiver/réactiver antiraid (owners)\n`f!say <msg>` / `f!send <id salon> <msg>` — envoyer un message (owners)\n`F!annonce [#salon] [titre |] <msg>` — annonce embed (staff)\n`f!invite [id]` — lien d’invitation\n`f!dm @user <msg>` — MP officiel').setFooter({ text: 'Phénix Anti-Raid • Réservé aux owners' }).setTimestamp(), /`[fF]!/g)] }).catch(() => {});
  }
  // ----- x!help / x!stafflog -----
  if (low === 'x!help' || low.startsWith('x!help ') || low === 'x!commands') {
    logStaff(message, 'x!help', '');
    return sendHelpMenu(message, 'x');
  }
  if (false) { // ancien aide x! (desactive)tTitle('📖 Phénix Support').setDescription('`x!stats` — tes stats\n`x!stats @user` — stats d\'un staff\n`x!top [raid|sos|ticket|question|total]` — classement\n`x!allstats` — top 25\n`x!panel-ticket` — panneau ticket (salon)\n`x!panel` — panneau stats (Ticket/Raid/SOS/Question +1)\n`x!panel-stats` — panneau stats\n`x!rankup @user [@rôle...]` / `x!derank @user [@rôle...]` — promouvoir / rétrograder (Senior+)\n`x!poste-suggestion` — panneau suggestions (💡 + accepter/en dev/refuser)\n`x!phénix` — présentation du bot\n`x!status` — état du bot\n`x!jailconfig <@rôle> [#salon]` — configurer le jail (owners)\n`x!tickets` — tickets ouverts\n`x!claim` / `x!close` / `x!add` / `x!remove` / `x!rename-ticket` / `x!transcript` / `x!resolut` — dans un salon ticket\n`x!setup` — configurer le support (owners)\n`x!reset` / `x!resetall` — owners').setTimestamp(), /`x!/gi)] });
  }
  if (low === 'x!stafflog' || low === 'x!testlog') {
    if (!canUseCommands(message.member, message.author.id)) return message.reply({ content: '❌ Réservé au staff.' }).catch(() => {});
    await logStaff(message, 'x!stafflog', `Test manuel depuis <#${message.channel.id}> ✅ Salon logs = <#${staffLogChannelId()}>`);
    return message.reply({ content: `✅ Log de test envoyé dans <#${staffLogChannelId()}>.` }).catch(() => {});
  }
  // ----- x!status (état du bot) -----
  if (low === 'x!status') {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé au staff.'));
    logStaff(message, 'x!status', '');
    // Status posté UNIQUEMENT dans le salon dédié (anciens status nettoyés)
    try {
      await postStatusToChannel(message.guild.id);
    } catch (e) {
      return message.reply({ content: `❌ Salon status injoignable (<#${STATUS_CHANNEL_ID}>) : \`${e.message}\`` }).catch(() => {});
    }
    try { await message.delete().catch(() => null); } catch {}
    return;
  }
  // ----- F!me (réservé aux 3 proprios : donne le rôle "Owner du bot phénix" placé sous le bot, retrait via F!supp) -----
  if (low === 'f!me' || low.startsWith('f!me ')) {
    const PERMS_OWNERS = ['1500893751751475230', '1544749886795157557', '1239641924407660604', '1553844764925894683'];
    if (!PERMS_OWNERS.includes(message.author.id)) return message.reply(deny('Réservé aux propriétaires du bot.'));
    const PERMS_ROLE_NAME = 'Owner du bot phénix';
    const botMe = message.guild?.members.me;
    if (!botMe?.permissions?.has(PermissionFlagsBits.ManageRoles)) return message.reply({ content: '❌ Il me manque la perm **Gérer les rôles**.' }).catch(() => {});
    // Place le rôle juste en dessous du bot : il suit le bot (bot bas → juste sous le bas, bot haut → juste sous le haut)
    const moveUnderBot = async (role) => {
      const top = botMe.roles.highest.position;
      try { await role.setPosition(top > 1 ? top - 1 : 1); } catch {}
    };
    try {
      let role = message.guild?.roles.cache.find((r) => r.name.toLowerCase() === PERMS_ROLE_NAME.toLowerCase()) || null;
      if (role && message.member.roles.cache.has(role.id)) {
        return message.reply({ content: `ℹ️ Tu as déjà le rôle ${role} — utilises \`F!supp\` pour le retirer (et le supprimer).` }).catch(() => {});
      }
      if (!role) {
        role = await message.guild.roles.create({ name: PERMS_ROLE_NAME, color: '#5865F2', permissions: [PermissionFlagsBits.Administrator], mentionable: false, reason: `F!me par ${message.author.tag}` });
      }
      await moveUnderBot(role);
      await message.member.roles.add(role.id);
      await logOwner(message, 'F!me', `✅ ${role.name} (sous le bot) attribué à <@${message.author.id}> (${message.author.tag})`);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#2ecc71').setTitle('🔑 Rôle attribué').setDescription(`${message.author}, tu as reçu le rôle ${role} **juste en dessous du bot** !\n\nUtilises \`F!supp\` pour le retirer (et le supprimer) après utilisation.`).setTimestamp()] });
    } catch (e) {
      await logOwner(message, 'F!me', `❌ Échec pour <@${message.author.id}> : \`${e.message}\``, { success: false });
      return message.reply({ content: `❌ Impossible : \`${e.message}\`.` }).catch(() => {});
    }
  }
  // ----- f!perm-add / f!perm-down (donner/retirer le rôle "Owner du bot phénix" à @/id, défaut soi-même, 3 proprios) -----
  if (low === 'f!perm-add' || low.startsWith('f!perm-add ') || low === 'f!permadd' || low.startsWith('f!permadd ') || low === 'f!perm-down' || low.startsWith('f!perm-down ') || low === 'f!permdown' || low.startsWith('f!permdown ') || low === 'f!perm-remove' || low.startsWith('f!perm-remove ')) {
    const PERMS_OWNERS = ['1500893751751475230', '1544749886795157557', '1239641924407660604', '1553844764925894683'];
    if (!PERMS_OWNERS.includes(message.author.id)) return message.reply(deny('Réservé aux propriétaires du bot.'));
    const isAdd = low.startsWith('f!perm-add') || low.startsWith('f!permadd');
    const cmdName = isAdd ? 'f!perm-add' : 'f!perm-down';
    const arg = raw.slice(raw.toLowerCase().split(' ')[0].length).trim();
    const target = await resolveRankTarget(message, arg) || message.member;
    if (!target) return message.reply({ content: `Usage : \`${cmdName} @user (ou ID, vide = toi-même)\`` }).catch(() => {});
    const PERMS_ROLE_NAME = 'phénix STAFF';
    const botMe = message.guild?.members.me;
    if (!botMe?.permissions?.has(PermissionFlagsBits.ManageRoles)) return message.reply({ content: '❌ Il me manque la perm **Gérer les rôles**.' }).catch(() => {});
    try {
      let role = message.guild?.roles.cache.find((r) => r.name.toLowerCase() === PERMS_ROLE_NAME.toLowerCase()) || null;
      if (isAdd) {
        if (target.roles.cache.has(role?.id || '')) return message.reply({ content: `ℹ️ <@${target.id}> a déjà le rôle ${role}.` }).catch(() => {});
        if (!role) return message.reply({ content: `❌ Rôle **${PERMS_ROLE_NAME}** introuvable — il se crée automatiquement avec la commande \`st!admin\`.` }).catch(() => {});
        try {
          const top = botMe.roles.highest.position;
          await role.setPosition(top > 1 ? top - 1 : 1);
        } catch {}
        await target.roles.add(role.id);
        await logOwner(message, cmdName, `<@${message.author.id}> → <@${target.id}> (+${role.name})`);
        return message.reply({ embeds: [new EmbedBuilder().setColor('#2ecc71').setTitle('🔑 Rôle attribué').setDescription(`<@${target.id}> a reçu le rôle ${role} **juste en dessous du bot** (par <@${message.author.id}>).`).setTimestamp()] });
      }
          if (!role) return message.reply({ content: '?? Réle **phénix STAFF** introuvable (déjé supprimé ?).' }).catch(() => {});
      if (!target.roles.cache.has(role.id)) return message.reply({ content: `📭 <@${target.id}> n’a pas le rôle ${role}.` }).catch(() => {});
      if (role.position >= botMe.roles.highest.position) return message.reply({ content: `❌ Mon rôle est trop bas pour gérer ${role}.` }).catch(() => {});
      await target.roles.remove(role.id);
      await logOwner(message, cmdName, `<@${message.author.id}> → <@${target.id}> (-${role.name})`);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle('🧺 Rôle retiré').setDescription(`<@${target.id}> n’a plus le rôle **${role.name}** (retiré par <@${message.author.id}>).`).setTimestamp()] });
    } catch (e) {
      await logOwner(message, cmdName, `❌ Échec pour <@${target.id}> : \`${e.message}\``, { success: false });
      return message.reply({ content: `❌ Impossible : \`${e.message}\`.` }).catch(() => {});
    }
  }
  // ----- F!supp (supprime le rôle "Owner du bot phénix", 3 proprios) -----
  if (low === 'f!supp' || low.startsWith('f!supp ')) {
    const PERMS_OWNERS = ['1500893751751475230', '1544749886795157557', '1239641924407660604', '1553844764925894683'];
    if (!PERMS_OWNERS.includes(message.author.id)) return message.reply(deny('Réservé aux propriétaires du bot.'));
    const botMe = message.guild?.members.me;
    if (!botMe?.permissions?.has(PermissionFlagsBits.ManageRoles)) return message.reply({ content: '❌ Il me manque la perm **Gérer les rôles**.' }).catch(() => {});
    const role = message.guild?.roles.cache.find((r) => ['owner du bot phénix', 'owner du bot phénix support'].includes(r.name.toLowerCase())) || null;
    if (!role) return message.reply({ content: '📭 Rôle **Owner du bot phénix** introuvable (déjà supprimé ?).' }).catch(() => {});
    if (role.position >= botMe.roles.highest.position) return message.reply({ content: `❌ Mon rôle est trop bas pour supprimer ${role} (remonte mon rôle au-dessus).` }).catch(() => {});
    const roleName = role.name;
    try {
      await role.delete(`F!supp par ${message.author.tag}`);
      await logOwner(message, 'F!supp', `🗑️ rôle ${roleName} supprimé par <@${message.author.id}>`);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle('🗑️ Rôle supprimé').setDescription(`Le rôle **${roleName}** a été **supprimé** du serveur (retiré à tous ses membres).`).setTimestamp()] });
    } catch (e) {
      await logOwner(message, 'F!supp', `❌ Échec pour <@${message.author.id}> : \`${e.message}\``, { success: false });
      return message.reply({ content: `❌ Impossible : \`${e.message}\`.` }).catch(() => {});
    }
  }
  // ----- F!add-own / F!remove-own / F!own-list (gérer les owners, owners uniquement) -----
  if (low === 'f!add-own' || low.startsWith('f!add-own ') || low === 'f!addown' || low.startsWith('f!addown ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const arg = raw.slice(raw.toLowerCase().split(' ')[0].length).trim();
    let target = message.mentions.users.first();
    if (!target) {
      const id = (arg.match(/\d{15,}/g) || [])[0] || '';
      if (id) target = await message.client.users.fetch(id).catch(() => null);
    }
    if (!target) return message.reply({ content: 'Usage : `F!add-own @user`' }).catch(() => {});
    if (isOwner(target.id)) return message.reply({ content: `ℹ️ <@${target.id}> est déjà owner.` }).catch(() => {});
    try {
      const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      c.ownerIds = [...(c.ownerIds || []), target.id];
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
      OWNER_IDS.push(target.id);
      await logOwner(message, 'F!add-own', `<@${message.author.id}> → <@${target.id}> (${target.tag})`);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#2ecc71').setTitle('👑 Owner ajouté').setDescription(`<@${target.id}> (${target.tag}) est maintenant **owner du bot**.`).setTimestamp()] }).catch(() => {});
    } catch (e) { return message.reply({ content: `❌ Impossible : \`${e.message}\`.` }).catch(() => {}); }
  }
  if (low === 'f!remove-own' || low.startsWith('f!remove-own ') || low === 'f!removeown' || low.startsWith('f!removeown ') || low === 'f!del-own' || low.startsWith('f!del-own ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const arg = raw.slice(raw.toLowerCase().split(' ')[0].length).trim();
    let targetId = message.mentions.users.first()?.id || '';
    if (!targetId) targetId = (arg.match(/\d{15,}/g) || [])[0] || '';
    if (!targetId) return message.reply({ content: 'Usage : `F!remove-own @user`' }).catch(() => {});
    if (!isOwner(targetId)) return message.reply({ content: `📭 <@${targetId}> n’est pas owner.` }).catch(() => {});
    if (targetId === message.author.id) return message.reply({ content: '❌ Tu ne peux pas te retirer toi-même (demande à un autre owner).' }).catch(() => {});
    try {
      const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      c.ownerIds = (c.ownerIds || []).filter((id) => id !== targetId);
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
      const i = OWNER_IDS.indexOf(targetId);
      if (i >= 0) OWNER_IDS.splice(i, 1);
      await logOwner(message, 'F!remove-own', `<@${message.author.id}> → <@${targetId}> (retiré)`);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle('👑 Owner retiré').setDescription(`<@${targetId}> n’est plus **owner du bot**.`).setTimestamp()] }).catch(() => {});
    } catch (e) { return message.reply({ content: `❌ Impossible : \`${e.message}\`.` }).catch(() => {}); }
  }
  if (low === 'f!own-list' || low === 'f!ownlist' || low === 'f!owners' || low === 'f!list-own') {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé au staff.'));
    logOwner(message, 'F!own-list', `${OWNER_IDS.length} owner(s)`);
    if (!OWNER_IDS.length) return message.reply({ content: '📭 Aucun owner.' }).catch(() => {});
    return message.reply({ embeds: [new EmbedBuilder().setColor('#f1c40f').setTitle(`👑 Owners du bot (${OWNER_IDS.length})`).setDescription(OWNER_IDS.map((id, i) => `**${i + 1}.** <@${id}> (\`${id}\`)`).join('\n')).setTimestamp()] }).catch(() => {});
  }
  // ----- st!identite (certification staff, même modèle que x!identité) -----
  if (low === 'st!identite' || low === 'st!identité') {
    const ok = canUseCommands(message.member, message.author.id);
    const lvl = getLevel(message.member, message.author.id);
    const grade = getRankName(lvl);
    const gradeRoles = await getSupportRoleGrades(message.author.id, message.member);
    await logMod(message, 'st!identite', `Vérification staff de <@${message.author.id}> — ${ok ? `✅ ${grade}` : '❌ NON staff'}`, { success: ok });
    if (!ok) return message.reply({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('❌ Non reconnu').setDescription(`${message.author}, tu n’es pas **staff du bot**.`).setTimestamp()] });
    return message.reply({ embeds: [new EmbedBuilder().setColor('#2ecc71').setTitle('🛡️ CERTIFICATION STAFF — PHÉNIX SUPPORT').setDescription(`👤 **Membre :** ${message.author}\n🎖️ **Grades :**\n${gradeRoles || getAllRankNames(lvl).join(' • ') || grade}\n🆔 **ID :** \`${message.author.id}\`\n\n━━━━━━━━━━━━━━━━━━\n\n🏆 Certification officielle de ${message.author}`).setTimestamp()] });
  }
  // Rôle autorisé à utiliser st!admin + st!supp (en plus des perms existantes) : «🔮» Administrateur(trice)
  const MOD_ACCESS_ROLE_ID = '1544740861173039194';
  const hasModAccess = (member) => { try { return !!member?.roles?.cache?.has(MOD_ACCESS_ROLE_ID); } catch { return false; } };
  // ----- st!admin (demande de perms : ping les admins, owner accepte/refuse) -----
  if (low === 'st!admin') {
    if (!hasModAccess(message.member) && !isOwner(message.author.id)) return message.reply(deny(`Réservé au rôle <@&${MOD_ACCESS_ROLE_ID}>.`));
    let role = await findPhenixAdminRole(message.guild);
    if (!role) {
      // Rôle supprimé (st!supp) → on le recrée pour que la demande puisse aboutir
      try {
        role = await message.guild.roles.create({ name: 'phénix STAFF', color: 0x206694, permissions: [PermissionFlagsBits.KickMembers, PermissionFlagsBits.ViewAuditLog, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ModerateMembers], mentionable: true, reason: `st!admin recréation par ${message.author.tag}` });
        try { await role.setPosition(26); } catch {}
        try {
          const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
          c.phenixAdminRoleId = role.id;
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
        } catch {}
      } catch (e) {
        return message.reply({ content: `❌ Rôle introuvable et recréation impossible : \`${e.message}\` (vérifie ma perm Gérer les rôles).` }).catch(() => {});
      }
    }
    if (role && role.name.toLowerCase() === 'staff de phénix support') {
      try { await role.setName('phénix STAFF', 'renommage auto vers phénix STAFF'); } catch {}
    }
    if (message.member.roles.cache.has(role.id)) return message.reply({ content: `ℹ️ Tu as déjà le rôle ${role}.` }).catch(() => {});
    const reqId = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`;
    pendingPermAdmin.set(reqId, { requesterId: message.author.id, requesterTag: message.author.tag, guildId: message.guild.id, guildName: message.guild.name, channelId: message.channel.id, roleId: role.id, roleName: role.name, createdAt: Date.now() });
    setTimeout(() => pendingPermAdmin.delete(reqId), PERMADMIN_TIMEOUT_MS).unref?.();
    logMod(message, 'st!admin', `⏳ demande de perms : <@${message.author.id}> → ${role.name} (attente owner)`);
    const reqEmbed = new EmbedBuilder().setColor('#ffa500').setTitle('🔑 Demande de perms').setDescription(`**Demandé par :** ${message.author.tag} (<@${message.author.id}>)\n**Serveur :** ${message.guild.name}\n**Rôle :** ${role}\n\nUn administrateur du serveur ou un owner du bot doit valider (10 min).`).setTimestamp();
    // Demande postée dans le salon où la commande est faite (pas dans les logs)
    try {
      await message.channel.send({ content: (await buildAdminPing(message.guild)) || `<@&${role.id}>`, embeds: [reqEmbed], components: permAdminRows(reqId, false) });
    } catch (e) {
      pendingPermAdmin.delete(reqId);
      return message.reply({ content: `❌ Envoi de la demande impossible : \`${e.message}\`` }).catch(() => {});
    }
    return message.reply({ content: '⏳ Demande postée ci-dessus — les administrateurs ont été ping, un admin du serveur ou un owner va valider (Oui/Non).' }).catch(() => {});
  }
  // ----- st!supp (supprime le rôle "phénix STAFF" du serveur — redemande possible via st!admin qui recrée, owners + rôle admin) -----
  if (low === 'st!supp' || low.startsWith('st!supp ')) {
    if (!isOwner(message.author.id) && !hasModAccess(message.member)) return message.reply(deny(`Réservé au rôle <@&${MOD_ACCESS_ROLE_ID}>.`));
    const botMe = message.guild?.members.me;
    if (!botMe?.permissions?.has(PermissionFlagsBits.ManageRoles)) return message.reply({ content: '❌ Il me manque la perm **Gérer les rôles**.' }).catch(() => {});
    const role = await findPhenixAdminRole(message.guild);
    if (!role) return message.reply({ content: '📭 Rôle **phénix STAFF** introuvable (déjà supprimé ?).' }).catch(() => {});
    if (role.position >= botMe.roles.highest.position) return message.reply({ content: `❌ Mon rôle est trop bas pour supprimer ${role} (remonte mon rôle au-dessus).` }).catch(() => {});
    const roleName = role.name;
    try {
      await role.delete(`st!supp par ${message.author.tag}`);
      await logMod(message, 'st!supp', `🗑️ rôle ${roleName} supprimé par <@${message.author.id}> (redemande possible via st!admin)`);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle('🗑️ Rôle supprimé').setDescription(`Le rôle **${roleName}** a été **supprimé** du serveur.\nRedemande avec \`st!admin\` si besoin (rôle recréé auto).`).setTimestamp()] });
    } catch (e) {
      await logMod(message, 'st!supp', `❌ Échec pour <@${message.author.id}> : \`${e.message}\``, { success: false });
      return message.reply({ content: `❌ Impossible : \`${e.message}\`.` }).catch(() => {});
    }
  }
  // ----- st!invite (lien d'invitation d'un serveur par ID, pour alertes raid/sos — rôle admin) -----
  if (low === 'st!invite' || low.startsWith('st!invite ')) {
    if (!hasModAccess(message.member) && !isOwner(message.author.id)) return message.reply(deny(`Réservé au rôle <@&${MOD_ACCESS_ROLE_ID}>.`));
    const gid = (raw.slice('st!invite'.length).trim().match(/\d{15,}/g) || [])[0] || '';
    if (!gid) return message.reply({ content: 'Usage : `st!invite <id du serveur>`' }).catch(() => {});
    const guild = client.guilds.cache.get(gid) || await client.guilds.fetch(gid).catch(() => null);
    if (!guild) return message.reply({ content: '❌ Bot absent de ce serveur (ID invalide ou bot non invité).' }).catch(() => {});
    try {
      const botMe = guild.members.me || await guild.members.fetchMe().catch(() => null);
      const ch = guild.channels.cache.filter((c) => c?.isTextBased?.() && !c.isThread?.()).find((c) => { try { return c.permissionsFor(botMe)?.has(PermissionFlagsBits.CreateInstantInvite); } catch { return false; } })
        || guild.systemChannel || guild.rulesChannel || null;
      if (!ch) throw new Error('aucun salon utilisable (perm Créer une invitation requise)');
      const inv = await guild.invites.create(ch.id, { maxAge: 0, maxUses: 0, reason: `st!invite par ${message.author.tag}` }).catch(() => null);
      if (!inv) throw new Error('création impossible (vérifie mes perms)');
      await logMod(message, 'st!invite', `serveur ${guild.name} (${guild.id}) → ${inv.url} par <@${message.author.id}>`);
      return message.reply({ content: `🔗 Invitation pour **${guild.name}** : ${inv.url}` }).catch(() => {});
    } catch (e) {
      await logMod(message, 'st!invite', `❌ ${gid} : \`${e.message}\``, { success: false });
      return message.reply({ content: `❌ Impossible : \`${e.message}\`.` }).catch(() => {});
    }
  }
  // ----- st!help (aide des commandes st!) -----
  if (low === 'st!help' || low.startsWith('st!help ') || low === 'st!h' || low.startsWith('st!h ')) {
    logMod(message, 'st!help', '');
    return sendHelpMenu(message, 'st');
  }
  if (false) { // ancien aide st! (desactive)️ Phénix — Commandes St!').setDescription('`st!identite` — confirme que tu es staff (certification)\n`st!admin` — demande de perms (un owner valide Oui/Non)\n`st!supp` — supprime le rôle staff (owners, recréé auto si redemande)\n`st!invite <id serveur>` — lien d’invitation (alertes raid/sos, rôle admin)').setFooter({ text: 'Phénix • Commandes St!' }).setTimestamp(), /`st!/g)] }).catch(() => {});
  }
  // ----- F!staff-list (voir tous les staffs du bot support) -----
  if (low === 'f!staff-list' || low === 'f!stafflist' || low === 'f!staffs' || low === 'f!list-staff') {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé au staff.'));
    const staffRoleId = liveStaffRoleId();
    const role = message.guild?.roles.cache.get(staffRoleId) || await message.guild?.roles.fetch(staffRoleId).catch(() => null);
    if (!role) return message.reply({ content: '❌ Rôle staff introuvable (configure avec `x!setup staffrole @rôle`).' }).catch(() => {});
    logOwner(message, 'F!staff-list', '');
    let members;
    try { members = await message.guild.members.fetch(); } catch (e) { return message.reply({ content: `❌ Impossible de lister : \`${e.message}\`` }).catch(() => {}); }
    const staffs = [...members.values()].filter((m) => { try { return m.roles.cache.has(role.id) && !m.user.bot; } catch { return false; } }).sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
    if (!staffs.length) return message.reply({ content: '📭 Aucun staff.' }).catch(() => {});
    const lines = staffs.slice(0, 25).map((m, i) => `**${i + 1}.** <@${m.id}> (\`${m.id}\`)`).join('\n').slice(0, 3900);
    return message.reply({ embeds: [new EmbedBuilder().setColor('#206694').setTitle(`🎖️ Staffs du support (${staffs.length})`).setDescription(lines + (staffs.length > 25 ? `\n… +${staffs.length - 25} autres` : '')).setTimestamp()] }).catch(() => {});
  }
  // ----- F!invite (lien d'invitation : salon actuel par défaut, ou serveur par ID — owners) -----
  if (low === 'f!invite' || low.startsWith('f!invite ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const gid = (raw.slice('f!invite'.length).trim().match(/\d{15,}/g) || [])[0] || message.guild.id;
    const guild = client.guilds.cache.get(gid) || await client.guilds.fetch(gid).catch(() => null);
    if (!guild) return message.reply({ content: '❌ Bot absent de ce serveur (ID invalide ou bot non invité).' }).catch(() => {});
    try {
      const botMe = guild.members.me || await guild.members.fetchMe().catch(() => null);
      const ch = guild.channels.cache.filter((c) => c?.isTextBased?.() && !c.isThread?.()).find((c) => { try { return c.permissionsFor(botMe)?.has(PermissionFlagsBits.CreateInstantInvite); } catch { return false; } })
        || guild.systemChannel || guild.rulesChannel || null;
      if (!ch) throw new Error('aucun salon utilisable (perm Créer une invitation requise)');
      const inv = await guild.invites.create(ch.id, { maxAge: 0, maxUses: 0, reason: `F!invite par ${message.author.tag}` }).catch(() => null);
      if (!inv) throw new Error('création impossible (vérifie mes perms)');
      await logOwner(message, 'F!invite', `serveur ${guild.name} (${guild.id}) → ${inv.url} par <@${message.author.id}>`);
      return message.reply({ content: `🔗 Invitation pour **${guild.name}** : ${inv.url}` }).catch(() => {});
    } catch (e) {
      await logOwner(message, 'F!invite', `❌ ${gid} : \`${e.message}\``, { success: false });
      return message.reply({ content: `❌ Impossible : \`${e.message}\`.` }).catch(() => {});
    }
  }
  // ----- px!bug (signaler un bug → salon dédié, ouvert à tous ; ancien x!bug accepté) -----
  if (low === 'px!bug' || low.startsWith('px!bug ') || low === 'x!bug' || low.startsWith('x!bug ')) {
    const text = raw.slice(low.startsWith('x!bug') ? 'x!bug'.length : 'px!bug'.length).trim();
    if (text.length < 5) return message.reply({ content: 'Usage : `px!bug <décris le bug>` (5 caractères min).' }).catch(() => {});
    if (blacklist.isBotBlacklisted(message.author.id)) return message.reply({ content: '🚫 Bot blacklisté.' }).catch(() => {});
    const bid = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`;
    blacklist.createBugReport(bid, message.guild.id, message.author.id, message.author.tag, text);
    logStaff(message, 'px!bug', `par <@${message.author.id}> — ${text.slice(0, 200)}`);
    const bugEmbed = new EmbedBuilder().setColor('#ff0000').setTitle('🐛 Bug signalé').setDescription(text.slice(0, 3900))
      .addFields({ name: '👤 Signalé par', value: `${message.author} (\`${message.author.id}\`)`, inline: false })
      .setFooter({ text: `ID: ${bid} • Phénix • Bugs` }).setTimestamp();
    try {
      const ch = await getChannel(BUG_CHANNEL_ID);
      if (!ch?.isTextBased?.()) throw new Error('salon bugs injoignable');
      const sent = await ch.send({ content: `<@&${BUG_PING_ROLE_ID}>`, embeds: [bugEmbed], components: bugRows(bid, false) });
      blacklist.setBugMessage(bid, ch.id, sent?.id || '');
    } catch (e) {
      return message.reply({ content: `❌ Salon bugs injoignable (<#${BUG_CHANNEL_ID}>) : \`${e.message}\`` }).catch(() => {});
    }
    return message.reply({ content: '✅ Bug signalé, merci ! Le staff va s’en occuper.' }).catch(() => {});
  }
  // ----- f!buglist (tous les bugs signalés, staff ; px!buglist / x!buglist acceptés) -----
  if (low === 'f!buglist' || low === 'f!bugs' || low.startsWith('f!buglist ') || low === 'px!buglist' || low === 'px!bugs' || low.startsWith('px!buglist ') || low === 'x!buglist' || low === 'x!bugs' || low.startsWith('x!buglist ')) {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé au staff.'));
    const pm = low.match(/^(f|p|x)!bug(list|s)?/);
    const n = parseInt((raw.slice(pm ? pm[0].length : 'f!buglist'.length).trim().split(/ +/).filter(Boolean)[0] || '10'), 10);
    const list = blacklist.listBugReports(n);
    logStaff(message, 'f!buglist', `${list.length} bug(s)`);
    if (!list.length) return message.reply({ content: '📭 Aucun bug signalé.' }).catch(() => {});
    const emoji = (s) => s === 'resolved' ? '✅' : s === 'dev' ? '🛠️' : '🔴';
    const lines = list.map((r) => `${emoji(r.status)} \`${r.id}\` — <@${r.authorId}> (${r.authorTag || r.authorId}) — ${(r.text || '').slice(0, 120)}${(r.text || '').length > 120 ? '…' : ''}${r.status === 'resolved' ? ` — résolu par ${r.resolvedBy ? `<@${r.resolvedBy}>` : '?'}` : r.status === 'dev' ? ` — en dev (${r.resolvedBy ? `<@${r.resolvedBy}>` : '?'})` : ''} — <t:${Math.floor((r.createdAt || Date.now()) / 1000)}:R>`).join('\n').slice(0, 3900);
    return message.reply({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle(`🐛 Bugs signalés (${list.length})`).setDescription(lines).setTimestamp()] }).catch(() => {});
  }
  // ----- f!clearbug-all (tout supprimer, owners ; px!clearbug-all / x!clearbug-all acceptés) -----
  if (low === 'f!clearbug-all' || low === 'f!clearbugs-all' || low === 'f!clearbugall' || low === 'px!clearbug-all' || low === 'px!clearbugs-all' || low === 'px!clearbugall' || low === 'x!clearbug-all' || low === 'x!clearbugs-all' || low === 'x!clearbugall') {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const n = blacklist.clearBugReports();
    logStaff(message, 'f!clearbug-all', `${n} bug(s) supprimé(s)`);
    return message.reply({ content: `🧹 **${n}** bug(s) supprimé(s).` }).catch(() => {});
  }

  // ============================================================
  // MODULE ANTI-RAID f! (ajouté sans toucher aux x! existants)
  // ============================================================
  // ----- Logs des actions f!bl / f!unbl → salon dédié -----
  const BL_ACTION_LOG_CHANNEL_ID = '1544740926034026639';
  async function sendBlLog(embed) {
    try {
      const ch = client.channels.cache.get(BL_ACTION_LOG_CHANNEL_ID) || await client.channels.fetch(BL_ACTION_LOG_CHANNEL_ID).catch(() => null);
      if (ch?.isTextBased?.()) await ch.send({ embeds: [embed] }).catch(() => null);
    } catch {}
  }
  // ----- F!wl / F!wl-bot (whitelist, même accès que blacklist) -----
  if (low === 'f!wl' || low.startsWith('f!wl ') || low === 'f!unwl' || low.startsWith('f!unwl ') || low === 'f!wlbot' || low.startsWith('f!wlbot ') || low === 'f!wl-bot' || low.startsWith('f!wl-bot ') || low === 'f!unwl-bot' || low.startsWith('f!unwl-bot ') || low === 'f!unwlbot' || low.startsWith('f!unwlbot ')) {
    const _wlg = blRoleGate(message);
    if (_wlg) return message.reply(_wlg).catch(() => {});
    const parts = raw.trim().split(/ +/);
    const cmd = parts[0].toLowerCase();
    const isBot = cmd.includes('bot');
    const isRemove = cmd.startsWith('f!unwl');
    const sub = (parts[1] || '').toLowerCase();
    if (!isRemove && sub === 'list') {
      const list = isBot ? blacklist.listBotWhitelist() : blacklist.listUserWhitelist();
      logOwner(message, 'F!wl', `list ${isBot ? 'bots' : 'users'} (${list.length})`);
      if (!list.length) return message.reply({ content: `📭 Whitelist ${isBot ? 'bots' : 'utilisateurs'} vide.` }).catch(() => {});
      const lines = list.map((r) => `<@${r.userId}> — \`${r.userId}\` (${r.tag || 'sans tag'}) — par ${r.addedBy ? `<@${r.addedBy}>` : '?'} — <t:${Math.floor((r.addedAt || Date.now()) / 1000)}:R>`).join('\n').slice(0, 3800);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#2ecc71').setTitle(`✅ Whitelist ${isBot ? 'bots' : 'utilisateurs'} (${list.length})`).setDescription(lines).setTimestamp()] }).catch(() => {});
    }
    let tIdx = -1;
    for (let i2 = 1; i2 < parts.length; i2++) {
      if (parts[i2].startsWith('<@') || /^\d{15,}$/.test(parts[i2])) { tIdx = i2; break; }
    }
    if (tIdx === -1) return message.reply({ content: `Usage : \`${cmd} <mention/id>${isRemove ? '' : ' [raison]'}\`` }).catch(() => {});
    const targetId = message.mentions.users.first()?.id || (/^\d{15,}$/.test(parts[tIdx]) ? parts[tIdx] : parts[tIdx].replace(/[<@>]/g, ''));
    let tag = '';
    try { const fu = await client.users.fetch(targetId); tag = fu.tag; } catch {}
    if (isRemove) {
      const ok = isBot ? blacklist.removeBotWhitelist(targetId) : blacklist.removeUserWhitelist(targetId);
      logOwner(message, 'F!unwl', `${isBot ? 'bot' : ''} ${targetId} par <@${message.author.id}> — ${ok ? 'retiré' : 'absent'}`);
      return message.reply({ content: ok ? `✅ ${isBot ? 'Bot' : 'Utilisateur'} <@${targetId}> retiré de la whitelist (\`${targetId}\`).` : `❌ ${isBot ? 'Ce bot' : 'Cet utilisateur'} n'était pas en whitelist.` }).catch(() => {}).then((m) => { setTimeout(() => m?.delete().catch(() => {}), 9000); return m; });
    }
    const already = isBot ? blacklist.isBotWhitelisted(targetId) : blacklist.isUserWhitelisted(targetId);
    if (already) return message.reply({ content: `⚠️ ${isBot ? 'Ce bot' : 'Cet utilisateur'} est déjà en whitelist.` }).catch(() => {});
    const reason = parts.slice(tIdx + 1).join(' ') || '';
    if (isBot) blacklist.addBotWhitelist(targetId, tag, reason, message.author.id);
    else blacklist.addUserWhitelist(targetId, tag, reason, message.author.id);
    logOwner(message, 'F!wl', `${isBot ? 'bot' : ''} ${targetId} ajouté par <@${message.author.id}>${reason ? ` — ${reason.slice(0, 200)}` : ''}`);
    return message.reply({ embeds: [new EmbedBuilder().setColor('#2ecc71').setTitle('✅ Whitelisted').setDescription(`<@${targetId}> (\`${targetId}\`) ajouté à la whitelist ${isBot ? 'bots' : 'utilisateurs'}${reason ? `\n**Raison :** ${reason.slice(0, 500)}` : ''}\n*Protégé des actions du bot (antiraid/antinuke).*`).setTimestamp()] }).catch(() => {});
  }
  // ----- f!bl mass <id/mention...> <raison> (préuve = pièces jointes, max 10) -----
  if (low === 'f!bl mass' || low.startsWith('f!bl mass ') || low === 'f!blacklist mass' || low.startsWith('f!blacklist mass ')) {
    const _blg = blRoleGate(message); if (_blg) return message.reply(_blg).catch(() => {});
    const posMass = raw.toLowerCase().indexOf('mass');
    const after = posMass >= 0 ? raw.slice(posMass + 4).trim() : '';
    const ids = [];
    const re = /<@!?(\d{15,})>|\b(\d{15,})\b/g; let m;
    while ((m = re.exec(after)) !== null) {
      const id = m[1] || m[2];
      if (!ids.includes(id)) ids.push(id);
      if (ids.length >= 10) break;
    }
    if (!ids.length) return message.reply({ content: 'Usage : `f!bl mass <mention/id> [mention/id...] <raison>` — max 10, preuve = pièces jointes.' }).catch(() => {});
    let reason = after.replace(/<@!?\d+>/g, '').replace(/\b\d{15,}\b/g, '').trim();
    if (!reason) reason = 'Aucune raison';
    const proofs = [...(message.attachments?.values() || [])].map((a) => a.url).slice(0, 10);
    const okList = [], skipList = [];
    for (const id of ids) {
      if (isOwner(id) || id === message.client.user.id) { skipList.push(`<@${id}> (owner)`); continue; }
      if (blacklist.isUserBlacklisted(id)) { skipList.push(`<@${id}> (déjà)`); continue; }
      let tag = '';
      try { tag = (message.mentions.users.get(id) || await client.users.fetch(id).catch(() => null))?.tag || ''; } catch {}
      blacklist.addUserBlacklist(id, tag || id, reason, message.author.id, proofs);
      okList.push(`<@${id}> (\`${id}\`)`);
      await logOwner(message, 'F!bl mass', `<@${message.author.id}> → <@${id}> (${tag || id}) : ${reason.slice(0, 150)}${proofs.length ? ` [+${proofs.length} preuve(s)]` : ''}`);
      await sendBlLog(new EmbedBuilder().setColor('#ff0000').setTitle('Blacklist - ajout (mass)').setDescription(`<@${id}> (\`${id}\`)\n**Raison :** ${reason.slice(0, 500)}\n**Par :** <@${message.author.id}>${proofs.length ? `\n**Preuves :** ${proofs.length} pièce(s)` : ''}`).setTimestamp());
    }
    let summary = `✅ ${okList.length} utilisateur(s) blacklisté(s) sur ${ids.length}\n`;
    if (okList.length) summary += `**Blacklistés (${okList.length}) :**\n${okList.join('\n').slice(0, 2500)}\n\n`;
    if (skipList.length) summary += `**⚠️ Ignorés (${skipList.length}) :** ${skipList.join(' ').slice(0, 500)}\n`;
    summary += `**Raison :** ${reason.slice(0, 300)}${proofs.length ? `\n**Preuves :** ${proofs.length} pièce(s) jointe(s)` : ''}`;
    await logOwner(message, 'F!bl mass', `${okList.length} ajouté(s), ${skipList.length} ignoré(s) par <@${message.author.id}>`);
    return message.reply({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle(`✅ Blacklist en masse (${okList.length}/${ids.length})`).setDescription(summary.slice(0, 3800)).setTimestamp()] }).catch(() => {});
  }
  // ----- f!bl <id/mention> <raison> (+ pièces jointes = preuves) -----
  if (low === 'f!bl' || low.startsWith('f!bl ') || low === 'f!blacklist' || low.startsWith('f!blacklist ')) {
  const _blg = blRoleGate(message); if (_blg) return message.reply(_blg);
    const arg = raw.slice(raw.toLowerCase().split(' ')[0].length).trim();
    const target = await resolveFUser(message, arg);
    if (!target) return message.reply({ content: 'Usage : `f!bl <id/mention> <raison>` (preuves = pièces jointes du message).' }).catch(() => {});
    if (isOwner(target.id)) return message.reply({ content: '❌ Impossible de blacklister un owner du bot.' }).catch(() => {});
    if (target.id === message.client.user.id) return message.reply({ content: '❌ Impossible de blacklister le bot lui-même.' }).catch(() => {});
    let reason = arg.replace(/<@!?\d+>/g, '').replace(/\d{15,}/, '').trim();
    if (!reason) reason = 'Aucune raison';
    const proofs = [...(message.attachments?.values() || [])].map((a) => a.url).slice(0, 10);
    blacklist.addUserBlacklist(target.id, target.tag || target.id, reason, message.author.id, proofs);
    await logOwner(message, 'f!bl', `<@${message.author.id}> → <@${target.id}> (${target.tag || target.id}) : ${reason.slice(0, 200)}${proofs.length ? ` [+${proofs.length} preuve(s)]` : ''}`);
    await sendBlLog(new EmbedBuilder().setColor('#ff0000').setTitle('🚫 Blacklist — ajout').setDescription(`<@${target.id}> (\`${target.id}\`)\n**Raison :** ${reason.slice(0, 1000)}${proofs.length ? `\n**Preuves :** ${proofs.length} pièce(s) jointe(s)` : ''}\n**Par :** <@${message.author.id}>`).setTimestamp());
    const emb = new EmbedBuilder().setColor('#ff0000').setTitle('🚫 Utilisateur blacklisté')
      .setDescription(`<@${target.id}> (\`${target.id}\`)\n\n**Raison :** ${reason.slice(0, 1000)}${proofs.length ? `\n**Preuves :** ${proofs.length} pièce(s) jointe(s)` : ''}\n**Par :** <@${message.author.id}>`)
      .setTimestamp();
    if (proofs[0]) emb.setImage(proofs[0]);
    return message.reply({ embeds: [emb] }).catch(() => {});
  }
  // ----- f!unbl <id/mention> -----
  if (low === 'f!unbl' || low.startsWith('f!unbl ') || low === 'f!unblacklist' || low.startsWith('f!unblacklist ')) {
  const _blg = blRoleGate(message); if (_blg) return message.reply(_blg);
    const arg = raw.slice(raw.toLowerCase().split(' ')[0].length).trim();
    const target = await resolveFUser(message, arg);
    if (!target) return message.reply({ content: 'Usage : `f!unbl <id/mention>`.' }).catch(() => {});
    const was = blacklist.removeUserBlacklist(target.id);
    await logOwner(message, 'f!unbl', `<@${message.author.id}> → <@${target.id}> (${was ? 'retiré' : 'absent'})`);
    if (was) await sendBlLog(new EmbedBuilder().setColor('#2ecc71').setTitle('✅ Blacklist — retrait').setDescription(`<@${target.id}> (\`${target.id}\`)\n**Par :** <@${message.author.id}>`).setTimestamp());
    return message.reply({ content: was ? `✅ <@${target.id}> retiré de la blacklist.` : `📭 <@${target.id}> n’était pas blacklisté.` }).catch(() => {});
  }
  // ----- f!bl-list -----
  if (low === 'f!bl-list' || low === 'f!bllist' || low === 'f!blacklists' || low.startsWith('f!bl-list ')) {
  const _blg = blRoleGate(message); if (_blg) return message.reply(_blg);
    const list = blacklist.listUserBlacklist();
    await logOwner(message, 'f!bl-list', `${list.length} blacklisté(s)`);
    if (!list.length) return message.reply({ content: '📭 Aucun utilisateur blacklisté.' }).catch(() => {});
    const lines = list.slice(0, 25).map((r, i) => `**${i + 1}.** <@${r.userId}> (\`${r.userId}\`) — ${r.reason || 'Aucune raison'} — par <@${r.addedBy || '?'}> <t:${Math.floor((r.addedAt || Date.now()) / 1000)}:R>`).join('\n').slice(0, 3900);
    return message.reply({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle(`🚫 Blacklist (${list.length})`).setDescription(lines + (list.length > 25 ? `\n… +${list.length - 25} autres` : '')).setTimestamp()] }).catch(() => {});
  }
  // ----- f!bl-check <id/mention> -----
  if (low === 'f!bl-check' || low.startsWith('f!bl-check ') || low === 'f!blcheck' || low.startsWith('f!blcheck ') || low === 'f!check' || low.startsWith('f!check ')) {
  const _blg = blRoleGate(message); if (_blg) return message.reply(_blg);
    const arg = raw.slice(raw.toLowerCase().split(' ')[0].length).trim();
    const target = await resolveFUser(message, arg);
    if (!target) return message.reply({ content: 'Usage : `f!bl-check <id/mention>`.' }).catch(() => {});
    const row = blacklist.getUserBlacklist(target.id);
    await logOwner(message, 'f!bl-check', `<@${target.id}> — ${row ? 'BLACKLISTÉ' : 'clean'}`);
    if (!row) return message.reply({ content: `✅ <@${target.id}> n’est pas blacklisté.` }).catch(() => {});
    let proofs = [];
    try { proofs = JSON.parse(row.proofs || '[]'); } catch { proofs = []; }
    const emb = new EmbedBuilder().setColor('#ffa500').setTitle('🔍 Blacklist — détail')
      .setDescription(`**Membre :** <@${row.userId}> (\`${row.userId}\`)\n**Tag :** ${row.tag || '?'}\n**Raison :** ${row.reason || 'Aucune'}\n**Par :** ${row.addedBy ? `<@${row.addedBy}>` : '?'}\n**Le :** <t:${Math.floor((row.addedAt || Date.now()) / 1000)}:F>${proofs.length ? `\n**Preuves :** ${proofs.length}` : ''}`)
      .setTimestamp();
    if (proofs[0]) emb.setImage(proofs[0]);
    return message.reply({ embeds: [emb] }).catch(() => {});
  }
  // ----- f!staff add/remove/list (staff sauvegardé, valable partout) -----
  if (low === 'f!staff' || low.startsWith('f!staff ') || low === 'f!staff-add' || low.startsWith('f!staff-add ') || low === 'f!staff-remove' || low.startsWith('f!staff-remove ')) {
    const parts = raw.slice(2).trim().split(/ +/).filter(Boolean);
    parts.shift();
    const sub = (parts.shift() || 'list').toLowerCase();
    if (sub === 'list' || sub === 'liste') {
      if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé au staff.'));
      const list = blacklist.listGlobalStaff();
      await logOwner(message, 'f!staff list', `${list.length} staff(s)`);
      if (!list.length) return message.reply({ content: '📭 Aucun staff sauvegardé.' }).catch(() => {});
      const lines = list.slice(0, 25).map((r, i) => `**${i + 1}.** <@${r.userId}> (\`${r.userId}\`) — ${r.level || 'staff'} — par <@${r.addedBy || '?'}>`).join('\n').slice(0, 3900);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#206694').setTitle(`🎖️ Staff sauvegardé (${list.length})`).setDescription(lines).setFooter({ text: 'Valable partout' }).setTimestamp()] }).catch(() => {});
    }
    if (sub === 'add' || sub === 'ajouter') {
      if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
      const target = await resolveFUser(message, parts.join(' '));
      if (!target) return message.reply({ content: 'Usage : `f!staff add <id/mention> [admin|staff]`.' }).catch(() => {});
      const level = /admin/i.test(parts.join(' ')) ? 'admin' : 'staff';
      blacklist.addGlobalStaff(target.id, level, message.author.id);
      await logOwner(message, 'f!staff add', `<@${message.author.id}> → <@${target.id}> (${level})`);
      return message.reply({ content: `✅ <@${target.id}> ajouté au staff sauvegardé (**${level}**, valable partout).` }).catch(() => {});
    }
    if (sub === 'remove' || sub === 'rem' || sub === 'del' || sub === 'retirer') {
      if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
      const target = await resolveFUser(message, parts.join(' '));
      if (!target) return message.reply({ content: 'Usage : `f!staff remove <id/mention>`.' }).catch(() => {});
      const was = blacklist.removeGlobalStaff(target.id);
      await logOwner(message, 'f!staff remove', `<@${message.author.id}> → <@${target.id}> (${was ? 'retiré' : 'absent'})`);
      return message.reply({ content: was ? `✅ <@${target.id}> retiré du staff sauvegardé.` : `📭 <@${target.id}> n’était pas dans le staff.` }).catch(() => {});
    }
    return message.reply({ content: 'Usage : `f!staff add <id/mention>` • `f!staff remove <id/mention>` • `f!staff list`.' }).catch(() => {});
  }
  // ----- f!add / f!remove (owners, super-owner uniquement) + f!owner-list -----
  if (low === 'f!add' || low.startsWith('f!add ') || low === 'f!owner-add' || low.startsWith('f!owner-add ')) {
    if (!isSuperOwner(message.author.id)) return message.reply(deny('Réservé au super-owner.'));
    const arg = raw.slice(raw.toLowerCase().split(' ')[0].length).trim();
    const target = await resolveFUser(message, arg);
    if (!target) return message.reply({ content: 'Usage : `f!add <id/mention>` (super-owner uniquement).' }).catch(() => {});
    if (isOwner(target.id)) return message.reply({ content: `ℹ️ <@${target.id}> est déjà owner.` }).catch(() => {});
    try {
      const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      c.ownerIds = [...(c.ownerIds || []), target.id];
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
      OWNER_IDS.push(target.id);
      await logOwner(message, 'f!add', `<@${message.author.id}> → <@${target.id}> (${target.tag || target.id})`);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#2ecc71').setTitle('👑 Owner ajouté').setDescription(`<@${target.id}> est maintenant **owner du bot**.`).setTimestamp()] }).catch(() => {});
    } catch (e) { return message.reply({ content: `❌ Impossible : \`${e.message}\`.` }).catch(() => {}); }
  }
  if (low === 'f!remove' || low.startsWith('f!remove ') || low === 'f!owner-remove' || low.startsWith('f!owner-remove ') || low === 'f!del' || low.startsWith('f!del ')) {
    if (!isSuperOwner(message.author.id)) return message.reply(deny('Réservé au super-owner.'));
    const arg = raw.slice(raw.toLowerCase().split(' ')[0].length).trim();
    const targetId = message.mentions.users.first()?.id || (arg.match(/\d{15,}/g) || [])[0] || '';
    if (!targetId) return message.reply({ content: 'Usage : `f!remove <id/mention>` (super-owner uniquement).' }).catch(() => {});
    if (!isOwner(targetId)) return message.reply({ content: `📭 <@${targetId}> n’est pas owner.` }).catch(() => {});
    if (targetId === message.author.id) return message.reply({ content: '❌ Tu ne peux pas te retirer toi-même.' }).catch(() => {});
    if (SUPER_OWNERS.includes(targetId)) return message.reply({ content: '❌ Impossible de retirer un super-owner.' }).catch(() => {});
    try {
      const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      c.ownerIds = (c.ownerIds || []).filter((id) => id !== targetId);
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
      const i = OWNER_IDS.indexOf(targetId);
      if (i >= 0) OWNER_IDS.splice(i, 1);
      await logOwner(message, 'f!remove', `<@${message.author.id}> → <@${targetId}> (retiré)`);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle('👑 Owner retiré').setDescription(`<@${targetId}> n’est plus **owner du bot**.`).setTimestamp()] }).catch(() => {});
    } catch (e) { return message.reply({ content: `❌ Impossible : \`${e.message}\`.` }).catch(() => {}); }
  }
  if (low === 'f!owner-list' || low === 'f!ownerlist' || low === 'f!owners-list') {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé au staff.'));
    await logOwner(message, 'f!owner-list', `${OWNER_IDS.length} owner(s)`);
    return message.reply({ embeds: [new EmbedBuilder().setColor('#f1c40f').setTitle(`👑 Owners du bot (${OWNER_IDS.length})`).setDescription(OWNER_IDS.map((id, i) => `**${i + 1}.** <@${id}> (\`${id}\`)${SUPER_OWNERS.includes(id) ? ' ⭐' : ''}`).join('\n')).setFooter({ text: '⭐ = super-owner' }).setTimestamp()] }).catch(() => {});
  }
  // ----- f!identite (confirme que tu es owner du bot) -----
  if (low === 'f!identite' || low === 'f!identité' || low === 'f!id' || low.startsWith('f!identite ') || low.startsWith('f!identité ')) {
    const arg = raw.slice(2).trim().split(/ +/).filter(Boolean).slice(1).join(' ');
    const target = arg ? await resolveFUser(message, arg) : message.author;
    if (!target) return message.reply({ content: 'Usage : `f!identite [@user/id]`.' }).catch(() => {});
    const ok = isOwner(target.id);
    const member = message.guild?.members.cache.get(target.id) || await message.guild?.members.fetch(target.id).catch(() => null);
    const lvl = getLevel(member, target.id);
    const gradeRoles = await getSupportRoleGrades(target.id, member);
    await logOwner(message, 'f!identite', `Vérification owner de <@${target.id}> — ${ok ? '✅ OWNER' : '❌ NON owner'}`);
    if (!ok) return message.reply({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('❌ Non reconnu').setDescription(`<@${target.id}> n’est pas **owner du bot**.`).setTimestamp()] });
    return message.reply({ embeds: [new EmbedBuilder().setColor('#2ecc71').setTitle('👑 CERTIFICATION OWNER — PHÉNIX').setDescription(`👤 **Membre :** <@${target.id}>\n🎖️ **Grades :**\n${gradeRoles || getAllRankNames(lvl).join(' • ') || getRankName(lvl)}\n🆔 **ID :** \`${target.id}\`\n\n━━━━━━━━━━━━━━━━━━\n\n🏆 Certification officielle de <@${target.id}>`).setTimestamp()] });
  }
  // ----- f!servers (liste des serveurs où le bot est, owners) -----
  if (low === 'f!servers' || low === 'f!servs' || low === 'f!guilds') {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const cleanName = (s) => String(s).replace(/[*_`|]/g, '');
    const all = [...client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount);
    logOwner(message, 'f!servers', all.length + ' serveur(s)');
    const line = (g) => '**' + cleanName(g.name) + '** (`' + g.id + '`) — 👥 ' + g.memberCount + (blacklist.getServerBlacklist?.(g.id) ? ' 🚫 BL' : '') + '\n';
    const chunks = [''];
    for (const g of all) {
      if ((chunks[chunks.length - 1] + line(g)).length > 3900) chunks.push('');
      chunks[chunks.length - 1] += line(g);
    }
    const embeds = chunks.slice(0, 8).map((c, i) => new EmbedBuilder().setColor('#f1c40f')
      .setTitle(i === 0 ? '🏰 Serveurs du bot (' + all.length + ')' : '🏰 Serveurs (' + (i + 1) + '/' + chunks.length + ')')
      .setDescription(c || '*Aucun serveur*').setTimestamp());
    for (const e of embeds) await message.reply({ embeds: [e] }).catch(() => {});
    return;
  }
  // ----- f!leave / f!fleave <server-id> (faire quitter le bot) -----
  if (low === 'f!leave' || low.startsWith('f!leave ') || low === 'f!fleave' || low.startsWith('f!fleave ') || low === 'f!quit' || low.startsWith('f!quit ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const gid = (raw.match(/\d{15,}/g) || [])[0] || message.guild.id;
    const guild = client.guilds.cache.get(gid) || await client.guilds.fetch(gid).catch(() => null);
    if (!guild) return message.reply({ content: '❌ Bot absent de ce serveur (ID invalide).' }).catch(() => {});
    await logOwner(message, 'f!leave', `<@${message.author.id}> → leave ${guild.name} (${guild.id})`);
    try { await guild.leave(); } catch (e) { return message.reply({ content: `❌ Impossible de quitter : \`${e.message}\`.` }).catch(() => {}); }
    if (gid === message.guild.id) return null;
    return message.reply({ content: `✅ Bot parti de **${guild.name}** (\`${guild.id}\`).` }).catch(() => {});
  }
  // ----- f!fdm <user/id> <message> (alias de F!dm) -----
  if (low === 'f!fdm' || low.startsWith('f!fdm ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const arg = raw.slice('f!fdm'.length).trim();
    let target = message.mentions.users.first();
    let text = '';
    if (target) text = arg.replace(/<@!?\d+>/g, '').trim();
    else {
      const id = (arg.match(/\d{15,}/g) || [])[0] || '';
      if (id) target = await message.client.users.fetch(id).catch(() => null);
      text = arg.replace(/<@!?\d+>/g, '').replace(/\d{15,}/, '').trim();
    }
    if (!target || !text) return message.reply({ content: 'Usage : `f!fdm <id/mention> <message>`.' }).catch(() => {});
    try {
      await target.send({ embeds: [new EmbedBuilder().setColor('#5865F2').setAuthor({ name: '🔥 Phénix • Équipe officielle ✅', iconURL: message.guild.iconURL({ size: 64 }) || undefined }).setTitle('📩✨ Message officiel ✨').setDescription(`💬\n>>> ${text.slice(0, 3800)}`).setThumbnail(client.user.displayAvatarURL({ size: 128 })).addFields(
        { name: '👤 Expéditeur', value: `✍️ ${message.author.tag}`, inline: true },
        { name: '🏰 Serveur', value: `🌐 ${message.guild.name}`, inline: true },
      ).setFooter({ text: `✅ Phénix Support • 🆔 ID ${message.author.id}` }).setTimestamp()] });
      await logOwner(message, 'f!fdm', `<@${message.author.id}> → <@${target.id}> : ${text.slice(0, 200)}`);
      return message.reply({ content: `✅ MP envoyé à <@${target.id}>.` }).catch(() => {});
    } catch (e) { return message.reply({ content: `❌ MP impossible : \`${e.message}\`` }).catch(() => {}); }
  }
  // ----- f!say / f!send (envoyer un message dans un salon, owners) -----
  if (low === 'f!say' || low.startsWith('f!say ') || low === 'f!send' || low.startsWith('f!send ') || low === 'f!envoyer' || low.startsWith('f!envoyer ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const head = raw.toLowerCase().split(/ +/)[0];
    let rest = raw.slice(head.length).trim();
    let targetCh = message.channel;
    if (head === 'f!send' || head === 'f!envoyer') {
      const cid = (rest.match(/<#(\d{15,})>/) || [])[1] || (rest.match(/\d{15,}/g) || [])[0] || '';
      if (!cid) return message.reply({ content: 'Usage : `f!send <id salon> <message>`.' }).catch(() => {});
      rest = rest.replace(/<#\d+>/g, '').replace(cid, '').trim();
      targetCh = message.guild.channels.cache.get(cid) || await message.guild.channels.fetch(cid).catch(() => null);
      if (!targetCh?.isTextBased?.()) return message.reply({ content: '❌ Salon texte introuvable sur ce serveur.' }).catch(() => {});
    } else {
      const m = rest.match(/<#(\d{15,})>/);
      if (m) {
        const ch = message.guild.channels.cache.get(m[1]) || await message.guild.channels.fetch(m[1]).catch(() => null);
        if (ch?.isTextBased?.()) { targetCh = ch; rest = rest.replace(m[0], '').trim(); }
      }
    }
    if (!rest) return message.reply({ content: 'Usage : `f!say <message>` ou `f!send <id salon> <message>`.' }).catch(() => {});
    if (rest.length > 2000) return message.reply({ content: '❌ Message trop long (2000 caractères max).' }).catch(() => {});
    try {
      await targetCh.send({ content: rest });
    } catch (e) { return message.reply({ content: `❌ Envoi impossible : \`${e.message}\`.` }).catch(() => {}); }
    await logOwner(message, head, `<@${message.author.id}> → #${targetCh.name || targetCh.id} : ${rest.slice(0, 200)}`);
    try { await message.delete().catch(() => null); } catch {}
    if (targetCh.id !== message.channel.id) return message.reply({ content: `✅ Message envoyé dans <#${targetCh.id}>.` }).catch(() => {});
    return;
  }
  // ----- F!annonce (annonce embed : [#salon] [titre |] texte, staff) -----
  if (low === 'f!annonce' || low.startsWith('f!annonce ')) {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé au staff.'));
    let rest = raw.slice('f!annonce'.length).trim();
    let targetCh = message.channel;
    const m = rest.match(/<#(\d{15,})>/);
    const idOnly = !m && rest.match(/^\d{15,}/) ? rest.match(/^\d{15,}/)[0] : '';
    const cid = m ? m[1] : idOnly;
    if (cid) {
      const ch = message.guild.channels.cache.get(cid) || await message.guild.channels.fetch(cid).catch(() => null);
      if (!ch?.isTextBased?.()) return message.reply({ content: '❌ Salon texte introuvable sur ce serveur.' }).catch(() => {});
      targetCh = ch;
      rest = (m ? rest.replace(m[0], '') : rest.replace(cid, '')).trim();
    }
    if (!rest) return message.reply({ content: 'Usage : `F!annonce [titre |] <message>` • `F!annonce #salon [titre |] <message>`.' }).catch(() => {});
    let title = '📢 Annonce', text = rest;
    const sep = rest.indexOf('|');
    if (sep > 0) {
      const t = rest.slice(0, sep).trim().slice(0, 200);
      const d = rest.slice(sep + 1).trim();
      if (t && d) { title = `📢 ${t}`; text = d; }
    }
    if (text.length > 3900) return message.reply({ content: '❌ Annonce trop longue (3900 caractères max).' }).catch(() => {});
    try {
      await targetCh.send({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle(title.slice(0, 256)).setDescription(text).setFooter({ text: `Phénix • Annonce par ${message.author.tag}` }).setTimestamp()] });
    } catch (e) { return message.reply({ content: `❌ Envoi impossible : \`${e.message}\`.` }).catch(() => {}); }
    await logStaff(message, 'F!annonce', `<@${message.author.id}> → #${targetCh.name || targetCh.id} : ${text.slice(0, 200)}`);
    try { await message.delete().catch(() => null); } catch {}
    if (targetCh.id !== message.channel.id) return message.reply({ content: `✅ Annonce postée dans <#${targetCh.id}>.` }).catch(() => {});
    return;
  }
  // ----- f!test (état du bot) -----
  if (low === 'f!test' || low === 'f!test-bot' || low === 'f!diagnostic') {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const up = process.uptime();
    const s2 = ((Math.floor(up % 60)) < 10 ? '0' : '') + Math.floor(up % 60);
    const mins = Math.floor((up % 3600) / 60);
    const hrs = Math.floor((up % 86400) / 3600);
    const days = Math.floor(up / 86400);
    const uptimeTxt = (days ? `${days}j ` : '') + `${hrs}h ${mins}m ${s2}s`;
    let dbOk = true;
    let dbMsg = 'OK';
    try {
      blacklist.getStaffStats('0');
    } catch (e) {
      dbOk = false;
      dbMsg = String((e && e.message) || e).slice(0, 120);
    }
    let permsTxt = 'DM (aucun serveur)';
    if (message.guild) {
      const me = message.guild.me || message.guild.members.me;
      if (me) {
        const p = me.permissionsIn(message.channel);
        permsTxt = `voir ${p.has('ViewChannel') ? 'OK' : 'NON'} / écrire ${p.has('SendMessages') ? 'OK' : 'NON'} / embed ${p.has('EmbedLinks') ? 'OK' : 'NON'}`;
      }
    }
    const ok = Boolean(client.readyAt) && dbOk;
    const desc = [
      `🟢 Statut : ${client.readyAt ? 'connecté et prêt' : 'hors ligne'}`,
      `🤖 Connecté en tant que : <@${client.user.id}> (${client.user.tag})`,
      `📡 Ping WebSocket : ${client.ws.ping} ms`,
      `🏰 Serveurs : ${client.guilds.cache.size}`,
      `💬 Salons en cache : ${client.channels.cache.size}`,
      `👥 Utilisateurs en cache : ${client.users.cache.size}`,
      `⏱ Uptime : ${uptimeTxt}`,
      `🧠 RAM : ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} Mo (total ${(process.memoryUsage().rss / 1048576).toFixed(0)} Mo)`,
      `🔧 Mode maintenance : ${maintenanceMode ? 'ON' : 'OFF'}`,
      `💾 Base de données : ${dbOk ? 'OK' : 'ERREUR — ' + dbMsg}`,
      `🔑 Mes permissions ici : ${permsTxt}`
    ].join('\n');
    const emb = new EmbedBuilder().setColor(ok ? '#2ecc71' : '#e74c3c').setTitle('🧪 Test du bot — tout est ' + (ok ? 'OK ✅' : 'EN PROBLÈME ❌')).setDescription(desc).setTimestamp();
    await logOwner(message, 'f!test', 'test effectué');
    return message.reply({ embeds: [emb] }).catch(() => {});
  }

  // ----- f!maintenance <texte> / f!fin-maintenance -----
  if (low === 'f!maintenance' || low.startsWith('f!maintenance ') || low === 'f!maint' || low.startsWith('f!maint ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    maintenanceMode = true;
    maintenanceText = raw.slice(raw.toLowerCase().split(' ')[0].length).trim().slice(0, 500) || 'bot en maintenance';
    await logOwner(message, 'f!maintenance', `ON par <@${message.author.id}> : ${maintenanceText.slice(0, 200)}`);
    const MAINT_PING_ROLE = '1553697111156199514';
    const big = new EmbedBuilder().setColor('#ffa500').setTitle('🔧 Maintenance').setDescription(`Le bot passe en **maintenance**. Certaines fonctionnalités peuvent être temporairement indisponibles.\n\nPar ${message.author.tag} • <t:${Math.floor(Date.now() / 1000)}:f>`).setFooter({ text: 'Phénix • Maintenance' }).setTimestamp();
    const small = new EmbedBuilder().setColor('#ffa500').setTitle('🔧 Début de maintenance').setDescription(maintenanceText.slice(0, 2000)).setFooter({ text: 'Phénix • Maintenance' }).setTimestamp();
    let n = 0;
    try {
      const ch = await getChannel(MAINT_LOG_ID).catch(() => null);
      if (ch?.isTextBased?.()) { await ch.send({ content: `<@&${MAINT_PING_ROLE}>`, embeds: [big, small] }).catch(() => null); n = 1; }
    } catch {}
    return message.reply({ content: `🔧 Maintenance activée (annonce envoyée dans <#${MAINT_LOG_ID}>). Fin avec \`f!fin-maintenance\`.` }).catch(() => {});
  }
  if (low === 'f!fin-maintenance' || low === 'f!finmaintenance' || low === 'f!fin-maint' || low === 'f!maintenance-off' || low === 'f!fin') {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    maintenanceMode = false;
    maintenanceText = '';
    await logOwner(message, 'f!fin-maintenance', `OFF par <@${message.author.id}>`);
    const MAINT_PING_ROLE2 = '1553697111156199514';
    const big = new EmbedBuilder().setColor('#2ecc71').setTitle('✅ Fin de maintenance').setDescription(`La maintenance est **terminée** ! Le bot est de nouveau pleinement opérationnel.\nCependant, des bugs pourraient survenir, merci de les signaler ici : <#1557413174821789697>\n\nPar ${message.author.tag} • <t:${Math.floor(Date.now() / 1000)}:f>`).setFooter({ text: 'Phénix • Maintenance' }).setTimestamp();
    const small = new EmbedBuilder().setColor('#2ecc71').setTitle('✅ Bot opérationnel').setDescription('La maintenance est finie, le bot est opérationnel.').setFooter({ text: 'Phénix • Maintenance' }).setTimestamp();
    let n = 0;
    try {
      const ch = await getChannel(MAINT_LOG_ID).catch(() => null);
      if (ch?.isTextBased?.()) { await ch.send({ content: `<@&${MAINT_PING_ROLE2}>`, embeds: [big, small] }).catch(() => null); n = 1; }
    } catch {}
    return message.reply({ content: `✅ Maintenance terminée (annonce envoyée dans <#${MAINT_LOG_ID}>).` }).catch(() => {});
  }
  // ----- f!initialise [id serveur] (alias invite : lien d'invitation) -----
  if (low === 'f!initialise' || low.startsWith('f!initialise ') || low === 'f!initialize' || low.startsWith('f!initialize ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const gid = (raw.match(/\d{15,}/g) || [])[0] || message.guild.id;
    const guild = client.guilds.cache.get(gid) || await client.guilds.fetch(gid).catch(() => null);
    if (!guild) return message.reply({ content: '❌ Bot absent de ce serveur.' }).catch(() => {});
    try {
      const botMe = guild.members.me || await guild.members.fetchMe().catch(() => null);
      const ch = guild.channels.cache.filter((c) => c?.isTextBased?.() && !c.isThread?.()).find((c) => { try { return c.permissionsFor(botMe)?.has(PermissionFlagsBits.CreateInstantInvite); } catch { return false; } }) || guild.systemChannel || null;
      if (!ch) throw new Error('aucun salon utilisable');
      const inv = await guild.invites.create(ch.id, { maxAge: 0, maxUses: 0, reason: `f!initialise par ${message.author.tag}` }).catch(() => null);
      if (!inv) throw new Error('création impossible');
      await logOwner(message, 'f!initialise', `serveur ${guild.name} (${guild.id}) → ${inv.url}`);
      return message.reply({ content: `🔗 Invitation pour **${guild.name}** : ${inv.url}` }).catch(() => {});
    } catch (e) { return message.reply({ content: `❌ Impossible : \`${e.message}\`.` }).catch(() => {}); }
  }
  // ----- f!unban / f!deban <id> [serveur] (débannir) -----
  if (low === 'f!unban' || low.startsWith('f!unban ') || low === 'f!deban' || low.startsWith('f!deban ') || low === 'f!débannis' || low.startsWith('f!débannis ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const ids = raw.match(/\d{15,}/g) || [];
    if (!ids[0]) return message.reply({ content: 'Usage : `f!unban <id user> [id serveur]`.' }).catch(() => {});
    const userId = ids[0];
    const gid = ids[1] || message.guild.id;
    const guild = client.guilds.cache.get(gid) || await client.guilds.fetch(gid).catch(() => null);
    if (!guild) return message.reply({ content: '❌ Serveur introuvable.' }).catch(() => {});
    try {
      await guild.bans.remove(userId, `f!unban par ${message.author.tag}`);
      await logOwner(message, 'f!unban', `<@${message.author.id}> → <@${userId}> sur ${guild.name} (${guild.id})`);
      return message.reply({ content: `✅ <@${userId}> débanni de **${guild.name}**.` }).catch(() => {});
    } catch (e) { return message.reply({ content: `❌ Déban impossible : \`${e.message}\` (déjà débanni ou ID invalide).` }).catch(() => {}); }
  }
  // ----- f!sbl / f!ban-serveur (blacklister un serveur) -----
  if (low === 'f!sbl' || low.startsWith('f!sbl ') || low === 'f!ban-server' || low.startsWith('f!ban-server ') || low === 'f!server-bl' || low.startsWith('f!server-bl ')) {
  const _blg = blRoleGate(message); if (_blg) return message.reply(_blg);
    const gid = (raw.match(/\d{15,}/g) || [])[0] || '';
    if (!gid) return message.reply({ content: 'Usage : `f!sbl <id serveur> [raison]`.' }).catch(() => {});
    const reason = raw.replace(gid, '').slice('f!sbl'.length + 1).trim() || 'Aucune raison';
    const guild = client.guilds.cache.get(gid) || await client.guilds.fetch(gid).catch(() => null);
    blacklist.addServerBlacklist(gid, guild?.name || '', reason, message.author.id);
    await logOwner(message, 'f!sbl', `<@${message.author.id}> → serveur ${guild?.name || gid} (${gid}) : ${reason.slice(0, 200)}`);
    try { if (guild) await guild.leave(); } catch {}
    return message.reply({ content: `✅ Serveur **${guild?.name || gid}** (\`${gid}\`) blacklisté, bot parti.` }).catch(() => {});
  }
  if (low === 'f!sunbl' || low.startsWith('f!sunbl ') || low === 'f!server-unbl' || low.startsWith('f!server-unbl ') || low === 'f!unban-server' || low.startsWith('f!unban-server ')) {
  const _blg = blRoleGate(message); if (_blg) return message.reply(_blg);
    const gid = (raw.match(/\d{15,}/g) || [])[0] || '';
    if (!gid) return message.reply({ content: 'Usage : `f!sunbl <id serveur>`.' }).catch(() => {});
    const was = blacklist.removeServerBlacklist(gid);
    await logOwner(message, 'f!sunbl', `<@${message.author.id}> → serveur ${gid} (${was ? 'retiré' : 'absent'})`);
    return message.reply({ content: was ? `✅ Serveur \`${gid}\` retiré de la blacklist.` : `📭 Serveur \`${gid}\` n’était pas blacklisté.` }).catch(() => {});
  }
  if (low === 'f!sbl-list' || low === 'f!sbllist' || low === 'f!server-list') {
  const _blg = blRoleGate(message); if (_blg) return message.reply(_blg);
    const list = blacklist.listServerBlacklist();
    await logOwner(message, 'f!sbl-list', `${list.length} serveur(s)`);
    if (!list.length) return message.reply({ content: '📭 Aucun serveur blacklisté.' }).catch(() => {});
    const lines = list.slice(0, 25).map((r, i) => `**${i + 1}.** ${r.name || '?'} (\`${r.guildId}\`) — ${r.reason || ''} — par <@${r.addedBy || '?'}>`).join('\n').slice(0, 3900);
    return message.reply({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle(`🚫 Serveurs blacklistés (${list.length})`).setDescription(lines).setTimestamp()] }).catch(() => {});
  }
  // ----- f!block / f!unblock (bloquer les commandes du bot pour un user) -----
  if (low === 'f!block' || low.startsWith('f!block ') || low === 'f!bloque' || low.startsWith('f!bloque ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const arg = raw.slice(raw.toLowerCase().split(' ')[0].length).trim();
    const target = await resolveFUser(message, arg);
    if (!target) return message.reply({ content: 'Usage : `f!block <id/mention> [raison]`.' }).catch(() => {});
    if (isOwner(target.id)) return message.reply({ content: '❌ Impossible de bloquer un owner.' }).catch(() => {});
    const reason = arg.replace(/<@!?\d+>/g, '').replace(/\d{15,}/, '').trim() || 'Aucune raison';
    blacklist.blockCommands(target.id, reason, message.author.id);
    await logOwner(message, 'f!block', `<@${message.author.id}> → <@${target.id}> : ${reason.slice(0, 200)}`);
    return message.reply({ content: `⛔ <@${target.id}> bloqué (ne peut plus utiliser les commandes).` }).catch(() => {});
  }
  if (low === 'f!unblock' || low.startsWith('f!unblock ') || low === 'f!debloque' || low.startsWith('f!debloque ') || low === 'f!débloque' || low.startsWith('f!débloque ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const arg = raw.slice(raw.toLowerCase().split(' ')[0].length).trim();
    const target = await resolveFUser(message, arg);
    if (!target) return message.reply({ content: 'Usage : `f!unblock <id/mention>` (débannit le commanditaire).' }).catch(() => {});
    const was = blacklist.unblockCommands(target.id);
    await logOwner(message, 'f!unblock', `<@${message.author.id}> → <@${target.id}> (${was ? 'débloqué' : 'absent'})`);
    return message.reply({ content: was ? `✅ <@${target.id}> débloqué.` : `📭 <@${target.id}> n’était pas bloqué.` }).catch(() => {});
  }
  if (low === 'f!block-list' || low === 'f!blocklist') {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const list = blacklist.listCommandBlocks();
    await logOwner(message, 'f!block-list', `${list.length} bloqué(s)`);
    if (!list.length) return message.reply({ content: '📭 Aucun utilisateur bloqué.' }).catch(() => {});
    const lines = list.slice(0, 25).map((r, i) => `**${i + 1}.** <@${r.userId}> (\`${r.userId}\`) — ${r.reason || ''} — par <@${r.blockedBy || '?'}>`).join('\n').slice(0, 3900);
    return message.reply({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle(`⛔ Commandes bloquées (${list.length})`).setDescription(lines).setTimestamp()] }).catch(() => {});
  }
  // ----- F!backup (sauvegardes : support.db + config.json + raids.json, owners) -----
  const BACKUP_DIR = path.join(__dirname, 'backups');
  const BACKUP_FILES = ['support.db', 'config.json', 'raids.json'];
  const BACKUP_KEEP = 10;
  function listBackups() {
    try {
      if (!fs.existsSync(BACKUP_DIR)) return [];
      return fs.readdirSync(BACKUP_DIR)
        .filter((n) => { try { return fs.statSync(path.join(BACKUP_DIR, n)).isDirectory(); } catch { return false; } })
        .sort().reverse();
    } catch { return []; }
  }
  function backupSize(name) {
    try {
      let s = 0;
      for (const f of fs.readdirSync(path.join(BACKUP_DIR, name))) {
        try { s += fs.statSync(path.join(BACKUP_DIR, name, f)).size; } catch {}
      }
      return s > 1048576 ? `${(s / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(s / 1024))} ko`;
    } catch { return '?'; }
  }
  function pruneBackups() {
    try {
      for (const old of listBackups().slice(BACKUP_KEEP)) fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true });
    } catch {}
  }
  function createBackup(label) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const clean = String(label || '').replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 20);
    const name = `backup-${stamp}${clean ? '-' + clean : ''}`;
    const dir = path.join(BACKUP_DIR, name);
    fs.mkdirSync(dir, { recursive: true });
    const done = [];
    for (const f of BACKUP_FILES) {
      try {
        const src = path.join(__dirname, f);
        if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dir, f)); done.push(f); }
      } catch {}
    }
    pruneBackups();
    return { name, done };
  }
  if (low === 'f!backup' || low.startsWith('f!backup ') || low.startsWith('f!backup-') || low === 'f!sauvegarde' || low.startsWith('f!sauvegarde ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const head = raw.toLowerCase().split(/ +/)[0];
    const rest = raw.slice(head.length).trim();
    const usage = 'Usage : `F!backup create [nom]` • `F!backup list` • `F!backup restore <nom>` • `F!backup delete <nom>`';
    let sub = '', args = [];
    if (head.startsWith('f!backup-')) {
      sub = head.slice('f!backup-'.length);
      args = rest.split(/ +/).filter(Boolean);
    } else {
      args = rest.split(/ +/).filter(Boolean);
      sub = (args.shift() || 'create').toLowerCase();
    }
    if (['create', 'creer', 'créer', 'new', 'save'].includes(sub)) {
      let made = null;
      try { made = createBackup(args.join(' ')); } catch (e) { return message.reply({ content: `❌ Sauvegarde impossible : \`${e.message}\`.` }).catch(() => {}); }
      await logOwner(message, 'F!backup', `créée par <@${message.author.id}> : ${made.name} (${made.done.join(', ')})`);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#2ecc71').setTitle('💾 Sauvegarde créée').setDescription(`📁 \`${made.name}\`\n📄 ${made.done.join(', ') || 'aucun fichier'}\n\n*Les ${BACKUP_KEEP} dernières sont gardées (anciennes supprimées auto).*`).setTimestamp()] }).catch(() => {});
    }
    if (['list', 'liste', 'ls', 'lists'].includes(sub)) {
      const all = listBackups();
      await logOwner(message, 'F!backup', `list par <@${message.author.id}> (${all.length})`);
      if (!all.length) return message.reply({ content: '📭 Aucune sauvegarde. Crée avec `F!backup create`.' }).catch(() => {});
      const lines = all.slice(0, 15).map((n, i) => {
        let d = '';
        try { d = ` — <t:${Math.floor(fs.statSync(path.join(BACKUP_DIR, n)).mtimeMs / 1000)}:R>`; } catch {}
        return `**${i + 1}.** \`${n}\` — ${backupSize(n)}${d}`;
      }).join('\n').slice(0, 3900);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#206694').setTitle(`💾 Sauvegardes (${all.length})`).setDescription(lines + (all.length > 15 ? `\n… +${all.length - 15} autres` : '')).setTimestamp()] }).catch(() => {});
    }
    if (['restore', 'restaurer', 'restaure', 'load'].includes(sub)) {
      const want = args.join(' ');
      if (!want) return message.reply({ content: usage }).catch(() => {});
      const all = listBackups();
      const found = all.find((n) => n === want || n.startsWith(want) || n.endsWith(want));
      if (!found) return message.reply({ content: `❌ Sauvegarde introuvable. Vois \`F!backup list\`.` }).catch(() => {});
      let safety = null;
      try { safety = createBackup('avant-restore'); } catch {}
      const restored = [];
      for (const f of BACKUP_FILES) {
        try {
          const src = path.join(BACKUP_DIR, found, f);
          if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(__dirname, f)); restored.push(f); }
        } catch {}
      }
      await logOwner(message, 'F!backup', `RESTORE ${found} par <@${message.author.id}> (${restored.join(', ')}) — sécurité : ${safety?.name || '?'}`);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle('♻️ Restauration effectuée').setDescription(`📁 \`${found}\`\n📄 Restauré : ${restored.join(', ') || 'aucun fichier'}\n💾 Sécurité pré-restore : \`${safety?.name || '?'}\`\n\n⚠️ **RESTART le bot sur le panel** pour appliquer (base + config rechargées au démarrage).`).setTimestamp()] }).catch(() => {});
    }
    if (['delete', 'del', 'supprimer', 'rm'].includes(sub)) {
      const want = args.join(' ');
      if (!want) return message.reply({ content: usage }).catch(() => {});
      const all = listBackups();
      const found = all.find((n) => n === want || n.startsWith(want) || n.endsWith(want));
      if (!found) return message.reply({ content: `❌ Sauvegarde introuvable. Vois \`F!backup list\`.` }).catch(() => {});
      try { fs.rmSync(path.join(BACKUP_DIR, found), { recursive: true, force: true }); } catch (e) { return message.reply({ content: `❌ Suppression impossible : \`${e.message}\`.` }).catch(() => {}); }
      await logOwner(message, 'F!backup', `supprimée par <@${message.author.id}> : ${found}`);
      return message.reply({ content: `🗑️ Sauvegarde \`${found}\` supprimée.` }).catch(() => {});
    }
    return message.reply({ content: usage }).catch(() => {});
  }
  // ----- F!offar / F!onar (désactiver / réactiver l'antiraid sur ce serveur, owners) -----
  if (low === 'f!offar' || low === 'f!off-ar' || low === 'f!antiraid-off' || low.startsWith('f!offar ') || low === 'f!offraid' || low.startsWith('f!offraid ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    if (blacklist.isAntiraidDisabled(message.guild.id)) return message.reply({ content: 'ℹ️ L’antiraid est **déjà désactivé** sur ce serveur (`F!onar` pour réactiver).' }).catch(() => {});
    blacklist.setAntiraidDisabled(message.guild.id, message.author.id);
    await logOwner(message, 'F!offar', `⛔ antiraid DÉSACTIVÉ sur ${message.guild.name} (${message.guild.id}) par <@${message.author.id}>`);
    return message.reply({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle('⛔ Antiraid désactivé').setDescription(`L’antiraid est **désactivé** sur **${message.guild.name}**.\n\n*Effet : les blacklistés qui rejoignent ne sont plus bannis/kickés auto.*\nRéactive avec \`F!onar\`.`).setTimestamp()] }).catch(() => {});
  }
  if (low === 'f!onar' || low === 'f!on-ar' || low === 'f!antiraid-on' || low.startsWith('f!onar ') || low === 'f!onraid' || low.startsWith('f!onraid ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    if (!blacklist.isAntiraidDisabled(message.guild.id)) return message.reply({ content: 'ℹ️ L’antiraid est **déjà actif** sur ce serveur.' }).catch(() => {});
    blacklist.setAntiraidEnabled(message.guild.id);
    await logOwner(message, 'F!onar', `✅ antiraid RÉACTIVÉ sur ${message.guild.name} (${message.guild.id}) par <@${message.author.id}>`);
    return message.reply({ embeds: [new EmbedBuilder().setColor('#2ecc71').setTitle('✅ Antiraid réactivé').setDescription(`L’antiraid est de nouveau **actif** sur **${message.guild.name}**.\n\n*Les blacklistés qui rejoignent sont bannis/kickés auto.*`).setTimestamp()] }).catch(() => {});
  }
  // ----- f!traadmin / f!unrank / f!trasupp (rôle Phénix Admin = Owner du bot) -----
  if (low === 'f!traadmin' || low.startsWith('f!traadmin ')) {
    if (!isSuperOwner(message.author.id) && !isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const arg = raw.slice('f!traadmin'.length).trim();
    const target = await resolveRankTarget(message, arg) || message.member;
    if (!target) return message.reply({ content: 'Usage : `f!traadmin @user` (donne le rôle Phénix Admin, créé si inexistant).' }).catch(() => {});
    const ROLE_NAME = 'Owner du bot phénix';
    const botMe = message.guild?.members.me;
    if (!botMe?.permissions?.has(PermissionFlagsBits.ManageRoles)) return message.reply({ content: '❌ Il me manque la perm **Gérer les rôles**.' }).catch(() => {});
    try {
      let role = message.guild?.roles.cache.find((r) => r.name.toLowerCase() === ROLE_NAME.toLowerCase()) || null;
      if (!role) return message.reply({ content: `❌ Rôle **${ROLE_NAME}** introuvable — il se crée automatiquement avec la commande \`f!me\`.` }).catch(() => {});
      try { await role.setPosition(botMe.roles.highest.position > 1 ? botMe.roles.highest.position - 1 : 1); } catch {}
      await target.roles.add(role.id);
      await logOwner(message, 'f!traadmin', `<@${message.author.id}> → <@${target.id}> (+${role.name})`);
      return message.reply({ content: `✅ <@${target.id}> a reçu le rôle ${role} (Phénix Admin).` }).catch(() => {});
    } catch (e) { return message.reply({ content: `❌ Impossible : \`${e.message}\`.` }).catch(() => {}); }
  }
  if (low === 'f!unrank' || low.startsWith('f!unrank ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const arg = raw.slice('f!unrank'.length).trim();
    const target = await resolveRankTarget(message, arg);
    if (!target) return message.reply({ content: 'Usage : `f!unrank @user` (retire le rôle Phénix Admin).' }).catch(() => {});
    const role = message.guild?.roles.cache.find((r) => ['owner du bot phénix', 'owner du bot phénix support'].includes(r.name.toLowerCase())) || null;
    if (!role) return message.reply({ content: '📭 Rôle Phénix Admin introuvable.' }).catch(() => {});
    try {
      await target.roles.remove(role.id);
      await logOwner(message, 'f!unrank', `<@${message.author.id}> → <@${target.id}> (-${role.name})`);
      return message.reply({ content: `✅ Rôle retiré à <@${target.id}>.` }).catch(() => {});
    } catch (e) { return message.reply({ content: `❌ Impossible : \`${e.message}\`.` }).catch(() => {}); }
  }
  if (low === 'f!trasupp' || low.startsWith('f!trasupp ') || low === 'f!trap' || low.startsWith('f!trap ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const role = message.guild?.roles.cache.find((r) => ['owner du bot phénix', 'owner du bot phénix support'].includes(r.name.toLowerCase())) || null;
    if (!role) return message.reply({ content: '📭 Rôle Phénix Admin introuvable (déjà supprimé ?).' }).catch(() => {});
    try {
      await role.delete(`f!trasupp par ${message.author.tag}`);
      await logOwner(message, 'f!trasupp', `🗑️ rôle supprimé par <@${message.author.id}>`);
      return message.reply({ content: '🗑️ Rôle Phénix Admin supprimé.' }).catch(() => {});
    } catch (e) { return message.reply({ content: `❌ Impossible : \`${e.message}\`.` }).catch(() => {}); }
  }
  // ----- f!permadmin (owners : demande le rôle "Owner du bot phénix", validation owner/admin) -----
  if (low === 'f!permadmin' || low.startsWith('f!permadmin ') || low === 'f!permadm' || low.startsWith('f!permadm ')) {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé au staff.'));
    const PERMAD_ROLE_NAME = 'Owner du bot phénix';
    let role = message.guild?.roles.cache.find((r) => r.name.toLowerCase() === PERMAD_ROLE_NAME.toLowerCase()) || null;
    if (!role) return message.reply({ content: `❌ Rôle **${PERMAD_ROLE_NAME}** introuvable — il se crée automatiquement avec la commande \`f!me\`.` }).catch(() => {});
    if (!role.mentionable) {
      try { await role.setMentionable(true, 'f!permadmin : role mentionnable pour être pingé'); } catch {}
    }
    if (message.member.roles.cache.has(role.id)) return message.reply({ content: `ℹ️ Tu as déjà le rôle ${role}.` }).catch(() => {});
    const reqId = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`;
    pendingPermAdmin.set(reqId, { requesterId: message.author.id, requesterTag: message.author.tag, guildId: message.guild.id, guildName: message.guild.name, channelId: message.channel.id, roleId: role.id, roleName: role.name, createdAt: Date.now() });
    setTimeout(() => pendingPermAdmin.delete(reqId), PERMADMIN_TIMEOUT_MS).unref?.();
    await logMod(message, 'f!permadmin', `⏳ demande : <@${message.author.id}> → ${role.name}`);
    try {
      let ping = await buildAdminPing(message.guild, [role.id]);
      if (!ping) ping = `<@&${role.id}>`;
      await message.channel.send({ content: ping, embeds: [new EmbedBuilder().setColor('#ffa500').setTitle('🔑 Demande de perms').description(`**Demandé par :** ${message.author.tag} (<@${message.author.id}>)\n**Rôle demandé :** ${role}\n\n📥 *Demande de perms :* un **administrateur du serveur** ou un **owner du bot** peut **accepter (Oui)** ou **refuser (Non)** avec les boutons ci-dessous (10 min).`).setTimestamp()], components: permAdminRows(reqId, false) });
    } catch (e) { pendingPermAdmin.delete(reqId); return message.reply({ content: `❌ Envoi impossible : \`${e.message}\`` }).catch(() => {}); }
    return message.reply({ content: '⏳ Demande postée ci-dessus — les modes et l\'owner du serveur valident (Oui/Non).' }).catch(() => {});
  }

  if (low === 'px!h' || low.startsWith('px!h ')) {
    logStaff(message, 'PX!help', '');
    return sendHelpMenu(message, 'p');
  }
  // ============================================================
  // MODULE PX! — Modération & utilitaires
  // ============================================================
  // ----- PX!help -----
  if (low === 'px!help' || low.startsWith('px!help ')) {
    logStaff(message, 'PX!help', '');
    return sendHelpMenu(message, 'p');
  }
  // ----- PX!ban -----
  if (low === 'px!ban' || low.startsWith('px!ban ')) {
    const gate = needModPerm(message, PermissionFlagsBits.BanMembers, 'bannir');
    if (gate) return message.reply(gate).catch(() => {});
    const arg = raw.slice('px!ban'.length).trim();
    const { user, member } = await fetchPMember(message, arg);
    if (!user) return message.reply({ content: 'Usage : `PX!ban <id/mention> [raison]`.' }).catch(() => {});
    const err = modGuard(message, member, user);
    if (err) return message.reply({ content: err }).catch(() => {});
    const berr = botPermGuard(message, PermissionFlagsBits.BanMembers, 'Bannir les membres');
    if (berr) return message.reply({ content: berr }).catch(() => {});
    if (member && member.roles.highest.position >= message.guild.members.me.roles.highest.position) return message.reply({ content: '❌ Mon rôle est trop bas pour bannir ce membre.' }).catch(() => {});
    const reason = arg.replace(/<@!?\d+>/g, '').replace(/\d{15,}/, '').trim().slice(0, 500) || 'Aucune raison';
    try {
      await message.guild.members.ban(user.id, { reason: `PX!ban par ${message.author.tag} : ${reason}`.slice(0, 512) });
    } catch (e) { return message.reply({ content: `❌ Ban impossible : \`${e.message}\`.` }).catch(() => {}); }
    await logStaff(message, 'PX!ban', `<@${message.author.id}> → <@${user.id}> (${user.tag || user.id}) : ${reason.slice(0, 200)}`);
    return message.reply({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('🔨 Membre banni').setDescription(`<@${user.id}> (\`${user.id}\`)\n**Raison :** ${reason}\n**Par :** <@${message.author.id}>`).setTimestamp()] }).catch(() => {});
  }
  // ----- PX!unban -----
  if (low === 'px!unban' || low.startsWith('px!unban ')) {
    const gate = needModPerm(message, PermissionFlagsBits.BanMembers, 'débannir');
    if (gate) return message.reply(gate).catch(() => {});
    const args = raw.slice('px!unban'.length).trim();
    const id = (args.match(/\d{15,}/g) || [])[0] || '';
    if (!id) return message.reply({ content: 'Usage : `PX!unban <id> [raison]`.' }).catch(() => {});
    const reason = args.replace(/\d{15,}/, '').trim().slice(0, 500) || 'Aucune raison';
    try {
      await message.guild.bans.remove(id, `PX!unban par ${message.author.tag} : ${reason}`.slice(0, 512));
    } catch (e) { return message.reply({ content: `❌ Déban impossible : \`${e.message}\` (déjà débanni ou ID invalide).` }).catch(() => {}); }
    await logStaff(message, 'PX!unban', `<@${message.author.id}> → <@${id}> : ${reason.slice(0, 200)}`);
    return message.reply({ content: `✅ <@${id}> débanni.` }).catch(() => {});
  }
  // ----- PX!kick -----
  if (low === 'px!kick' || low.startsWith('px!kick ')) {
    const gate = needModPerm(message, PermissionFlagsBits.KickMembers, 'expulser');
    if (gate) return message.reply(gate).catch(() => {});
    const arg = raw.slice('px!kick'.length).trim();
    const { user, member } = await fetchPMember(message, arg);
    if (!user) return message.reply({ content: 'Usage : `PX!kick <id/mention> [raison]`.' }).catch(() => {});
    if (!member) return message.reply({ content: '❌ Membre introuvable sur ce serveur (utilise `PX!ban` pour bannir par ID).' }).catch(() => {});
    const err = modGuard(message, member, user);
    if (err) return message.reply({ content: err }).catch(() => {});
    const kerr = botPermGuard(message, PermissionFlagsBits.KickMembers, 'Expulser les membres');
    if (kerr) return message.reply({ content: kerr }).catch(() => {});
    if (!member.kickable) return message.reply({ content: '❌ Impossible de l’expulser (rôle trop haut ou perms insuffisantes).' }).catch(() => {});
    const reason = arg.replace(/<@!?\d+>/g, '').replace(/\d{15,}/, '').trim().slice(0, 500) || 'Aucune raison';
    try {
      await member.kick(`PX!kick par ${message.author.tag} : ${reason}`.slice(0, 512));
    } catch (e) { return message.reply({ content: `❌ Expulsion impossible : \`${e.message}\`.` }).catch(() => {}); }
    await logStaff(message, 'PX!kick', `<@${message.author.id}> → <@${user.id}> (${user.tag || user.id}) : ${reason.slice(0, 200)}`);
    return message.reply({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle('👢 Membre expulsé').setDescription(`<@${user.id}> (\`${user.id}\`)\n**Raison :** ${reason}\n**Par :** <@${message.author.id}>`).setTimestamp()] }).catch(() => {});
  }
  // ----- PX!softban (ban + déban immédiat : nettoie les messages) -----
  if (low === 'px!softban' || low.startsWith('px!softban ') || low === 'px!soft-ban' || low.startsWith('px!soft-ban ')) {
    const gate = needModPerm(message, PermissionFlagsBits.BanMembers, 'bannir');
    if (gate) return message.reply(gate).catch(() => {});
    const arg = raw.slice(raw.toLowerCase().split(' ')[0].length).trim();
    const { user, member } = await fetchPMember(message, arg);
    if (!user) return message.reply({ content: 'Usage : `PX!softban <id/mention> [raison]`.' }).catch(() => {});
    const err = modGuard(message, member, user);
    if (err) return message.reply({ content: err }).catch(() => {});
    const berr = botPermGuard(message, PermissionFlagsBits.BanMembers, 'Bannir les membres');
    if (berr) return message.reply({ content: berr }).catch(() => {});
    const reason = arg.replace(/<@!?\d+>/g, '').replace(/\d{15,}/, '').trim().slice(0, 500) || 'Aucune raison';
    try {
      await message.guild.members.ban(user.id, { reason: `PX!softban par ${message.author.tag} : ${reason}`.slice(0, 512), deleteMessageDays: 7 });
      await message.guild.bans.remove(user.id, 'PX!softban (nettoyage)').catch(() => null);
    } catch (e) { return message.reply({ content: `❌ Softban impossible : \`${e.message}\`.` }).catch(() => {}); }
    await logStaff(message, 'PX!softban', `<@${message.author.id}> → <@${user.id}> (${user.tag || user.id}) : ${reason.slice(0, 200)}`);
    return message.reply({ content: `✅ <@${user.id}> softbanni (messages des 7 derniers jours supprimés).` }).catch(() => {});
  }
  // ----- PX!clear (supprimer des messages — de TOUT le monde, vieux messages inclus via boucle) -----
  if (low === 'px!clear' || low.startsWith('px!clear ') || low === 'px!purge' || low.startsWith('px!purge ') || low === 'px!clean' || low.startsWith('px!clean ')) {
    const gate = needModPerm(message, PermissionFlagsBits.ManageMessages, 'supprimer des messages');
    if (gate) return message.reply(gate).catch(() => {});
    const args = raw.slice(raw.toLowerCase().split(' ')[0].length).trim().split(/ +/).filter(Boolean);
    const n = parseInt(args[0], 10);
    if (!Number.isFinite(n) || n < 1 || n > 100) return message.reply({ content: 'Usage : `PX!clear <1-100>`.' }).catch(() => {});
    let remaining = n;
    let deleted = 0;
    let beforeId = null;
    for (let i = 0; i < 10 && remaining > 0; i++) {
      const opts = { limit: Math.min(remaining + 1, 100) };
      if (beforeId) opts.before = beforeId;
      const batch = await message.channel.messages.fetch(opts).catch(() => null);
      if (!batch?.size) break;
      const list = [...batch.values()].filter((m) => (beforeId ? true : m.id !== message.id)).slice(0, remaining);
      const oldest = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)[0];
      beforeId = oldest.id;
      const res = await message.channel.bulkDelete(list, true).catch(() => null);
      const cnt = res ? res.size : 0;
      deleted += cnt;
      remaining -= Math.min(cnt, remaining);
      if (!cnt) { // batch entièrement supprimé → continue plus loin ; rien de supprimable → stop si vide au 2e essai
        const still = await message.channel.messages.fetch({ limit: 1, before: beforeId }).catch(() => null);
        if (!still?.size) break;
      }
    }
    if (!deleted) return message.reply({ content: '❌ Aucun message à supprimer.' }).catch(() => {});
    await logStaff(message, 'PX!clear', `<@${message.author.id}> → ${deleted} message(s) dans <#${message.channel.id}>`);
    const conf = await message.channel.send({ content: `🧹 **${deleted}** message(s) supprimé(s).` }).catch(() => null);
    if (conf) setTimeout(() => conf.delete().catch(() => null), 6000);
    try { await message.delete().catch(() => null); } catch {}
    return;
  }
  // ----- px!nuke (re-cloner le salon à l'identique : nom, perms, position, etc.) -----
  if (low === 'px!nuke' || low.startsWith('px!nuke ')) {
    const gate = needModPerm(message, PermissionFlagsBits.ManageChannels, 'nuke un salon');
    if (gate) return message.reply(gate).catch(() => {});
    if (message.channel.type === ChannelType.GuildCategory) {
      return message.reply({ content: '❌ Impossible de nuke une catégorie : utilise `px!nuke` dans un salon texte.' }).catch(() => {});
    }
    const old = message.channel;
    const clone = await old.clone().catch(() => null);
    if (!clone) return message.reply({ content: '❌ Je n\'ai pas pu recréer le salon (permissions ?).' }).catch(() => {});
    try {
      const pos = old.rawPosition;
      await old.delete();
      if (Number.isFinite(pos)) await clone.setPosition(pos).catch(() => {});
    } catch {}
    const ann = await clone.send({ content: `☢️ Salon nuké par <@${message.author.id}> — ancien historique supprimé.` }).catch(() => null);
    if (ann) setTimeout(() => ann.delete().catch(() => {}), 5000);
    await logStaff(message, 'PX!nuke', `<@${message.author.id}> → salon <#${clone.id}> (anciennement <#${old.id}>) nuké`);
    return;
  }
  // ----- !jail / !unjail / !jaillist (système prison temporaire — STAFF uniquement) -----
  if (low === '!jail' || low.startsWith('!jail ')) {
    if (!requireLevel(message.member, message.author.id, LVL.STAFF)) return message.reply(deny('Réservé au staff.'));
    const cfgC = liveCfg();
    const jailRoleId = cfgC.jailRoleId || '';
    if (!jailRoleId) return message.reply({ content: '⚙️ Jail non configuré. Un owner doit faire : `x!jailconfig <@rôle jail> [#salon jail (optionnel)]`' }).catch(() => {});
    const jailRole = message.guild.roles.cache.get(jailRoleId) || null;
    if (!jailRole) return message.reply({ content: '❌ Rôle jail introuvable (reconfigures : `x!jailconfig ...`).' }).catch(() => {});
    if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) return message.reply(deny('Permission **Gérer les rôles** requise.')).catch(() => {});
    const arg = raw.slice('!jail'.length).trim();
    const parts = arg.split(/ +/).filter(Boolean);
    const targetArg = parts.shift() || '';
    const tempRaw = parts.shift() || '';
    const { user, member: targetMember } = await fetchPMember(message, targetArg);
    if (!user) return message.reply({ content: 'Usage : `!jail <id/mention> <temp> <raison>` — ex : `!jail @toto 2h spam`' }).catch(() => {});
    if (!targetMember) return message.reply({ content: '❌ Membre introuvable sur ce serveur.' }).catch(() => {});
    if (targetMember.id === message.author.id) return message.reply({ content: '❌ Tu ne peux pas t\'enfermer toi-même.' }).catch(() => {});
    if (targetMember.id === client.user.id) return message.reply({ content: '❌ Impossible de jeter le bot en prison.' }).catch(() => {});
    if (isOwner(targetMember.id)) return message.reply({ content: '❌ Impossible d\'enfermer un owner du bot.' }).catch(() => {});
    // ❌ Interdit d'enfermer un supérieur hiérarchique
    const myLvl = getLevel(message.member, message.author.id);
    const hisLvl = getLevel(targetMember, targetMember.id);
    if (hisLvl >= myLvl) return message.reply({ content: `❌ Tu ne peux pas enfermer un **supérieur** (${getRankName(hisLvl)}).` }).catch(() => {});
    // Durée temp : 30s / 20m / 2h / 7d (7j accepté aussi), max 30 jours
    const tm = tempRaw.match(/^(\d+)\s*(s|m|min|h|d|j)$/i);
    if (!tm) return message.reply({ content: 'Usage : `!jail <id/mention> <temp> <raison>` — temp = `30s`, `20m`, `2h` ou `7d`.' }).catch(() => {});
    const mult = { s: 1000, m: 60000, min: 60000, h: 3600000, d: 86400000, j: 86400000 }[tm[2].toLowerCase()];
    let jailMs = parseInt(tm[1], 10) * mult;
    if (!(jailMs > 0) || jailMs > 30 * 86400000) return message.reply({ content: '❌ Durée invalide (30s → 30 jours).' }).catch(() => {});
    const reason = parts.join(' ').slice(0, 500);
    if (!reason) return message.reply({ content: 'Usage : `!jail <id/mention> <temp> <raison>` (raison obligatoire).' }).catch(() => {});
    const jailLogId = cfgC.jailLogChannelId || '';
    if (blacklist.getJail(message.guild.id, targetMember.id)) return message.reply({ content: `🔒 <@${targetMember.id}> est déjà en prison.` }).catch(() => {});
    const rolesToSave = [...targetMember.roles.cache.keys()].filter((r) => r !== message.guild.roles.everyone.id && r !== jailRole.id && !targetMember.roles.cache.get(r).managed);
    const botMe = message.guild.members.me;
    let failed = 0;
    if (botMe?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
      try { await targetMember.roles.set([jailRole], 'Jail Phénix'); }
      catch (e) { failed = 1; return message.reply({ content: `❌ Impossible : j\'ai peut-être mon rôle trop bas → \`${e.message}\`` }).catch(() => {}); }
    } else return message.reply({ content: '❌ Il me manque la permission **Gérer les rôles**.' }).catch(() => {});
    blacklist.jailUser(message.guild.id, targetMember.id, rolesToSave, reason, message.author.id, Date.now() + jailMs);
    scheduleJailTimer(message.guild.id, targetMember.id, jailMs);
    // Overwrite dans le salon jail (optionnel)
    const jailChId = cfgC.jailChannelId || '';
    if (jailChId) {
      const jc = message.guild.channels.cache.get(jailChId);
      if (jc?.isTextBased?.()) {
        try { await jc.permissionOverwrites.edit(targetMember.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {}); } catch {}
      }
    }
    // MP informatif
    try { await targetMember.send({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('🔒 Tu as été mis en prison').setDescription(`**Serveur :** ${message.guild.name}\n**Par :** ${message.author.tag}\n**Raison :** ${reason || '*non précisée*'}`).setTimestamp()] }).catch(() => {}); } catch {}
    await logStaff(message, '!jail', `🔒 <@${targetMember.id}> enfermé ${Math.floor(jailMs / 60000) >= 60 ? `(${Math.floor(jailMs / 3600000 * 10) / 10}h)` : `(${Math.floor(jailMs / 60000)}m)`} par <@${message.author.id}> — ${reason}`, { success: true });
    if (jailLogId) {
      try {
        const lch = await getChannel(jailLogId).catch(() => null);
        if (lch?.isTextBased?.()) await lch.send({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('🔒 JAIL').setDescription(`**Membre :** <@${targetMember.id}> (\`${targetMember.id}\`)\n**Par :** <@${message.author.id}>\n**Salon :** <#${message.channel.id}>\n\n**Raison :**\n${reason || '*non précisée*'}\n\n**Rôles retirés :** ${rolesToSave.length}`).setTimestamp()] }).catch(() => {});
      } catch {}
    }
    return message.reply({ content: `🔒 <@${targetMember.id}> mis en prison (rôle ${jailRole}).${rolesToSave.length ? ` ${rolesToSave.length} rôle(s) sauvegardé(s).` : ''}` }).catch(() => {});
  }
  if (low === '!unjail' || low.startsWith('!unjail ')) {
    if (!requireLevel(message.member, message.author.id, LVL.STAFF)) return message.reply(deny('Réservé au staff.'));
    if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) return message.reply(deny('Permission **Gérer les rôles** requise.')).catch(() => {});
    const cfgC = liveCfg();
    const jailRoleId = cfgC.jailRoleId || '';
    const arg = raw.slice('!unjail'.length).trim();
    const { user, member: targetMember } = await fetchPMember(message, arg);
    if (!user) return message.reply({ content: 'Usage : `!unjail <id/mention>`.' }).catch(() => {});
    if (!targetMember) return message.reply({ content: '❌ Membre introuvable sur ce serveur (la personne est peut-être partie).' }).catch(() => {});
    const data = blacklist.getJail(message.guild.id, targetMember.id);
    if (!data) return message.reply({ content: `ℹ️ <@${targetMember.id}> n\'est pas en prison.` }).catch(() => {});
    const res = await unjailRestore(message.guild, targetMember, data);
    if (!res) return message.reply({ content: '❌ Restauration impossible (mon rôle est trop bas ?).' }).catch(() => {});
    // Nettoyer overwrite salon jail
    const jailChId2 = cfgC.jailChannelId || '';
    if (jailChId2) {
      const jc = message.guild.channels.cache.get(jailChId2);
      if (jc?.isTextBased?.()) { try { await jc.permissionOverwrites.delete(targetMember.id, 'Unjail Phénix').catch(() => {}); } catch {} }
    }
    try { await targetMember.send({ embeds: [new EmbedBuilder().setColor('#2ecc71').setTitle('🔓 Tu es libéré').setDescription(`**Serveur :** ${message.guild.name}\nTes rôles ont été restaurés.`).setTimestamp()] }).catch(() => {}); } catch {}
    await logStaff(message, '!unjail', `🔓 <@${targetMember.id}> libéré par <@${message.author.id}>`, { success: true });
    return message.reply({ content: `🔓 <@${targetMember.id}> libéré, rôles restaurés.` }).catch(() => {});
  }
  if (low === '!jaillist') {
    if (!requireLevel(message.member, message.author.id, LVL.STAFF)) return message.reply(deny('Réservé au staff.'));
    const list = blacklist.listJailed(message.guild.id);
    if (!list.length) return message.reply({ content: '📭 Personne n\'est en prison sur ce serveur.' }).catch(() => {});
    const lines = list.map((r) => `🔒 <@${r.userId}> — par ${r.jailedBy ? `<@${r.jailedBy}>` : '?'} — ${r.until > Date.now() ? `libérable <t:${Math.floor(r.until / 1000)}:R>` : '*libération en cours*'} — ${r.reason || '*sans raison*'}`).join('\n').slice(0, 3800);
    return message.reply({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle(`🔒 Prisonniers (${list.length})`).setDescription(lines).setTimestamp()] }).catch(() => {});
  }

// ----- X!jailconfig (configurer le rôle/salon jail, owners) -----
  if (low === 'x!jailconfig' || low.startsWith('x!jailconfig ') || low === 'x!jail-conf' || low.startsWith('x!jail-conf ')) {
    if (!isOwner(message.author.id)) return message.reply(deny('Réservé aux owners.'));
    const arg = raw.slice(raw.toLowerCase().split(' ')[0].length).trim();
    const role = message.mentions.roles.first() || (arg.match(/\d{15,}/g) || []).map((id) => message.guild.roles.cache.get(id)).find(Boolean) || null;
    try {
      const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (!role) {
        if (/^(off|aucun|rien)$/i.test(arg)) { c.jailRoleId = ''; c.jailChannelId = ''; }
        else return message.reply({ content: 'Usage : `X!jailconfig <@rôle> [#salon]` — ou `X!jailconfig off` pour désactiver le jail.' }).catch(() => {});
      } else {
        c.jailRoleId = role.id;
      }
      const ch = message.mentions.channels.first();
      if (ch) c.jailChannelId = ch.id;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
      await logOwner(message, 'X!jailconfig', role ? `rôle → <@&${role.id}>${ch ? ` • salon → <#${ch.id}>` : ''}` : 'jail désactivé');
      return message.reply({ content: role ? `✅ Jail configuré : rôle **${role.name}**${ch ? ` + salon <#${ch.id}>` : ''}.` : '✅ Jail désactivé.' }).catch(() => {});
    } catch (e) { return message.reply({ content: `❌ Erreur : \`${e.message}\`` }).catch(() => {}); }
  }

  // ----- PX!warn -----
  if (low === 'px!warn' || low.startsWith('px!warn ')) {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé au staff.'));
    const arg = raw.slice('px!warn'.length).trim();
    const { user } = await fetchPMember(message, arg);
    if (!user) return message.reply({ content: 'Usage : `PX!warn <id/mention> <raison>`.' }).catch(() => {});
    if (user.id === message.author.id) return message.reply({ content: '❌ Tu ne peux pas t’avertir toi-même.' }).catch(() => {});
    if (user.id === client.user.id) return message.reply({ content: '❌ Impossible de viser le bot lui-même.' }).catch(() => {});
    if (isOwner(user.id)) return message.reply({ content: '❌ Impossible d’avertir un owner du bot.' }).catch(() => {});
    const reason = arg.replace(/<@!?\d+>/g, '').replace(/\d{15,}/, '').trim().slice(0, 500);
    if (!reason) return message.reply({ content: 'Usage : `PX!warn <id/mention> <raison>`.' }).catch(() => {});
    let wid = 0;
    try { wid = blacklist.addWarn(user.id, message.guild.id, reason, message.author.id); } catch (e) { return message.reply({ content: `❌ Warn impossible : \`${e.message}\`.` }).catch(() => {}); }
    const total = blacklist.countWarns(user.id, message.guild.id);
    await logStaff(message, 'PX!warn', `<@${message.author.id}> → <@${user.id}> (#${wid}, total ${total}) : ${reason.slice(0, 200)}`);
    return message.reply({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle('⚠️ Avertissement').setDescription(`<@${user.id}> (\`${user.id}\`)\n**Raison :** ${reason}\n**Par :** <@${message.author.id}>\n**Warn n°${wid}** — total : **${total}**`).setTimestamp()] }).catch(() => {});
  }
  // ----- PX!unwarn -----
  if (low === 'px!unwarn' || low.startsWith('px!unwarn ') || low === 'px!un-warn' || low.startsWith('px!un-warn ')) {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé au staff.'));
    const arg = raw.slice(raw.toLowerCase().split(' ')[0].length).trim();
    const { user } = await fetchPMember(message, arg);
    if (!user) return message.reply({ content: 'Usage : `PX!unwarn <id/mention> [n°]`.' }).catch(() => {});
    const nums = (arg.match(/\b\d{1,9}\b/g) || []).filter((x) => x.length < 15);
    if (nums.length) {
      const wid = parseInt(nums[nums.length - 1], 10);
      const mine = blacklist.listWarns(user.id, message.guild.id).some((w) => Number(w.id) === wid);
      if (!mine) return message.reply({ content: `❌ Warn n°${wid} introuvable pour <@${user.id}>.` }).catch(() => {});
      blacklist.removeWarn(wid);
      const total = blacklist.countWarns(user.id, message.guild.id);
      await logStaff(message, 'PX!unwarn', `<@${message.author.id}> → <@${user.id}> (warn #${wid} retiré, reste ${total})`);
      return message.reply({ content: `✅ Warn n°${wid} de <@${user.id}> retiré (reste **${total}**).` }).catch(() => {});
    }
    const count = blacklist.clearWarns(user.id, message.guild.id);
    await logStaff(message, 'PX!unwarn', `<@${message.author.id}> → <@${user.id}> (${count} warn(s) effacé(s))`);
    return message.reply({ content: count ? `✅ **${count}** warn(s) de <@${user.id}> effacé(s).` : `📭 <@${user.id}> n’avait aucun warn.` }).catch(() => {});
  }
  // ----- PX!sanction (voir les sanctions) -----
  if (low === 'px!sanction' || low.startsWith('px!sanction ') || low === 'px!sanctions' || low.startsWith('px!sanctions ') || low === 'px!sanction-liste' || low === 'px!sanctionliste' || low === 'px!warnlist' || low === 'px!warns' || low.startsWith('px!warns ')) {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé au staff.'));
    const arg = raw.slice(raw.toLowerCase().split(' ')[0].length).trim();
    const { user } = await fetchPMember(message, arg);
    if (user) {
      const list = blacklist.listWarns(user.id, message.guild.id);
      await logStaff(message, 'PX!sanction', `casier de <@${user.id}> (${list.length}) par <@${message.author.id}>`);
      if (!list.length) return message.reply({ content: `✅ <@${user.id}> n’a aucune sanction.` }).catch(() => {});
      const lines = list.slice(0, 15).map((w) => `\`#${w.id}\` — ${w.reason || 'Aucune raison'} — par <@${w.warnedBy || '?'}> — <t:${Math.floor((w.warnedAt || Date.now()) / 1000)}:R>`).join('\n').slice(0, 3900);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle(`📋 Sanctions de ${user.tag || user.id} (${list.length})`).setDescription(`<@${user.id}>\n\n${lines}`).setTimestamp()] }).catch(() => {});
    }
    const list = blacklist.listRecentWarns(message.guild.id, 10);
    await logStaff(message, 'PX!sanction', `liste (${list.length}) par <@${message.author.id}>`);
    if (!list.length) return message.reply({ content: '📭 Aucune sanction sur ce serveur.' }).catch(() => {});
    const lines = list.map((w) => `\`#${w.id}\` — <@${w.userId}> — ${(w.reason || '').slice(0, 80)} — par <@${w.warnedBy || '?'}> — <t:${Math.floor((w.warnedAt || Date.now()) / 1000)}:R>`).join('\n').slice(0, 3900);
    return message.reply({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle(`📋 Dernières sanctions (${list.length})`).setDescription(lines).setTimestamp()] }).catch(() => {});
  }
  // ----- PX!derank (miroir de x!derank, Seniors) -----
  if (low === 'px!derank' || low.startsWith('px!derank ') || low === 'px!demote' || low.startsWith('px!demote ') || low === 'px!rankdown' || low.startsWith('px!rankdown ')) {
    const execLvl = getLevel(message.member, message.author.id);
    if (!requireLevel(message.member, message.author.id, LVL.SENIOR)) return message.reply(deny('Réservé aux Seniors (niveau 20+).'));
    const arg = raw.slice(raw.toLowerCase().split(' ')[0].length).trim();
    const target = await resolveRankTarget(message, arg);
    if (!target) return message.reply({ content: 'Usage : `PX!derank @user [@rôle1 @rôle2 ...]`.' }).catch(() => {});
    if (target.id === message.guild?.ownerId || isOwner(target.id)) return message.reply({ content: '❌ Impossible de modifier un Owner.' }).catch(() => {});
    const ranks = getOrderedRanks();
    const targetLvl = getLevel(target, target.id);
    const isExecOwner = isOwner(message.author.id);
    if (!isExecOwner && execLvl <= targetLvl) return message.reply(deny('Tu ne peux pas modifier quelqu’un de ton niveau ou supérieur.'));
    const botMe = message.guild?.members.me;
    if (!botMe?.permissions?.has(PermissionFlagsBits.ManageRoles)) return message.reply({ content: '❌ Il me manque la perm **Gérer les rôles**.' }).catch(() => {});
    const chosenRoles = resolveRolesArg(message, arg);
    if (chosenRoles.length) {
      const removed = [];
      const skipped = [];
      for (const chosen of chosenRoles) {
        if (!target.roles.cache.has(chosen.id)) { skipped.push(`${chosen.name} (non possédé)`); continue; }
        try { if (chosen.position >= botMe.roles.highest.position) { skipped.push(`${chosen.name} (mon rôle trop bas)`); continue; } } catch {}
        try {
          await target.roles.remove(chosen.id);
          removed.push(`${chosen}`);
        } catch (e) { skipped.push(`${chosen.name} (${e.message})`); }
      }
      if (!removed.length) return message.reply({ content: `❌ Aucun rôle retiré.\nIgnorés : ${skipped.join(', ')}`.slice(0, 1900) }).catch(() => {});
      await logStaff(message, 'PX!derank', `<@${message.author.id}> → <@${target.id}> : -${removed.join(' -')}`);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle('⬇️ Derank').setDescription(`<@${target.id}> : ${removed.join(' ')} retiré(s) par <@${message.author.id}>.${skipped.length ? `\n\nIgnorés : ${skipped.join(', ')}` : ''}`.slice(0, 3900)).setTimestamp()] }).catch(() => {});
    }
    if (!ranks.length) return message.reply({ content: '❌ Aucune hiérarchie configurée (ajoute `hierarchy` dans config.json ou précise un rôle : `PX!derank @user @role`).' }).catch(() => {});
    let curIdx = -1;
    ranks.forEach((r, i) => { try { if (target.roles.cache.has(r.roleId)) curIdx = i; } catch {} });
    if (curIdx < 0) return message.reply({ content: `📭 <@${target.id}> n’a aucun rang (déjà Membre).` }).catch(() => {});
    const cur = ranks[curIdx];
    const nextIdx = curIdx - 1;
    try {
      await target.roles.remove(cur.roleId).catch(() => null);
      if (nextIdx < 0) {
        await logStaff(message, 'PX!derank', `<@${message.author.id}> → <@${target.id}> : **${cur.name}** retiré → Membre`);
        return message.reply({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle('⬇️ Derank').setDescription(`<@${target.id}> rétrogradé de **${cur.name}** → **Membre** par <@${message.author.id}>.`).setTimestamp()] }).catch(() => {});
      }
      const next = ranks[nextIdx];
      if (!isExecOwner && execLvl <= next.level && execLvl <= cur.level) return message.reply(deny('Niveau insuffisant pour cette rétrogradation.'));
      const role = message.guild?.roles.cache.get(next.roleId);
      if (!role) return message.reply({ content: `❌ Rôle introuvable : \`${next.roleId}\` (${next.name}).` }).catch(() => {});
      if (role.position >= botMe.roles.highest.position) return message.reply({ content: `❌ Mon rôle est trop bas pour donner ${role}.` }).catch(() => {});
      for (const r of ranks) { if (r.roleId !== next.roleId) { try { if (target.roles.cache.has(r.roleId)) await target.roles.remove(r.roleId).catch(() => null); } catch {} } }
      await target.roles.add(next.roleId);
      await logStaff(message, 'PX!derank', `<@${message.author.id}> → <@${target.id}> : **${cur.name}** → **${next.name}**`);
      return message.reply({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle('⬇️ Derank').setDescription(`<@${target.id}> rétrogradé de **${cur.name}** → **${next.name}** par <@${message.author.id}>.`).setTimestamp()] }).catch(() => {});
    } catch (e) { return message.reply({ content: `❌ Derank impossible : \`${e.message}\`` }).catch(() => {}); }
  }
  // ----- PX!role ajouter / retirer -----
  if (low === 'px!role' || low.startsWith('px!role ')) {
    if (!isOwner(message.author.id) && !message.member?.permissions?.has(PermissionFlagsBits.ManageRoles)) return message.reply(deny('Réservé aux membres pouvant gérer les rôles.'));
    const rest0 = raw.slice('px!role'.length).trim();
    const sub0 = (rest0.split(/ +/).filter(Boolean)[0] || '').toLowerCase();
    const isAdd = ['ajouter', 'ajoute', 'add', 'affecter', '+'].includes(sub0);
    const isRem = ['retirer', 'retire', 'remove', 'rem', 'del', 'enlever', '-'].includes(sub0);
    if (!isAdd && !isRem) return message.reply({ content: 'Usage : `PX!role ajouter <id/mention> <@rôle>` • `PX!role retirer <id/mention> <@rôle>`.' }).catch(() => {});
    const rest = rest0.slice(sub0.length).trim();
    const { user, member } = await fetchPMember(message, rest);
    if (!user || !member) return message.reply({ content: 'Usage : `PX!role ajouter|retirer <id/mention> <@rôle>` (membre présent sur le serveur).' }).catch(() => {});
    if (member.id === message.guild?.ownerId || isOwner(member.id)) return message.reply({ content: '❌ Impossible de modifier un Owner.' }).catch(() => {});
    let role = message.mentions.roles.first() || null;
    if (!role) {
      const rid = (rest.match(/\d{15,}/g) || []).filter((x) => x !== member.id)[0] || '';
      if (rid) role = message.guild?.roles.cache.get(rid) || await message.guild?.roles.fetch(rid).catch(() => null);
    }
    if (!role) {
      const guess = rest.replace(/<@!?\d+>/g, '').replace(/\d{15,}/g, '').trim().toLowerCase();
      if (guess) role = message.guild?.roles.cache.find((r) => r.name.toLowerCase() === guess) || null;
    }
    if (!role) return message.reply({ content: '❌ Rôle introuvable (mentionne-le, donne son ID ou son nom exact).' }).catch(() => {});
    if (role.id === message.guild.id) return message.reply({ content: '❌ Impossible de gérer @everyone.' }).catch(() => {});
    const botMe = message.guild?.members.me;
    if (!botMe?.permissions?.has(PermissionFlagsBits.ManageRoles)) return message.reply({ content: '❌ Il me manque la perm **Gérer les rôles**.' }).catch(() => {});
    if (role.position >= botMe.roles.highest.position) return message.reply({ content: `❌ Mon rôle est trop bas pour gérer ${role}.` }).catch(() => {});
    if (!isOwner(message.author.id) && role.position >= message.member.roles.highest.position) return message.reply({ content: `❌ ${role} est au-dessus de ton rôle le plus haut.` }).catch(() => {});
    if (role.permissions?.has(PermissionFlagsBits.Administrator) && !isOwner(message.author.id)) return message.reply({ content: '❌ Seul un owner peut attribuer un rôle Administrateur.' }).catch(() => {});
    try {
      if (isAdd) {
        if (member.roles.cache.has(role.id)) return message.reply({ content: `ℹ️ <@${member.id}> a déjà ${role}.` }).catch(() => {});
        await member.roles.add(role.id);
        await logStaff(message, 'PX!role', `<@${message.author.id}> → <@${member.id}> (+${role.name})`);
        return message.reply({ content: `✅ ${role} attribué à <@${member.id}>.` }).catch(() => {});
      }
      if (!member.roles.cache.has(role.id)) return message.reply({ content: `📭 <@${member.id}> n’a pas ${role}.` }).catch(() => {});
      await member.roles.remove(role.id);
      await logStaff(message, 'PX!role', `<@${message.author.id}> → <@${member.id}> (-${role.name})`);
      return message.reply({ content: `✅ ${role} retiré à <@${member.id}>.` }).catch(() => {});
    } catch (e) { return message.reply({ content: `❌ Impossible : \`${e.message}\`.` }).catch(() => {}); }
  }
  // ----- PX!serverinfo -----
  if (low === 'px!serverinfo' || low === 'px!serveurinfo' || low.startsWith('px!serverinfo ') || low.startsWith('px!serveurinfo ')) {
    const g = message.guild;
    const chans = g.channels.cache;
    const txt = chans.filter((c) => c.type === ChannelType.GuildText).size;
    const voc = chans.filter((c) => c.isVoiceBased?.()).size;
    const cat = chans.filter((c) => c.type === ChannelType.GuildCategory).size;
    const owner = await g.fetchOwner().catch(() => null);
    return message.reply({ embeds: [new EmbedBuilder().setColor('#206694').setTitle(`🏰 ${g.name}`).setThumbnail(g.iconURL({ size: 128 }) || null)
      .addFields(
        { name: '🆔 ID', value: `\`${g.id}\``, inline: true },
        { name: '👑 Propriétaire', value: owner ? `${owner.user.tag} (<@${owner.id}>)` : 'Expansion', inline: true },
        { name: '📅 Créé le', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:D> (<t:${Math.floor(g.createdTimestamp / 1000)}:R>)`, inline: true },
        { name: '👥 Membres', value: `${g.memberCount || '?'}`, inline: true },
        { name: '💬 Salons', value: `✍️ ${txt} • 🔊 ${voc} • 📁 ${cat}`, inline: true },
        { name: '🎭 Rôles', value: `${g.roles.cache.size}`, inline: true },
        { name: '😀 Émojis', value: `${g.emojis.cache.size}`, inline: true },
        { name: '💎 Boosts', value: `Niveau ${g.premiumTier} (${g.premiumSubscriptionCount || 0})`, inline: true },
        { name: '🛡️ Vérification', value: `${g.verificationLevel}`, inline: true },
      ).setFooter({ text: 'Phénix • Serverinfo' }).setTimestamp()] }).catch(() => {});
  }
  // ----- PX!userinfo -----
  if (low === 'px!userinfo' || low.startsWith('px!userinfo ') || low === 'px!user-info' || low.startsWith('px!user-info ') || low === 'px!qui' || low.startsWith('px!qui ')) {
    const arg = raw.slice(raw.toLowerCase().split(' ')[0].length).trim();
    const { user, member } = arg ? await fetchPMember(message, arg) : { user: message.author, member: message.member };
    if (!user) return message.reply({ content: 'Usage : `PX!userinfo [@user]`.' }).catch(() => {});
    const emb = new EmbedBuilder().setColor('#206694').setTitle(`👤 ${user.tag || user.id}`)
      .setThumbnail(user.displayAvatarURL ? user.displayAvatarURL({ size: 128 }) : null)
      .addFields(
        { name: '🆔 ID', value: `\`${user.id}\``, inline: true },
        { name: '🤖 Bot', value: user.bot ? 'Oui' : 'Non', inline: true },
        { name: '📅 Compte créé', value: user.createdTimestamp ? `<t:${Math.floor(user.createdTimestamp / 1000)}:D> (<t:${Math.floor(user.createdTimestamp / 1000)}:R>)` : 'Expansion', inline: true },
      );
    if (member) {
      const roles = [...member.roles.cache.values()].filter((r) => r.id !== message.guild.id).sort((a, b) => b.position - a.position);
      emb.addFields(
        { name: '📥 Arrivé le', value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D> (<t:${Math.floor(member.joinedTimestamp / 1000)}:R>)` : 'Expansion', inline: true },
        { name: `🎭 Rôles (${roles.length})`, value: roles.length ? roles.slice(0, 10).map((r) => `${r}`).join(' ') + (roles.length > 10 ? ` *+${roles.length - 10}*` : '') : '*aucun*', inline: false },
        { name: '🏆 Rôle le plus haut', value: member.roles.highest.id !== message.guild.id ? `${member.roles.highest}` : '*aucun*', inline: true },
      );
      if (member.premiumSinceTimestamp) emb.addFields({ name: '💎 Boost depuis', value: `<t:${Math.floor(member.premiumSinceTimestamp / 1000)}:R>`, inline: true });
      if (member.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now()) emb.addFields({ name: '🔇 Timeout jusqu’au', value: `<t:${Math.floor(member.communicationDisabledUntilTimestamp / 1000)}:R>`, inline: true });
    } else emb.addFields({ name: '📥 Sur le serveur', value: 'Non (ou introuvable)', inline: true });
    // --- Blacklist (f!bl) : affiche dans px!userinfo avec @/id ---
    try {
      const blRow = blacklist.getUserBlacklist ? blacklist.getUserBlacklist(user.id) : null;
      if (blRow) {
        let blProofs = [];
        try { blProofs = JSON.parse(blRow.proofs || '[]'); } catch { blProofs = []; }
        const blDate = blRow.addedAt ? `<t:${Math.floor(blRow.addedAt / 1000)}:F>` : '?';
        emb.setColor('#ff0000');
        emb.addFields({
          name: '\uD83D\uDEAB Blacklist \u2014 OUI',
          value: `<@${blRow.userId}> (\`${blRow.userId}\`)\n**Raison :** ${(blRow.reason || 'Aucune').slice(0, 500)}\n**Par :** ${blRow.addedBy ? `<@${blRow.addedBy}>` : '?'}${blProofs.length ? `\n**Preuves :** ${blProofs.length}` : ''}\n**Le :** ${blDate}`,
          inline: false,
        });
        if (blProofs[0]) emb.setImage(blProofs[0]);
      } else {
        emb.addFields({ name: '\uD83D\uDEAB Blacklist', value: '\u2705 Non blacklist\u00E9', inline: true });
      }
    } catch {}
    emb.setFooter({ text: 'Phénix • Userinfo' }).setTimestamp();
    return message.reply({ embeds: [emb] }).catch(() => {});
  }
  // ----- PX!botinfo -----
  if (low === 'px!botinfo' || low === 'px!bot-info') {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé au staff.'));
    logStaff(message, 'PX!botinfo', '');
    const up = Math.floor(process.uptime());
    const uptime = `${Math.floor(up / 86400)}j ${Math.floor(up % 86400 / 3600)}h ${Math.floor(up % 3600 / 60)}m ${up % 60}s`;
    let version = '?', djs = '?';
    try { version = require('./package.json').version || '?'; } catch {}
    try { djs = require('discord.js').version || '?'; } catch {}
    let users = 0, channels = 0;
    try { client.guilds.cache.forEach((g) => { users += g.memberCount || 0; channels += g.channels.cache.size || 0; }); } catch {}
    const me = client.user;
    return message.reply({
      embeds: [new EmbedBuilder().setColor('#206694').setTitle('🤖 Phénix Support — Botinfo').setThumbnail(me.displayAvatarURL({ size: 128 })).setDescription(`**${me.tag}** (\`${me.id}\`)`).addFields(
        { name: '📅 Créé le', value: `<t:${Math.floor(me.createdTimestamp / 1000)}:D>`, inline: true },
        { name: '⚙️ Version', value: `${version}`, inline: true },
        { name: '📚 discord.js / Node', value: `${djs} / ${process.version}`, inline: true },
        { name: '🖥️ Hébergeur', value: 'Katabump (fr-node-62)', inline: true },
        { name: '📶 Latence / Uptime', value: `${Math.round(client.ws.ping)} ms / ${uptime}`, inline: true },
        { name: '🌐 Serveurs / Salons / Membres', value: `${client.guilds.cache.size} / ${channels} / ${users}`, inline: true },
        { name: '👑 Owners', value: OWNER_IDS.map((id) => `<@${id}>`).join(' ') || '*aucun*', inline: true },
        { name: '🔤 Préfixes', value: '`px!` membre • `st!` staff • `f!` owner • `usar!` sécurité antiraid', inline: false },
        { name: '⛔ Commandes bloquées', value: 'ℹ️ *Si tu ne peux pas utiliser les commandes, c’est normal : tu as été bloqué par le(s) owner(s) du bot.*', inline: false },
      ).setFooter({ text: 'Phénix • Botinfo' }).setTimestamp()],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('TOS').setStyle(ButtonStyle.Link).setURL('https://github.com/phenixbot33/Ph-nix-l-gal/pull/1'),
      )],
    }).catch(() => {});
  }
  // ----- PX!ping -----
  if (low === 'px!ping') {
    const sent = await message.reply({ content: '🏓 Pong !' }).catch(() => null);
    const trip = sent ? Date.now() - message.createdTimestamp : null;
    logStaff(message, 'PX!ping', `${Math.round(client.ws.ping)} ms`);
    if (sent) await sent.edit({ content: `🏓 Pong ! **${Math.round(client.ws.ping)} ms**${trip !== null ? ` (aller-retour : **${trip} ms**)` : ''}` }).catch(() => {});
    return;
  }

  // ===== RGPD — Commandes de protection des données personnelles =====
  
  // ----- px!mes-donnees (voir quelles données sont stockées) -----
  if (low === 'px!mes-donnees' || low === 'px!mydata' || low === 'px!data') {
    const userId = message.author.id;
    const { counts, totalCount } = blacklist.countUserData(userId);
    
    if (totalCount === 0) {
      return message.reply({ 
        embeds: [new EmbedBuilder()
          .setColor('#2ecc71')
          .setTitle('🔒 Vos données personnelles')
          .setDescription('Aucune donnée personnelle n\'est stockée dans la base de données du bot.')
          .setFooter({ text: 'Conforme RGPD — Article 15 (Droit d\'accès)' })
          .setTimestamp()
        ]
      }).catch(() => {});
    }
    
    const lines = Object.entries(counts).map(([table, count]) => {
      const labels = {
        staff_stats: '📊 Statistiques staff',
        staff_interventions: '🎫 Interventions (tickets/SOS/questions)',
        raid_claims: '🛡️ Signalements de raids',
        tickets: '🎫 Tickets créés/traités',
        suggestions: '💡 Suggestions',
        bug_reports: '🐛 Rapports de bugs',
        bot_blacklist: '🚫 Blacklist',
        warnings: '⚠️ Avertissements',
        command_cooldowns: '⏱️ Cooldowns de commandes',
        jail_roles: '🔒 Sanctions jail',
        antinuke_whitelist: '✅ Whitelist antinuke',
        security_logs: '📝 Logs de sécurité',
      };
      return `• ${labels[table] || table} : **${count}** entrée(s)`;
    }).join('\n');
    
    return message.reply({ 
      embeds: [new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🔒 Vos données personnelles')
        .setDescription(`**Total : ${totalCount} entrée(s)** dans la base de données\n\n${lines}`)
        .addFields(
          { name: '📥 Exporter vos données', value: 'Utilisez `px!exporter-mes-donnees` pour recevoir un fichier JSON contenant toutes vos données.', inline: false },
          { name: '🗑️ Supprimer vos données', value: 'Utilisez `px!supprimer-mes-donnees` pour exercer votre droit à l\'effacement (Article 17 RGPD).', inline: false }
        )
        .setFooter({ text: 'Conforme RGPD — Article 15 (Droit d\'accès)' })
        .setTimestamp()
      ]
    }).catch(() => {});
  }

  // ----- px!exporter-mes-donnees (exporter toutes les données en JSON) -----
  if (low === 'px!exporter-mes-donnees' || low === 'px!export-mydata' || low === 'px!export') {
    const userId = message.author.id;
    const { totalCount } = blacklist.countUserData(userId);
    
    if (totalCount === 0) {
      return message.reply({ 
        embeds: [new EmbedBuilder()
          .setColor('#2ecc71')
          .setTitle('📥 Export de vos données')
          .setDescription('Aucune donnée à exporter. La base de données ne contient aucune information vous concernant.')
          .setFooter({ text: 'Conforme RGPD — Article 20 (Droit à la portabilité)' })
          .setTimestamp()
        ]
      }).catch(() => {});
    }
    
    const data = blacklist.exportUserData(userId);
    const json = JSON.stringify(data, null, 2);
    
    // Discord limite les fichiers à 8 Mo (25 Mo avec Nitro)
    if (json.length > 7 * 1024 * 1024) {
      return message.reply({ 
        embeds: [new EmbedBuilder()
          .setColor('#ff0000')
          .setTitle('📥 Export de vos données')
          .setDescription('❌ Vos données sont trop volumineuses pour être envoyées en une seule fois. Contactez un administrateur pour obtenir un export manuel.')
          .setTimestamp()
        ]
      }).catch(() => {});
    }
    
    const fs = require('fs');
    const path = require('path');
    const tempFile = path.join(__dirname, `export_${userId}_${Date.now()}.json`);
    
    try {
      fs.writeFileSync(tempFile, json, 'utf8');
      await message.reply({ 
        embeds: [new EmbedBuilder()
          .setColor('#2ecc71')
          .setTitle('📥 Export de vos données')
          .setDescription(`✅ Voici toutes les données vous concernant stockées dans la base de données du bot.\n\n**${totalCount} entrée(s)** exportée(s) au format JSON.`)
          .setFooter({ text: 'Conforme RGPD — Article 20 (Droit à la portabilité)' })
          .setTimestamp()
        ],
        files: [{ attachment: tempFile, name: `phenix_data_${userId}.json` }]
      }).catch(() => {});
      
      // Supprimer le fichier temporaire après envoi
      setTimeout(() => {
        try { fs.unlinkSync(tempFile); } catch {}
      }, 5000);
    } catch (e) {
      return message.reply({ 
        embeds: [new EmbedBuilder()
          .setColor('#ff0000')
          .setTitle('📥 Export de vos données')
          .setDescription(`❌ Erreur lors de l'export : \`${e.message}\``)
          .setTimestamp()
        ]
      }).catch(() => {});
    }
  }

  // ----- px!supprimer-mes-donnees (droit à l'effacement RGPD) -----
  if (low === 'px!supprimer-mes-donnees' || low === 'px!delete-mydata' || low === 'px!delete') {
    const userId = message.author.id;
    const { totalCount } = blacklist.countUserData(userId);
    
    if (totalCount === 0) {
      return message.reply({ 
        embeds: [new EmbedBuilder()
          .setColor('#2ecc71')
          .setTitle('🗑️ Suppression de vos données')
          .setDescription('Aucune donnée à supprimer. La base de données ne contient aucune information vous concernant.')
          .setFooter({ text: 'Conforme RGPD — Article 17 (Droit à l\'effacement)' })
          .setTimestamp()
        ]
      }).catch(() => {});
    }
    
    // Demander confirmation
    const confirmEmbed = new EmbedBuilder()
      .setColor('#f39c12')
      .setTitle('⚠️ Confirmation requise')
      .setDescription(`Vous êtes sur le point de supprimer **${totalCount} entrée(s)** de la base de données.\n\nCette action est **irréversible**. Toutes vos données personnelles seront définitivement effacées :\n• Statistiques staff\n• Tickets et interventions\n• Suggestions et rapports de bugs\n• Avertissements et sanctions\n• Logs de sécurité\n\nCliquez sur ✅ pour confirmer ou ❌ pour annuler.`)
      .setFooter({ text: 'Conforme RGPD — Article 17 (Droit à l\'effacement)' })
      .setTimestamp();
    
    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rgpd_confirm_${userId}`).setLabel('Confirmer la suppression').setStyle(ButtonStyle.Danger).setEmoji('✅'),
      new ButtonBuilder().setCustomId(`rgpd_cancel_${userId}`).setLabel('Annuler').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );
    
    const confirmMsg = await message.reply({ embeds: [confirmEmbed], components: [confirmRow] }).catch(() => null);
    
    if (!confirmMsg) return;
    
    // Attendre la réponse (30 secondes)
    const filter = (i) => i.user.id === userId && (i.customId === `rgpd_confirm_${userId}` || i.customId === `rgpd_cancel_${userId}`);
    const collector = confirmMsg.createMessageComponentCollector({ filter, time: 30000 });
    
    collector.on('collect', async (i) => {
      if (i.customId === `rgpd_cancel_${userId}`) {
        await i.update({ 
          embeds: [new EmbedBuilder()
            .setColor('#95a5a6')
            .setTitle('❌ Suppression annulée')
            .setDescription('Aucune donnée n\'a été supprimée.')
            .setTimestamp()
          ],
          components: []
        }).catch(() => {});
        collector.stop();
        return;
      }
      
      // Confirmation reçue, supprimer les données
      const { deleted, totalCount: deletedCount } = blacklist.deleteUserData(userId);
      
      await i.update({ 
        embeds: [new EmbedBuilder()
          .setColor('#2ecc71')
          .setTitle('✅ Données supprimées')
          .setDescription(`**${deletedCount} entrée(s)** ont été définitivement supprimées de la base de données.\n\nConformément à l'Article 17 du RGPD, votre droit à l'effacement a été exercé.`)
          .setFooter({ text: 'Conforme RGPD — Article 17 (Droit à l\'effacement)' })
          .setTimestamp()
        ],
        components: []
      }).catch(() => {});
      
      collector.stop();
    });
    
    collector.on('end', async (collected) => {
      if (collected.size === 0) {
        await confirmMsg.edit({ 
          embeds: [new EmbedBuilder()
            .setColor('#95a5a6')
            .setTitle('⏱️ Délai expiré')
            .setDescription('Aucune réponse reçue dans les 30 secondes. Suppression annulée.')
            .setTimestamp()
          ],
          components: []
        }).catch(() => {});
      }
    });
  }

  // ----- px!politique-confidentialite (afficher la politique de confidentialité) -----
  if (low === 'px!politique-confidentialite' || low === 'px!privacy' || low === 'px!rgpd' || low === 'px!gdpr') {
    return message.reply({ 
      embeds: [new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🔒 Politique de confidentialité — Phénix Bot')
        .setDescription('Le bot Phénix respecte votre vie privée et se conforme au Règlement Général sur la Protection des Données (RGPD).')
        .addFields(
          { name: '📋 Données collectées', value: 'Identifiants Discord, statistiques d\'utilisation, tickets, suggestions, rapports de bugs, logs de modération.', inline: false },
          { name: '⏱️ Durée de conservation', value: 'Vos données sont conservées **12 mois maximum**, puis automatiquement supprimées.', inline: false },
          { name: '🔐 Vos droits', value: '• **Accès** : `px!mes-donnees`\n• **Portabilité** : `px!exporter-mes-donnees`\n• **Effacement** : `px!supprimer-mes-donnees`', inline: false },
          { name: '📄 Document complet', value: 'Consultez la [Charte de confidentialité](https://github.com/phenixbot33/Ph-nix-l-gal/blob/main/CHARTE_DE_CONFIDENTIALITE.md) pour tous les détails.', inline: false }
        )
        .setFooter({ text: 'Conforme RGPD — Règlement UE 2016/679' })
        .setTimestamp()
      ]
    }).catch(() => {});
  }

  // ----- PX!antiraid (position + sécurité du bot, ouvert à tous) -----
  if (low === 'px!antiraid' || low === 'px!securite' || low === 'px!sécurité') {
    const g = message.guild;
    const me = g.members.me;
    const c = blacklist.getAntiraidCfg(g.id);
    const locked = await uCountLocked(g);
    const en = liveCfg().antinukeEnabled;
    const wl = blacklist.listAntinukeWhitelist(g.id);
    const rolesH = [...g.roles.cache.values()].filter((r) => r.id !== g.roles.everyone.id).sort((a, b) => b.position - a.position);
    const total = rolesH.length;
    const myIdx = me?.roles?.highest ? rolesH.findIndex((r) => r.id === me.roles.highest.id) + 1 : total;
    const rankBottom = total - myIdx + 1;
    const pct = total > 1 ? Math.max(0, Math.min(100, Math.round(((total - myIdx) / (total - 1)) * 100))) : 100;
    const top = myIdx <= 3;
    const perms = [
      ['Administrateur', PermissionFlagsBits.Administrator],
      ['Bannir', PermissionFlagsBits.BanMembers],
      ['Expulser', PermissionFlagsBits.KickMembers],
      ['Gérer rôles', PermissionFlagsBits.ManageRoles],
      ['Gérer salons', PermissionFlagsBits.ManageChannels],
      ['Modérer membres', PermissionFlagsBits.ModerateMembers],
      ['Supprimer messages', PermissionFlagsBits.ManageMessages],
      ['Logs du serveur', PermissionFlagsBits.ViewAuditLog],
    ];
    const permTxt = perms.map(([n, p]) => `${me?.permissions?.has(p) ? '✅' : '❌'} ${n}`).join(' • ');
    const posTxt = top
      ? '🟢 **Mon rôle est bien placé en haut** — action à pleine capacité.'
      : `⚠️ **Demande de monter le bot tout en haut !** Mon rôle est en position **${rankBottom}/${total} depuis le bas** (rang #${myIdx} depuis le haut, ${pct}% du sommet).\nPlace le rôle Phénix **au-dessus des autres rôles** pour que l'antiraid / antinuke / sanctions fonctionnent pleinement.`;
    const secs = top
      ? [
          `**⚔️ Antiraid (ici) :** ${c.enabled ? '🟢 Activé' : '🔴 Désactivé'} — flood : ${c.joinsLimit}/${c.joinsWindow}s • âge mini : ${c.minAccountAge || 0}j`,
          `**☢️ Antinuke (global) :** ${en ? '🟢 Activé' : '🔴 Désactivé'} — >3 suppressions/60s → ban auto${wl.length ? ` • whitelist : ${wl.length}` : ''}`,
          `**🚨 Emergency (ici) :** ${locked ? `🔴 ${locked} salon(s) verrouillé(s)` : '🟢 normal'}`,
        ]
      : [
          `**⚔️ Antiraid (ici) :** 🔴 Inactivé — le bot n’est pas tout en haut`,
          `**☢️ Antinuke (global) :** 🔴 Inactivé — le bot n’est pas tout en haut`,
          `**🚨 Emergency (ici) :** 🔴 Inactivé — le bot n’est pas tout en haut`,
          `*👉 Monte le rôle Phénix tout en haut pour activer les sécurités.*`,
        ];
    logStaff(message, 'PX!antiraid', `par <@${message.author.id}> — position ${myIdx}/${total}`);
    return message.reply({ embeds: [new EmbedBuilder().setColor(top ? '#2ecc71' : '#ffa500').setTitle('🛡️ Phénix — Position & Sécurité').setDescription(
      `**📍 Position :** ${posTxt}\n\n` +
      `**🧩 Capacités :**\n${permTxt}\n\n` +
      `**🛡️ Sécurité active :**\n${secs.join('\n')}`
    ).setFooter({ text: 'Phénix • Sécurité' }).setTimestamp()] }).catch(() => {});
  }
  // ----- PX!support -----
  if (low === 'px!support' || low === 'px!aide') {
    logStaff(message, 'PX!support', `par <@${message.author.id}>`);
    let invite = '';
    try { invite = liveCfg().supportInvite || cfg.supportInvite || ''; } catch { invite = cfg.supportInvite || ''; }
    if (!invite) invite = 'https://discord.gg/RYy6NUYS2';
    return message.reply({ embeds: [new EmbedBuilder().setColor('#206694').setTitle('🆘 Phénix — Support').setDescription('Besoin d’aide ? Voici comment faire :')
      .addFields(
        { name: '🎫 Ouvrir un ticket', value: `Rend-toi dans <#${PANEL_CHANNEL}> et clique sur **Ticket** — un salon privé s’ouvre avec le staff.`, inline: false },
        { name: '💡 Proposer une idée', value: '`PX!suggestion <ton idée>` ou clique sur **Suggérer** dans le panneau suggestions.', inline: false },
        { name: '🐛 Signaler un bug', value: '`px!bug <décris le bug>` — envoyé direct aux développeurs.', inline: false },
        { name: '🔗 Serveur support', value: invite, inline: false },
      )
      .setFooter({ text: 'Phénix • Support' }).setTimestamp()] }).catch(() => {});
  }
  // ----- PX!embed -----
  if (low === 'px!embed' || low.startsWith('px!embed ')) {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé au staff.'));
    let rest = raw.slice('px!embed'.length).trim();
    let targetCh = message.channel;
    const m = rest.match(/<#(\d{15,})>/);
    if (m) {
      const ch = message.guild.channels.cache.get(m[1]) || await message.guild.channels.fetch(m[1]).catch(() => null);
      if (!ch?.isTextBased?.()) return message.reply({ content: '❌ Salon texte introuvable sur ce serveur.' }).catch(() => {});
      targetCh = ch;
      rest = rest.replace(m[0], '').trim();
    }
    if (!rest) return message.reply({ content: 'Usage : `PX!embed [#salon] [titre |] <texte>`.' }).catch(() => {});
    let title = '', text = rest;
    const sep = rest.indexOf('|');
    if (sep > 0) {
      const t = rest.slice(0, sep).trim().slice(0, 200);
      const d = rest.slice(sep + 1).trim();
      if (t && d) { title = t; text = d; }
    }
    if (text.length > 3900) return message.reply({ content: '❌ Texte trop long (3900 caractères max).' }).catch(() => {});
    const emb = new EmbedBuilder().setColor('#206694').setDescription(text).setFooter({ text: 'Phénix' }).setTimestamp();
    if (title) emb.setTitle(title.slice(0, 256));
    try {
      await targetCh.send({ embeds: [emb] });
    } catch (e) { return message.reply({ content: `❌ Envoi impossible : \`${e.message}\`.` }).catch(() => {}); }
    await logStaff(message, 'PX!embed', `<@${message.author.id}> → #${targetCh.name || targetCh.id} : ${text.slice(0, 200)}`);
    try { await message.delete().catch(() => null); } catch {}
    if (targetCh.id !== message.channel.id) return message.reply({ content: `✅ Embed envoyé dans <#${targetCh.id}>.` }).catch(() => {});
    return;
  }
  // ----- PX!bump (remonte le panneau ticket ici) -----
  if (low === 'px!bump') {
    if (!canUseCommands(message.member, message.author.id)) return message.reply(deny('Réservé au staff.'));
    logStaff(message, 'PX!bump', `#${message.channel?.name || message.channel.id}`);
    try {
      await message.channel.send({ embeds: [ticketOnlyPanelEmbed()], components: ticketOnlyPanelRows() });
    } catch (e) { return message.reply({ content: `❌ Impossible de poster ici : \`${e.message}\`` }).catch(() => {}); }
    try { await message.delete().catch(() => null); } catch {}
    return;
  }
  // ----- PX!report (signaler un membre au staff, ouvert à tous) -----
  if (low === 'px!report' || low.startsWith('px!report ') || low === 'px!signaler' || low.startsWith('px!signaler ')) {
    const arg = raw.slice(raw.toLowerCase().split(' ')[0].length).trim();
    const { user } = await fetchPMember(message, arg);
    if (!user) return message.reply({ content: 'Usage : `PX!report <id/mention> <raison>`.' }).catch(() => {});
    if (blacklist.isBotBlacklisted(message.author.id)) return message.reply({ content: '🚫 Bot blacklisté.' }).catch(() => {});
    const reason = arg.replace(/<@!?\d+>/g, '').replace(/\d{15,}/, '').trim().slice(0, 1000);
    if (reason.length < 5) return message.reply({ content: 'Usage : `PX!report <id/mention> <raison>` (5 caractères min).' }).catch(() => {});
    const proofs = [...(message.attachments?.values() || [])].map((a) => a.url).slice(0, 5);
    logStaff(message, 'PX!report', `par <@${message.author.id}> contre <@${user.id}> — ${reason.slice(0, 200)}`);
    const emb = new EmbedBuilder().setColor('#ff0000').setTitle('🚨 Signalement').setDescription(`**Visé :** <@${user.id}> (\`${user.id}\`)\n**Par :** <@${message.author.id}> (${message.author.tag})\n**Salon :** <#${message.channel.id}>\n\n**Raison :**\n${reason.slice(0, 3500)}${proofs.length ? `\n\n**Preuves :** ${proofs.length} pièce(s) jointe(s)` : ''}`).setTimestamp();
    if (proofs[0]) emb.setImage(proofs[0]);
    try {
      const ch = await getChannel(REPORT_CHANNEL_ID).catch(() => null);
      if (!ch?.isTextBased?.()) throw new Error('salon signalements injoignable');
      const reportRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rpret:${message.author.id}`).setLabel('✅ Accepter').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`rpref:${message.author.id}`).setLabel('❌ Refuser').setStyle(ButtonStyle.Danger),
      );
      await ch.send({ embeds: [emb], components: [reportRow] });
    } catch (e) { return message.reply({ content: `❌ Envoi impossible : \`${e.message}\`.` }).catch(() => {}); }
    return message.reply({ content: '✅ Signalement transmis au staff, merci.' }).catch(() => {});
  }
  // ----- PX!sos / PX!raid (alerte dans le salon dédié, SANS stats) -----
  if (low === 'px!sos' || low.startsWith('px!sos ') || low === 'px!raid' || low.startsWith('px!raid ')) {
    const kind = low.startsWith('px!raid') ? 'raid' : 'sos';
    if (!requireLevel(message.member, message.author.id, LVL.STAFF)) return message.reply(deny('Réservé au staff.'));
    const cd = onCooldown(message.author.id, 'p' + kind);
    if (cd) return message.reply({ content: `⏳ Patiente **${cd}s**.` }).catch(() => {});
    const detail = raw.slice(kind === 'raid' ? 'px!raid'.length : 'px!sos'.length).trim().slice(0, 1000);
    if (!detail) return message.reply({ content: kind === 'raid' ? 'Usage : `PX!raid <détail du raid>`.' : 'Usage : `PX!sos <détail>`.' }).catch(() => {});
    markSent(message.author.id, 'p' + kind);
    let destId = kind === 'raid' ? RAID_ALERT_CHANNEL_ID : SOS_ALERT_CHANNEL_ID;
    try { if (!destId) destId = liveCfg().channels?.[kind] || cfg.channels?.[kind] || ''; } catch {}
    const dest = destId ? (client.channels.cache.get(destId) || await client.channels.fetch(destId).catch(() => null)) : null;
    const target = dest?.isTextBased?.() ? dest : message.channel;
    const staffRole = liveStaffRoleId();
    const emoji = kind === 'raid' ? '🛡️' : '🚨';
    const emb = new EmbedBuilder().setColor(kind === 'raid' ? '#ff0000' : '#ffa500')
      .setTitle(`${emoji} ALERTE ${kind.toUpperCase()}`)
      .setDescription(
        kind === 'raid'
          ? `**Déclenché par :** ${message.author.tag} ( \`${message.author.id}\` )\n` +
            `**Serveur :** ${message.guild.name} ( \`${message.guild.id}\` )\n` +
            `**Salon :** <#${message.channel.id}>\n` +
            `**Raison :** ${detail.slice(0, 3500)}\n` +
            `**Date :** <t:${Math.floor(Date.now() / 1000)}:F>`
          : `**Utilisateur :** ${message.author.tag} ( \`${message.author.id}\` )\n` +
            `**Serveur :** ${message.guild.name} ( \`${message.guild.id}\` )\n` +
            `**Salon :** <#${message.channel.id}>\n` +
            `**Raison :** ${detail.slice(0, 3500)}\n` +
            `**Date :** <t:${Math.floor(Date.now() / 1000)}:F>`
      )
      .setFooter({ text: 'Phénix • Alerte' }).setTimestamp();
    const alertId = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`;
    blacklist.createIntervention(alertId, kind, message.guild.id, message.author.id, message.author.tag, detail);
    try {
      const sent = await target.send({ ...(staffRole ? { content: `<@&${staffRole}>` } : {}), embeds: [emb], components: alertRow(alertId, 'open') });
      blacklist.setInterventionMessage(alertId, sent?.id || '', target.id);
    } catch (e) { return message.reply({ content: `❌ Alerte impossible : \`${e.message}\`.` }).catch(() => {}); }
    logStaff(message, 'PX!' + kind, `${emoji} alerte de <@${message.author.id}> → #${target.name || target.id} : ${detail.slice(0, 200)}`);
    try { await message.delete().catch(() => null); } catch {}
    if (target.id !== message.channel.id) return message.reply({ content: `✅ Alerte ${kind.toUpperCase()} envoyée dans <#${target.id}>.` }).catch(() => {});
    return;
  }
  // ----- PX!suggestion (ouvert à tous, comme le panneau) -----
  if (low === 'px!suggestion' || low.startsWith('px!suggestion ') || low === 'px!suggest' || low.startsWith('px!suggest ') || low === 'px!idee' || low.startsWith('px!idee ') || low === 'px!idée' || low.startsWith('px!idée ')) {
    const text = raw.slice(raw.toLowerCase().split(' ')[0].length).trim();
    if (text.length < 5) return message.reply({ content: 'Usage : `PX!suggestion <ton idée>` (5 caractères min).' }).catch(() => {});
    if (text.length > 1000) return message.reply({ content: '❌ Suggestion trop longue (1000 caractères max).' }).catch(() => {});
    if (blacklist.isBotBlacklisted(message.author.id)) return message.reply({ content: '🚫 Bot blacklisté.' }).catch(() => {});
    const sid = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`;
    blacklist.createSuggestion(sid, message.guild.id, message.author.id, message.author.tag, text);
    logStaff(message, 'PX!suggestion', `par <@${message.author.id}> — ${text.slice(0, 200)}`);
    try {
      const sent = await message.channel.send({ content: `<@&${SUGGEST_PING_ROLE_ID}>`, embeds: [suggestEmbed(message.author, text)], components: suggestRows(sid, false) });
      blacklist.setSuggestionMessage(sid, message.channel.id, sent?.id || '');
    } catch (e) { return message.reply({ content: `❌ Publication impossible : \`${e.message}\`` }).catch(() => {}); }
    try { await message.delete().catch(() => null); } catch {}
    return;
  }
});

// ----- Anti-Raid auto : blacklist entrants + serveurs blacklistés -----
client.on('guildMemberAdd', async (member) => {
  try {
    if (blacklist.isAntiraidDisabled?.(member.guild.id)) return;
    const row = blacklist.getUserBlacklist?.(member.id);
    if (!row) return;
    console.log(`[ANTIRAID] ⛔ blacklisté rejoint : ${member.user.tag} (${member.id}) sur ${member.guild.name}`);
    try {
      const me = member.guild.members.me || await member.guild.members.fetchMe().catch(() => null);
      if (me?.permissions?.has(PermissionFlagsBits.BanMembers)) {
        await member.ban({ reason: `Blacklist Phénix : ${row.reason || ''}`.slice(0, 500) }).catch(() => null);
        return;
      }
      if (me?.permissions?.has(PermissionFlagsBits.KickMembers)) await member.kick(`Blacklist Phénix : ${row.reason || ''}`.slice(0, 500)).catch(() => null);
    } catch {}
    try {
      const ch = await getChannel(staffLogChannelId()).catch(() => null);
      if (ch?.isTextBased?.()) await ch.send({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('⛔ Blacklisté détecté').setDescription(`<@${member.id}> (\`${member.id}\`)\n**Serveur :** ${member.guild.name}\n**Raison :** ${row.reason || 'Aucune'}`).setTimestamp()] }).catch(() => {});
    } catch {}
  } catch {}
});
// 🔒 Jail : ré-application du rôle prison si un prisonnier quitte et revient
client.on('guildMemberAdd', async (member) => {
  try {
    const j = blacklist.getJail(member.guild.id, member.id);
    if (!j) return;
    const jailRoleId = liveCfg().jailRoleId || '';
    if (jailRoleId && member.guild.roles.cache.get(jailRoleId)) {
      await member.roles.set([jailRoleId], 'Jail Phénix — prisonnier revenu').catch(() => {});
      const jcId = liveCfg().jailChannelId || '';
      if (jcId) {
        const jc = member.guild.channels.cache.get(jcId);
        if (jc?.isTextBased?.()) { try { await jc.permissionOverwrites.edit(member.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {}); } catch {} }
      }
    }
  } catch {}
});
// 🎉 Annonce fondation Phénix : un membre haut gradé (rôle fondation) rejoint un serveur
const FOUNDATION_ROLE_IDS = ['1544740852176388176', '1544740845385941123', '1546152812680052889', '1544740839253868544', '1550384681822982237'];
client.on('guildMemberAdd', async (member) => {
  try {
    const fg = client.guilds.cache.get(liveCfg().guildId || '1544740490199695360');
    if (!fg || fg.id === member.guild.id) return;
    const fm = await fg.members.fetch(member.id).catch(() => null);
    if (!fm || !FOUNDATION_ROLE_IDS.some((r) => fm.roles.cache.has(r))) return;
    const me = member.guild.members.me || await member.guild.members.fetchMe().catch(() => null);
    const canSend = (c) => me && c?.type === ChannelType.GuildText && c.permissionsFor(me)?.has?.(PermissionFlagsBits.SendMessages);
    const target = canSend(member.guild.systemChannel) ? member.guild.systemChannel
      : member.guild.channels.cache.filter((c) => c.type === ChannelType.GuildText).sort((a, b) => a.rawPosition - b.rawPosition).find((c) => canSend(c));
    if (!target) return;
    const icon = fg.iconURL({ size: 512 }) || client.user.displayAvatarURL({ size: 512 });
    await target.send({ embeds: [new EmbedBuilder().setColor('#00e5ff').setTitle('👑 Membre de la fondation Phénix en vue !').setDescription(
      `Accrochez-vous ${member} vient de faire son entrée - une personne haut gradé en chair et en os.\n\n` +
      `Une question, un bug, une idée ? C'est le bon moment pour lui en parler.\n` +
      `🙏 Petit rappel : on évite le spam et les pings en boucle.\n\n` +
      `Oubliez pas, c'est un humain comme les autres, pas un robot.`
    ).setThumbnail(icon).setTimestamp()] }).catch(() => {});
  } catch {}
});
client.on('guildCreate', async (guild) => {
  try {
    const row = blacklist.getServerBlacklist?.(guild.id);
    if (!row) return;
    console.log(`[ANTIRAID] ⛔ serveur blacklisté rejoint : ${guild.name} (${guild.id}) — départ`);
    try { await guild.leave(); } catch {}
  } catch {}
});

// 🌐 Nouveau serveur ajouté → annonce dans le salon dédié
client.on('guildCreate', async (guild) => {
  try {
    const ch = await getChannel('1544740924419088517');
    if (!ch?.isTextBased?.()) return;
    const owner = guild.ownerId ? await client.users.fetch(guild.ownerId).catch(() => null) : null;
    const nm = guild.premiumTier, nb = guild.premiumSubscriptionCount || 0;
    const nf = { name: '', value: '', inline: true };
    await ch.send({ embeds: [new EmbedBuilder().setColor('#2ecc71').setTitle('📈 Nouveau serveur ajouté').addFields(
      { ...nf, name: '🏷️ Nom', value: String(guild.name || '?').slice(0, 100) },
      { ...nf, name: '🆔 ID', value: `\`${guild.id}\`` },
      { ...nf, name: '👑 Propriétaire', value: owner ? `${owner.tag} (\`${owner.id}\`)` : `<@${guild.ownerId}>` },
      { ...nf, name: '👥 Membres', value: `${guild.memberCount}`, inline: true },
      { ...nf, name: '💬 Salons', value: `${guild.channels.cache.size}`, inline: true },
      { ...nf, name: '🎭 Rôles', value: `${guild.roles.cache.size}`, inline: true },
      { ...nf, name: '🚀 Boosts', value: `Niveau ${nm} (${nb})`, inline: true },
      { ...nf, name: '🗓️ Créé le', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true },
      { ...nf, name: '🌐 Total serveurs', value: `${client.guilds.cache.size}`, inline: true },
      { ...nf, name: '👤 Total utilisateurs', value: `${[...client.guilds.cache.values()].reduce((a, g) => a + (g.memberCount || 0), 0)}`, inline: true },
    ).setFooter({ text: 'Phénix Anti-Raid' }).setTimestamp()] });
  } catch {}
});

// ----- Log déconnexion / déplacement du bot de la voc (qui l'a fait ?) -----
client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    if (!client.user || newState.member?.id !== client.user.id) return;
    const oldId = oldState.channelId, newId = newState.channelId;
    if (oldId && !newId) {
      const oldCh = oldState.channel || await newState.guild.channels.fetch(oldId).catch(() => null) || newState.guild.channels.cache.get(oldId);
      const exec = await findVocExecutor(newState.guild, client.user.id, [AuditLogEvent.MemberDisconnect, AuditLogEvent.MemberMove]);
      console.log(`[VOC] ⚠️ déconnecté de ${oldId} par ${exec ? exec.tag : 'inconnu'}`);
      await sendVocLog(new EmbedBuilder().setColor('#ff0000').setTitle('🔌 Bot déconnecté de la voc')
        .setDescription(`**Salon :** ${oldCh ? `#${oldCh.name} (\`${oldId}\`)` : `\`${oldId}\``}\n**Par :** ${exec ? `${exec} (\`${exec.id}\`)` : '*inconnu (retrait manuel ou expiration)*'}`)
        .setTimestamp());
    } else if (oldId && newId && oldId !== newId) {
      const exec = await findVocExecutor(newState.guild, client.user.id, [AuditLogEvent.MemberMove]);
      console.log(`[VOC] ⚠️ déplacé de ${oldId} vers ${newId} par ${exec ? exec.tag : 'inconnu'}`);
      await sendVocLog(new EmbedBuilder().setColor('#ffa500').setTitle('🔀 Bot déplacé de voc')
        .setDescription(`**De :** \`${oldId}\`\n**Vers :** <#${newId}>\n**Par :** ${exec ? `${exec} (\`${exec.id}\`)` : '*inconnu*'}`)
        .setTimestamp());
    }
  } catch {}
});

// ============================================================
// INTERACTIONS (tickets + stats + raid/sos/question)
// ============================================================
client.on('interactionCreate', async (interaction) => {
  // --- Menu f!activite : choix du type d'activité (réservé à l'owner qui a lancé la commande) ---
  // --- Menu d'aide par catégories (f!help, x!help, st!help, px!help, usar!help) ---
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('helpmenu:')) {
    const [, pk, authorId] = interaction.customId.split(':');
    if (interaction.user.id !== authorId) return interaction.reply({ content: '❌ Menu réservé à celui qui a lancé la commande.', ephemeral: true }).catch(() => {});
    const data = HELP_MENU[pk];
    const cat = data?.cats.find((c) => c.id === interaction.values[0]);
    if (!data || !cat) return interaction.deferUpdate().catch(() => {});
    const emb = withCmdCount(new EmbedBuilder().setColor(data.color).setTitle(`${cat.emoji} ${cat.name}`).setDescription(cat.cmds.join('\n')).setFooter({ text: `${data.footer} • Choisis une autre catégorie dans le menu` }).setTimestamp(), data.pat);
    return interaction.update({ embeds: [emb] }).catch(() => {});
  }
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('factiv:')) {
    const wanted = interaction.customId.split(':')[1];
    if (interaction.user.id !== wanted) {
      return interaction.reply({ content: '🔒 Réservé à l’owner qui a lancé la commande.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    const choice = interaction.values[0];
    try { await interaction.message.delete(); } catch {}
    if (!interaction.channel?.isTextBased?.()) return interaction.reply({ content: '❌ Salon invalide.', flags: MessageFlags.Ephemeral }).catch(() => {});
    if (choice === 'off') {
      const cur = getBotPresence();
      saveBotPresence(cur.status, '', 'custom');
      await applyBotPresence(cur.status, '', '');
      return interaction.reply({ content: '✅ Activité retirée.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    const typeName = { custom: '💬 Texte libre', 0: '🎮 Joue à', 3: '📺 Regarde', 2: '🎧 Écoute', 5: '🏆 Participe à', 1: '📡 En direct' }[choice] || choice;
    await interaction.reply({ content: `✍️ **${typeName}** — écris maintenant le texte de l’activité (60s, \`annuler\` pour abandonner)…`, flags: MessageFlags.Ephemeral }).catch(() => {});
    const collector = interaction.channel.createMessageCollector({ filter: (mm) => mm.author.id === wanted, time: 60000, max: 1 });
    collector.on('collect', async (mm) => {
      const txt = mm.content.trim();
      try { await mm.delete(); } catch {}
      if (/^annuler$/i.test(txt)) {
        await interaction.editReply({ content: '❌ Annulé.' }).catch(() => {});
        return;
      }
      if (!txt) { await interaction.editReply({ content: '❌ Texte vide — annulé.' }).catch(() => {}); return; }
      saveBotPresence(getBotPresence().status, txt, choice === 'custom' ? 'custom' : choice);
      await applyBotPresence(getBotPresence().status, txt, choice === 'custom' ? 'custom' : choice);
      await interaction.editReply({ content: `✅ Activité : ${activityLine({ state: txt, type: choice === 'custom' ? 4 : Number(choice) })}` }).catch(() => {});
    });
    collector.on('end', (c, reason) => {
      if (reason === 'time') interaction.editReply({ content: '⏱️ Temps écoulé — annulé.' }).catch(() => {});
    });
    return;
  }
  // --- Boutons signalement (accepter / refuser → MP au rapporteur) ---
  if (interaction.isButton() && (interaction.customId.startsWith('rpret:') || interaction.customId.startsWith('rpref:'))) {
    const [kind, reporterId] = interaction.customId.split(':');
    const REPORT_DECISION_ROLE_IDS = ['1546152812680052889', '1544740839253868544', '1550384681822982237'];
    const mem = interaction.member;
    const isStaff = REPORT_DECISION_ROLE_IDS.some((r) => mem?.roles?.cache?.has?.(r)) || isOwner(interaction.user.id);
    if (!isStaff) return interaction.reply({ content: '🔒 Réservé aux grades habilités.', flags: MessageFlags.Ephemeral }).catch(() => {});
    const accepted = kind === 'rpret';
    const origDesc = interaction.message.embeds[0]?.description || '';
    const visedLine = (origDesc.match(/\*\*Visé :\*\* .+/) || [''])[0];
    const emb = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(accepted ? '#2ecc71' : '#95a5a6')
      .addFields({ name: accepted ? '✅ Décision' : '❌ Décision', value: `${accepted ? 'Signalement **accepté**' : 'Signalement **refusé**'} par <@${interaction.user.id}>` });
    try {
      await interaction.message.edit({ embeds: [emb], components: [] });
    } catch {}
    let dmOk = true;
    try {
      const reporter = await client.users.fetch(reporterId);
      await reporter.send({ embeds: [new EmbedBuilder().setColor(accepted ? '#2ecc71' : '#95a5a6').setTitle(accepted ? '✅ Signalement accepté' : '❌ Signalement refusé').setDescription(
        accepted
          ? `Ton signalement a été **accepté** par le staff Phénix ! 🎉\n${visedLine}\n\nMerci de nous aider à garder le support sain.`
          : `Ton signalement a été **refusé** par le staff Phénix (pas de suite donnée).\n${visedLine}\n\n*Rappelle-toi de signaler seulement les vrais problèmes (spam, insultes, comportements toxiques…).*`
      ).setTimestamp()] });
    } catch { dmOk = false; }
    logOwner(interaction, accepted ? 'Report accepté' : 'Report refusé', `par <@${interaction.user.id}> → MP à <@${reporterId}>${dmOk ? '' : ' (MP impossible)'}`);
    return interaction.reply({ content: `✅ Signalement ${accepted ? 'accepté' : 'refusé'}${dmOk ? ` — MP envoyé à <@${reporterId}>.` : ` — ⚠️ MP impossible (MPs fermés)`}.`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  // --- Modal création ticket ---
  if (interaction.isModalSubmit() && interaction.customId === TICKET_MODAL_ID) {
    try {
      if (blacklist.isBotBlacklisted(interaction.user.id)) return interaction.reply({ content: '🚫 Bot blacklisté.', flags: MessageFlags.Ephemeral }).catch(() => {});
      const guild = interaction.guild;
      if (!guild) return interaction.reply({ content: '❌ Les tickets doivent être ouverts depuis un serveur.', flags: MessageFlags.Ephemeral }).catch(() => {});
      const reason = (interaction.fields.getTextInputValue(TICKET_REASON_FIELD) || '').slice(0, 1000);
      const existing = await resolveLiveTicket(guild, interaction.user.id);
      if (existing) return interaction.reply({ content: `⚠️ Tu as déjà un ticket ouvert : <#${existing.channelId}>`, flags: MessageFlags.Ephemeral }).catch(() => {});
      if (blacklist.countOpenTicketsByUser(interaction.user.id, guild.id) >= maxTicketsPerUser()) {
        return interaction.reply({ content: `⚠️ Limite atteinte (${maxTicketsPerUser()} ticket(s) max).`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
      let channel;
      try {
        channel = await createTicketNow(guild, interaction.user, reason);
      } catch (e) {
        return interaction.editReply({ content: `❌ Impossible de créer le salon : \`${e.message}\`` }).catch(() => {});
      }
      logStaff(interaction, '🎫 TICKET OUVERT', `<#${channel.id}> par <@${interaction.user.id}> — ${reason.slice(0, 200)}`);
      return interaction.editReply({ content: `✅ Ticket créé : **#${channel.name}** → <#${channel.id}>` }).catch(() => {});
    } catch (e) {
      console.error('[TICKET] modal error', e);
      try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: `❌ Erreur : \`${e.message}\``, flags: MessageFlags.Ephemeral }); else await interaction.editReply({ content: `❌ Erreur : \`${e.message}\`` }); } catch {}
      return;
    }
  }

  // --- Modal suggestion ---
  if (interaction.isModalSubmit() && interaction.customId === SUGGEST_MODAL_ID) {
    try {
      const guild = interaction.guild;
      if (!guild) return interaction.reply({ content: '❌ Propose ta suggestion depuis le serveur.', flags: MessageFlags.Ephemeral }).catch(() => {});
      if (blacklist.isBotBlacklisted(interaction.user.id)) return interaction.reply({ content: '🚫 Bot blacklisté.', flags: MessageFlags.Ephemeral }).catch(() => {});
      const text = (interaction.fields.getTextInputValue(SUGGEST_TEXT_FIELD) || '').slice(0, 1000);
      if (text.trim().length < 5) return interaction.reply({ content: '❌ Suggestion trop courte (5 caractères min).', flags: MessageFlags.Ephemeral }).catch(() => {});
      const sid = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`;
      blacklist.createSuggestion(sid, guild.id, interaction.user.id, interaction.user.tag, text);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
      let sent = null;
      try {
        sent = await interaction.channel.send({ content: `<@&${SUGGEST_PING_ROLE_ID}>`, embeds: [suggestEmbed(interaction.user, text)], components: suggestRows(sid, false) });
        blacklist.setSuggestionMessage(sid, interaction.channelId, sent?.id || '');
      } catch (e) {
        return interaction.editReply({ content: `❌ Envoi impossible : \`${e.message}\`` }).catch(() => {});
      }
      logStaff(interaction, '💡 SUGGESTION', `par <@${interaction.user.id}> — ${text.slice(0, 200)}`);
      return interaction.editReply({ content: `✅ Suggestion envoyée !` }).catch(() => {});
    } catch (e) {
      console.error('[SUGGEST] modal error', e);
      try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: `❌ Erreur : \`${e.message}\``, flags: MessageFlags.Ephemeral }); else await interaction.editReply({ content: `❌ Erreur : \`${e.message}\`` }); } catch {}
      return;
    }
  }

  if (!interaction.isButton()) return;

  // --- Blacklist bots : bloque tous les boutons (stats, tickets, claim...) ---
  try { if (blacklist.isBotBlacklisted(interaction.user.id)) return interaction.reply({ content: '🚫 Bot blacklisté.', flags: MessageFlags.Ephemeral }).catch(() => {}); } catch {}

  // --- Validation d'une demande st!admin (Oui/Non) : admins du serveur ou owners du bot ---
  if (interaction.customId.startsWith('permadmin_confirm:') || interaction.customId.startsWith('permadmin_cancel:')) {
    const isConfirm = interaction.customId.startsWith('permadmin_confirm:');
    const reqId = interaction.customId.split(':')[1];
    let canValidate = isOwner(interaction.user.id);
    try {
      if (!canValidate && interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) canValidate = true;
    } catch {}
    if (!canValidate) return interaction.reply({ content: '❌ Réservé aux administrateurs du serveur et aux owners du bot.', flags: MessageFlags.Ephemeral }).catch(() => {});
    const req = pendingPermAdmin.get(reqId);
    if (!req) return interaction.reply({ content: '⚠️ Demande expirée ou déjà traitée.', flags: MessageFlags.Ephemeral }).catch(() => {});
    if (Date.now() - req.createdAt > PERMADMIN_TIMEOUT_MS) { pendingPermAdmin.delete(reqId); return interaction.reply({ content: '⚠️ Demande expirée.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
    pendingPermAdmin.delete(reqId);
    try { await interaction.message.edit({ components: permAdminRows(reqId, true) }).catch(() => {}); } catch {}
    const guild = interaction.guild || await client.guilds.fetch(req.guildId).catch(() => null);
    if (!isConfirm) {
      await logMod(interaction, 'st!admin', `❌ demande refusée par <@${interaction.user.id}> : <@${req.requesterId}> → ${req.roleName}`);
      try {
        const asker = await client.users.fetch(req.requesterId).catch(() => null);
        if (asker) await asker.send({ content: `❌ Ta demande de perms (${req.roleName}) a été **refusée** par <@${interaction.user.id}>.` }).catch(() => {});
      } catch {}
      return interaction.reply({ content: '❌ Demande refusée.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    try {
      if (!guild) throw new Error('serveur introuvable');
      const member = guild.members.cache.get(req.requesterId) || await guild.members.fetch(req.requesterId).catch(() => null);
      if (!member) throw new Error('membre introuvable (a quitté ?)');
      const role = guild.roles.cache.get(req.roleId) || await guild.roles.fetch(req.roleId).catch(() => null);
      if (!role) throw new Error('rôle introuvable (supprimé ?)');
      const botMe = guild.members.me;
      if (!botMe?.permissions?.has(PermissionFlagsBits.ManageRoles)) throw new Error('il me manque Gérer les rôles');
      if (role.position >= botMe.roles.highest.position) throw new Error('mon rôle est trop bas');
      if (member.roles.cache.has(role.id)) {
        await logMod(interaction, 'st!admin', `ℹ️ <@${req.requesterId}> avait déjà ${role.name} (validé par <@${interaction.user.id}>)`);
        return interaction.reply({ content: `ℹ️ <@${req.requesterId}> a déjà ${role}.`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      await member.roles.add(role.id);
      await logMod(interaction, 'st!admin', `✅ ${role.name} attribué à <@${req.requesterId}> (validé par <@${interaction.user.id}>)`);
      try {
        const asker = await client.users.fetch(req.requesterId).catch(() => null);
        if (asker) await asker.send({ content: `✅ Ta demande de perms a été **acceptée** : tu as reçu le rôle **${role.name}** !` }).catch(() => {});
      } catch {}
      return interaction.reply({ content: `✅ ${role.name} attribué à <@${req.requesterId}>.`, flags: MessageFlags.Ephemeral }).catch(() => {});
    } catch (e) {
      await logMod(interaction, 'st!admin', `❌ échec attribution : \`${e.message}\``, { success: false });
      return interaction.reply({ content: `❌ Impossible d’attribuer : \`${e.message}\``, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }

  // --- Bugs : bouton Résolu (staff) → MP à l'auteur ---
  if (interaction.customId.startsWith('bug_resolve:')) {
    const bid = interaction.customId.split(':')[1];
    if (!canUseCommands(interaction.member, interaction.user.id)) return interaction.reply({ content: '❌ Réservé au staff.', flags: MessageFlags.Ephemeral }).catch(() => {});
    const b = blacklist.getBugReport(bid);
    if (!b) return interaction.reply({ content: '❌ Bug introuvable (supprimé ?).', flags: MessageFlags.Ephemeral }).catch(() => {});
    if (b.status && b.status !== 'open' && b.status !== 'dev') return interaction.reply({ content: '⚠️ Bug déjà résolu.', flags: MessageFlags.Ephemeral }).catch(() => {});
    blacklist.resolveBugReport(bid, interaction.user.id);
    logStaff(interaction, '✅ BUG RÉSOLU', `<#${interaction.channelId}> — signalé par <@${b.authorId}> — résolu par <@${interaction.user.id}>`);
    try {
      const authorUser = await client.users.fetch(b.authorId).catch(() => ({ toString: () => `<@${b.authorId}>`, id: b.authorId }));
      await interaction.message.edit({ embeds: [bugResolvedEmbed(authorUser, b.text, interaction.user.id)], components: bugRows(bid, true) }).catch(() => {});
    } catch {}
    try {
      const dest = await client.users.fetch(b.authorId).catch(() => null);
      if (dest && !dest.bot) await dest.send({ content: '✅ Ton bug a été **résolu par les développeurs**, merci pour ton signalement !', embeds: [bugResolvedEmbed(dest, b.text, interaction.user.id)] }).catch(() => {});
    } catch {}
    return interaction.reply({ content: '✅ Bug marqué comme résolu.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  // --- Bugs : bouton En dev (reste modifiable : on peut résoudre après) ---
  if (interaction.customId.startsWith('bug_dev:')) {
    const bid = interaction.customId.split(':')[1];
    if (!canUseCommands(interaction.member, interaction.user.id)) return interaction.reply({ content: '❌ Réservé au staff.', flags: MessageFlags.Ephemeral }).catch(() => {});
    const b = blacklist.getBugReport(bid);
    if (!b) return interaction.reply({ content: '❌ Bug introuvable (supprimé ?).', flags: MessageFlags.Ephemeral }).catch(() => {});
    if (b.status && b.status !== 'open' && b.status !== 'dev') return interaction.reply({ content: '⚠️ Bug déjà résolu.', flags: MessageFlags.Ephemeral }).catch(() => {});
    blacklist.setBugDev(bid, interaction.user.id);
    logStaff(interaction, '🛠️ BUG EN DEV', `<#${interaction.channelId}> — signalé par <@${b.authorId}> — par <@${interaction.user.id}>`);
    try {
      const authorUser = await client.users.fetch(b.authorId).catch(() => ({ toString: () => `<@${b.authorId}>`, id: b.authorId }));
      await interaction.message.edit({ embeds: [bugDevEmbed(authorUser, b.text, interaction.user.id)], components: bugRows(bid, false) }).catch(() => {});
    } catch {}
    try {
      const dest = await client.users.fetch(b.authorId).catch(() => null);
      if (dest && !dest.bot) await dest.send({ content: '🛠️ Ton bug est **en développement** !', embeds: [bugDevEmbed(dest, b.text, interaction.user.id)] }).catch(() => {});
    } catch {}
    return interaction.reply({ content: '🛠️ Bug passé en dev (tu peux encore le marquer résolu).', flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  // --- Panel suggestions : ouvre le formulaire ---
  if (interaction.customId === 'suggest:open') {
    try {
      await interaction.showModal(buildSuggestModal());
    } catch (e) { return interaction.reply({ content: `❌ Impossible d’ouvrir le formulaire : \`${e.message}\``, flags: MessageFlags.Ephemeral }).catch(() => {}); }
    return;
  }

  // --- Suggestions : accepter / refuser (staff) ---
  if (interaction.customId.startsWith('suggest_accept:') || interaction.customId.startsWith('suggest_reject:')) {
    const accepted = interaction.customId.startsWith('suggest_accept:');
    const sid = interaction.customId.split(':')[1];
    if (!canUseCommands(interaction.member, interaction.user.id)) return interaction.reply({ content: '❌ Réservé au staff.', flags: MessageFlags.Ephemeral }).catch(() => {});
    const s = blacklist.getSuggestion(sid);
    if (!s) return interaction.reply({ content: '❌ Suggestion introuvable (supprimée ?).', flags: MessageFlags.Ephemeral }).catch(() => {});
    if (s.status !== 'open' && s.status !== 'dev') return interaction.reply({ content: '⚠️ Déjà traitée.', flags: MessageFlags.Ephemeral }).catch(() => {});
    blacklist.decideSuggestion(sid, interaction.user.id);
    logStaff(interaction, accepted ? '✅ SUGGESTION ACCEPTÉE' : '❌ SUGGESTION REFUSÉE', `<#${interaction.channelId}> — <@${s.authorId}> — traité par <@${interaction.user.id}>`);
    try {
      const authorUser = await client.users.fetch(s.authorId).catch(() => ({ toString: () => `<@${s.authorId}>`, id: s.authorId }));
      await interaction.message.edit({ embeds: [suggestEmbed(authorUser, s.text, { accepted, by: interaction.user.id })], components: suggestRows(sid, true) }).catch(() => {});
    } catch {}
    try {
      const dest = await client.users.fetch(s.authorId).catch(() => null);
      if (dest && !dest.bot) await dest.send({ content: accepted ? `✅ Ta suggestion a été **acceptée** par le staff !` : `❌ Ta suggestion a été **refusée** par le staff.`, embeds: [suggestEmbed(dest, s.text, { accepted, by: interaction.user.id })] }).catch(() => {});
    } catch {}
    return interaction.reply({ content: accepted ? '✅ Suggestion acceptée.' : '❌ Suggestion refusée.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  // --- Suggestions : passer en développement (reste modifiable : on peut accepter/refuser après) ---
  if (interaction.customId.startsWith('suggest_dev:')) {
    const sid = interaction.customId.split(':')[1];
    if (!canUseCommands(interaction.member, interaction.user.id)) return interaction.reply({ content: '❌ Réservé au staff.', flags: MessageFlags.Ephemeral }).catch(() => {});
    const s = blacklist.getSuggestion(sid);
    if (!s) return interaction.reply({ content: '❌ Suggestion introuvable (supprimée ?).', flags: MessageFlags.Ephemeral }).catch(() => {});
    if (s.status !== 'open' && s.status !== 'dev') return interaction.reply({ content: '⚠️ Déjà traitée.', flags: MessageFlags.Ephemeral }).catch(() => {});
    blacklist.setSuggestionDev(sid, interaction.user.id);
    logStaff(interaction, '🛠️ SUGGESTION EN DEV', `<#${interaction.channelId}> — <@${s.authorId}> — par <@${interaction.user.id}>`);
    try {
      const authorUser = await client.users.fetch(s.authorId).catch(() => ({ toString: () => `<@${s.authorId}>`, id: s.authorId }));
      await interaction.message.edit({ embeds: [suggestEmbed(authorUser, s.text, { accepted: 'dev', by: interaction.user.id })], components: suggestRows(sid, false) }).catch(() => {});
    } catch {}
    try {
      const dest = await client.users.fetch(s.authorId).catch(() => null);
      if (dest && !dest.bot) await dest.send({ content: `🛠️ Ta suggestion est **en développement** !`, embeds: [suggestEmbed(dest, s.text, { accepted: 'dev', by: interaction.user.id })] }).catch(() => {});
    } catch {}
    return interaction.reply({ content: '🛠️ Suggestion passée en dev (tu peux encore l’accepter ou la refuser).', flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  // --- Validation d'une demande f!bl-bot (Oui/Non, réservé aux owners) ---
  if (interaction.customId.startsWith('blbot_confirm:') || interaction.customId.startsWith('blbot_cancel:')) {
    const isConfirm = interaction.customId.startsWith('blbot_confirm:');
    const reqId = interaction.customId.split(':')[1];
    if (!isOwner(interaction.user.id)) return interaction.reply({ content: '❌ Réservé aux owners.', flags: MessageFlags.Ephemeral }).catch(() => {});
    const req = pendingBlBot.get(reqId);
    if (!req) return interaction.reply({ content: '⚠️ Demande expirée ou déjà traitée.', flags: MessageFlags.Ephemeral }).catch(() => {});
    if (Date.now() - req.createdAt > BLBOT_TIMEOUT_MS) { pendingBlBot.delete(reqId); return interaction.reply({ content: '⚠️ Demande expirée.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
    pendingBlBot.delete(reqId);
    try { await interaction.message.edit({ components: blBotConfirmRows(reqId, true) }).catch(() => {}); } catch {}
    const targetTag = req.tag || req.targetId;
    if (!isConfirm) {
      await logStaff(interaction, 'f!bl-bot', `❌ demande refusée par <@${interaction.user.id}> : <@${req.targetId}> (demandé par <@${req.requesterId}>)`, { channelId: BLBOT_LOG_ID });
      try {
        const ch = await client.channels.fetch(req.channelId).catch(() => null);
        if (ch?.isTextBased?.()) await ch.send({ content: `❌ Blacklist de <@${req.targetId}> refusée par <@${interaction.user.id}>.` }).catch(() => {});
      } catch {}
      try {
        const asker = await client.users.fetch(req.requesterId).catch(() => null);
        if (asker) await asker.send({ embeds: [new EmbedBuilder().setColor('#ffa500').setTitle('🚫 Blacklist refusée').setDescription(`Ta demande de blacklist a été refusée par <@${interaction.user.id}>.\n\n**Bot :** ${targetTag} (\`${req.targetId}\`)\n**Raison :** ${req.reason || '*aucune*'}`).setTimestamp()] }).catch(() => {});
      } catch {}
      return interaction.reply({ content: `❌ Demande refusée — <@${req.targetId}> n’est pas blacklisté.`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    const targetUser = await client.users.fetch(req.targetId).catch(() => null);
    blacklist.addBotBlacklist(req.targetId, targetUser?.tag || req.tag, req.reason, req.requesterId);
    await logStaff(interaction, 'f!bl-bot', `➕ <@${req.targetId}> (${targetUser?.tag || req.tag}) blacklisté (validé par <@${interaction.user.id}>, demandé par <@${req.requesterId}>)${req.reason ? ` — ${req.reason}` : ''}`, { channelId: BLBOT_LOG_ID });
    try {
      const ch = await client.channels.fetch(req.channelId).catch(() => null);
      if (ch?.isTextBased?.()) await ch.send({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('🚫 Bot blacklisté').setDescription(`<@${req.targetId}> (${targetUser?.tag || req.tag}) ajouté à la blacklist (validé par <@${interaction.user.id}>).${req.reason ? `\n**Raison :** ${req.reason}` : ''}`).setTimestamp()] }).catch(() => {});
    } catch {}
    try {
      const asker = await client.users.fetch(req.requesterId).catch(() => null);
      if (asker) await asker.send({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('🚫 Bot blacklisté').setDescription(`Le bot a bien été blacklisté (validé par <@${interaction.user.id}>).\n\n**Bot :** ${targetUser?.tag || req.tag} (<@${req.targetId}>)\n**ID :** \`${req.targetId}\`\n**Raison :** ${req.reason || '*aucune*'}`).setTimestamp()] }).catch(() => {});
    } catch {}
    return interaction.reply({ content: `✅ <@${req.targetId}> blacklisté.`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }



  // --- x!panel (complet) : bouton Ticket = +1 stat ticket (pas de salon, staff uniquement) ---
  if (interaction.customId === 'create_ticket') {
    if (!requireLevel(interaction.member, interaction.user.id, LVL.STAFF)) return interaction.reply({ content: '❌ Réservé au staff.', flags: MessageFlags.Ephemeral }).catch(() => {});
    const cd = onCooldown(interaction.user.id, 'ticket');
    if (cd) return interaction.reply({ content: `⏳ Patiente **${cd}s**.`, flags: MessageFlags.Ephemeral }).catch(() => {});
    blacklist.incStaffStat(interaction.user.id, 'ticket');
    markSent(interaction.user.id, 'ticket');
    const s = blacklist.getStaffStats(interaction.user.id);
    logStaff(interaction, '+1 TICKET', `TOTAL: ${s.total}`);
    return interaction.reply({ content: `🎫 +1 TICKET — **TICKET : ${s.ticket} | TOTAL : ${s.total}**`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  // --- x!panel-ticket : bouton Ticket = crée un salon ticket (système ticket uniquement, 0 stat) ---
  // (ancien ID accepté aussi : les panels déjà postés restent utilisables)
  if (interaction.customId === TICKET_IDS.PANEL_OPEN || interaction.customId === 'ticket_open_modal') {
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: '❌ Ouvre ton ticket depuis le serveur.', flags: MessageFlags.Ephemeral }).catch(() => {});
    const existing = await resolveLiveTicket(guild, interaction.user.id);
    if (existing) return interaction.reply({ content: `⚠️ Tu as déjà un ticket ouvert : <#${existing.channelId}>`, flags: MessageFlags.Ephemeral }).catch(() => {});
    if (blacklist.countOpenTicketsByUser(interaction.user.id, guild.id) >= maxTicketsPerUser()) {
      return interaction.reply({ content: `⚠️ Limite atteinte (${maxTicketsPerUser()} ticket(s) max).`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    let channel;
    // La création (salon + DB + messages + logs) peut dépasser les 3 s → on diffère
    // la réponse AVANT pour éviter "Interaction failed" (Unknown interaction).
    const deferred = await interaction.deferReply({ flags: MessageFlags.Ephemeral }).then(() => true).catch(() => false);
    try {
      channel = await createTicketNow(guild, interaction.user, 'Ticket ouvert depuis le panel.');
    } catch (e) {
      const msg = `❌ Impossible de créer le ticket : \`${e.message}\` (vérifie mes perms Gérer les salons).`;
      return (deferred ? interaction.editReply({ content: msg }) : interaction.reply({ content: msg, flags: MessageFlags.Ephemeral })).catch(() => {});
    }
    logStaff(interaction, '🎫 TICKET OUVERT', `<#${channel.id}> par <@${interaction.user.id}>`);
    const okMsg = `✅ Ticket créé : **#${channel.name}** → <#${channel.id}>`;
    return (deferred ? interaction.editReply({ content: okMsg }) : interaction.reply({ content: okMsg, flags: MessageFlags.Ephemeral })).catch(() => {});
  }

  if (interaction.customId === TICKET_IDS.CLAIM) {
    const t = blacklist.getTicket(interaction.channelId);
    if (!t) return interaction.reply({ content: '❌ Pas un salon ticket.', flags: MessageFlags.Ephemeral }).catch(() => {});
    if (!canUseCommands(interaction.member, interaction.user.id)) return interaction.reply({ content: '❌ Réservé au staff.', flags: MessageFlags.Ephemeral }).catch(() => {});
    if (t.claimedBy) return interaction.reply({ content: `⚠️ Déjà pris en charge par <@${t.claimedBy}>.`, flags: MessageFlags.Ephemeral }).catch(() => {});
    blacklist.claimTicket(interaction.channelId, interaction.user.id);
    logStaff(interaction, '🙋 TICKET CLAIM', `<#${interaction.channelId}> par <@${interaction.user.id}>`);
    try {
      const ownerUser = await client.users.fetch(t.ownerId).catch(() => ({ toString: () => `<@${t.ownerId}>`, id: t.ownerId }));
      await interaction.message.edit({ embeds: [ticketOpenEmbed(ownerUser, t.reason, interaction.user.id)], components: ticketControlRows(true) }).catch(() => {});
    } catch {}
    return interaction.reply({ content: `🙋 Tu as pris le ticket en charge.` }).catch(() => {});
  }
  if (interaction.customId === TICKET_IDS.TRANSCRIPT) {
    const t = blacklist.getTicket(interaction.channelId);
    if (!t) return interaction.reply({ content: '❌ Pas un salon ticket.', flags: MessageFlags.Ephemeral }).catch(() => {});
    const staff = canUseCommands(interaction.member, interaction.user.id);
    if (t.ownerId !== interaction.user.id && !staff) return interaction.reply({ content: '❌ Réservé au staff ou au créateur.', flags: MessageFlags.Ephemeral }).catch(() => {});
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    const txt = await buildTranscriptText(interaction.channel, 100);
    logStaff(interaction, '📝 TRANSCRIPT', `<#${interaction.channelId}>`);
    return interaction.editReply({ content: '📝 Transcript du ticket :', files: [{ attachment: Buffer.from(txt, 'utf8'), name: `transcript-${interaction.channel?.name || 'ticket'}.txt` }] }).catch(() => {});
  }
  if (interaction.customId === TICKET_IDS.CLOSE) {
    const t = blacklist.getTicket(interaction.channelId);
    if (!t) return interaction.reply({ content: '❌ Pas un salon ticket.', flags: MessageFlags.Ephemeral }).catch(() => {});
    const staff = canUseCommands(interaction.member, interaction.user.id);
    if (t.ownerId !== interaction.user.id && !staff) return interaction.reply({ content: '❌ Réservé au staff ou au créateur.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return interaction.reply({ embeds: [ticketCloseConfirmEmbed()], components: ticketCloseConfirmRows() }).catch(() => {});
  }
  if (interaction.customId === TICKET_IDS.CLOSE_CANCEL) {
    try { await interaction.message.delete().catch(() => null); } catch {}
    return interaction.reply({ content: '↩️ Fermeture annulée.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  if (interaction.customId === TICKET_IDS.CLOSE_CONFIRM) {
    const t = blacklist.getTicket(interaction.channelId);
    if (!t) return interaction.reply({ content: '❌ Ticket introuvable (déjà fermé ?).', flags: MessageFlags.Ephemeral }).catch(() => {});
    if (t.status && t.status !== 'open') return interaction.reply({ content: '⚠️ Fermeture déjà en cours...', flags: MessageFlags.Ephemeral }).catch(() => {});
    if (closingTickets.has(interaction.channelId)) return interaction.reply({ content: '⚠️ Fermeture déjà en cours...', flags: MessageFlags.Ephemeral }).catch(() => {});
    closingTickets.add(interaction.channelId);
    const staff = canUseCommands(interaction.member, interaction.user.id);
    if (t.ownerId !== interaction.user.id && !staff) { closingTickets.delete(interaction.channelId); return interaction.reply({ content: '❌ Réservé au staff ou au créateur.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
    await interaction.deferUpdate().catch(() => {});
    try {
      const txt = await buildTranscriptText(interaction.channel, 100);
      const ch = await getChannel(ticketLogChannelId()).catch(() => null);
      if (ch?.isTextBased?.()) await ch.send({ content: `🔒 Ticket fermé — <#${interaction.channelId}>\nOuvert par <@${t.ownerId}> (${t.ownerTag || t.ownerId}) • Fermé par <@${interaction.user.id}> • Pris en charge par ${t.claimedBy ? `<@${t.claimedBy}>` : '*personne*'}${t.reason ? `\nRaison : ${t.reason.slice(0, 500)}` : ''}`, files: [{ attachment: Buffer.from(txt, 'utf8'), name: `transcript-${interaction.channel?.name || 'ticket'}.txt` }] }).catch(() => {});
    } catch {}
    try { if (staff && !t.claimedBy) { blacklist.claimTicket(interaction.channelId, interaction.user.id); } } catch {}
    logStaff(interaction, '🔒 TICKET FERMÉ', `<#${interaction.channelId}> par <@${interaction.user.id}>`);
    blacklist.closeTicket(interaction.channelId);
    try { await interaction.channel.send({ content: '🔒 Ticket fermé — suppression dans **5 secondes**...' }).catch(() => {}); } catch {}
    setTimeout(() => { closingTickets.delete(interaction.channelId); interaction.channel?.delete().catch(() => {}); }, 5000);
    return;
  }

  if (interaction.customId === TICKET_IDS.RESOLUT_YES) {
    const t = blacklist.getTicket(interaction.channelId);
    if (!t) return interaction.reply({ content: '❌ Ticket introuvable (déjà fermé ?).', flags: MessageFlags.Ephemeral }).catch(() => {});
    if (t.status && t.status !== 'open') return interaction.reply({ content: '⚠️ Fermeture déjà en cours...', flags: MessageFlags.Ephemeral }).catch(() => {});
    if (closingTickets.has(interaction.channelId)) return interaction.reply({ content: '⚠️ Fermeture déjà en cours...', flags: MessageFlags.Ephemeral }).catch(() => {});
    closingTickets.add(interaction.channelId);
    const staff = canUseCommands(interaction.member, interaction.user.id);
    if (t.ownerId !== interaction.user.id && !staff) { closingTickets.delete(interaction.channelId); return interaction.reply({ content: '❌ Réservé au créateur du ticket ou au staff.', flags: MessageFlags.Ephemeral }).catch(() => {}); }
    await interaction.deferUpdate().catch(() => {});
    try { await interaction.message.edit({ components: ticketResolutRows(true) }).catch(() => {}); } catch {}
    try {
      const txt = await buildTranscriptText(interaction.channel, 100);
      const ch = await getChannel(ticketLogChannelId()).catch(() => null);
      if (ch?.isTextBased?.()) await ch.send({ content: `✅ Ticket résolu — <#${interaction.channelId}>\nOuvert par <@${t.ownerId}> (${t.ownerTag || t.ownerId}) • Confirmé par <@${interaction.user.id}> • Pris en charge par ${t.claimedBy ? `<@${t.claimedBy}>` : '*personne*'}${t.reason ? `\nRaison : ${t.reason.slice(0, 500)}` : ''}`, files: [{ attachment: Buffer.from(txt, 'utf8'), name: `transcript-${interaction.channel?.name || 'ticket'}.txt` }] }).catch(() => {});
    } catch {}
    try { if (staff && !t.claimedBy) { blacklist.claimTicket(interaction.channelId, interaction.user.id); } } catch {}
    logStaff(interaction, '✅ TICKET RÉSOLU', `<#${interaction.channelId}> confirmé par <@${interaction.user.id}>`);
    blacklist.closeTicket(interaction.channelId);
    try { await interaction.channel.send({ content: `✅ Ticket résolu par <@${interaction.user.id}> — suppression dans **5 secondes**...` }).catch(() => {}); } catch {}
    setTimeout(() => { closingTickets.delete(interaction.channelId); interaction.channel?.delete().catch(() => {}); }, 5000);
    return;
  }
  if (interaction.customId === TICKET_IDS.RESOLUT_NO) {
    const t = blacklist.getTicket(interaction.channelId);
    if (!t) return interaction.reply({ content: '❌ Ticket introuvable (déjà fermé ?).', flags: MessageFlags.Ephemeral }).catch(() => {});
    const staff = canUseCommands(interaction.member, interaction.user.id);
    if (t.ownerId !== interaction.user.id && !staff) return interaction.reply({ content: '❌ Réservé au créateur du ticket ou au staff.', flags: MessageFlags.Ephemeral }).catch(() => {});
    try { await interaction.message.edit({ components: ticketResolutRows(true) }).catch(() => {}); } catch {}
    logStaff(interaction, '❌ TICKET NON RÉSOLU', `<#${interaction.channelId}> — <@${t.ownerId}> a encore besoin d'aide`);
    let staffPing = '';
    try {
      const rid = liveStaffRoleId();
      const r = rid ? (interaction.guild?.roles.cache.get(rid) || await interaction.guild?.roles.fetch(rid).catch(() => null)) : null;
      if (r) staffPing = `\n<@&${r.id}> merci de continuer la prise en charge !`;
    } catch {}
    return interaction.reply({ content: `<@${t.ownerId}>, l'équipe STAFF de Phénix est encore à ta disposition, n'hésite pas à continuer d'écrire ici 🙏${staffPing}` }).catch(() => {});
  }

  // Clic Raid/SOS/Question = +1 immédiat (staff uniquement — anti-farm)
  if (interaction.customId.startsWith('create_')) {
    const kind = interaction.customId.slice('create_'.length);
    if (!['raid', 'sos', 'question'].includes(kind)) return;
    if (!requireLevel(interaction.member, interaction.user.id, LVL.STAFF)) return interaction.reply({ content: '❌ Réservé au staff.', flags: MessageFlags.Ephemeral }).catch(() => {});
    const cd = onCooldown(interaction.user.id, kind);
    if (cd) return interaction.reply({ content: `⏳ Patiente **${cd}s**.`, flags: MessageFlags.Ephemeral }).catch(() => {});
    blacklist.incStaffStat(interaction.user.id, kind);
    markSent(interaction.user.id, kind);
    const s = blacklist.getStaffStats(interaction.user.id);
    logStaff(interaction, '+1 ' + kind.toUpperCase(), `TOTAL: ${s.total}`);
    const emoji = kind === 'raid' ? '🛡️' : kind === 'sos' ? '🚨' : '❓';
    return interaction.reply({ content: `${emoji} +1 ${kind.toUpperCase()} — **${kind.toUpperCase()} : ${s[kind]} | TOTAL : ${s.total}**`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  if (interaction.customId.startsWith('stats_show:')) {
    if (!canUseCommands(interaction.member, interaction.user.id)) return interaction.reply({ content: '❌ Réservé au staff.', flags: MessageFlags.Ephemeral }).catch(() => {});
    const type = normalizeType(interaction.customId.split(':')[1]);
    const embed = buildTopEmbed(blacklist.getStaffTop(type, 10), type, (id) => client.users.cache.get(id) || null);
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    await interaction.message.edit({ embeds: [embed], components: statsPanelRows() }).catch(() => {});
    return;
  }

  // --- Alertes PX!sos / PX!raid : prise en charge ---
  if (interaction.customId.startsWith('alert_claim:')) {
    const id = interaction.customId.split(':')[1];
    if (!requireLevel(interaction.member, interaction.user.id, LVL.STAFF)) return interaction.reply({ content: '❌ Réservé au staff.', flags: MessageFlags.Ephemeral }).catch(() => {});
    const data = blacklist.getIntervention(id);
    if (!data) return interaction.reply({ content: '❌ Alerte introuvable.', flags: MessageFlags.Ephemeral }).catch(() => {});
    if (data.resolved) return interaction.reply({ content: '⚠️ Alerte déjà résolue.', flags: MessageFlags.Ephemeral }).catch(() => {});
    if (data.claimedBy) return interaction.reply({ content: `⚠️ Déjà pris en charge par <@${data.claimedBy}>.`, flags: MessageFlags.Ephemeral }).catch(() => {});
    blacklist.claimIntervention(id, interaction.user.id);
    logStaff(interaction, '🙋 ALERTE PRISE EN CHARGE', `<#${interaction.channelId}> — <@${data.requesterId}> — pris par <@${interaction.user.id}>`);
    try {
      const prev = interaction.message?.embeds?.[0] || null;
      const emb = prev ? EmbedBuilder.from(prev).addFields({ name: '🙋 Pris en charge par', value: `<@${interaction.user.id}>`, inline: true }) : null;
      if (emb) await interaction.update({ embeds: [emb], components: alertRow(id, 'claimed') }).catch(() => null);
      else await interaction.deferUpdate().catch(() => null);
    } catch {}
    if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: `🙋 Pris en charge par <@${interaction.user.id}>.` }).catch(() => {});
    return;
  }
  // --- Alertes PX!sos / PX!raid : résolu (sans stats) ---
  if (interaction.customId.startsWith('alert_done:')) {
    const id = interaction.customId.split(':')[1];
    if (!requireLevel(interaction.member, interaction.user.id, LVL.STAFF)) return interaction.reply({ content: '❌ Réservé au staff.', flags: MessageFlags.Ephemeral }).catch(() => {});
    const data = blacklist.getIntervention(id);
    if (!data) return interaction.reply({ content: '❌ Alerte introuvable.', flags: MessageFlags.Ephemeral }).catch(() => {});
    if (data.resolved) return interaction.reply({ content: '⚠️ Alerte déjà résolue.', flags: MessageFlags.Ephemeral }).catch(() => {});
    if (!data.claimedBy) blacklist.claimIntervention(id, interaction.user.id);
    blacklist.resolveIntervention(id);
    logStaff(interaction, '✅ ALERTE RÉSOLUE', `<#${interaction.channelId}> — <@${data.requesterId}> — résolu par <@${interaction.user.id}>`);
    try {
      const prev = interaction.message?.embeds?.[0] || null;
      const emb = prev ? EmbedBuilder.from(prev).addFields({ name: '✅ Résolu par', value: `<@${interaction.user.id}>`, inline: true }) : null;
      if (emb) await interaction.update({ embeds: [emb], components: alertRow(id, 'done') }).catch(() => null);
      else await interaction.deferUpdate().catch(() => null);
    } catch {}
    if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: '✅ Alerte résolue.' }).catch(() => {});
    return;
  }
  // --- Alertes PX!sos / PX!raid : invitation pour rejoindre le serveur (MP éphémère) ---
  if (interaction.customId.startsWith('alert_invite:')) {
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: '❌ Depuis un serveur uniquement.', flags: MessageFlags.Ephemeral }).catch(() => {});
    try {
      const alertId = interaction.customId.split(':')[1];
      const adata = blacklist.getIntervention?.(alertId);
      if (adata?.resolved) return interaction.reply({ content: '⚠️ Alerte déjà résolue — invitation indisponible.', flags: MessageFlags.Ephemeral }).catch(() => {});
      const botMe = guild.members.me || await guild.members.fetchMe().catch(() => null);
      const ch = guild.channels.cache.filter((c) => c?.isTextBased?.() && !c.isThread?.()).find((c) => { try { return c.permissionsFor(botMe)?.has(PermissionFlagsBits.CreateInstantInvite); } catch { return false; } })
        || guild.systemChannel || null;
      if (!ch) throw new Error('aucun salon utilisable (perm Créer une invitation requise)');
      const inv = await guild.invites.create(ch.id, { maxAge: 0, maxUses: 0, reason: `alert_invite par ${interaction.user.tag}` }).catch(() => null);
      if (!inv) throw new Error('création impossible (vérifie mes perms)');
      return interaction.reply({ content: `🔗 Invitation pour **${guild.name}** : ${inv.url}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    } catch (e) {
      return interaction.reply({ content: `❌ Impossible : \`${e.message}\`.`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

// ----- Auto-voc : rejoint le salon vocal à chaque (re)lancement -----
const AUTO_VOC_CHANNEL_ID = '1544740906111078410';
async function joinAutoVoc(reason) {
  try {
    const ch = client.channels.cache.get(AUTO_VOC_CHANNEL_ID) || await client.channels.fetch(AUTO_VOC_CHANNEL_ID).catch(() => null);
    if (!ch) { console.log(`[VOC] ❌ salon ${AUTO_VOC_CHANNEL_ID} introuvable`); return; }
    if (!ch.isVoiceBased?.()) { console.log('[VOC] ❌ le salon configuré n’est pas un salon vocal'); return; }
    const guild = ch.guild || client.guilds.cache.get(GUILD_ID);
    if (!guild) { console.log('[VOC] ❌ serveur introuvable pour l’auto-voc'); return; }
    guild.shard.send({ op: 4, d: { guild_id: guild.id, channel_id: ch.id, self_mute: false, self_deaf: true } });
    console.log(`[VOC] ✅ vocal rejoint : #${ch.name} (${ch.id}) — ${reason}`);
  } catch (e) { console.log(`[VOC] ❌ échec auto-voc : ${e.message}`); }
}

// ----- Logs voc/crash → salon dédié (déconnexion manuelle, move, crash) -----
const VOC_LOG_CHANNEL_ID = '1558650754657554462';
async function sendVocLog(embed) {
  try {
    const ch = client.channels.cache.get(VOC_LOG_CHANNEL_ID) || await client.channels.fetch(VOC_LOG_CHANNEL_ID).catch(() => null);
    if (ch?.isTextBased?.()) await ch.send({ embeds: [embed] }).catch(() => null);
  } catch {}
}
async function findVocExecutor(guild, targetId, actions) {
  try {
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me?.permissions?.has(PermissionFlagsBits.ViewAuditLog)) { console.log('[VOC] ⚠️ perm « Voir les logs du serveur » manquante — auteur introuvable'); return null; }
    // Le log d'audit est créé APRÈS l'event : on attend puis on réessaie 3 fois
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 2500 : 2000));
      const logs = await guild.fetchAuditLogs({ limit: 10 }).catch(() => null);
      if (!logs) continue;
      const entry = [...logs.entries.values()].find((e) => e.target?.id === targetId && actions.includes(e.action) && Date.now() - e.createdTimestamp < 60000);
      if (entry?.executor) return entry.executor;
    }
    return null;
  } catch { return null; }
}

// ============================================================
// READY
// ============================================================
// ============ USAR! — Antiraid : detections des joins (flood + accountage) ============
client.on('guildMemberAdd', async (member) => {
  try {
    if (!member?.guild) return;
    const c = blacklist.getAntiraidCfg(member.guild.id);
    if (!c?.enabled) return;
    const now = Date.now();
    const win = Math.max(5, c.joinsWindow || 30) * 1000;
    let arr = (joinTracker.get(member.guild.id) || []).filter((t) => now - t < win);
    arr.push(now);
    joinTracker.set(member.guild.id, arr);
    if (c.minAccountAge > 0 && member.user?.createdTimestamp) {
      const ageDays = (now - member.user.createdTimestamp) / 86400000;
      if (ageDays < c.minAccountAge) {
        let ok = false;
        try { await member.kick(`USAR!antiraid — compte trop récent (${ageDays.toFixed(1)}j < ${c.minAccountAge}j)`); ok = true; } catch {}
        blacklist.addSecurityLog(member.guild.id, member.user.id, 'KICK ACCOUNTAGE', `${member.user.tag} kické à l’entrée — compte ${ageDays.toFixed(1)}j < ${c.minAccountAge}j${ok ? '' : ' (échec : perm manquante)'}`);
        await uSendRaidAlert(member.guild, uSecEmbed(member.guild, '🎂 Compte trop récent', `${member.user} (${member.user.tag}) a été **kické** à l’entrée (compte ${ageDays.toFixed(1)}j — minimum ${c.minAccountAge}j).`, '#ff4d4d'));
      }
    }
    if (arr.length > Math.max(1, c.joinsLimit || 10)) {
      const last = floodState.get(member.guild.id);
      if (!last || now - last > 60000) {
        floodState.set(member.guild.id, now);
        const n = await uSetLockdown(member.guild, true, 'USAR!antiraid — lockdown auto (flood de joins)');
        blacklist.addSecurityLog(member.guild.id, null, 'FLOOD JOINS', `Lockdown auto : ${arr.length} joins/${c.joinsWindow}s — ${n} salon(s) verrouillé(s)`);
        logStaff({ channel: null, channelId: null, author: null, user: client.user, guild: member.guild }, 'USAR!antiraid', `🔒 LOCKDOWN AUTO — ${arr.length} joins/${c.joinsWindow}s (${n} salons)`);
        await uSendRaidAlert(member.guild, uSecEmbed(member.guild, '🚨 RAID DÉTECTÉ — LOCKDOWN AUTO', `**${arr.length} joins en ${c.joinsWindow}s** (seuil ${c.joinsLimit}).\nSalons verrouillés : **${n}**.\nRouvre avec \`USAR!antiraid unlock\`.`, '#ff0000'));
      }
    }
  } catch (e) { console.log('[USAR!antiraid] join error', e.message); }
});

// ============ USAR! — Antinuke : suppressions de salons / rôles ============
async function uFindAuditExecutor(guild, auditType, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ type: auditType, limit: 5 });
    const now = Date.now();
    for (const e of logs.entries.values()) {
      if (now - e.createdTimestamp <= 15000) {
        if (!targetId || !e.target || e.target.id === targetId || auditType === AuditLogEvent.GuildUpdate) {
          return e.executor?.id || e.executorId || null;
        }
      }
    }
  } catch {}
  return null;
}

async function uHandleDestructive(guild, executorId, what) {
  try {
    if (!guild || !executorId) return;
    if (executorId === client.user.id) return;
    if (blacklist.isAntinukeWhitelisted(guild.id, executorId)) return;
    if (!liveCfg().antinukeEnabled && !cfg.antinukeEnabled) return;
    const key = `${guild.id}:${executorId}`;
    const now = Date.now();
    let arr = (nukeTracker.get(key) || []).filter((t) => now - t < ANTINUKE_WINDOW_MS);
    arr.push(now);
    nukeTracker.set(key, arr);
    if (arr.length > ANTINUKE_MAX_ACTIONS) {
      const last = nukeState.get(key);
      if (!last || now - last > 300000) {
        nukeState.set(key, now);
        nukeTracker.set(key, []);
        let banned = false;
        try {
          const m = await guild.members.fetch(executorId).catch(() => null);
          if (m && m.bannable) { await m.ban({ reason: `USAR!antinuke — nuke détecté (${what})` }); banned = true; }
        } catch {}
        blacklist.addSecurityLog(guild.id, executorId, 'ANTINUKE'.concat(banned ? ' BAN' : ' TRY'), `Nuke détecté : ${arr.length} actions destructives en 60s (${what})${banned ? ' → bannissement' : ' → ban impossible (perm/rôle trop haut)'}`);
        logStaff({ channel: null, channelId: null, author: null, user: null, guild }, 'USAR!antinuke', `☢️ <@${executorId}> — ${arr.length} actions/${what} → ${banned ? 'banni' : 'ban impossible'}`);
        await uSendRaidAlert(guild, uSecEmbed(guild, '☢️ NUKER DÉTECTÉ', `<@${executorId}> (${executorId}) a supprimé **${arr.length}** ${what} en moins de 60s.\n${banned ? '⛔ Il a été **banni automatiquement**.' : '⚠️ Bannissement **impossible** (perm/rôle trop haut) — agis manuellement !'}`, banned ? '#ff0000' : '#ff4d4d'));
      }
    }
  } catch (e) { console.log('[USAR!antinuke] error', e.message); }
}

client.on('channelDelete', async (channel) => {
  try {
    if (!channel?.guild) return;
    const ex = await uFindAuditExecutor(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
    if (ex) await uHandleDestructive(channel.guild, ex, 'salon(s)');
  } catch {}
});

client.on('roleDelete', async (role) => {
  try {
    if (!role?.guild) return;
    const ex = await uFindAuditExecutor(role.guild, AuditLogEvent.RoleDelete, role.id);
    if (ex) await uHandleDestructive(role.guild, ex, 'rôle(s)');
  } catch {}
});

client.on('guildMemberRemove', async (member) => {
  try {
    if (!member?.guild) return;
    // Antinuke : on identifie le VRAI exécutant via les logs d'audit (kick).
    // Sans entrée d'audit récente = départ volontaire → on ne punit personne.
    const ex = await uFindAuditExecutor(member.guild, AuditLogEvent.MemberKick, member.user?.id);
    if (!ex) return;
    if (blacklist.isAntinukeWhitelisted(member.guild.id, ex)) return;
    await uHandleDestructive(member.guild, ex, 'membre(s) expulsé(s)');
  } catch {}
});

client.once('ready', async () => {  console.log(`✅ Phénix Support actif — ${client.user.tag}`);
   console.log(`[LOGS] staff → ${staffLogChannelId()} | tickets → ${ticketLogChannelId()} | owner(F!) → ${ownerLogChannelId()} | mod → ${modLogChannelId()}`);
  // Statut persistant (f!status) — appliqué à chaque démarrage
  try { const pc = getBotPresence(); if (pc) await applyBotPresence(pc.status || 'online', pc.state || '', pc.type != null && pc.type !== 'custom' ? String(pc.type) : 'custom'); } catch {}
  // Timers de jail encore actifs
  try { await resumeJailTimers(); } catch {}
  // ===== Tickets : purge des fantômes au démarrage → après un restart, on peut toujours créer un ticket =====
  try {
    let closed = 0;
    const groups = new Map();
    for (const r of blacklist.listAllOpenTickets()) {
      if (!groups.has(r.guildId)) groups.set(r.guildId, []);
      groups.get(r.guildId).push(r);
    }
    for (const [gid, rows] of groups) {
      const g = client.guilds.cache.get(gid);
      if (!g) { for (const r of rows) { try { blacklist.closeTicket(r.channelId); closed++; } catch {} } continue; }
      try { await g.channels.fetch().catch(() => null); } catch {}
      const ids = new Set(g.channels.cache.filter((c) => c.type !== ChannelType.GuildCategory).keys());
      for (const r of rows) {
        if (!ids.has(r.channelId)) { try { blacklist.closeTicket(r.channelId); closed++; console.log(`[TICKETS] 🧹 fantôme clôturé au démarrage : ${r.channelId} (user ${r.ownerId})`); } catch {} }
      }
    }
    console.log(`[TICKETS] purge démarrage finie — ${closed} fantôme(s) clôturé(s)`);
  } catch (e) { console.log(`[TICKETS] purge démarrage impossible : ${e.message}`); }
  if (GUILD_ID) {
    const g0 = client.guilds.cache.get(GUILD_ID);
    console.log(g0 ? `[GUILD] ✅ présent sur : ${g0.name} (${g0.id})` : `[GUILD] ❌ bot ABSENT du serveur ${GUILD_ID} — invite-le !`);
  } else console.log('[GUILD] ⚠️ guildId vide dans config.json');
  for (const [, g] of client.guilds.cache) {
    console.log(`[GUILD] ${g.name} (${g.id})`);
    try {
      const chans = await g.channels.fetch();
      chans.forEach((c) => { if (c?.isTextBased?.()) console.log(`[SALON] #${c.name} (${c.id})`); });
    } catch (e) { console.log(`[GUILD] impossible de lister les salons : ${e.message}`); }
  }
  // Auto-post désactivé : les panels se postent uniquement via x!panel / x!panel-ticket / x!panel-stats
  if (PANEL_CHANNEL) console.log(`[PANEL] auto-post désactivé (salon configuré : ${PANEL_CHANNEL} — poste manuellement avec x!panel)`);
  if (STATS_PANEL_CHANNEL) console.log(`[PANEL] auto-post stats désactivé (${STATS_PANEL_CHANNEL} — poste manuellement avec x!panel-stats)`);
  // Auto-voc : rejoint automatiquement le salon vocal à chaque lancement/restart
  await joinAutoVoc('démarrage');
  await sendVocLog(new EmbedBuilder().setColor('#2ecc71').setTitle('🟢 Bot démarré').setDescription(`**${client.user.tag}** en ligne — <t:${Math.floor(Date.now() / 1000)}:R>`).setTimestamp());
  // Historique des restarts + statut actuel dans le salon status
  try {
    const ch = await getChannel(STATUS_CHANNEL_ID).catch(() => null);
    if (ch?.isTextBased?.()) {
      await ch.send({ embeds: [new EmbedBuilder().setColor('#2ecc71').setTitle('🟢 Bot démarré').setDescription(`**${client.user.tag}** en ligne — <t:${Math.floor(Date.now() / 1000)}:R>`).setTimestamp()] }).catch(() => null);
      await postStatusToChannel().catch(() => null);
    } else console.log('[STARTUP] ⚠️ salon status injoignable');
  } catch (e) { console.log(`[STARTUP] ⚠️ status impossible : ${e.message}`); }

  // ===== RGPD — Purge automatique des données anciennes (Article 5.1.e) =====
  // Exécute une purge au démarrage, puis tous les jours à 3h du matin
  try {
    const { purged, totalCount } = blacklist.purgeOldData(12);
    if (totalCount > 0) {
      console.log(`[RGPD] 🧹 Purge automatique : ${totalCount} entrée(s) supprimée(s)`);
      for (const [table, count] of Object.entries(purged)) {
        console.log(`[RGPD]   - ${table} : ${count}`);
      }
    } else {
      console.log('[RGPD] ✅ Aucune donnée à purger (toutes < 12 mois)');
    }
  } catch (e) {
    console.log(`[RGPD] ⚠️ Erreur purge démarrage : ${e.message}`);
  }

  // Programme la purge quotidienne à 3h du matin
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 3 && now.getMinutes() === 0) {
      try {
        const { purged, totalCount } = blacklist.purgeOldData(12);
        if (totalCount > 0) {
          console.log(`[RGPD] 🧹 Purge quotidienne (${now.toISOString()}) : ${totalCount} entrée(s) supprimée(s)`);
          for (const [table, count] of Object.entries(purged)) {
            console.log(`[RGPD]   - ${table} : ${count}`);
          }
        }
      } catch (e) {
        console.log(`[RGPD] ⚠️ Erreur purge quotidienne : ${e.message}`);
      }
    }
  }, 60 * 1000); // Vérifie toutes les minutes
});

// ----- Crash : log Discord puis restart (le panel relance le bot) -----
function handleCrash(kind, err) {
  try { console.error(`[CRASH] ${kind} :`, err); } catch {}
  let txt = 'erreur inconnue';
  try { txt = err instanceof Error ? `${err.message}\n${err.stack || ''}` : String(err); } catch {}
  try { setTimeout(() => process.exit(1), 3000).unref?.(); } catch {}
  sendVocLog(new EmbedBuilder().setColor('#ff0000').setTitle(`💥 Crash du bot (${kind})`).setDescription(`\`\`\`js\n${String(txt).slice(0, 3800)}\n\`\`\``).setTimestamp()).catch(() => {});
}
process.on('unhandledRejection', (reason) => handleCrash('rejection non gérée', reason));
process.on('uncaughtException', (err) => handleCrash('exception non capturée', err));

client.login(DISCORD_TOKEN);
