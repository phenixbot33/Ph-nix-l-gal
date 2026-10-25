// Phénix Support — DB légère : node:sqlite (intégré à Node 22+, aucun binaire natif à compiler)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const db = new DatabaseSync(path.join(__dirname, '..', 'support.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS staff_stats (
    userId TEXT PRIMARY KEY,
    raid INTEGER NOT NULL DEFAULT 0,
    sos INTEGER NOT NULL DEFAULT 0,
    ticket INTEGER NOT NULL DEFAULT 0,
    question INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL
  )
`);

try {
  const cols = db.prepare(`PRAGMA table_info(staff_stats)`).all().map(c => c.name);
  if (!cols.includes('question')) db.exec(`ALTER TABLE staff_stats ADD COLUMN question INTEGER NOT NULL DEFAULT 0`);
} catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS staff_interventions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    messageId TEXT,
    channelId TEXT,
    guildId TEXT NOT NULL,
    requesterId TEXT,
    requesterTag TEXT,
    detail TEXT,
    claimedBy TEXT,
    claimedAt INTEGER,
    resolved INTEGER DEFAULT 0,
    resolvedAt INTEGER,
    createdAt INTEGER NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS raid_claims (
    raidId TEXT PRIMARY KEY,
    messageId TEXT,
    guildId TEXT NOT NULL,
    channelId TEXT,
    raiderId TEXT,
    raiderTag TEXT,
    reason TEXT,
    sanction TEXT,
    claimedBy TEXT,
    claimedAt INTEGER,
    resolved INTEGER DEFAULT 0,
    resolvedAt INTEGER,
    createdAt INTEGER NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    channelId TEXT PRIMARY KEY,
    guildId TEXT NOT NULL,
    ownerId TEXT NOT NULL,
    ownerTag TEXT,
    reason TEXT,
    claimedBy TEXT,
    claimedAt INTEGER,
    status TEXT NOT NULL DEFAULT 'open',
    createdAt INTEGER NOT NULL,
    closedAt INTEGER
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tickets_owner ON tickets(ownerId, status)`);

module.exports = {
  // ===== STATS =====
  incStaffStat(userId, type) {
    const t = String(type || '').toLowerCase();
    if (!['raid', 'sos', 'ticket', 'question'].includes(t)) return null;
    const now = Date.now();
    db.prepare('INSERT INTO staff_stats (userId, raid, sos, ticket, question, updatedAt) VALUES (?, 0, 0, 0, 0, ?) ON CONFLICT(userId) DO NOTHING').run(userId, now);
    db.prepare(`UPDATE staff_stats SET ${t} = ${t} + 1, updatedAt = ? WHERE userId = ?`).run(now, userId);
    return this.getStaffStats(userId);
  },
  getStaffStats(userId) {
    const row = db.prepare('SELECT userId, raid, sos, ticket, question, updatedAt FROM staff_stats WHERE userId = ?').get(userId);
    if (!row) return { userId, raid: 0, sos: 0, ticket: 0, question: 0, total: 0, updatedAt: null };
    return { ...row, question: row.question || 0, total: (row.raid || 0) + (row.sos || 0) + (row.ticket || 0) + (row.question || 0) };
  },
  getStaffTop(type = 'total', limit = 10) {
    const t = String(type || 'total').toLowerCase();
    const col = ['raid', 'sos', 'ticket', 'question'].includes(t) ? t : null;
    const orderBy = col ? `${col} DESC, (raid + sos + ticket + COALESCE(question,0)) DESC` : '(raid + sos + ticket + COALESCE(question,0)) DESC';
    const lim = Math.max(1, Math.min(25, parseInt(limit) || 10));
    const rows = db.prepare(`SELECT userId, raid, sos, ticket, COALESCE(question,0) AS question, updatedAt FROM staff_stats ORDER BY ${orderBy} LIMIT ?`).all(lim);
    return rows.map(r => ({ ...r, total: (r.raid || 0) + (r.sos || 0) + (r.ticket || 0) + (r.question || 0) }));
  },
  resetStaffStats(userId) {
    if (userId) return db.prepare('DELETE FROM staff_stats WHERE userId = ?').run(userId);
    return db.prepare('DELETE FROM staff_stats').run();
  },
  resetStaffStatType(userId, type) {
    const t = String(type || '').toLowerCase();
    if (t === 'total') return this.resetStaffStats(userId);
    if (!['raid', 'sos', 'ticket', 'question'].includes(t)) return null;
    db.prepare('INSERT INTO staff_stats (userId, raid, sos, ticket, question, updatedAt) VALUES (?, 0, 0, 0, 0, ?) ON CONFLICT(userId) DO NOTHING').run(userId, Date.now());
    return db.prepare(`UPDATE staff_stats SET ${t} = 0, updatedAt = ? WHERE userId = ?`).run(Date.now(), userId);
  },

  // ===== INTERVENTIONS SOS / TICKET / QUESTION =====
  createIntervention(id, kind, guildId, requesterId, requesterTag, detail) {
    return db.prepare('INSERT OR REPLACE INTO staff_interventions (id, kind, guildId, requesterId, requesterTag, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, String(kind || '').toLowerCase(), guildId, requesterId, requesterTag, (detail || '').slice(0, 1000), Date.now());
  },
  setInterventionMessage(id, messageId, channelId) {
    return db.prepare('UPDATE staff_interventions SET messageId = ?, channelId = ? WHERE id = ?').run(messageId, channelId, id);
  },
  getIntervention(id) {
    return db.prepare('SELECT * FROM staff_interventions WHERE id = ?').get(id);
  },
  claimIntervention(id, userId) {
    return db.prepare('UPDATE staff_interventions SET claimedBy = ?, claimedAt = ? WHERE id = ? AND claimedBy IS NULL').run(userId, Date.now(), id).changes > 0;
  },
  resolveIntervention(id) {
    return db.prepare('UPDATE staff_interventions SET resolved = 1, resolvedAt = ? WHERE id = ?').run(Date.now(), id);
  },
  deleteIntervention(id) {
    return db.prepare('DELETE FROM staff_interventions WHERE id = ?').run(id);
  },

  // ===== RAIDS =====
  createRaid(raidId, guildId, raiderId, raiderTag, reason, sanction) {
    return db.prepare('INSERT INTO raid_claims (raidId, guildId, raiderId, raiderTag, reason, sanction, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(raidId, guildId, raiderId, raiderTag, reason, sanction, Date.now());
  },
  setRaidMessage(raidId, messageId, channelId) {
    return db.prepare('UPDATE raid_claims SET messageId = ?, channelId = ? WHERE raidId = ?').run(messageId, channelId, raidId);
  },
  getRaid(raidId) {
    return db.prepare('SELECT * FROM raid_claims WHERE raidId = ?').get(raidId);
  },
  claimRaid(raidId, userId) {
    return db.prepare('UPDATE raid_claims SET claimedBy = ?, claimedAt = ? WHERE raidId = ? AND claimedBy IS NULL').run(userId, Date.now(), raidId).changes > 0;
  },
  deleteRaid(raidId) {
    return db.prepare('DELETE FROM raid_claims WHERE raidId = ?').run(raidId);
  },
  dumpRaidsToJson() {
    try {
      const rows = db.prepare('SELECT * FROM raid_claims').all();
      fs.writeFileSync(path.join(__dirname, '..', 'raids.json'), JSON.stringify(rows, null, 2));
    } catch {}
  },

  // ===== TICKETS (salons privés) =====
  createTicket(channelId, guildId, ownerId, ownerTag, reason) {
    return db.prepare('INSERT OR REPLACE INTO tickets (channelId, guildId, ownerId, ownerTag, reason, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(channelId, guildId, ownerId, ownerTag, (reason || '').slice(0, 1000), 'open', Date.now());
  },
  getTicket(channelId) {
    return db.prepare('SELECT * FROM tickets WHERE channelId = ?').get(channelId);
  },
  getOpenTicketByUser(ownerId, guildId) {
    if (guildId) return db.prepare("SELECT * FROM tickets WHERE ownerId = ? AND guildId = ? AND status = 'open' LIMIT 1").get(ownerId, guildId);
    return db.prepare("SELECT * FROM tickets WHERE ownerId = ? AND status = 'open' LIMIT 1").get(ownerId);
  },
  listOpenTicketsByUser(ownerId, guildId) {
    if (guildId) return db.prepare("SELECT * FROM tickets WHERE ownerId = ? AND guildId = ? AND status = 'open' ORDER BY createdAt ASC").all(ownerId, guildId);
    return db.prepare("SELECT * FROM tickets WHERE ownerId = ? AND status = 'open' ORDER BY createdAt ASC").all(ownerId);
  },
  listAllOpenTickets() {
    return db.prepare("SELECT * FROM tickets WHERE status = 'open' ORDER BY createdAt ASC").all();
  },
  countOpenTicketsByUser(ownerId, guildId) {
    const row = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE ownerId = ? AND guildId = ? AND status = 'open'").get(ownerId, guildId);
    return row?.n || 0;
  },
  listOpenTickets(guildId) {
    return db.prepare("SELECT * FROM tickets WHERE guildId = ? AND status = 'open' ORDER BY createdAt ASC").all(guildId);
  },
  claimTicket(channelId, userId) {
    return db.prepare('UPDATE tickets SET claimedBy = ?, claimedAt = ? WHERE channelId = ? AND claimedBy IS NULL').run(userId, Date.now(), channelId).changes > 0;
  },
  closeTicket(channelId) {
    return db.prepare("UPDATE tickets SET status = 'closed', closedAt = ? WHERE channelId = ?").run(Date.now(), channelId);
  },
  deleteTicket(channelId) {
    return db.prepare('DELETE FROM tickets WHERE channelId = ?').run(channelId);
  },

  // ===== SUGGESTIONS (x!poste-suggestion) =====
  createSuggestion(id, guildId, authorId, authorTag, text) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS suggestions (
        id TEXT PRIMARY KEY,
        guildId TEXT NOT NULL,
        channelId TEXT,
        messageId TEXT,
        authorId TEXT NOT NULL,
        authorTag TEXT,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        decidedBy TEXT,
        decidedAt INTEGER,
        createdAt INTEGER NOT NULL
      )
    `);
    return db.prepare('INSERT OR REPLACE INTO suggestions (id, guildId, authorId, authorTag, text, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, guildId, authorId, authorTag, (text || '').slice(0, 1000), 'open', Date.now());
  },
  setSuggestionMessage(id, channelId, messageId) {
    try { return db.prepare('UPDATE suggestions SET channelId = ?, messageId = ? WHERE id = ?').run(channelId, messageId, id); } catch { return null; }
  },
  getSuggestion(id) {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS suggestions (id TEXT PRIMARY KEY, guildId TEXT NOT NULL, channelId TEXT, messageId TEXT, authorId TEXT NOT NULL, authorTag TEXT, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', decidedBy TEXT, decidedAt INTEGER, createdAt INTEGER NOT NULL)`);
      return db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
    } catch { return null; }
  },
  decideSuggestion(id, userId) {
    try { return db.prepare("UPDATE suggestions SET status = 'decided', decidedBy = ?, decidedAt = ? WHERE id = ? AND status IN ('open', 'dev')").run(userId, Date.now(), id).changes > 0; } catch { return false; }
  },
  setSuggestionDev(id, userId) {
    try { return db.prepare("UPDATE suggestions SET status = 'dev', decidedBy = ?, decidedAt = ? WHERE id = ? AND status IN ('open', 'dev')").run(userId, Date.now(), id).changes > 0; } catch { return false; }
  },
  countOpenSuggestions(guildId) {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS suggestions (id TEXT PRIMARY KEY, guildId TEXT NOT NULL, channelId TEXT, messageId TEXT, authorId TEXT NOT NULL, authorTag TEXT, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', decidedBy TEXT, decidedAt INTEGER, createdAt INTEGER NOT NULL)`);
      if (guildId) return db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE guildId = ? AND status = 'open'").get(guildId)?.n || 0;
      return db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE status = 'open'").get()?.n || 0;
    } catch { return 0; }
  },

  // ===== BUGS (px!bug) =====
  ensureBugColumns() {
    try { db.exec(`CREATE TABLE IF NOT EXISTS bug_reports (id TEXT PRIMARY KEY, guildId TEXT NOT NULL, channelId TEXT, messageId TEXT, authorId TEXT NOT NULL, authorTag TEXT, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolvedBy TEXT, resolvedAt INTEGER, createdAt INTEGER NOT NULL)`); } catch {}
    try {
      const cols = db.prepare('PRAGMA table_info(bug_reports)').all().map(c => c.name);
      if (!cols.includes('status')) db.exec(`ALTER TABLE bug_reports ADD COLUMN status TEXT NOT NULL DEFAULT 'open'`);
      if (!cols.includes('resolvedBy')) db.exec(`ALTER TABLE bug_reports ADD COLUMN resolvedBy TEXT`);
      if (!cols.includes('resolvedAt')) db.exec(`ALTER TABLE bug_reports ADD COLUMN resolvedAt INTEGER`);
    } catch {}
  },
  createBugReport(id, guildId, authorId, authorTag, text) {
    this.ensureBugColumns();
    return db.prepare("INSERT OR REPLACE INTO bug_reports (id, guildId, authorId, authorTag, text, status, createdAt) VALUES (?, ?, ?, ?, ?, 'open', ?)").run(id, guildId, authorId, authorTag, (text || '').slice(0, 1000), Date.now());
  },
  setBugMessage(id, channelId, messageId) {
    try { this.ensureBugColumns(); return db.prepare('UPDATE bug_reports SET channelId = ?, messageId = ? WHERE id = ?').run(channelId, messageId, id); } catch { return null; }
  },
  getBugReport(id) {
    try { this.ensureBugColumns(); return db.prepare('SELECT * FROM bug_reports WHERE id = ?').get(id); } catch { return null; }
  },
  resolveBugReport(id, userId) {
    try { this.ensureBugColumns(); return db.prepare("UPDATE bug_reports SET status = 'resolved', resolvedBy = ?, resolvedAt = ? WHERE id = ? AND status IN ('open', 'dev')").run(userId, Date.now(), id).changes > 0; } catch { return false; }
  },
  setBugDev(id, userId) {
    try { this.ensureBugColumns(); return db.prepare("UPDATE bug_reports SET status = 'dev', resolvedBy = ?, resolvedAt = ? WHERE id = ? AND status IN ('open', 'dev')").run(userId, Date.now(), id).changes > 0; } catch { return false; }
  },
  listBugReports(limit) {
    try {
      this.ensureBugColumns();
      const lim = Math.max(1, Math.min(25, parseInt(limit) || 10));
      return db.prepare('SELECT * FROM bug_reports ORDER BY createdAt DESC LIMIT ?').all(lim);
    } catch { return []; }
  },
  clearBugReports() {
    try { this.ensureBugColumns(); return db.prepare('DELETE FROM bug_reports').run().changes || 0; } catch { return 0; }
  },

  // ===== BLACKLIST BOTS (f!bl-bot) =====
  addBotBlacklist(userId, tag, reason, addedBy) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bot_blacklist (
        userId TEXT PRIMARY KEY,
        tag TEXT,
        reason TEXT,
        addedBy TEXT,
        createdAt INTEGER NOT NULL
      )
    `);
    return db.prepare('INSERT OR REPLACE INTO bot_blacklist (userId, tag, reason, addedBy, createdAt) VALUES (?, ?, ?, ?, ?)').run(userId, tag || '', (reason || '').slice(0, 500), addedBy || '', Date.now());
  },
  removeBotBlacklist(userId) {
    try { return db.prepare('DELETE FROM bot_blacklist WHERE userId = ?').run(userId).changes > 0; }
    catch { return false; }
  },
  isBotBlacklisted(userId) {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS bot_blacklist (userId TEXT PRIMARY KEY, tag TEXT, reason TEXT, addedBy TEXT, createdAt INTEGER NOT NULL)`);
      return !!db.prepare('SELECT userId FROM bot_blacklist WHERE userId = ?').get(userId);
    } catch { return false; }
  },
  listBotBlacklist() {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS bot_blacklist (userId TEXT PRIMARY KEY, tag TEXT, reason TEXT, addedBy TEXT, createdAt INTEGER NOT NULL)`);
      return db.prepare('SELECT * FROM bot_blacklist ORDER BY createdAt ASC').all();
    } catch { return []; }
  },

  // ===== BLACKLIST UTILISATEURS (f!bl) — compat ancien bot Anti-RAID =====
  ensureUserBlacklist() {
    try { db.exec(`CREATE TABLE IF NOT EXISTS user_blacklist (userId TEXT PRIMARY KEY, tag TEXT, reason TEXT NOT NULL, proofs TEXT NOT NULL DEFAULT '[]', addedBy TEXT NOT NULL, addedAt INTEGER NOT NULL)`); } catch {}
    try {
      const cols = db.prepare('PRAGMA table_info(user_blacklist)').all().map(c => c.name);
      if (!cols.includes('proofs')) db.exec(`ALTER TABLE user_blacklist ADD COLUMN proofs TEXT NOT NULL DEFAULT '[]'`);
      if (!cols.includes('tag')) db.exec(`ALTER TABLE user_blacklist ADD COLUMN tag TEXT`);
      // Compat ancien schéma (createdAt au lieu de addedAt) : ajoute + migre, sinon f!bl crash
      if (!cols.includes('addedAt')) {
        db.exec(`ALTER TABLE user_blacklist ADD COLUMN addedAt INTEGER NOT NULL DEFAULT 0`);
        try { if (cols.includes('createdAt')) db.exec(`UPDATE user_blacklist SET addedAt = createdAt WHERE addedAt = 0 OR addedAt IS NULL`); } catch {}
      }
      if (!cols.includes('createdAt')) {
        try { db.exec(`ALTER TABLE user_blacklist ADD COLUMN createdAt INTEGER NOT NULL DEFAULT 0`); } catch {}
      }
    } catch {}
  },
  addUserBlacklist(userId, tag, reason, addedBy, proofs) {
    this.ensureUserBlacklist();
    let p = '[]';
    try { p = JSON.stringify(Array.isArray(proofs) ? proofs.slice(0, 10) : []); } catch { p = '[]'; }
    const now = Date.now();
    return db.prepare('INSERT OR REPLACE INTO user_blacklist (userId, tag, reason, proofs, addedBy, addedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(userId, tag || '', (reason || 'Aucune raison').slice(0, 1000), p, addedBy || '', now, now);
  },
  removeUserBlacklist(userId) {
    try { this.ensureUserBlacklist(); return db.prepare('DELETE FROM user_blacklist WHERE userId = ?').run(userId).changes > 0; }
    catch { return false; }
  },
  getUserBlacklist(userId) {
    try { this.ensureUserBlacklist(); return db.prepare('SELECT * FROM user_blacklist WHERE userId = ?').get(userId) || null; }
    catch { return null; }
  },
  isUserBlacklisted(userId) {
    try { this.ensureUserBlacklist(); return !!db.prepare('SELECT userId FROM user_blacklist WHERE userId = ?').get(userId); }
    catch { return false; }
  },
  listUserBlacklist() {
    try { this.ensureUserBlacklist(); return db.prepare('SELECT * FROM user_blacklist ORDER BY addedAt ASC').all(); }
    catch { return []; }
  },

  // ===== WHITELIST UTILISATEURS / BOTS (f!wl, f!wl-bot) =====
  ensureUserWhitelist() {
    try { db.exec(`CREATE TABLE IF NOT EXISTS user_whitelist (userId TEXT PRIMARY KEY, tag TEXT, reason TEXT, addedBy TEXT, addedAt INTEGER NOT NULL)`); } catch {}
  },
  addUserWhitelist(userId, tag, reason, addedBy) {
    this.ensureUserWhitelist();
    return db.prepare('INSERT OR REPLACE INTO user_whitelist (userId, tag, reason, addedBy, addedAt) VALUES (?, ?, ?, ?, ?)').run(userId, tag || '', (reason || 'Aucune raison').slice(0, 500), addedBy || '', Date.now());
  },
  removeUserWhitelist(userId) {
    try { this.ensureUserWhitelist(); return db.prepare('DELETE FROM user_whitelist WHERE userId = ?').run(userId).changes > 0; }
    catch { return false; }
  },
  isUserWhitelisted(userId) {
    try { this.ensureUserWhitelist(); return !!db.prepare('SELECT userId FROM user_whitelist WHERE userId = ?').get(userId); }
    catch { return false; }
  },
  listUserWhitelist() {
    try { this.ensureUserWhitelist(); return db.prepare('SELECT * FROM user_whitelist ORDER BY addedAt ASC').all(); }
    catch { return []; }
  },
  ensureBotWhitelist() {
    try { db.exec(`CREATE TABLE IF NOT EXISTS bot_whitelist (userId TEXT PRIMARY KEY, tag TEXT, reason TEXT, addedBy TEXT, addedAt INTEGER NOT NULL)`); } catch {}
  },
  addBotWhitelist(userId, tag, reason, addedBy) {
    this.ensureBotWhitelist();
    return db.prepare('INSERT OR REPLACE INTO bot_whitelist (userId, tag, reason, addedBy, addedAt) VALUES (?, ?, ?, ?, ?)').run(userId, tag || '', (reason || 'Aucune raison').slice(0, 500), addedBy || '', Date.now());
  },
  removeBotWhitelist(userId) {
    try { this.ensureBotWhitelist(); return db.prepare('DELETE FROM bot_whitelist WHERE userId = ?').run(userId).changes > 0; }
    catch { return false; }
  },
  isBotWhitelisted(userId) {
    try { this.ensureBotWhitelist(); return !!db.prepare('SELECT userId FROM bot_whitelist WHERE userId = ?').get(userId); }
    catch { return false; }
  },
  listBotWhitelist() {
    try { this.ensureBotWhitelist(); return db.prepare('SELECT * FROM bot_whitelist ORDER BY addedAt ASC').all(); }
    catch { return []; }
  },

  // ===== STAFF GLOBAL SAUVEGARDÉ (f!staff add/remove/list, valable partout) =====
  ensureGlobalStaff() {
    try { db.exec(`CREATE TABLE IF NOT EXISTS global_staff (userId TEXT PRIMARY KEY, level TEXT NOT NULL DEFAULT 'staff', addedBy TEXT, addedAt INTEGER NOT NULL)`); } catch {}
  },
  addGlobalStaff(userId, level, addedBy) {
    this.ensureGlobalStaff();
    return db.prepare(`INSERT OR REPLACE INTO global_staff (userId, level, addedBy, addedAt) VALUES (?, ?, ?, ?)`).run(userId, level || 'staff', addedBy || '', Date.now());
  },
  removeGlobalStaff(userId) {
    try { this.ensureGlobalStaff(); return db.prepare('DELETE FROM global_staff WHERE userId = ?').run(userId).changes > 0; }
    catch { return false; }
  },
  isGlobalStaff(userId) {
    try { this.ensureGlobalStaff(); return !!db.prepare('SELECT userId FROM global_staff WHERE userId = ?').get(userId); }
    catch { return false; }
  },
  getGlobalStaff(userId) {
    try { this.ensureGlobalStaff(); return db.prepare('SELECT * FROM global_staff WHERE userId = ?').get(userId) || null; }
    catch { return null; }
  },
  listGlobalStaff() {
    try { this.ensureGlobalStaff(); return db.prepare('SELECT * FROM global_staff ORDER BY addedAt ASC').all(); }
    catch { return []; }
  },

  // ===== SERVEURS BLACKLISTÉS (f!sbl) =====
  ensureServerBlacklist() {
    try { db.exec(`CREATE TABLE IF NOT EXISTS server_blacklist (guildId TEXT PRIMARY KEY, name TEXT, reason TEXT NOT NULL, addedBy TEXT NOT NULL, addedAt INTEGER NOT NULL)`); } catch {}
  },
  addServerBlacklist(guildId, name, reason, addedBy) {
    this.ensureServerBlacklist();
    return db.prepare('INSERT OR REPLACE INTO server_blacklist (guildId, name, reason, addedBy, addedAt) VALUES (?, ?, ?, ?, ?)').run(guildId, name || '', (reason || 'Aucune raison').slice(0, 1000), addedBy || '', Date.now());
  },
  removeServerBlacklist(guildId) {
    try { this.ensureServerBlacklist(); return db.prepare('DELETE FROM server_blacklist WHERE guildId = ?').run(guildId).changes > 0; }
    catch { return false; }
  },
  getServerBlacklist(guildId) {
    try { this.ensureServerBlacklist(); return db.prepare('SELECT * FROM server_blacklist WHERE guildId = ?').get(guildId) || null; }
    catch { return null; }
  },
  listServerBlacklist() {
    try { this.ensureServerBlacklist(); return db.prepare('SELECT * FROM server_blacklist ORDER BY addedAt ASC').all(); }
    catch { return []; }
  },

  // ===== BLOCAGE COMMANDES (f!block) — l'utilisateur ne peut plus utiliser le bot =====
  ensureCmdBlocks() {
    try { db.exec(`CREATE TABLE IF NOT EXISTS cmd_blocks (userId TEXT PRIMARY KEY, reason TEXT NOT NULL, blockedBy TEXT NOT NULL, blockedAt INTEGER NOT NULL)`); } catch {}
  },
  blockCommands(userId, reason, blockedBy) {
    this.ensureCmdBlocks();
    return db.prepare('INSERT OR REPLACE INTO cmd_blocks (userId, reason, blockedBy, blockedAt) VALUES (?, ?, ?, ?)').run(userId, (reason || 'Aucune raison').slice(0, 500), blockedBy || '', Date.now());
  },
  unblockCommands(userId) {
    try { this.ensureCmdBlocks(); return db.prepare('DELETE FROM cmd_blocks WHERE userId = ?').run(userId).changes > 0; }
    catch { return false; }
  },
  isCommandBlocked(userId) {
    try { this.ensureCmdBlocks(); return db.prepare('SELECT * FROM cmd_blocks WHERE userId = ?').get(userId) || null; }
    catch { return null; }
  },
  listCommandBlocks() {
    try { this.ensureCmdBlocks(); return db.prepare('SELECT * FROM cmd_blocks ORDER BY blockedAt ASC').all(); }
    catch { return []; }
  },

  // ===== ANTIRAID ON/OFF par serveur (F!offar / F!onar) — compat ancien bot =====
  ensureAntiraidDisabled() {
    try { db.exec(`CREATE TABLE IF NOT EXISTS antiraid_disabled (guildId TEXT PRIMARY KEY, disabledBy TEXT NOT NULL, disabledAt INTEGER NOT NULL)`); } catch {}
  },
  setAntiraidDisabled(guildId, disabledBy) {
    this.ensureAntiraidDisabled();
    return db.prepare('INSERT OR REPLACE INTO antiraid_disabled (guildId, disabledBy, disabledAt) VALUES (?, ?, ?)').run(guildId, disabledBy || '', Date.now());
  },
  setAntiraidEnabled(guildId) {
    try { this.ensureAntiraidDisabled(); return db.prepare('DELETE FROM antiraid_disabled WHERE guildId = ?').run(guildId).changes > 0; }
    catch { return false; }
  },
  isAntiraidDisabled(guildId) {
    try { this.ensureAntiraidDisabled(); return !!db.prepare('SELECT guildId FROM antiraid_disabled WHERE guildId = ?').get(guildId); }
    catch { return false; }
  },
  listAntiraidDisabled() {
    try { this.ensureAntiraidDisabled(); return db.prepare('SELECT * FROM antiraid_disabled ORDER BY disabledAt ASC').all(); }
    catch { return []; }
  },

  // ===== WARNS / SANCTIONS (PX!warn, PX!unwarn, PX!sanction) — compat ancien bot =====
  ensureWarns() {
    try { db.exec(`CREATE TABLE IF NOT EXISTS warns (id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT NOT NULL, guildId TEXT NOT NULL, reason TEXT NOT NULL, warnedBy TEXT NOT NULL, warnedAt INTEGER NOT NULL)`); } catch {}
  },
  addWarn(userId, guildId, reason, warnedBy) {
    this.ensureWarns();
    return db.prepare('INSERT INTO warns (userId, guildId, reason, warnedBy, warnedAt) VALUES (?, ?, ?, ?, ?)').run(userId, guildId, (reason || 'Aucune raison').slice(0, 500), warnedBy || '', Date.now()).lastInsertRowid;
  },
  removeWarn(id) {
    try { this.ensureWarns(); return db.prepare('DELETE FROM warns WHERE id = ?').run(Number(id)).changes > 0; }
    catch { return false; }
  },
  clearWarns(userId, guildId) {
    try { this.ensureWarns(); return db.prepare('DELETE FROM warns WHERE userId = ? AND guildId = ?').run(userId, guildId).changes || 0; }
    catch { return 0; }
  },
  listWarns(userId, guildId) {
    try { this.ensureWarns(); return db.prepare('SELECT * FROM warns WHERE userId = ? AND guildId = ? ORDER BY warnedAt DESC').all(userId, guildId); }
    catch { return []; }
  },
  countWarns(userId, guildId) {
    try { this.ensureWarns(); return db.prepare('SELECT COUNT(*) AS n FROM warns WHERE userId = ? AND guildId = ?').get(userId, guildId)?.n || 0; }
    catch { return 0; }
  },
  listRecentWarns(guildId, limit) {
    try {
      this.ensureWarns();
      const lim = Math.max(1, Math.min(25, parseInt(limit) || 10));
      return db.prepare('SELECT * FROM warns WHERE guildId = ? ORDER BY warnedAt DESC LIMIT ?').all(guildId, lim);
    } catch { return []; }
  },

  // ===== AFK (px!afk) =====
  ensureAfk() {
    try { db.exec(`CREATE TABLE IF NOT EXISTS afk (userId TEXT PRIMARY KEY, reason TEXT, since INTEGER NOT NULL, pings INTEGER NOT NULL DEFAULT 0)`); } catch {}
  },
  setAfk(userId, reason) {
    try { this.ensureAfk(); return db.prepare('INSERT OR REPLACE INTO afk (userId, reason, since, pings) VALUES (?, ?, ?, 0)').run(userId, (reason || 'Aucune raison').slice(0, 500), Date.now()); }
    catch { return null; }
  },
  getAfk(userId) {
    try { this.ensureAfk(); return db.prepare('SELECT * FROM afk WHERE userId = ?').get(userId) || null; }
    catch { return null; }
  },
  clearAfk(userId) {
    try {
      this.ensureAfk();
      const row = db.prepare('SELECT * FROM afk WHERE userId = ?').get(userId) || null;
      db.prepare('DELETE FROM afk WHERE userId = ?').run(userId);
      return row;
    } catch { return null; }
  },
  incAfkPings(userId, guildId) {
    try {
      this.ensureAfk();
      return db.prepare('UPDATE afk SET pings = pings + 1 WHERE userId = ?').run(userId).changes > 0;
    } catch { return false; }
  },

  // ===== USAR! ANTIRAID / ANTINUKE / SECURITY =====
  // ===== JAIL (prison configurable) =====
  ensureJail() {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS jail (
          guildId TEXT NOT NULL,
          userId TEXT NOT NULL,
          roles TEXT NOT NULL DEFAULT '[]',
          reason TEXT NOT NULL DEFAULT '',
          jailedBy TEXT NOT NULL DEFAULT '',
          jailedAt INTEGER NOT NULL,
          until INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (guildId, userId)
        )
      `);
    } catch {}
    try {
      const cols = db.prepare('PRAGMA table_info(jail)').all().map((c) => c.name);
      if (!cols.includes('until')) db.exec('ALTER TABLE jail ADD COLUMN until INTEGER NOT NULL DEFAULT 0');
    } catch {}
  },
  getJail(guildId, userId) {
    try {
      this.ensureJail();
      const r = db.prepare('SELECT * FROM jail WHERE guildId = ? AND userId = ?').get(guildId, userId);
      if (!r) return null;
      let roles = [];
      try { roles = JSON.parse(r.roles || '[]'); } catch {}
      return { ...r, roleIds: roles };
    } catch { return null; }
  },
  jailUser(guildId, userId, roleIds, reason, jailedBy, until = 0) {
    try {
      this.ensureJail();
      db.prepare(`INSERT INTO jail (guildId, userId, roles, reason, jailedBy, jailedAt, until) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(guildId, userId) DO UPDATE SET roles = excluded.roles, reason = excluded.reason, jailedBy = excluded.jailedBy, jailedAt = excluded.jailedAt, until = excluded.until`)
        .run(guildId, userId, JSON.stringify(roleIds || []), reason || '', jailedBy || '', Date.now(), until | 0);
      return true;
    } catch { return false; }
  },
  dueJails(now = Date.now()) {
    try {
      this.ensureJail();
      return db.prepare('SELECT * FROM jail WHERE until > 0 AND until <= ?').all(now);
    } catch { return []; }
  },
  unjailUser(guildId, userId) {
    try {
      this.ensureJail();
      return db.prepare('DELETE FROM jail WHERE guildId = ? AND userId = ?').run(guildId, userId).changes > 0;
    } catch { return false; }
  },
  listJailed(guildId) {
    try {
      this.ensureJail();
      return db.prepare('SELECT * FROM jail WHERE guildId = ? ORDER BY jailedAt DESC').all(guildId);
    } catch { return []; }
  },

  // ===== USAR! ANTIRAID / ANTINUKE / SECURITY =====
  ensureSecurity() {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS antiraid_cfg (
          guildId TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL DEFAULT 0,
          joinsLimit INTEGER NOT NULL DEFAULT 10,
          joinsWindow INTEGER NOT NULL DEFAULT 30,
          minAccountAge INTEGER NOT NULL DEFAULT 0,
          updatedAt INTEGER NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS antinuke_whitelist (
          guildId TEXT NOT NULL,
          userId TEXT NOT NULL,
          addedBy TEXT,
          addedAt INTEGER NOT NULL,
          PRIMARY KEY (guildId, userId)
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS security_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guildId TEXT NOT NULL,
          userId TEXT,
          action TEXT NOT NULL,
          detail TEXT,
          createdAt INTEGER NOT NULL
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_seclog_guild ON security_logs(guildId, createdAt)`);
    } catch {}
  },
  getAntiraidCfg(guildId) {
    try {
      this.ensureSecurity();
      const row = db.prepare('SELECT * FROM antiraid_cfg WHERE guildId = ?').get(guildId);
      if (!row) return { guildId, enabled: 0, joinsLimit: 10, joinsWindow: 30, minAccountAge: 0 };
      return row;
    } catch { return null; }
  },
  setAntiraidOn(guildId) {
    try {
      this.ensureSecurity();
      return db.prepare('INSERT INTO antiraid_cfg (guildId, enabled, joinsLimit, joinsWindow, minAccountAge, updatedAt) VALUES (?, 1, 10, 30, 0, ?) ON CONFLICT(guildId) DO UPDATE SET enabled = 1, updatedAt = ?').run(guildId, Date.now(), Date.now());
    } catch { return null; }
  },
  setAntiraidOff(guildId) {
    try {
      this.ensureSecurity();
      return db.prepare('UPDATE antiraid_cfg SET enabled = 0, updatedAt = ? WHERE guildId = ?').run(Date.now(), guildId);
    } catch { return null; }
  },
  setAntiraidLimit(guildId, joinsLimit, joinsWindow) {
    try {
      this.ensureSecurity();
      return db.prepare('INSERT INTO antiraid_cfg (guildId, enabled, joinsLimit, joinsWindow, minAccountAge, updatedAt) VALUES (?, 0, ?, ?, 0, ?) ON CONFLICT(guildId) DO UPDATE SET joinsLimit = ?, joinsWindow = ?, updatedAt = ?').run(guildId, joinsLimit, joinsWindow, Date.now(), joinsLimit, joinsWindow, Date.now());
    } catch { return null; }
  },
  setAntiraidAccountAge(guildId, days) {
    try {
      this.ensureSecurity();
      return db.prepare('INSERT INTO antiraid_cfg (guildId, enabled, joinsLimit, joinsWindow, minAccountAge, updatedAt) VALUES (?, 0, 10, 30, ?, ?) ON CONFLICT(guildId) DO UPDATE SET minAccountAge = ?, updatedAt = ?').run(guildId, days, Date.now(), days, Date.now());
    } catch { return null; }
  },
  listAntinukeWhitelist(guildId) {
    try {
      this.ensureSecurity();
      return db.prepare('SELECT * FROM antinuke_whitelist WHERE guildId = ? ORDER BY addedAt ASC').all(guildId);
    } catch { return []; }
  },
  addAntinukeWhitelist(guildId, userId, addedBy) {
    try {
      this.ensureSecurity();
      return db.prepare('INSERT OR IGNORE INTO antinuke_whitelist (guildId, userId, addedBy, addedAt) VALUES (?, ?, ?, ?)').run(guildId, userId, addedBy || '', Date.now()).changes > 0;
    } catch { return false; }
  },
  removeAntinukeWhitelist(guildId, userId) {
    try {
      this.ensureSecurity();
      return db.prepare('DELETE FROM antinuke_whitelist WHERE guildId = ? AND userId = ?').run(guildId, userId).changes > 0;
    } catch { return false; }
  },
  isAntinukeWhitelisted(guildId, userId) {
    try {
      this.ensureSecurity();
      return !!db.prepare('SELECT userId FROM antinuke_whitelist WHERE guildId = ? AND userId = ?').get(guildId, userId);
    } catch { return false; }
  },
  addSecurityLog(guildId, userId, action, detail) {
    try {
      this.ensureSecurity();
      return db.prepare('INSERT INTO security_logs (guildId, userId, action, detail, createdAt) VALUES (?, ?, ?, ?, ?)').run(guildId, userId || null, String(action || 'EVENT').slice(0, 100), (detail || '').slice(0, 1000), Date.now());
    } catch { return null; }
  },
  listSecurityLogs(guildId, limit) {
    try {
      this.ensureSecurity();
      const lim = Math.max(1, Math.min(25, parseInt(limit) || 10));
      return db.prepare('SELECT * FROM security_logs WHERE guildId = ? ORDER BY createdAt DESC LIMIT ?').all(guildId, lim);
    } catch { return []; }
  },
  listSecurityLogsByUser(guildId, userId, limit) {
    try {
      this.ensureSecurity();
      const lim = Math.max(1, Math.min(25, parseInt(limit) || 10));
      return db.prepare('SELECT * FROM security_logs WHERE guildId = ? AND userId = ? ORDER BY createdAt DESC LIMIT ?').all(guildId, userId, lim);
    } catch { return []; }
  },

  // ===== RGPD — Droit à l'effacement (Article 17) =====
  deleteUserData(userId) {
    const deleted = {};
    const tables = [
      { name: 'staff_stats', column: 'userId' },
      { name: 'staff_interventions', column: 'requesterId' },
      { name: 'staff_interventions', column: 'claimedBy' },
      { name: 'raid_claims', column: 'raiderId' },
      { name: 'raid_claims', column: 'claimedBy' },
      { name: 'tickets', column: 'ownerId' },
      { name: 'tickets', column: 'claimedBy' },
      { name: 'suggestions', column: 'authorId' },
      { name: 'suggestions', column: 'decidedBy' },
      { name: 'bug_reports', column: 'authorId' },
      { name: 'bug_reports', column: 'resolvedBy' },
      { name: 'bot_blacklist', column: 'userId' },
      { name: 'bot_blacklist', column: 'addedBy' },
      { name: 'warnings', column: 'userId' },
      { name: 'warnings', column: 'warnedBy' },
      { name: 'command_cooldowns', column: 'userId' },
      { name: 'jail_roles', column: 'userId' },
      { name: 'jail_roles', column: 'jailedBy' },
      { name: 'antinuke_whitelist', column: 'userId' },
      { name: 'antinuke_whitelist', column: 'addedBy' },
      { name: 'security_logs', column: 'userId' },
    ];
    
    let totalCount = 0;
    for (const { name, column } of tables) {
      try {
        const result = db.prepare(`DELETE FROM ${name} WHERE ${column} = ?`).run(userId);
        if (result.changes > 0) {
          deleted[name] = (deleted[name] || 0) + result.changes;
          totalCount += result.changes;
        }
      } catch (e) {
        // Table might not exist, continue
      }
    }
    
    return { deleted, totalCount };
  },

  // ===== RGPD — Droit à la portabilité (Article 20) =====
  exportUserData(userId) {
    const data = {
      userId,
      exportedAt: new Date().toISOString(),
      staff_stats: [],
      staff_interventions: [],
      raid_claims: [],
      tickets: [],
      suggestions: [],
      bug_reports: [],
      bot_blacklist: [],
      warnings: [],
      command_cooldowns: [],
      jail_roles: [],
      antinuke_whitelist: [],
      security_logs: [],
    };
    
    const queries = [
      { table: 'staff_stats', column: 'userId' },
      { table: 'staff_interventions', column: 'requesterId', also: 'claimedBy' },
      { table: 'raid_claims', column: 'raiderId', also: 'claimedBy' },
      { table: 'tickets', column: 'ownerId', also: 'claimedBy' },
      { table: 'suggestions', column: 'authorId', also: 'decidedBy' },
      { table: 'bug_reports', column: 'authorId', also: 'resolvedBy' },
      { table: 'bot_blacklist', column: 'userId', also: 'addedBy' },
      { table: 'warnings', column: 'userId', also: 'warnedBy' },
      { table: 'command_cooldowns', column: 'userId' },
      { table: 'jail_roles', column: 'userId', also: 'jailedBy' },
      { table: 'antinuke_whitelist', column: 'userId', also: 'addedBy' },
      { table: 'security_logs', column: 'userId' },
    ];
    
    for (const { table, column, also } of queries) {
      try {
        let query = `SELECT * FROM ${table} WHERE ${column} = ?`;
        let rows = db.prepare(query).all(userId);
        
        if (also) {
          query = `SELECT * FROM ${table} WHERE ${also} = ?`;
          const moreRows = db.prepare(query).all(userId);
          rows = rows.concat(moreRows.filter(r => !rows.some(existing => existing.id === r.id || existing.userId === r.userId)));
        }
        
        data[table] = rows;
      } catch (e) {
        // Table might not exist, continue
      }
    }
    
    return data;
  },

  // ===== RGPD — Compter les données d'un utilisateur =====
  countUserData(userId) {
    const counts = {};
    const queries = [
      { table: 'staff_stats', column: 'userId' },
      { table: 'staff_interventions', column: 'requesterId', also: 'claimedBy' },
      { table: 'raid_claims', column: 'raiderId', also: 'claimedBy' },
      { table: 'tickets', column: 'ownerId', also: 'claimedBy' },
      { table: 'suggestions', column: 'authorId', also: 'decidedBy' },
      { table: 'bug_reports', column: 'authorId', also: 'resolvedBy' },
      { table: 'bot_blacklist', column: 'userId', also: 'addedBy' },
      { table: 'warnings', column: 'userId', also: 'warnedBy' },
      { table: 'command_cooldowns', column: 'userId' },
      { table: 'jail_roles', column: 'userId', also: 'jailedBy' },
      { table: 'antinuke_whitelist', column: 'userId', also: 'addedBy' },
      { table: 'security_logs', column: 'userId' },
    ];
    
    let totalCount = 0;
    for (const { table, column, also } of queries) {
      try {
        let query = `SELECT COUNT(*) as count FROM ${table} WHERE ${column} = ?`;
        let count = db.prepare(query).get(userId).count;
        
        if (also) {
          query = `SELECT COUNT(*) as count FROM ${table} WHERE ${also} = ? AND ${column} != ?`;
          count += db.prepare(query).get(userId, userId).count;
        }
        
        if (count > 0) {
          counts[table] = count;
          totalCount += count;
        }
      } catch (e) {
        // Table might not exist, continue
      }
    }
    
    return { counts, totalCount };
  },

  // ===== RGPD — Purge automatique des données anciennes (Article 5.1.e) =====
  purgeOldData(months = 12) {
    const cutoff = Date.now() - (months * 30 * 24 * 60 * 60 * 1000);
    const purged = {};
    const tables = [
      'staff_interventions',
      'raid_claims',
      'tickets',
      'suggestions',
      'bug_reports',
      'warnings',
      'security_logs',
    ];
    
    let totalCount = 0;
    for (const table of tables) {
      try {
        const result = db.prepare(`DELETE FROM ${table} WHERE createdAt < ?`).run(cutoff);
        if (result.changes > 0) {
          purged[table] = result.changes;
          totalCount += result.changes;
        }
      } catch (e) {
        // Table might not exist, continue
      }
    }
    
    return { purged, totalCount };
  },
};
