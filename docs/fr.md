# Lightwave Smart pour Gladys Assistant

Affiche et commande dans Gladys les appareils **Lightwave Smart** de votre
compte Lightwave (Royaume-Uni ; hub Link Plus, appareils de génération 1
« Connect » et de génération 2 « Smart »), par l'**API publique de
Lightwave**.

> **Jamais testée avec un vrai compte.** L'intégration parle à l'API publique
> que Lightwave ouvre à chaque compte (`publicapi.lightwaverf.com`), écrite
> d'après la bibliothèque lightwave2 et son intégration Home Assistant, et
> testée seulement avec des réponses inventées. Lightwave peut changer l'API.
> Sans lien avec Lightwave.

## Ce que vous obtenez

Un appareil Gladys par « feature set » Lightwave (une lumière, une prise, une
vanne de radiateur…) :

| Appareil Lightwave                                         | Fonctionnalités Gladys                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Lumière, variateur (un `dimLevel`)                         | Marche/Arrêt (`light/binary`), Luminosité (0 à 100), Puissance en W quand l'appareil la donne |
| Prise, relais, interrupteur (un `switch` sans niveau)      | Marche/Arrêt (`switch/binary`), Puissance en W quand elle est donnée                          |
| Vanne de radiateur (TRV)                                   | Température (°C), Température de consigne (°C), En chauffe (1 = vanne ouverte), Batterie (%)  |
| Thermostat, chaudière ou relais de chauffage (`heatState`) | Température, Consigne, Mode (arrêt / chauffage), En chauffe (1 = demande de chauffe)          |
| Capteur de fenêtre ou de porte                             | Fenêtre (0 = ouverte, 1 = fermée, le capteur d'ouverture de Gladys), Batterie                 |
| Capteur de mouvement                                       | Mouvement (1 = oui), Batterie                                                                 |

- **Luminosité** : 0 éteint la lumière ; toute autre valeur règle le niveau
  puis allume (deux requêtes, comme l'application Lightwave).
- **Consigne** et **mode « chauffage »** : refusés tant que vous n'activez pas
  _Autoriser les commandes de chauffage_ dans la configuration. Une consigne
  est aussi refusée sous 5 °C ou au-dessus de la _Température de consigne
  maximale_ de la configuration (25 °C par défaut, 40 °C au plus : la limite
  de Lightwave). Le **mode « arrêt »** est accepté quelle que soit l'option et
  quelle que soit la pause en cours, tant que l'intégration détient un jeton
  porteur ; il n'est refusé que si les jetons ont été refusés par Lightwave
  (aucun jeton pour l'envoyer) ou si l'appareil n'est plus dans la dernière
  hiérarchie lue (lancez un Scan).
- **En chauffe** (lecture seule) : la vanne ouverte (`valveLevel` au-dessus
  de 0), ou la demande de chauffe d'un thermostat.
- **Non affichés dans cette version** : le hub Link Plus, les relais à trois
  voies (volets, portes de garage), les couleurs des LED, les appuis sur les
  boutons physiques, le verrouillage des boutons (`protection`), l'énergie
  cumulée (Wh) des prises, la force du signal, la luminosité ambiante des
  capteurs.

Les lumières (`light/binary`) et les prises ou relais (`switch/binary`) sont
des commandes ordinaires de Gladys : un « tout éteindre » de Gladys, d'un
assistant vocal ou d'une scène les éteint aussi. Ne câblez pas un relais sur
ce qui ne doit jamais être coupé depuis Gladys (un congélateur, un moteur de
portail) : laissez-le hors de Gladys.

## Installation

1. Connectez-vous sur [my.lightwaverf.com](https://my.lightwaverf.com), ouvrez
   la page **API** de votre compte et créez un **jeton d'API** et un **jeton de
   rafraîchissement** (Lightwave parle de jeton « basic » et de jeton
   « refresh »).
2. Dans Gladys, installez l'intégration **Lightwave Smart** depuis le store,
   collez les deux jetons, enregistrez.
3. Ouvrez l'onglet **Découverte** et ajoutez les appareils.

Les deux champs sont des champs `secret` : Gladys les garde dans sa base (en
clair, comme toute valeur de configuration, et dans ses sauvegardes), ne les
réaffiche jamais, et l'intégration ne les envoie qu'à Lightwave
(`auth.lightwaverf.com`). Le jeton d'API identifie votre compte ; le jeton de
rafraîchissement est échangé contre un **jeton porteur** qui vit une journée
(Lightwave dit combien) et n'est gardé qu'en mémoire.

### Le jeton de rafraîchissement ne sert qu'une fois

Lightwave donne un **nouveau jeton de rafraîchissement** avec chaque jeton
porteur, et celui que vous avez collé est consommé au premier usage.
L'intégration garde elle-même le nouveau dans la configuration de Gladys (deux
valeurs cachées à côté du champ : le jeton donné en dernier par Lightwave, et
celui que vous aviez collé dont il dérive), si bien qu'un redémarrage ou un
renouvellement utilise le bon sans rien vous demander. Le champ collé reste
tel que vous l'avez laissé ; ne collez un nouveau jeton que si le statut le
demande.

Si Gladys n'a pas pu enregistrer le nouveau jeton (Gladys injoignable à ce
moment), le statut le dit : le jeton est gardé en mémoire et réenregistré à la
lecture suivante. Ne redémarrez pas l'intégration avant le retour du statut
normal, sinon le nouveau jeton est perdu et le statut en demande un autre.

## Rafraîchissement

Les valeurs des fonctionnalités sont lues toutes les **60 secondes** par
défaut (30 à 300, _Intervalle de rafraîchissement_), une requête par 150
fonctionnalités ; la hiérarchie (les maisons du compte et leurs appareils) est
lue **une fois par heure**, une requête par maison plus une pour la liste.
Une maison dont la lecture échoue garde ses derniers appareils, marqués
« injoignables », leurs dernières valeurs n'étant pas renvoyées ; elle est
retentée 5 minutes plus tard, sans arrêter les lectures des autres maisons.

Une commande part aussitôt ; la valeur envoyée est affichée aussitôt,
l'appareil est relu 2 secondes plus tard, et une lecture un peu en retard ne
défait pas la valeur commandée (15 secondes). Les commandes d'un même appareil
passent l'une après l'autre. Gladys attend 5 secondes la réponse : une
commande qui n'est pas partie 3 secondes après le clic (file, renouvellement
de jeton en cours, réseau lent) est refusée **sans avoir été envoyée** ; une
commande envoyée mais lente est acquittée à 4,3 secondes et son effet
s'affiche ensuite.

Le bouton _Tester la connexion_ renouvelle le jeton porteur si besoin et lit
une fois les appareils, mais jamais plus tôt que l'intervalle après la
dernière lecture (il dit alors quand vient la prochaine), et au plus une fois
toutes les 30 secondes.

## Dépannage

- **Jeton d'API ou jeton de rafraîchissement refusé** (HTTP 400, 401 ou 403
  du point de jeton) : l'intégration s'arrête, même après un redémarrage, et
  ne réessaie jamais d'elle-même (un jeton de rafraîchissement consommé le
  reste, et de nouveaux essais pourraient bloquer le compte). Générez un
  nouveau jeton de rafraîchissement sur la page API, collez-le, enregistrez :
  un nouvel essai aussitôt.
- **Demande de jeton rejetée** (tout autre statut) : l'intégration s'arrête
  jusqu'à un clic sur _Tester la connexion_ ou un enregistrement de la
  configuration.
- **Jeton porteur refusé par l'API** (HTTP 401 d'une lecture) : un
  renouvellement et la lecture à nouveau ; refusé encore juste après, le cycle
  compte comme injoignable et le cycle suivant renouvelle encore. Un 401 sur
  une commande ne renouvelle jamais depuis la commande : la commande échoue,
  le cycle suivant renouvelle.
- **Trop de requêtes (HTTP 429)** : une pause de 1 minute à 6 heures (le
  `Retry-After` de Lightwave, 15 minutes sans lui) pour les lectures, les
  commandes et le bouton, gardée après un redémarrage ou une reconnexion à
  Gladys. Le mode « arrêt » d'un thermostat passe quand même, une fois.
- **HTTP 403 des lectures** : une pause d'une heure de tous les chemins (sauf
  le mode « arrêt »). Un 403 sur une commande est cette commande refusée,
  rien d'autre.
- **Lightwave indisponible (5xx, réseau, mauvaise réponse)** : nouveaux essais
  après 1, 2, 5, 10, puis toutes les 15 minutes, jamais plus tôt que
  l'intervalle.

## Limites

- API publique : Lightwave peut la changer ou en limiter l'usage.
- Pas de mises à jour en direct (les webhooks de l'API publique exigent une
  URL publique) : une lecture toutes les 30 à 300 secondes. Les appareils de
  génération 1 ne remontent pas leur état d'eux-mêmes : un changement fait
  sur l'interrupteur mural peut mettre un cycle à s'afficher.
- Un compte Lightwave par Gladys, dix maisons au plus.
- Pas de relais à trois voies, de couleurs de LED, d'appuis de boutons,
  d'index d'énergie ni de réglages dans cette version.
- Jamais testée avec un vrai compte : signalez ce que vous voyez sur le
  [dépôt GitHub](https://github.com/LM1LC3N7/gladys-lightwave/issues) (sans
  vos jetons).

## Vie privée

L'intégration garde dans `/data/lightwave-state.json` (lisible par son seul
conteneur) : un sel aléatoire, la fin d'une pause, l'heure de la dernière
tentative de lecture, et un arrêt sur jetons refusés lié à une empreinte salée
des deux jetons. Jamais un jeton : le jeton porteur vit en mémoire, les
jetons de rafraîchissement dans la configuration de Gladys. Les identifiants
Lightwave des appareils et des fonctionnalités sont les identifiants des
appareils Gladys. Rien n'est envoyé ailleurs qu'à Lightwave.
