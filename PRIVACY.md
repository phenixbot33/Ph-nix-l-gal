# Charte de confidentialité — Phénix Bot (Phénix Support)

**Dernière mise à jour : 25 octobre 2026**

---

La présente charte de confidentialité (ci-après la « Charte ») décrit comment le bot Discord **Phénix Bot**, aussi appelé **Phénix Support** (ci-après le « Bot »), collecte, utilise, conserve et protège vos données personnelles.

Elle complète les [Conditions d'utilisation](./Terms-of-services.md) du Bot et constitue la politique de confidentialité au sens de la loi n° 78-17 du 6 janvier 1978 modifiée (Informatique et Libertés) et du Règlement général sur la protection des données (RGPD – Règlement UE 2016/679).

---

## Article 1 – Responsable du traitement

- **Éditeur** : Phénix (pseudo Discord), propriétaire du Bot.
- **Contact** : serveur Discord Phénix — ouverture d'un ticket de support via le panneau du Bot, ou message privé aux propriétaires du Bot.
- **Hébergeur de la plateforme** : Discord, Inc. (https://discord.com/terms – https://discord.com/privacy).

Le Bot est exécuté sur une machine locale (serveur privé). La base de données est stockée **en local** sur cette machine, dans un fichier SQLite (`support.db`). Aucun serveur tiers n'héberge cette base.

---

## Article 2 – Données collectées

Le Bot ne collecte **aucune donnée sensible** (pas de mot de passe, pas de pièce d'identité, pas de donnée de paiement, pas de donnée de santé, de localisation ou d'état civil). Les données traitées sont les suivantes :

### 2.1 – Données provenant de l'API Discord (automatiques)

| Donnée | Description |
|---|---|
| Identifiant Discord (`userId`) | Identifiant numérique unique de votre compte Discord |
| Pseudonyme (`tag`, `username`) | Votre nom d'affichage Discord |
| Avatar | URL de votre image de profil (utilisée dans les embeds de stats et de logs) |
| Rôles Discord | Rôles attribués sur le serveur (utilisés pour les permissions et les certifications) |
| Identifiant du serveur (`guildId`) | Identifiant du serveur Discord sur lequel le Bot est utilisé |
| Identifiant du salon (`channelId`) | Identifiant du salon dans lequel une commande est exécutée |

### 2.2 – Données que vous saisissez volontairement

| Donnée | Origine | Limite |
|---|---|---|
| Motif du ticket | Formulaire (modal) à l'ouverture d'un ticket | 1 000 caractères max |
| Texte d'une suggestion | Commande `x!poste-suggestion` | 1 000 caractères max |
| Texte d'un rapport de bug | Commande `px!bug` | 1 000 caractères max |
| Raison d'un signalement raid | Bouton Raid du panneau | 1 000 caractères max |
| Raison AFK | Commande AFK | Effacée automatiquement à la fin de l'état AFK |

### 2.3 – Données enregistrées automatiquement par le Bot

| Table (base `support.db`) | Données stockées | Origine |
|---|---|---|
| **tickets** | `channelId`, `guildId`, `ownerId`, `ownerTag`, `reason`, `claimedBy`, `claimedAt`, `status`, `createdAt`, `closedAt` | Ouverture et gestion de tickets |
| **staff_stats** | `userId`, compteurs (`raid`, `sos`, `ticket`, `question`), `updatedAt` | Interventions du staff (clic sur « Traité ») |
| **staff_interventions** | `id`, `kind`, `messageId`, `channelId`, `guildId`, `requesterId`, `requesterTag`, `detail` (≤ 1 000 car.), `claimedBy`, `claimedAt`, `resolved`, `resolvedAt`, `createdAt` | Alertes SOS, tickets, questions |
| **raid_claims** | `raidId`, `messageId`, `guildId`, `channelId`, `raiderId`, `raiderTag`, `reason`, `sanction`, `claimedBy`, `claimedAt`, `resolved`, `resolvedAt`, `createdAt` | Signalements de raid |
| **suggestions** | `id`, `guildId`, `channelId`, `messageId`, `authorId`, `authorTag`, `text` (≤ 1 000 car.), `status`, `decidedBy`, `decidedAt`, `createdAt` | Suggestions postées |
| **bug_reports** | `id`, `guildId`, `channelId`, `messageId`, `authorId`, `authorTag`, `text` (≤ 1 000 car.), `status`, `resolvedBy`, `resolvedAt`, `createdAt` | Rapports de bugs |
| **bot_blacklist** | `userId`, `tag`, `reason` (≤ 500 car.), `addedBy`, `createdAt` | Liste noire du Bot |
| **warnings** | `id`, `guildId`, `userId`, `userTag`, `reason`, `warnedBy`, `createdAt` | Avertissements distribués |
| **command_cooldowns** | `userId`, `command`, `cooldownUntil` | Blocages temporaires de commandes |
| **jail_roles** | `userId`, `guildId`, `roles` (JSON des rôles retirés), `reason`, `jailedBy`, `jailedAt`, `releaseAt` | Sanctions « jail » |
| **antiraid_cfg** | `guildId`, `enabled`, `joinsLimit`, `joinsWindow`, `minAccountAge`, `updatedAt` | Configuration anti-raid (par serveur) |
| **antinuke_whitelist** | `guildId`, `userId`, `addedBy`, `addedAt` | Liste blanche anti-nuke |
| **security_logs** | `guildId`, `userId`, `action` (≤ 100 car.), `detail` (≤ 1 000 car.), `createdAt` | Journaux de sécurité (anti-raid) |

### 2.4 – Transcripts de tickets

À la fermeture d'un ticket, un **transcript textuel** des 100 derniers messages du salon est généré et envoyé en fichier `.txt` dans le salon de logs dédié. Ce transcript contient :

- La date et l'heure de chaque message ;
- Le pseudonyme et l'identifiant Discord de chaque auteur ;
- Le contenu textuel des messages ;
- Le nombre de pièces jointes (sans leur contenu).

Ce fichier est hébergé par Discord (en tant que pièce jointe dans le salon de logs). **Aucune copie du transcript n'est stockée dans la base de données locale.**

### 2.5 – Journaux d'activité (logs staff)

Chaque commande staff exécutée génère un journal envoyé dans le salon de logs dédié (`staffLogChannelId`), contenant :

- L'identifiant et le pseudonyme de l'utilisateur ayant exécuté la commande ;
- Le nom de la commande ;
- Le salon et le serveur concernés ;
- Un détail textuel de l'action effectuée.

Ces journaux sont également écrits dans la console du serveur d'hébergement (limités à 500 caractères par ligne).

### 2.6 – Certifications de statut

Les commandes `f!identite` et `st!identite` vérifient automatiquement votre qualité de membre, staff ou propriétaire du Bot à partir de vos **rôles Discord uniquement**. La carte de certification publiée contient :

- Votre pseudonyme ;
- Votre identifiant Discord ;
- Vos grades/rôles.

**Aucune pièce d'identité, aucun document, aucune donnée sensible n'est demandé ni collecté.** Les certifications sont journalisées dans les salons de logs (conservation : 12 mois).

---

## Article 3 – Finalités du traitement

Vos données sont traitées pour les finalités suivantes :

| Finalité | Base juridique |
|---|---|
| Fonctionnement du Bot (commandes, panneaux, boutons) | Exécution du service demandé |
| Prise en charge et suivi des tickets de support | Exécution du service demandé |
| Modération et sécurité du serveur (anti-raid, anti-nuke, sanctions, blacklist, jail) | Intérêt légitime (sécurité) |
| Statistiques d'activité du staff (classements, top) | Intérêt légitime (gestion d'équipe) |
| Preuve en cas de litige (transcripts, logs) | Intérêt légitime (preuve) |
| Suivi des suggestions et rapports de bugs | Exécution du service demandé |
| Certification de statut (vérification des rôles) | Intérêt légitime (authentification) |

---

## Article 4 – Destinataires des données

Vos données sont accessibles **uniquement** aux personnes suivantes :

1. **L'éditeur du Bot** et les **propriétaires du Bot** (identifiés par leurs `ownerIds` dans la configuration) ;
2. Les **membres du staff habilités** du serveur de support Phénix (détenteurs des rôles staff, admin ou propriétaire) ;
3. **Discord, Inc.**, en tant qu'hébergeur de la plateforme, qui traite les données selon ses propres conditions (https://discord.com/terms et https://discord.com/privacy).

**Aucune donnée n'est vendue, partagée à des fins commerciales, ni communiquée à des tiers** en dehors de Discord et du staff habilité, sauf obligation légale.

---

## Article 5 – Stockage et sécurité des données

### 5.1 – Localisation

- La base de données (`support.db`) est stockée **en local** sur la machine qui exécute le Bot. Aucun service cloud tiers n'y a accès.
- Les salons de logs sont **privés** et réservés au staff (permissions Discord restreintes).
- Les transcripts sont hébergés par Discord en tant que pièces jointes dans les salons de logs.

### 5.2 – Mesures de sécurité

- Accès à la base de données limité aux propriétaires du Bot ayant un accès physique ou distant à la machine d'hébergement ;
- Salons de logs protégés par des permissions Discord (lecture réservée au staff) ;
- Aucun mot de passe Discord ni code de vérification n'est demandé ou stocké ;
- Les champs textuels saisis par les utilisateurs sont limités en longueur (1 000 caractères) pour prévenir les abus.

### 5.3 – Ce que le Bot ne fait PAS

- Il ne collecte **aucune donnée de paiement** ;
- Il ne collecte **aucune pièce d'identité** ni document officiel ;
- Il ne collecte **aucune donnée de santé, de localisation ou d'état civil** ;
- Il ne collecte **aucun mot de passe** ni code de vérification Discord ;
- Il ne fait **aucun suivi publicitaire** ni profilage commercial.

> ⚠️ **Méfiez-vous de toute personne vous réclamant ces informations « au nom du Bot » : elle usurpe son identité.**

---

## Article 6 – Durées de conservation

| Donnée | Durée de conservation |
|---|---|
| Tickets (métadonnées en base : motif, statut, dates) | 12 mois après la fermeture du ticket |
| Transcripts de tickets (fichier `.txt` dans les logs) | 12 mois après la fermeture du ticket |
| Journaux d'activité (salons de logs) et cartes de certification | 12 mois, puis purge manuelle par le staff |
| Statistiques et interventions du staff | 12 mois glissants (réinitialisables par les propriétaires) |
| Suggestions et rapports de bugs | 12 mois après la décision (acceptée, refusée, résolue) |
| Avertissements (`warnings`) | 12 mois |
| Listes noire/blanche et blocages de commandes (`command_cooldowns`) | Pendant la durée de la sanction, puis suppression à sa levée |
| Journaux de sécurité anti-raid (`security_logs`) | 12 mois |
| Sanction « jail » (`jail_roles`) | Fin automatique à la date de libération prévue (`releaseAt`), puis suppression de l'enregistrement |
| État AFK | Le temps de l'état AFK, puis effacement automatique |
| Configuration anti-raid (`antiraid_cfg`) | Tant que le Bot est actif sur le serveur |
| Liste blanche anti-nuke (`antinuke_whitelist`) | Tant que le membre y est inscrit |

Au-delà de ces durées, les données sont **supprimées ou anonymisées**. Le Bot n'assurant pas de purge automatique intégrée, ces suppressions sont réalisées **manuellement** par le staff à l'aide des commandes de suppression prévues à cet effet et par la purge des salons de logs.

---

## Article 7 – Vos droits

Conformément à la loi Informatique et Libertés et au RGPD, vous disposez des droits suivants sur vos données personnelles :

| Droit | Description |
|---|---|
| **Accès** | Savoir quelles données le Bot détient à votre sujet |
| **Rectification** | Corriger des données inexactes |
| **Effacement** | Demander la suppression de vos données |
| **Limitation** | Demander la limitation du traitement |
| **Opposition** | Vous opposer au traitement de vos données |
| **Portabilité** | Recevoir vos données dans un format structuré |

### Comment exercer vos droits

1. **Ouvrez un ticket de support** sur le serveur Discord Phénix (panneau du Bot) ;
2. Ou **envoyez un message privé** aux propriétaires du Bot ;
3. Votre demande est traitée **sous 1 mois**.

Vous pouvez également demander directement au staff du serveur la suppression d'un transcript ou d'un log vous concernant.

### Réclamation

Si vous estimez que vos droits ne sont pas respectés, vous pouvez saisir la **CNIL** :
- Site web : [www.cnil.fr](https://www.cnil.fr)
- Adresse : 3 place de Fontenoy, 75001 Paris

---

## Article 8 – Cookies et traceurs

Le Bot **n'utilise aucun cookie, aucun traceur web et aucun outil d'analyse tiers**. Il fonctionne exclusivement via l'API Discord et sa base de données locale.

---

## Article 9 – Transferts de données hors UE

Le Bot ne transfère **aucune donnée** vers un pays hors de l'Union européenne de sa propre initiative.

Cependant, Discord, Inc. (hébergeur de la plateforme) est une société américaine qui peut traiter certaines données aux États-Unis. Ces transferts sont encadrés par les mécanismes de protection prévus par Discord (clauses contractuelles types, certifications). Pour plus d'informations, consultez la politique de confidentialité de Discord : https://discord.com/privacy.

---

## Article 10 – Modifications de la Charte

La présente Charte peut être modifiée à tout moment pour refléter les évolutions du Bot, de la réglementation ou de nos pratiques. La date de « Dernière mise à jour » en en-tête est mise à jour à chaque changement.

La poursuite de l'utilisation du Bot après modification vaut acceptation de la nouvelle Charte.

---

## Article 11 – Contact

Pour toute question relative à cette Charte ou à vos données personnelles :

- **Serveur Discord Phénix** — ticket de support ou message privé aux propriétaires du Bot
- **CNIL** — www.cnil.fr (réclamation)

---

> *Note : cette charte est un document adapté au projet Phénix Bot. Elle ne constitue pas un conseil juridique. Pour une mise en production, une relecture par un professionnel du droit (notamment en matière de RGPD) est recommandée.*
