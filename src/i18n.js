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
    'Lightwave refused the API token or the refresh token. A refresh token is used once: generate a new one on the "API" page of my.lightwaverf.com, paste it in the configuration and save. The integration stops until then.',
    "Lightwave a refusé le jeton d'API ou le jeton de rafraîchissement. Un jeton de rafraîchissement ne sert qu'une fois : générez-en un nouveau sur la page « API » de my.lightwaverf.com, collez-le dans la configuration et enregistrez. L'intégration s'arrête jusque-là.",
  ),
  tokenRejected: (status) =>
    both(
      `Lightwave rejected the token request (HTTP ${status}): if it stays, the integration needs an update. Click "Test the connection" to try again.`,
      `Lightwave a rejeté la demande de jeton (HTTP ${status}) : si cela reste, l'intégration doit être mise à jour. Cliquez sur « Tester la connexion » pour réessayer.`,
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
