// Phénix — Logs Staff centralisés (salon 1544740969025642672 par défaut)
const { EmbedBuilder } = require('discord.js');

const DEFAULT_STAFF_LOG_ID = '1544740969025642672';

function getStaffLogId(liveCfgFn, cfg) {
  try {
    const live = typeof liveCfgFn === 'function' ? liveCfgFn() : {};
    return (
      live.staffLogChannelId ||
      live.logChannelId ||
      cfg?.staffLogChannelId ||
      cfg?.logChannelId ||
      DEFAULT_STAFF_LOG_ID
    );
  } catch {
    return cfg?.staffLogChannelId || cfg?.logChannelId || DEFAULT_STAFF_LOG_ID;
  }
}

async function getLogChannel(client, channelId) {
  if (!channelId) return null;
  try {
    return client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
  } catch { return null; }
}

// Formate l'utilisateur proprement (gère les objets simples {id, tag} sans toString)
function formatUserMention(user) {
  if (!user) return '`Inconnu`';
  if (typeof user === 'string') return user.startsWith('<@') ? user : `<@${user}>`;
  if (user.id && /^\d{15,}$/.test(String(user.id))) return `<@${user.id}>`;
  try {
    const str = String(user);
    if (str && str !== '[object Object]') return str;
  } catch {}
  return user.tag ? `**${user.tag}**` : '`Inconnu`';
}
function userLabel(user) {
  if (!user) return '?';
  return user.tag || user.username || user.id || '?';
}

// Embed standard pour chaque commande staff
function buildStaffLogEmbed({ command, user, guild, channel, detail, success = true, extraFields = [] }) {
  const color = success === false ? '#ff0000' : success === true ? '#2ecc71' : '#206694';
  const safeCommand = String(command || '?').slice(0, 200);
  const chanTxt = channel?.id ? `<#${channel.id}>` : '`?`';
  const userId = user?.id || '?';
  let desc =
    `**Utilisateur :** ${formatUserMention(user)} (\`${userId}\` — ${userLabel(user)})\n` +
    `**Salon :** ${chanTxt}\n` +
    `**Serveur :** ${guild ? `**${guild.name || '?'}** (\`${guild.id || '?'}\`)` : '`MP / ?`'}` +
    (detail ? `\n\n${String(detail)}` : '');
  // Limite Discord : 4096 caractères max pour la description
  if (desc.length > 4000) desc = desc.slice(0, 4000) + '\n… *(tronqué)*';
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`📋 ${safeCommand}`)
    .setDescription(desc)
    .setTimestamp()
    .setFooter({ text: 'Phénix • Logs Staff' });
  if (user?.displayAvatarURL) {
    try { embed.setThumbnail(user.displayAvatarURL({ size: 64 })); } catch {}
  }
  if (extraFields?.length) embed.addFields(extraFields.slice(0, 5));
  return embed;
}

async function sendStaffLog(client, getChannelId, payload = {}) {
  const channelId = typeof getChannelId === 'string' ? getChannelId : typeof getChannelId === 'function' ? getChannelId() : undefined;
  // console toujours
  try {
    console.log(`[STAFF-LOG] ${payload.command} par ${payload.user?.tag || payload.user?.id || '?'} : ${String(payload.detail || '')}`.slice(0, 500));
  } catch {}
  if (!channelId) return;
  let embed;
  try {
    embed = buildStaffLogEmbed(payload);
  } catch (e) {
    console.log('[STAFF-LOG] construction embed impossible :', e.message);
    return;
  }
  try {
    const ch = await getLogChannel(client, channelId);
    if (!ch || !ch.isTextBased?.()) {
      console.log(`[STAFF-LOG] ❌ salon logs introuvable : ${channelId}`);
      return;
    }
    await ch.send({ embeds: [embed] }).catch((e) => console.log('[STAFF-LOG] envoi impossible :', e.message));
  } catch (e) {
    console.log('[STAFF-LOG] erreur :', e.message);
  }
}

module.exports = {
  DEFAULT_STAFF_LOG_ID,
  getStaffLogId,
  buildStaffLogEmbed,
  sendStaffLog,
};
