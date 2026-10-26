// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, button, command errors, feature
// names), in English and French.
// -----------------------------------------------------------------------------

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts[language] ?? texts.en;

const both = (en, fr) => ({ en, fr });

/** Feature names, in the language chosen in the configuration. */
export const FEATURE_NAMES = {
  power: both('On/Off', 'Marche/Arrêt'),
  brightness: both('Brightness', 'Luminosité'),
  temperature: both('Temperature', 'Température'),
  setpoint: both('Target temperature', 'Température de consigne'),
  mode: both('Mode (off / heating)', 'Mode (arrêt / chauffage)'),
  heating: both('Heating now (1 = yes)', 'En chauffe (1 = oui)'),
  watts: both('Power', 'Puissance'),
  battery: both('Battery', 'Batterie'),
  opening: both('Window (0 = open)', 'Fenêtre (0 = ouverte)'),
  motion: both('Movement', 'Mouvement'),
  humidity: both('Humidity', 'Humidité'),
};

/** The thermostat modes (`supported_options` labels, plain strings). */
export const MODE_NAMES = {
  0: both('Off', 'Arrêt'),
  1: both('Heating', 'Chauffage'),
};

/** "25 min" / "3 h", for the pauses. */
export function age(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) {
    return { en: `${minutes} min`, fr: `${minutes} min` };
  }
  const hours = Math.round(minutes / 60);
  return { en: `${hours} h`, fr: `${hours} h` };
}

/** Two messages one after the other, in each language. */
export const join = (...messages) =>
  both(messages.map((m) => m.en).join(' '), messages.map((m) => m.fr).join(' '));

export const T = {
  notReadYet: both(
    'Waiting for the first read since the start (only "off" and 5 °C of the heating are accepted until then).',
    "En attente de la première lecture depuis le démarrage (seuls « arrêt » et 5 °C du chauffage sont acceptés d'ici là).",
  ),
  noCredentials: both(
    'Enter the API token and the refresh token of your Lightwave account (the "API" page of my.lightwaverf.com).',
    "Saisissez le jeton d'API et le jeton de rafraîchissement de votre compte Lightwave (page « API » de my.lightwaverf.com).",
  ),
  connecting: both('Connecting to Lightwave…', 'Connexion à Lightwave…'),
  connected: (count, supported) =>
    both(
      `Connected to Lightwave: ${supported} device(s) Gladys can show (out of ${count}). Open Discovery to add them.`,
      `Connecté à Lightwave : ${supported} appareil(s) que Gladys peut afficher (sur ${count}). Ouvrez Découverte pour les ajouter.`,
    ),
  refused: both(
    'Lightwave refused the API token or the refresh token (a refresh token is used once, per lightwave2): generate a new one on the "API" page of my.lightwaverf.com, paste it in the configuration and save. The integration stops until then.',
    "Lightwave a refusé le jeton d'API ou le jeton de rafraîchissement (un jeton de rafraîchissement ne sert qu'une fois, d'après lightwave2) : générez-en un nouveau sur la page « API » de my.lightwaverf.com, collez-le dans la configuration et enregistrez. L'intégration s'arrête jusque-là.",
  ),
  tokenRejected: (status) =>
    both(
      `Unexpected answer of the Lightwave token endpoint (HTTP ${status}); the tokens are probably still good. Click "Test the connection" (or save the configuration) to try again; if it stays, the integration needs an update.`,
      `Réponse inattendue du point de jeton de Lightwave (HTTP ${status}) ; les jetons sont sans doute toujours bons. Cliquez sur « Tester la connexion » (ou enregistrez la configuration) pour réessayer ; si cela reste, l'intégration doit être mise à jour.`,
    ),
  tokenNotSaved: both(
    'The new refresh token Lightwave gave could not be saved in Gladys yet; it is kept in memory and saved again at the next read. Do not restart the integration before the status is back to normal.',
    "Le nouveau jeton de rafraîchissement donné par Lightwave n'a pas encore pu être enregistré dans Gladys ; il est gardé en mémoire et réenregistré à la prochaine lecture. Ne redémarrez pas l'intégration avant le retour du statut normal.",
  ),
  rateLimited: (wait) =>
    both(
      `Lightwave asks to slow down (HTTP 429): pausing for ${wait.en}, commands included.`,
      `Lightwave demande de ralentir (HTTP 429) : pause de ${wait.fr}, commandes comprises.`,
    ),
  forbidden: (wait) =>
    both(
      `Lightwave refuses the requests (HTTP 403): pausing for ${wait.en}, commands included.`,
      `Lightwave refuse les requêtes (HTTP 403) : pause de ${wait.fr}, commandes comprises.`,
    ),
  unreachable: (reason, wait) =>
    both(
      `Lightwave not read (${reason}); new try in ${wait.en}.`,
      `Lightwave non lu (${reason}) ; nouvel essai dans ${wait.fr}.`,
    ),
  apiRefused: (wait) =>
    both(
      `The Lightwave API refuses a bearer token it has just issued (HTTP 401): does the account have access to the API? New try in ${wait.en}, without a new token.`,
      `L'API Lightwave refuse un jeton porteur qu'elle vient d'émettre (HTTP 401) : le compte a-t-il accès à l'API ? Nouvel essai dans ${wait.fr}, sans nouveau jeton.`,
    ),
  apiRefusedStop: both(
    'The Lightwave API refused the bearer token three times in a row (HTTP 401): stopped. Check the API access of the account, then click "Test the connection" or paste new tokens.',
    "L'API Lightwave a refusé le jeton porteur trois fois de suite (HTTP 401) : arrêt. Vérifiez l'accès à l'API du compte, puis cliquez sur « Tester la connexion » ou collez de nouveaux jetons.",
  ),
  offNotApplied: (name) =>
    both(
      `"${name}": the off (or 5 °C) sent is not what Lightwave reads back; sent again. Check the device.`,
      `« ${name} » : l'arrêt (ou 5 °C) envoyé n'est pas ce que Lightwave relit ; renvoyé. Vérifiez l'appareil.`,
    ),
  notApplied: (name) =>
    both(
      `"${name}": the last command is not what Lightwave reads back 15 s later (not applied).`,
      `« ${name} » : la dernière commande n'est pas ce que Lightwave relit 15 s après (non appliquée).`,
    ),
  dropped: (count) =>
    both(
      `${count} more device(s) not shown (500 at most).`,
      `${count} appareil(s) de plus non affiché(s) (500 au plus).`,
    ),
  unread: (count) =>
    both(
      `${count} device(s) not read this time (marked unreachable).`,
      `${count} appareil(s) non lu(s) cette fois (marqués injoignables).`,
    ),
  partial: (count) =>
    both(
      `${count} home(s) not read this time (their devices are marked unreachable).`,
      `${count} maison(s) non lue(s) cette fois (leurs appareils sont marqués injoignables).`,
    ),
  busy: both(
    'A read is in progress: try again in a moment.',
    'Une lecture est en cours : réessayez dans un instant.',
  ),
  test: {
    tooSoon: (seconds) =>
      both(
        `The last read is more recent than the interval: the next one is in ${seconds} s. The last status:`,
        `La dernière lecture est plus récente que l'intervalle : la prochaine est dans ${seconds} s. Dernier statut :`,
      ),
    cooldown: both(
      'Tested less than 30 seconds ago; the last status:',
      'Testé il y a moins de 30 secondes ; dernier statut :',
    ),
  },
};

/** Command errors (thrown to Gladys), in the language of the configuration. */
export const ERRORS = {
  unknown: both(
    'Unknown device or feature: run a Scan.',
    'Appareil ou fonctionnalité inconnu : lancez un Scan.',
  ),
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  invalidValue: both('Invalid value.', 'Valeur invalide.'),
  heatingDisabled: both(
    'Heating commands are off: enable "Allow the heating commands" in the configuration first.',
    "Les commandes de chauffage sont désactivées : activez d'abord « Autoriser les commandes de chauffage » dans la configuration.",
  ),
  belowMin: both('Target below 5 °C: refused.', 'Consigne sous 5 °C : refusée.'),
  aboveMax: both(
    'Target above the maximum of the configuration: refused.',
    'Consigne au-dessus du maximum de la configuration : refusée.',
  ),
  blocked: both(
    'Not connected to Lightwave: see the status of the integration.',
    "Non connecté à Lightwave : voir le statut de l'intégration.",
  ),
  tokensRefused: both(
    'Not sent: Lightwave refused the tokens, there is no token to send it with. Paste new tokens.',
    "Non envoyée : Lightwave a refusé les jetons, aucun jeton pour l'envoyer. Collez de nouveaux jetons.",
  ),
  notReadYet: both(
    'Not sent: the devices have not been read yet since the start of the integration; try again after the first read (see the status).',
    "Non envoyée : les appareils n'ont pas encore été lus depuis le démarrage de l'intégration ; réessayez après la première lecture (voir le statut).",
  ),
  onlyProtectiveYet: both(
    'Not sent: until the first read since the start, only "off" and 5 °C are accepted on this device.',
    "Non envoyée : jusqu'à la première lecture depuis le démarrage, seuls « arrêt » et 5 °C sont acceptés sur cet appareil.",
  ),
  offPending: both(
    'Not sent yet (a bearer token is being obtained): it leaves as soon as possible. Check the device.',
    "Pas encore envoyée (un jeton porteur est en cours d'obtention) : elle part dès que possible. Vérifiez l'appareil.",
  ),
  otherAccount: both(
    'Not sent: this device is not in the homes of the Lightwave account configured now (another account?). Run a Scan.',
    "Non envoyée : cet appareil n'est pas dans les maisons du compte Lightwave configuré maintenant (un autre compte ?). Lancez un Scan.",
  ),
  tokenEndpointWait: both(
    'Not sent: the Lightwave token endpoint answered unexpectedly less than a minute ago; try again in a minute (see the status).',
    "Non envoyée : le point de jeton de Lightwave a répondu de façon inattendue il y a moins d'une minute ; réessayez dans une minute (voir le statut).",
  ),
  cancelledByOff: both(
    'Not sent: an "off" (or 5 °C) given after it on the same device cancels it.',
    "Non envoyée : un « arrêt » (ou 5 °C) donné après elle sur le même appareil l'annule.",
  ),
  paused: both(
    'Lightwave is paused: see the status of the integration.',
    "Lightwave est en pause : voir le statut de l'intégration.",
  ),
  late: both(
    'Not sent: the command could not leave in time (another command in progress or a slow connection).',
    "Non envoyée : la commande n'a pas pu partir à temps (autre commande en cours ou connexion lente).",
  ),
  unsure: (reason) =>
    both(
      `Sent, without confirmation (${reason}): the device is read again shortly.`,
      `Envoyée, sans confirmation (${reason}) : l'appareil est relu sous peu.`,
    ),
  refused: (reason) =>
    both(`Refused by Lightwave (${reason}).`, `Refusée par Lightwave (${reason}).`),
};
