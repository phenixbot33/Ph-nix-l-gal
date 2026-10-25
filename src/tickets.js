// ============================================================
// Phénix Support — TICKETS v3 (rebuild à zéro)
// Un seul flux, aucun lien avec les stats :
//   panel [Ouvrir un ticket] -> modal (raison) -> salon privé
//   -> boutons : Prendre en charge / Transcript / Fermer
//   -> x!resolut : Oui (= ferme + supprime) / Non (= garde + ping)
// Règle d'or : ouvrir ou cliquer un ticket ne donne JAMAIS de stat.
// ============================================================
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

// IDs uniques préfixés "ticket:" — impossible à confondre avec
// les boutons de stats (eux préfixés "create_" / "stats_" / "raid_"...).
const TICKET_MODAL_ID = 'ticket:modal';
const TICKET_REASON_FIELD = 'ticket:reason';

const TICKET_IDS = {
  PANEL_OPEN: 'ticket:open',
  CLAIM: 'ticket:claim',
  TRANSCRIPT: 'ticket:transcript',
  CLOSE: 'ticket:close',
  CLOSE_CONFIRM: 'ticket:close:confirm',
  CLOSE_CANCEL: 'ticket:close:cancel',
  RESOLUT_YES: 'ticket:resolut:yes',
  RESOLUT_NO: 'ticket:resolut:no',
};

const PANEL_TITLE = '🎫 Support — Phénix';
const RESOLUT_TITLE = '❓ Ticket résolu ?';

// ---------- Panel complet (x!panel) : Ticket = +1 stat, Raid/SOS/Question = +1 stat ----------
function ticketPanelEmbed() {
  return new EmbedBuilder()
    .setColor('#206694')
    .setTitle(PANEL_TITLE)
    .setDescription('Clique sur un bouton :\n\n🎫 **Ticket** — ticket (+1 stat)\n🛡️ **Raid** — signaler un raid (+1 stat)\n🚨 **SOS** — urgence (+1 stat)\n❓ **Question** — question au staff (+1 stat)')
    .setFooter({ text: 'Phénix • Support par boutons' })
    .setTimestamp();
}

function ticketPanelRows() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('create_ticket')
      .setLabel('Ticket')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🎫'),
    new ButtonBuilder()
      .setCustomId('create_raid')
      .setLabel('Raid')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🛡️'),
    new ButtonBuilder()
      .setCustomId('create_sos')
      .setLabel('SOS')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🚨'),
    new ButtonBuilder()
      .setCustomId('create_question')
      .setLabel('Question')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('❓'),
  )];
}

// ---------- Panel ticket seul (x!panel-ticket) : uniquement "Ouvrir un ticket" ----------
function ticketOnlyPanelEmbed() {
  return new EmbedBuilder()
    .setColor('#206694')
    .setTitle(PANEL_TITLE)
    .setDescription('🎫 **Ticket** — clique pour créer un ticket')
    .setFooter({ text: 'Phénix • Support par boutons' })
    .setTimestamp();
}

function ticketOnlyPanelRows() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_IDS.PANEL_OPEN)
      .setLabel('Ticket')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🎫'),
  )];
}

// Vrai si le message est un panel ticket (sert à l'anti-doublon du x!panel)
// customId : le bouton à chercher — 'ticket:open' (x!panel-ticket) ou 'create_ticket' (x!panel)
// Sans arg accepté pour compat, mais toujours passer l'ID pour éviter les faux doublons.
function isTicketPanelMessage(m, customId) {
  try {
    const ids = customId ? [customId] : [TICKET_IDS.PANEL_OPEN, 'create_ticket'];
    return !!m
      && m.embeds?.some((e) => e.title === PANEL_TITLE)
      && m.components?.some((r) => r.components?.some((c) => ids.includes(c.customId)));
  } catch { return false; }
}

// ---------- Modal : la raison du ticket ----------
function buildTicketModal() {
  const modal = new ModalBuilder()
    .setCustomId(TICKET_MODAL_ID)
    .setTitle('Ouvrir un ticket');
  const reason = new TextInputBuilder()
    .setCustomId(TICKET_REASON_FIELD)
    .setLabel('Décris ton problème')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Ex : je veux signaler un membre, poser une question...')
    .setRequired(true)
    .setMinLength(5)
    .setMaxLength(1000);
  modal.addComponents(new ActionRowBuilder().addComponents(reason));
  return modal;
}

// Nom de salon sûr : ticket-pseudo-1234
function ticketChannelName(username, discriminatorOrId) {
  const clean = String(username || 'ticket').toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').slice(0, 20) || 'ticket';
  const suffix = String(discriminatorOrId || Date.now()).replace(/[^0-9]/g, '').slice(-4) || String(Math.floor(Math.random() * 9000) + 1000);
  return `ticket-${clean}-${suffix}`;
}

// ---------- Message posté dans le salon à la création ----------
function ticketOpenEmbed(owner, reason, claimedBy = null) {
  return new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('🎫 Ticket ouvert')
    .setDescription(`Bienvenue ${owner} !\nUn membre du staff va te prendre en charge.\n\n**Raison :**\n${reason || '*Aucune raison fournie*'}`)
    .addFields(
      { name: '👤 Ouvert par', value: `${owner} (\`${owner.id}\`)`, inline: true },
      { name: '📌 Pris en charge par', value: claimedBy ? `<@${claimedBy}>` : '*En attente*', inline: true },
    )
    .setFooter({ text: 'Phénix • Support Ticket' })
    .setTimestamp();
}

function ticketControlRows(claimed = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(TICKET_IDS.CLAIM).setLabel(claimed ? 'Pris en charge ✅' : 'Prendre en charge').setStyle(claimed ? ButtonStyle.Secondary : ButtonStyle.Success).setEmoji('🙋').setDisabled(!!claimed),
      new ButtonBuilder().setCustomId(TICKET_IDS.TRANSCRIPT).setLabel('Transcript').setStyle(ButtonStyle.Secondary).setEmoji('📝'),
      new ButtonBuilder().setCustomId(TICKET_IDS.CLOSE).setLabel('Fermer').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
    ),
  ];
}

// ---------- Confirmation de fermeture ----------
function ticketCloseConfirmEmbed() {
  return new EmbedBuilder()
    .setColor('#ff0000')
    .setTitle('🔒 Fermer le ticket ?')
    .setDescription('Le salon sera **verrouillé puis supprimé dans 5 secondes**.\nUn transcript sera envoyé dans les logs si configuré.')
    .setTimestamp();
}

function ticketCloseConfirmRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(TICKET_IDS.CLOSE_CONFIRM).setLabel('Confirmer la fermeture').setStyle(ButtonStyle.Danger).setEmoji('✅'),
      new ButtonBuilder().setCustomId(TICKET_IDS.CLOSE_CANCEL).setLabel('Annuler').setStyle(ButtonStyle.Secondary).setEmoji('↩️'),
    ),
  ];
}

// ---------- x!resolut : Oui = ferme + supprime / Non = garde + ping ----------
function ticketResolutEmbed(ownerId) {
  return new EmbedBuilder()
    .setColor('#f1c40f')
    .setTitle(RESOLUT_TITLE)
    .setDescription(`<@${ownerId}>, ton ticket est-il **résolu** ?\n\n✅ **Oui** → le ticket sera **fermé et supprimé** (transcript gardé)\n❌ **Non** → le ticket **reste ouvert**, le staff sera re-ping`)
    .setFooter({ text: 'Phénix • Confirmation résolution' })
    .setTimestamp();
}

function ticketResolutRows(disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(TICKET_IDS.RESOLUT_YES).setLabel('Oui, résolu').setStyle(ButtonStyle.Success).setEmoji('✅').setDisabled(!!disabled),
      new ButtonBuilder().setCustomId(TICKET_IDS.RESOLUT_NO).setLabel('Non, encore besoin').setStyle(ButtonStyle.Danger).setEmoji('❌').setDisabled(!!disabled),
    ),
  ];
}

// Vrai si le message est une question "résolu ?" avec boutons encore actifs
// (sert à l'anti-doublon du x!resolut : on ne repose pas la question 2 fois)
function isActiveResolutPrompt(m) {
  try {
    return !!m
      && m.embeds?.some((e) => e.title === RESOLUT_TITLE)
      && m.components?.some((r) => r.components?.some((c) =>
        (c.customId === TICKET_IDS.RESOLUT_YES || c.customId === TICKET_IDS.RESOLUT_NO) && !c.disabled));
  } catch { return false; }
}

// ---------- Transcript texte des N derniers messages ----------
async function buildTranscriptText(channel, limit = 100) {
  try {
    const msgs = await channel.messages.fetch({ limit }).catch(() => null);
    if (!msgs) return 'Transcript indisponible.';
    const sorted = [...msgs.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const lines = sorted.map((m) => {
      const date = new Date(m.createdTimestamp).toLocaleString('fr-FR');
      const author = `${m.author?.tag || 'Inconnu'} (${m.author?.id || '?'})`;
      const content = m.content || (m.embeds?.length ? `[embed: ${m.embeds[0].title || m.embeds[0].description?.slice(0, 80) || 'embed'}]` : '[sans contenu texte]');
      const att = m.attachments?.size ? ` [${m.attachments.size} pièce(s) jointe(s)]` : '';
      return `[${date}] ${author} : ${content}${att}`;
    });
    return `TRANSCRIPT — #${channel.name} (${channel.id})\nGénéré le ${new Date().toLocaleString('fr-FR')}\n${'='.repeat(50)}\n` + lines.join('\n');
  } catch (e) {
    return `Transcript impossible : ${e.message}`;
  }
}

module.exports = {
  TICKET_MODAL_ID,
  TICKET_REASON_FIELD,
  TICKET_IDS,
  PANEL_TITLE,
  RESOLUT_TITLE,
  ticketPanelEmbed,
  ticketPanelRows,
  ticketOnlyPanelEmbed,
  ticketOnlyPanelRows,
  isTicketPanelMessage,
  buildTicketModal,
  ticketChannelName,
  ticketOpenEmbed,
  ticketControlRows,
  ticketCloseConfirmEmbed,
  ticketCloseConfirmRows,
  ticketResolutEmbed,
  ticketResolutRows,
  isActiveResolutPrompt,
  buildTranscriptText,
};
