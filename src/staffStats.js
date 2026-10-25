const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const STATS_TYPES = ['raid', 'sos', 'ticket', 'question', 'total'];

const TYPE_META = {
  raid: { emoji: '🛡️', label: 'RAID', color: '#ff0000' },
  sos: { emoji: '🚨', label: 'SOS', color: '#ffa500' },
  ticket: { emoji: '🎫', label: 'TICKET', color: '#5865F2' },
  question: { emoji: '❓', label: 'QUESTION', color: '#00b0f4' },
  total: { emoji: '🏆', label: 'TOTAL', color: '#206694' },
};

function normalizeType(t) {
  t = String(t || 'total').toLowerCase();
  return STATS_TYPES.includes(t) ? t : 'total';
}

function medal(i) {
  if (i === 0) return '🥇';
  if (i === 1) return '🥈';
  if (i === 2) return '🥉';
  return `**${i + 1}.**`;
}

function buildUserStatsEmbed(user, stats) {
  const total = (stats.raid || 0) + (stats.sos || 0) + (stats.ticket || 0) + (stats.question || 0);
  return new EmbedBuilder()
    .setColor('#206694')
    .setTitle(`📊 Stats Staff — ${user.tag || user.id}`)
    .setThumbnail(user.displayAvatarURL ? user.displayAvatarURL({ size: 128 }) : null)
    .addFields(
      { name: '🛡️ RAID', value: `**${stats.raid || 0}**`, inline: true },
      { name: '🚨 SOS', value: `**${stats.sos || 0}**`, inline: true },
      { name: '🎫 TICKET', value: `**${stats.ticket || 0}**`, inline: true },
      { name: '❓ QUESTION', value: `**${stats.question || 0}**`, inline: true },
      { name: '🏆 TOTAL', value: `**${total}** intervention(s)`, inline: false },
    )
    .setFooter({ text: `ID: ${user.id} • Phénix Stats Staff` })
    .setTimestamp();
}

function buildTopEmbed(rows, type, fetchUser) {
  const t = normalizeType(type);
  const meta = TYPE_META[t];
  const valueOf = (r) => t === 'total' ? r.total : (r[t] || 0);
  const lines = rows.length === 0
    ? 'Aucune stat pour le moment.\nChaque alerte traitée rapporte **+1** (RAID / SOS / TICKET / QUESTION).'
    : rows.map((r, i) => {
        const u = fetchUser ? fetchUser(r.userId) : null;
        const name = u ? `${u.tag}` : `ID ${r.userId}`;
        return `${medal(i)} <@${r.userId}> (${name}) — **${valueOf(r)}** ${meta.label} \`[🛡️${r.raid} 🚨${r.sos} 🎫${r.ticket} ❓${r.question || 0}]\``;
      }).join('\n');
  return new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${meta.emoji} Top Staff — ${meta.label}`)
    .setDescription(lines.slice(0, 4000))
    .setFooter({ text: 'Phénix • Stats Staff — +1 par traitement' })
    .setTimestamp();
}

function statsPanelEmbed() {
  return new EmbedBuilder()
    .setColor('#206694')
    .setTitle('📊 Stats Staff — Phénix')
    .setDescription('Clique sur un bouton pour afficher le classement :\n\n🛡️ **RAID** — raids traités\n🚨 **SOS** — SOS traités\n🎫 **TICKET** — tickets/reports traités\n❓ **QUESTION** — questions traitées\n🏆 **TOTAL** — tout cumulé')
    .setFooter({ text: 'Phénix • Panneau Stats Staff' })
    .setTimestamp();
}

function statsPanelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('stats_show:raid').setLabel('RAID').setStyle(ButtonStyle.Danger).setEmoji('🛡️'),
      new ButtonBuilder().setCustomId('stats_show:sos').setLabel('SOS').setStyle(ButtonStyle.Primary).setEmoji('🚨'),
      new ButtonBuilder().setCustomId('stats_show:ticket').setLabel('TICKET').setStyle(ButtonStyle.Secondary).setEmoji('🎫'),
      new ButtonBuilder().setCustomId('stats_show:question').setLabel('QUESTION').setStyle(ButtonStyle.Primary).setEmoji('❓'),
      new ButtonBuilder().setCustomId('stats_show:total').setLabel('TOTAL').setStyle(ButtonStyle.Success).setEmoji('🏆'),
    ),
  ];
}

function interventionRow(kind, id, done) {
  // Un seul bouton : le premier staff qui clique sur Traité gagne +1, sans prise en charge
  const prefix = String(kind || 'ticket').toLowerCase();
  const emoji = prefix === 'raid' ? '🛡️' : prefix === 'sos' ? '🚨' : prefix === 'question' ? '❓' : '🎫';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}_done:${id}`)
      .setLabel(done ? 'Traité' : 'Traité (+1)')
      .setStyle(done ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setEmoji(done ? '✅' : emoji)
      .setDisabled(!!done)
  );
}

module.exports = {
  STATS_TYPES,
  TYPE_META,
  normalizeType,
  buildUserStatsEmbed,
  buildTopEmbed,
  statsPanelEmbed,
  statsPanelRows,
  interventionRow,
};
