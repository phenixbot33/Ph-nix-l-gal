# Implémentation RGPD — Phénix Bot

Ce document décrit les mesures techniques mises en place pour assurer la conformité au Règlement Général sur la Protection des Données (RGPD).

## 📋 Vue d'ensemble

Le bot Phénix a été mis en conformité avec le RGPD (Règlement UE 2016/679) en implémentant :

1. **Commandes utilisateur** pour exercer les droits RGPD
2. **Fonctions de base de données** pour gérer les données personnelles
3. **Purge automatique** des données anciennes
4. **Documentation légale** complète

## 🎯 Commandes RGPD disponibles

Les utilisateurs peuvent exercer leurs droits via les commandes suivantes :

### `px!mes-donnees` (Article 15 — Droit d'accès)
Affiche un résumé de toutes les données personnelles stockées dans la base de données.

**Tables vérifiées :**
- Statistiques staff
- Interventions (tickets/SOS/questions)
- Signalements de raids
- Tickets créés/traités
- Suggestions
- Rapports de bugs
- Blacklist
- Avertissements
- Cooldowns de commandes
- Sanctions jail
- Whitelist antinuke
- Logs de sécurité

### `px!exporter-mes-donnees` (Article 20 — Droit à la portabilité)
Exporte toutes les données personnelles au format JSON et les envoie en fichier joint.

**Fonctionnalités :**
- Export complet de toutes les tables
- Format JSON structuré et lisible
- Limite de taille : 7 Mo (limite Discord)
- Suppression automatique du fichier temporaire après envoi

### `px!supprimer-mes-donnees` (Article 17 — Droit à l'effacement)
Supprime définitivement toutes les données personnelles de la base de données.

**Processus :**
1. Affiche le nombre d'entrées à supprimer
2. Demande confirmation via boutons interactifs
3. Supprime les données de toutes les tables
4. Confirme la suppression

**Tables concernées :**
- `staff_stats`
- `staff_interventions`
- `raid_claims`
- `tickets`
- `suggestions`
- `bug_reports`
- `bot_blacklist`
- `warnings`
- `command_cooldowns`
- `jail_roles`
- `antinuke_whitelist`
- `security_logs`

### `px!politique-confidentialite` (Article 13 — Information)
Affiche un résumé de la politique de confidentialité avec liens vers les documents complets.

## 🔧 Fonctions techniques

### `src/database.js`

#### `deleteUserData(userId)`
Supprime toutes les données d'un utilisateur dans toutes les tables.

```javascript
const { deleted, totalCount } = blacklist.deleteUserData(userId);
// deleted: { tickets: 5, suggestions: 2, ... }
// totalCount: 7
```

#### `exportUserData(userId)`
Exporte toutes les données d'un utilisateur au format JSON.

```javascript
const data = blacklist.exportUserData(userId);
// data: { userId, exportedAt, tickets: [...], suggestions: [...], ... }
```

#### `countUserData(userId)`
Compte le nombre d'entrées par table pour un utilisateur.

```javascript
const { counts, totalCount } = blacklist.countUserData(userId);
// counts: { tickets: 5, suggestions: 2, ... }
// totalCount: 7
```

#### `purgeOldData(months = 12)`
Purge automatiquement les données plus anciennes que X mois (12 par défaut).

**Tables purgées :**
- `staff_interventions`
- `raid_claims`
- `tickets`
- `suggestions`
- `bug_reports`
- `warnings`
- `security_logs`

```javascript
const { purged, totalCount } = blacklist.purgeOldData(12);
// purged: { tickets: 150, warnings: 23, ... }
// totalCount: 173
```

## 🔄 Purge automatique

### Au démarrage
Une purge est exécutée automatiquement à chaque démarrage du bot.

### Quotidienne
Une purge est programmée tous les jours à 3h00 du matin via `setInterval()`.

**Logs générés :**
```
[RGPD] 🧹 Purge automatique : 173 entrée(s) supprimée(s)
[RGPD]   - tickets : 150
[RGPD]   - warnings : 23
```

## 📊 Durées de conservation

| Table | Durée | Base juridique |
|-------|-------|----------------|
| `staff_stats` | 12 mois | Intérêt légitime |
| `staff_interventions` | 12 mois | Intérêt légitime |
| `raid_claims` | 12 mois | Intérêt légitime |
| `tickets` | 12 mois | Exécution contrat |
| `suggestions` | 12 mois | Consentement |
| `bug_reports` | 12 mois | Intérêt légitime |
| `bot_blacklist` | Durée sanction | Intérêt légitime |
| `warnings` | 12 mois | Intérêt légitime |
| `command_cooldowns` | Durée cooldown | Exécution contrat |
| `jail_roles` | Durée sanction | Intérêt légitime |
| `antinuke_whitelist` | Jusqu'à retrait | Consentement |
| `security_logs` | 12 mois | Obligation légale |

## 🔒 Mesures de sécurité

### Limite de taille des données
- **Raison ticket** : 1 000 caractères max
- **Suggestion** : 1 000 caractères max
- **Rapport bug** : 1 000 caractères max
- **Raison blacklist** : 1 000 caractères max
- **Logs console** : 500 caractères max

### Transcripts
- Limite : 100 derniers messages
- Stockage : Salon Discord (pas en base de données)
- Durée : 12 mois

### Accès aux données
- Seuls les propriétaires du bot peuvent accéder à la base de données
- Les logs sont envoyés dans des salons privés (permissions restreintes)
- Aucun service tiers n'a accès aux données

## 📄 Documents légaux

### Conditions d'utilisation
- `CONDITIONS_D_UTILISATION.md` : Version française complète
- `Terms-of-services.md` : Version anglaise

### Charte de confidentialité
- `CHARTE_DE_CONFIDENTIALITE.md` : Politique de confidentialité détaillée
- Conforme aux Articles 13 et 14 du RGPD

## 🎓 Formation des utilisateurs

Les utilisateurs sont informés de leurs droits via :
1. La commande `px!politique-confidentialite`
2. Les documents légaux accessibles sur GitHub
3. Les messages d'information dans les commandes RGPD

## 🔍 Audit de conformité

### Vérifications effectuées
- ✅ Droit d'accès (Article 15) : `px!mes-donnees`
- ✅ Droit à la portabilité (Article 20) : `px!exporter-mes-donnees`
- ✅ Droit à l'effacement (Article 17) : `px!supprimer-mes-donnees`
- ✅ Limitation de conservation (Article 5.1.e) : Purge automatique 12 mois
- ✅ Minimisation des données (Article 5.1.c) : Seules les données nécessaires sont collectées
- ✅ Transparence (Articles 13-14) : Documents légaux complets
- ✅ Sécurité (Article 32) : Accès restreint, logs privés

### Points d'attention
- Les transcripts sont stockés par Discord (pas en base de données locale)
- La purge automatique ne supprime pas les messages Discord (logs, transcripts)
- Les utilisateurs doivent demander manuellement la suppression des messages Discord

## 📞 Support

Pour toute question relative à la protection des données :
- Commande `px!politique-confidentialite`
- Contact via ticket Discord
- Réclamation CNIL : https://www.cnil.fr

## 📅 Historique des modifications

- **2026-10-25** : Implémentation initiale de la conformité RGPD
  - Ajout des 4 commandes utilisateur
  - Ajout des fonctions de base de données
  - Mise en place de la purge automatique
  - Création des documents légaux

---

**Dernière mise à jour :** 25 octobre 2026
