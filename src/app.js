// -----------------------------------------------------------------------------
// The integration: the Lightwave account (the API token and the refresh
// token of the "API" page, the bearer token they give), one read of the
// feature values per cycle (30 to 300 s), the structures every hour, the
// Gladys devices and their states, the commands (one at a time per device,
// refused before they are sent when they cannot be answered within Gladys'
// 5 s, the device read again after; the heating commands behind an option,
// "off" never held back), the transport badges and the test button. index.js
// only wires the SDK handlers to it.
//
// Two clocks: `now` (wall clock) dates /data and the token; `monotonic`
// paces the reads, the pauses, the holds and the command deadlines, so that
// a wall clock set back or forward never doubles or skips a read. The clock
// is read once per decision (`dueAt(mono)` receives the instant).
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { LightwaveClient } from './client.js';
import { INTERNAL_KEYS, normalizeConfig } from './config.js';
import { FEATURES, LIMITS, TIMINGS } from './constants.js';
import { buildDevice, deviceIds, deviceStates, planOf } from './devices.js';
import { LightwaveError, errorReason } from './http.js';
import { ERRORS, T, age, join, word } from './i18n.js';
import { featureIdsOf, kindOf, readSets, readStructure, valuesOf } from './model.js';
import { StatePublisher } from './publisher.js';
import { PAUSES, fileStore, fingerprint, newSalt, normalizeMemory } from './store.js';

/** Errors Lightwave did not answer usefully for: the account is unreachable. */
const OFFLINE = new Set(['network', 'timeout', 'unavailable', 'bad_response', 'size', 'http']);
/** Errors that end a cycle at once, even when an older list of structures is known. */
const FATAL = new Set([
  'refused',
  'token_rejected',
  'unauthorized',
  'rate_limited',
  'forbidden',
  'no_credentials',
]);
/**
 * Errors of the read of one structure that leave the others readable (the
 * structure keeps its last feature sets, marked unreachable).
 */
const PER_STRUCTURE = new Set([
  'forbidden',
  'http',
  'unavailable',
  'network',
  'timeout',
  'bad_response',
  'size',
]);
/** The Lightwave features read every cycle. */
const READ_TYPES = [
  FEATURES.SWITCH,
  FEATURES.DIM_LEVEL,
  FEATURES.TEMPERATURE,
  FEATURES.TARGET_TEMPERATURE,
  FEATURES.HEAT_STATE,
  FEATURES.VALVE_LEVEL,
  FEATURES.CALL_FOR_HEAT,
  FEATURES.POWER,
  FEATURES.BATTERY_LEVEL,
  FEATURES.WINDOW_POSITION,
  FEATURES.MOVEMENT,
  FEATURES.HUMIDITY,
];
/** The fields of a Gladys feature that a publication carries. */
const FEATURE_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

export class LightwaveApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'lightwave' }),
    transport,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.client = new LightwaveClient({
      transport,
      now,
      onToken: (next, previous) => this.tokenRotated(next, previous),
    });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null);
    /** The structures of the account, and when they were read (monotonic). */
    this.structures = undefined;
    this.topologyAt = undefined;
    /** Structure id -> its last feature sets (kept when a later read of it fails). */
    this.lists = new Map();
    /** Ids of the feature sets of a structure whose last read failed (badge unreachable). */
    this.stale = new Set();
    /** The last read: feature set id -> set (src/model.js). */
    this.sets = new Map();
    /** Feature set id -> `{ <type>: value }` of the last read. */
    this.values = new Map();
    /** Feature set id -> plan (src/devices.js). */
    this.plans = new Map();
    /** feature external id -> { setId, spec } */
    this.writers = new Map();
    this.readOnly = new Set();
    /** Every device published in this run, by external id: a publication never shrinks. */
    this.known = new Map();
    this.knownAccount = undefined;
    /** feature external id -> { expected, until (monotonic) }: a commanded value no read has confirmed yet. */
    this.holds = new Map();
    /** Feature set id -> the tail of its command queue. */
    this.queues = new Map();
    /** Feature set id -> the timer of its read after a command. */
    this.rereads = new Map();
    this.readCount = 0;
    this.published = undefined;
    this.badges = new Map();
    this.timer = undefined;
    this.running = undefined;
    this.generation = 0;
    /** undefined | 'refused' | 'token_rejected' */
    this.blocked = undefined;
    this.blockStatus = undefined;
    this.offline = false;
    this.connectedOnce = false;
    this.failures = 0;
    /** The pause of every path: `{ kind, due (monotonic) }`, or the backoff after a failed read. */
    this.pause = undefined;
    /** The last read (monotonic): the next one is never sooner than the interval. */
    this.lastReadAt = undefined;
    this.lastAttemptSavedAt = undefined;
    this.lastTestAt = undefined;
    this.started = false;
    this.lastStatus = undefined;
    /** A rotated refresh token not yet saved in the Gladys configuration: `{ seed, current }`. */
    this.tokenUnsaved = undefined;
    /** The refresh tokens this run rotated from (spent): a stale one sent back by Gladys is not used. */
    this.spent = new Set();
    /** The number of structures not read in the last cycle. */
    this.partial = 0;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    await this.running;
    this.config = normalizeConfig(raw);
    this.reset();
    if (this.knownAccount !== this.config.account) {
      // Another account: the devices of the previous one are not published again.
      this.known = new Map();
      this.knownAccount = this.config.account;
    }
    const now = this.now();
    const mono = this.monotonic();
    this.memory = normalizeMemory(await this.store.load().catch(() => null), now);
    if (!this.memory.salt) {
      this.memory.salt = newSalt();
      await this.saveMemory();
    }
    // A pause of every path survives a restart and a change of account.
    const pause = this.memory.pause;
    if (pause) {
      this.setPause(pause.kind, pause.until - now, mono);
    }
    // A restart never reads sooner than the interval after the last attempt.
    if (this.memory.lastAttemptAt !== undefined) {
      const since = Math.max(0, now - this.memory.lastAttemptAt);
      this.lastReadAt = mono - since;
    }
    const { apiToken, refreshToken } = this.config;
    this.client.configure({ apiToken, refreshToken });
    this.publisher.start();
    if (!this.client.hasCredentials) {
      await this.setStatus(false, T.noCredentials);
      return;
    }
    // A stop on these very tokens survives a restart: only new tokens lift it.
    const block = this.memory.block;
    if (block && block.fingerprint === this.fingerprint) {
      this.blocked = 'refused';
      await this.setStatus(false, this.blockMessage());
      return;
    }
    await this.setStatus(false, this.pauseMessage() ?? T.connecting);
    this.schedule();
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    for (const timer of this.rereads.values()) {
      this.timers.clearTimeout(timer);
    }
    this.rereads = new Map();
    this.publisher.stop();
  }

  clearTimer() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Forgets the account and the failures: a new account, or a restart. A pause of every path stays. */
  reset() {
    this.structures = undefined;
    this.topologyAt = undefined;
    this.lists = new Map();
    this.stale = new Set();
    this.sets = new Map();
    this.values = new Map();
    this.plans = new Map();
    this.writers = new Map();
    this.readOnly = new Set();
    this.holds = new Map();
    this.readCount = 0;
    this.published = undefined;
    this.badges = new Map();
    this.blocked = undefined;
    this.blockStatus = undefined;
    this.offline = false;
    this.connectedOnce = false;
    this.failures = 0;
    this.partial = 0;
    if (this.pause && !PAUSES.has(this.pause.kind)) {
      this.pause = undefined;
    }
  }

  get fingerprint() {
    return fingerprint(this.memory.salt ?? '', this.config.apiToken, this.config.refreshToken);
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badges, states). The pauses, the stops and the token stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw, { click: false });
    this.published = undefined;
    this.badges = new Map();
    const status = this.lastStatus;
    this.lastStatus = undefined;
    if (status) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadges();
  }

  /**
   * New tokens restart (the stop on refused tokens is lifted by new tokens
   * only); a new interval reschedules; a new language renames; the heating
   * option and the ceiling apply at the next command. Saved by the user
   * (`click`): a stop on a rejected token request is tried again.
   */
  async configUpdated(raw = {}, { click = true } = {}) {
    const next = normalizeConfig(raw);
    const previous = this.config;
    if (next.apiToken !== previous.apiToken || next.refreshToken !== previous.refreshToken) {
      const rotated = this.tokenUnsaved;
      if (
        next.apiToken === previous.apiToken &&
        next.pastedRefreshToken === previous.pastedRefreshToken &&
        ((rotated && next.pastedRefreshToken === rotated.seed) || this.spent.has(next.refreshToken))
      ) {
        // Gladys sent the configuration back before the rotated token was
        // saved, or a page loaded before the rotation was saved again: the
        // token in memory is the right one, and it is saved (again).
        this.config = { ...next, refreshToken: previous.refreshToken };
        this.tokenUnsaved = rotated ?? {
          seed: next.pastedRefreshToken,
          current: previous.refreshToken,
        };
        await this.saveToken();
        return;
      }
      this.tokenUnsaved = undefined;
      return this.start(raw);
    }
    this.config = next;
    if (next.language !== previous.language) {
      this.rebuild();
      await this.publishDevices();
    }
    if (click && this.blocked === 'token_rejected') {
      this.blocked = undefined;
      this.blockStatus = undefined;
      this.schedule();
      return;
    }
    if (next.pollInterval !== previous.pollInterval && this.timer !== undefined) {
      this.schedule();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  get lastMessage() {
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? undefined;
  }

  async saveMemory() {
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  /** Keeps the current stop (or none) in /data, tied to the tokens. */
  async saveBlock() {
    const block =
      this.blocked === 'refused' ? { kind: 'refused', fingerprint: this.fingerprint } : null;
    if (JSON.stringify(block) !== JSON.stringify(this.memory.block ?? null)) {
      this.memory.block = block;
      await this.saveMemory();
    }
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  // --- The refresh token ------------------------------------------------------

  /**
   * Lightwave gave a new refresh token (the old one is spent): kept in the
   * Gladys configuration, with the token the user pasted it derives from.
   * Not saved (Gladys unreachable): kept in memory, saved again at every
   * cycle, and said in the status.
   */
  async tokenRotated(next, previous) {
    const seed = this.config.pastedRefreshToken;
    if (this.config.refreshToken === previous) {
      this.config = { ...this.config, refreshToken: next };
    }
    this.spent.add(previous);
    if (this.spent.size > 50) {
      this.spent.delete(this.spent.values().next().value);
    }
    this.tokenUnsaved = { seed, current: next };
    await this.saveToken();
  }

  async saveToken() {
    const unsaved = this.tokenUnsaved;
    if (!unsaved) {
      return true;
    }
    try {
      await this.gladys.setConfig({
        [INTERNAL_KEYS.seed]: unsaved.seed,
        [INTERNAL_KEYS.current]: unsaved.current,
      });
      if (this.tokenUnsaved === unsaved) {
        this.tokenUnsaved = undefined;
      }
      return true;
    } catch (err) {
      this.logger.warn(`The new refresh token could not be saved in Gladys: ${err.message}`);
      return false;
    }
  }

  // --- Pace ------------------------------------------------------------------

  /** A pause of every path or a backoff, measured on the monotonic clock, capped. */
  setPause(kind, wait, mono = this.monotonic()) {
    const capped = Math.min(Math.max(0, wait), TIMINGS.persistedPauseMax);
    const due = mono + capped;
    if (!this.pause || due > this.pause.due || this.pause.kind !== kind) {
      this.pause = { kind, due: Math.max(due, this.pause?.due ?? 0) };
    }
  }

  /** The rest of the pause (ms), capped at every use; 0 when none. */
  pauseLeft(mono) {
    if (!this.pause) {
      return 0;
    }
    const left = Math.min(Math.max(0, this.pause.due - mono), TIMINGS.persistedPauseMax);
    if (left === 0) {
      this.pause = undefined;
    }
    return left;
  }

  /** The monotonic time from which the next read may start, from the caller's instant. */
  dueAt(mono) {
    const interval = this.config.pollInterval * 1000;
    const due = this.lastReadAt === undefined ? mono : this.lastReadAt + interval;
    return Math.max(due, mono + this.pauseLeft(mono));
  }

  /** One timer: the next read when it is due; none while the tokens are refused. */
  schedule() {
    this.clearTimer();
    if (!this.client.hasCredentials || this.blocked) {
      return;
    }
    const mono = this.monotonic();
    const wait = Math.max(0, this.dueAt(mono) - mono);
    const generation = this.generation;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      if (generation !== this.generation) {
        return undefined;
      }
      // The promise is returned for the fake timers of the tests: the real ones ignore it.
      return this.tick().catch((err) =>
        this.logger.error(`Lightwave refresh failed: ${err.message}`),
      );
    }, wait);
  }

  /** One run at a time: a tick during a run joins it. `quick`: for the button. */
  tick({ quick = false, force = false } = {}) {
    if (!this.running) {
      this.running = this.run({ quick, force }).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  async run({ quick = false, force = false } = {}) {
    const generation = this.generation;
    if (!this.client.hasCredentials || this.blocked) {
      return;
    }
    const mono = this.monotonic();
    if (!force && mono < this.dueAt(mono)) {
      this.schedule();
      return;
    }
    if (force && this.pauseLeft(mono) > 0 && PAUSES.has(this.pause?.kind)) {
      // A 429 or 403 pause holds the button too.
      this.schedule();
      return;
    }
    this.lastReadAt = mono;
    // Kept BEFORE the requests: a restart during them never reads again sooner.
    await this.saveAttempt();
    if (generation !== this.generation) {
      return;
    }
    this.client.timeout = quick ? TIMINGS.quickTimeout : undefined;
    try {
      await this.saveToken();
      if (
        !this.structures ||
        this.topologyAt === undefined ||
        mono - this.topologyAt >= TIMINGS.topologyInterval
      ) {
        await this.readTopology(mono, generation);
        if (generation !== this.generation) {
          return;
        }
      }
      const sets = readSets([...this.structures].map((s) => this.lists.get(s)).filter(Boolean));
      const values = await this.readValues(sets);
      if (generation !== this.generation) {
        return;
      }
      await this.apply(sets, values);
      this.failures = 0;
      this.offline = false;
      this.connectedOnce = true;
      if (this.pause?.kind === 'backoff') {
        this.pause = undefined;
      }
      await this.saveBlock();
      await this.setStatus(true, this.connectedMessage());
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      await this.failed(err);
    } finally {
      this.client.timeout = undefined;
    }
    await this.publishBadges();
    await this.flush();
    if (generation === this.generation) {
      this.schedule();
    }
  }

  connectedMessage() {
    const notes = [T.connected(this.readCount, this.plans.size)];
    if (this.partial > 0) {
      notes.push(T.partial(this.partial));
    }
    if (this.tokenUnsaved) {
      notes.push(T.tokenNotSaved);
    }
    return join(...notes);
  }

  /** The time of the attempt in /data, at most once a minute. */
  async saveAttempt() {
    const now = this.now();
    if (
      this.lastAttemptSavedAt !== undefined &&
      now - this.lastAttemptSavedAt < TIMINGS.attemptWriteInterval
    ) {
      return;
    }
    this.lastAttemptSavedAt = now;
    this.memory.lastAttemptAt = now;
    await this.saveMemory();
  }

  /**
   * The hierarchy, every hour: the structures of the account, then the
   * feature sets of each, each structure read on its own: one that fails
   * keeps its last sets (badge unreachable, read again in 5 min) and the
   * others go on. Only when every structure fails is the error the cycle's.
   */
  async readTopology(mono, generation) {
    try {
      this.structures = await this.client.structures();
    } catch (err) {
      if (!this.structures || FATAL.has(err.kind)) {
        throw err;
      }
      // The structures known keep working; they are read again next cycle.
      this.logger.info(`Lightwave structures not read again: ${errorReason(err)}`);
    }
    if (generation !== this.generation) {
      return;
    }
    const lists = new Map();
    const failures = new Map();
    for (const structure of this.structures) {
      try {
        lists.set(structure, readStructure(await this.client.structure(structure), structure));
      } catch (err) {
        const own = err instanceof LightwaveError && PER_STRUCTURE.has(err.kind);
        if (!own) {
          throw err;
        }
        failures.set(structure, err);
      }
    }
    if (failures.size > 0 && lists.size === 0) {
      throw [...failures.values()][0];
    }
    for (const structure of [...this.lists.keys()]) {
      if (!this.structures.includes(structure)) {
        this.lists.delete(structure);
      }
    }
    this.stale = new Set();
    for (const [structure, list] of lists) {
      this.lists.set(structure, list);
    }
    for (const [structure, err] of failures) {
      this.logger.info(`Lightwave: one structure not read (${errorReason(err)})`);
      for (const set of this.lists.get(structure) ?? []) {
        this.stale.add(set.id);
      }
    }
    this.partial = failures.size;
    // A structure not read: the hierarchy is tried again in 5 minutes, not an hour.
    this.topologyAt =
      failures.size > 0 ? mono - TIMINGS.topologyInterval + TIMINGS.topologyRetry : mono;
  }

  /** The values of the features of the sets read this cycle (the stale ones keep their old values). */
  async readValues(sets) {
    const fresh = new Map([...sets].filter(([id]) => !this.stale.has(id)));
    const ids = featureIdsOf(fresh, READ_TYPES);
    return ids.length === 0 ? new Map() : this.client.readFeatures(ids);
  }

  async apply(sets, values) {
    this.sets = sets;
    this.readCount = sets.size;
    for (const set of sets.values()) {
      if (!this.stale.has(set.id)) {
        this.values.set(set.id, valuesOf(set, values));
      }
    }
    for (const id of [...this.values.keys()]) {
      if (!sets.has(id)) {
        this.values.delete(id);
      }
    }
    this.rebuild();
    await this.publishDevices();
    this.queueStates();
  }

  /** The plans and the writers of the last read. */
  rebuild() {
    this.plans = new Map();
    this.writers = new Map();
    this.readOnly = new Set();
    for (const set of this.sets.values()) {
      const plan = planOf(set, kindOf(set), this.config.language);
      if (!plan) {
        continue;
      }
      this.plans.set(set.id, plan);
      const ids = deviceIds(this.gladys, set.id);
      for (const spec of plan.specs) {
        if (spec.write) {
          this.writers.set(ids.feature(spec.key), { setId: set.id, spec });
        } else {
          this.readOnly.add(ids.feature(spec.key));
        }
      }
    }
  }

  /** A pause of every path (429, 403), kept in /data. */
  async pauseAll(err) {
    let wait;
    let kind;
    if (err.kind === 'rate_limited') {
      wait = Math.min(
        TIMINGS.rateLimitMax,
        Math.max(TIMINGS.rateLimitMin, err.retryAfter ?? TIMINGS.rateLimitDefault),
      );
      kind = 'rate';
    } else {
      wait = TIMINGS.forbiddenPause;
      kind = 'forbidden';
      this.offline = true;
    }
    const mono = this.monotonic();
    this.setPause(kind, wait, mono);
    this.memory.pause = { kind, until: this.now() + (this.pause.due - mono) };
    await this.saveMemory();
    return wait;
  }

  blockMessage() {
    return this.blocked === 'refused' ? T.refused : T.tokenRejected(this.blockStatus ?? '?');
  }

  async failed(err) {
    const reason = errorReason(err);
    if (err.kind === 'no_credentials') {
      await this.setStatus(false, T.noCredentials);
      return;
    }
    if (err.kind === 'refused' || err.kind === 'token_rejected') {
      // Never tried again by itself: a refused refresh token is spent, and
      // new tries could lock the account. New tokens, or the button, lift it.
      this.blocked = err.kind;
      this.blockStatus = err.status;
      this.clearTimer();
      await this.saveBlock();
      this.logger.warn(`Lightwave stopped: ${reason}`);
      await this.setStatus(false, this.blockMessage());
      return;
    }
    let wait;
    let message;
    if (err.kind === 'rate_limited' || err.kind === 'forbidden') {
      wait = await this.pauseAll(err);
      message = this.pauseMessage();
    } else {
      // Never read again sooner than the interval (a 401 of every read after
      // a renewal counts as unreachable: the next cycle renews again).
      wait = Math.max(
        this.config.pollInterval * 1000,
        TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)],
      );
      this.setPause('backoff', wait);
      this.offline = OFFLINE.has(err.kind) || this.offline;
      message = T.unreachable(reason, age(wait));
    }
    this.failures += 1;
    const connected = err.kind === 'rate_limited' && this.connectedOnce;
    await this.setStatus(connected, message);
    this.logger.warn(`Lightwave: ${reason}; next try in ${Math.round(wait / 1000)} s`);
  }

  // --- Gladys ----------------------------------------------------------------

  createdDevices() {
    return new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /**
   * The devices of the last read, merged so that nothing ever disappears: a
   * created device keeps its features as Gladys has them (types and units are
   * fixed at creation), plus any new one; a device or a feature seen earlier
   * in this run stays published.
   */
  async publishDevices() {
    const created = this.createdDevices();
    for (const set of this.sets.values()) {
      const plan = this.plans.get(set.id);
      if (!plan) {
        continue;
      }
      const fresh = buildDevice(this.gladys, set, plan, this.config.language);
      const previous = this.known.get(fresh.external_id);
      const mine = created.get(fresh.external_id);
      const features = new Map();
      for (const f of mine?.features ?? []) {
        features.set(
          f.external_id,
          Object.fromEntries(
            FEATURE_FIELDS.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
          ),
        );
      }
      for (const f of [...(previous?.features ?? []), ...fresh.features]) {
        if (!features.has(f.external_id)) {
          features.set(f.external_id, f);
        }
      }
      if (!previous && this.known.size >= LIMITS.devices) {
        continue;
      }
      this.known.set(fresh.external_id, { ...fresh, features: [...features.values()] });
    }
    const list = [...this.known.values()];
    const json = JSON.stringify(list);
    if (list.length === 0 || json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(list);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  /** A commanded value waiting for its confirmation hides an older read one. */
  held(featureId, state, mono) {
    const hold = this.holds.get(featureId);
    if (!hold) {
      return false;
    }
    if (mono >= hold.until || state === hold.expected) {
      this.holds.delete(featureId);
      return false;
    }
    return true;
  }

  queueStates(created = this.createdFeatures(), only) {
    const mono = this.monotonic();
    for (const [id, plan] of this.plans) {
      // A set of a structure not read this cycle: its old values are not
      // queued again (nor sent again by the 30 min heartbeat).
      if ((only && id !== only) || this.stale.has(id)) {
        continue;
      }
      const set = this.sets.get(id);
      const values = this.values.get(id);
      if (!set || !values) {
        continue;
      }
      for (const { device_feature_external_id: featureId, state } of deviceStates(
        this.gladys,
        set,
        values,
        plan,
      )) {
        if (created.has(featureId) && !this.held(featureId, state, mono)) {
          this.publisher.push(featureId, { state });
        }
      }
    }
  }

  /** One badge per created device: cloud, or unreachable (stopped, unreachable, structure not read). */
  async publishBadges() {
    const entries = [];
    for (const device of this.gladys.devices ?? []) {
      if (!this.known.has(device.external_id)) {
        continue;
      }
      const set = [...this.sets.values()].find(
        (s) => deviceIds(this.gladys, s.id).device === device.external_id,
      );
      const unreachable = this.blocked || this.offline || !set || this.stale.has(set.id);
      const transport = unreachable ? DEVICE_TRANSPORTS.UNREACHABLE : DEVICE_TRANSPORTS.CLOUD;
      if (this.badges.get(device.external_id) !== transport) {
        entries.push({ external_id: device.external_id, transport });
      }
    }
    for (let i = 0; i < entries.length; i += 100) {
      const batch = entries.slice(i, i + 100);
      try {
        await this.gladys.publishTransports(batch);
        for (const entry of batch) {
          this.badges.set(entry.external_id, entry.transport);
        }
      } catch (err) {
        this.logger.warn(`Transport badges failed: ${err.message}`);
      }
    }
  }

  async deviceCreated(device) {
    if (device?.external_id) {
      this.badges.delete(device.external_id);
    }
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadges();
  }

  async deviceDeleted(device) {
    if (device?.external_id) {
      this.badges.delete(device.external_id);
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the devices of the last read (no extra request). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Commands --------------------------------------------------------------

  error(text) {
    return new Error(word(text, this.config.language));
  }

  /**
   * A command. Protective ("off" of a thermostat): never held back by a
   * pause, a backoff or the queue of the device; it needs a bearer token.
   */
  async setValue(device, feature, value) {
    const received = this.monotonic();
    const writer = this.writers.get(feature?.external_id);
    if (!writer) {
      throw this.error(this.readOnly.has(feature?.external_id) ? ERRORS.readOnly : ERRORS.unknown);
    }
    const number = Number(value);
    if (value === null || value === '' || typeof value === 'boolean' || !Number.isFinite(number)) {
      throw this.error(ERRORS.invalidValue);
    }
    const { setId, spec } = writer;
    const protective = Boolean(spec.protective?.(number));
    if (this.blocked || !this.client.hasCredentials) {
      throw this.error(ERRORS.blocked);
    }
    if (!protective) {
      const paused = this.commandPause(received);
      if (paused) {
        throw this.error(paused);
      }
    }
    const generation = this.generation;
    const job = () => this.command(setId, spec, number, received, generation, protective);
    if (protective) {
      await job();
      return;
    }
    await this.serial(setId, job, received + TIMINGS.commandSendBy);
  }

  /** The message of a pause that holds the commands (429, 403), else undefined. */
  commandPause(mono = this.monotonic()) {
    if (this.pauseLeft(mono) === 0 || !PAUSES.has(this.pause?.kind)) {
      return undefined;
    }
    return this.pauseMessage(mono) ?? ERRORS.paused;
  }

  /**
   * One command at a time per device: each waits for the previous one,
   * including a request still finishing in the background, but never past
   * `sendBy` (monotonic): still waiting then, it is refused unsent.
   */
  serial(setId, job, sendBy) {
    const previous = this.queues.get(setId) ?? Promise.resolve();
    let handle;
    const late = new Promise((resolve) => {
      handle = this.timers.setTimeout(() => resolve(false), Math.max(0, sendBy - this.monotonic()));
    });
    const run = Promise.race([previous.then(() => true), late]).then((ready) => {
      this.timers.clearTimeout(handle);
      if (!ready) {
        throw this.error(ERRORS.late);
      }
      return job();
    });
    const tail = Promise.all([
      previous,
      run.then(
        (result) => result?.background,
        () => {},
      ),
    ]).then(() => undefined);
    this.queues.set(setId, tail);
    tail.finally(() => {
      if (this.queues.get(setId) === tail) {
        this.queues.delete(setId);
      }
    });
    return run.then(() => undefined);
  }

  /**
   * Builds the writes (the option and the ceiling read from the
   * configuration right now), sends them once, one after the other. Gladys
   * waits 5 s: nothing is sent later than 3 s after the click (refused
   * unsent), and Gladys is answered at 4.3 s at the latest; the requests
   * then finish in the background, and their promise is returned as
   * `background` (the next command of the device waits for it). The set is
   * read again after.
   */
  async command(setId, spec, number, received, generation, protective) {
    const sendBy = received + TIMINGS.commandSendBy;
    const set = this.sets.get(setId);
    if (!set || generation !== this.generation) {
      throw this.error(ERRORS.unknown);
    }
    const payload = spec.write(number, this.values.get(setId) ?? {}, this.config);
    if (payload.refuse) {
      throw this.error(ERRORS[payload.refuse]);
    }
    if (this.blocked) {
      throw this.error(ERRORS.blocked);
    }
    const mono = this.monotonic();
    if (!protective) {
      const paused = this.commandPause(mono);
      if (paused) {
        throw this.error(paused);
      }
    }
    if (sendBy - mono < 300 || (!protective && this.client.authenticating)) {
      // Too late, or a renewal runs (the command would leave after it): unsent.
      throw this.error(ERRORS.late);
    }
    const writes = payload.writes
      .map(({ type, value }) => ({ type, value, id: set.features[type] }))
      .filter((w) => w.id);
    if (writes.length === 0) {
      throw this.error(ERRORS.unknown);
    }
    this.logger.info(`Lightwave command: ${spec.key} of a ${this.plans.get(setId)?.kind}`);
    let sent = false;
    /** The writes done (a later one past the deadline is not sent: the read after tells). */
    const done = [];
    const request = (async () => {
      for (const [index, write] of writes.entries()) {
        const left = sendBy - this.monotonic();
        if (index === 0 && left < 100) {
          throw new LightwaveError('timeout', 'not sent in time', { notSent: true });
        }
        if (index > 0 && left <= 0) {
          break;
        }
        await this.client.writeFeature(write.id, write.value, {
          timeout: TIMINGS.requestTimeout,
          ...(index === 0 ? { sendWithin: left } : {}),
          onSent: () => {
            sent = true;
          },
        });
        done.push(write);
      }
    })();
    let handle;
    const ack = new Promise((resolve) => {
      handle = this.timers.setTimeout(
        () => resolve({ pending: true }),
        Math.max(0, received + TIMINGS.commandAck - this.monotonic()),
      );
    });
    const outcome = await Promise.race([
      request.then(
        () => ({ done: true }),
        (err) => ({ err }),
      ),
      ack,
    ]);
    this.timers.clearTimeout(handle);
    if (outcome.pending && !sent) {
      // Never left (its send limit destroys it): Gladys hears it was not sent.
      request.catch(() => {});
      throw this.error(ERRORS.late);
    }
    if (outcome.pending) {
      // Sent, Lightwave still at work: Gladys is answered now, the state follows.
      const background = request
        .then(
          () => {
            if (generation === this.generation) {
              this.confirm(setId, done);
            }
          },
          async (err) => {
            this.logger.warn(`Lightwave command ${spec.key} failed: ${errorReason(err)}`);
            if (generation === this.generation && err.kind === 'rate_limited') {
              await this.pauseAll(err);
              await this.setStatus(this.connectedOnce, this.pauseMessage());
            }
          },
        )
        .finally(() => {
          if (generation === this.generation) {
            this.scheduleReread(setId);
          }
        });
      return { background };
    }
    if (outcome.err) {
      throw await this.commandFailure(outcome.err, setId, sent);
    }
    this.confirm(setId, done);
    this.scheduleReread(setId);
    return {};
  }

  /**
   * The values written become the state at once, held 15 s against an older
   * read. Published without making Gladys wait.
   */
  confirm(setId, writes) {
    const set = this.sets.get(setId);
    const plan = this.plans.get(setId);
    const before = this.values.get(setId);
    if (!set || !plan || !before) {
      return;
    }
    const after = { ...before };
    for (const write of writes) {
      after[write.type] = write.value;
    }
    this.values.set(setId, after);
    const old = new Map(
      deviceStates(this.gladys, set, before, plan).map((s) => [
        s.device_feature_external_id,
        s.state,
      ]),
    );
    this.queueStates(undefined, setId);
    // Set after the confirmed values are queued: they are the expected ones.
    const until = this.monotonic() + TIMINGS.commandHold;
    for (const { device_feature_external_id: id, state } of deviceStates(
      this.gladys,
      set,
      after,
      plan,
    )) {
      if (old.get(id) !== state) {
        this.holds.set(id, { expected: state, until });
      }
    }
    this.flush();
  }

  /** The set is read again shortly after a command (once, whatever the number of commands). */
  scheduleReread(setId) {
    const existing = this.rereads.get(setId);
    if (existing) {
      this.timers.clearTimeout(existing);
    }
    const generation = this.generation;
    this.rereads.set(
      setId,
      this.timers.setTimeout(() => {
        this.rereads.delete(setId);
        if (generation !== this.generation) {
          return undefined;
        }
        return this.reread(setId, generation).catch(() => {});
      }, TIMINGS.rereadAfterCommand),
    );
  }

  async reread(setId, generation) {
    const set = this.sets.get(setId);
    if (this.blocked || this.pauseLeft(this.monotonic()) > 0 || !set || !this.client.session) {
      return;
    }
    try {
      const ids = featureIdsOf(new Map([[setId, set]]), READ_TYPES);
      const values = await this.client.readFeatures(ids, { allowRefresh: false });
      if (generation !== this.generation || !this.sets.has(setId)) {
        return;
      }
      this.values.set(setId, { ...this.values.get(setId), ...valuesOf(set, values) });
      this.queueStates(undefined, setId);
      await this.flush();
      await this.publishBadges();
    } catch (err) {
      this.logger.info(`Lightwave device not read again: ${errorReason(err)}`);
      if (err.kind === 'rate_limited' && generation === this.generation) {
        await this.pauseAll(err);
        await this.setStatus(this.connectedOnce, this.pauseMessage());
      }
    }
  }

  async commandFailure(err, setId, sent) {
    if (!(err instanceof LightwaveError)) {
      return err;
    }
    const reason = errorReason(err);
    this.logger.warn(`Lightwave command not done: ${reason}`);
    switch (err.kind) {
      case 'rate_limited':
        await this.pauseAll(err);
        await this.setStatus(this.connectedOnce, this.pauseMessage());
        return this.error(this.pauseMessage() ?? ERRORS.paused);
      case 'unauthorized':
        // No token, or refused: the next cycle renews it; nothing was done.
        return this.error(err.notSent || !sent ? ERRORS.blocked : ERRORS.refused(reason));
      case 'timeout':
      case 'network':
        if (err.notSent && !sent) {
          return this.error(ERRORS.late);
        }
        this.scheduleReread(setId);
        return this.error(ERRORS.unsure(reason));
      case 'unavailable':
      case 'bad_response':
      case 'size':
        // Answered, but not as expected: the command may have been done.
        this.scheduleReread(setId);
        return this.error(ERRORS.unsure(reason));
      default:
        // A 403 of a command is that command refused, never a pause of everything.
        return this.error(ERRORS.refused(reason));
    }
  }

  // --- Configuration button -----------------------------------------------------

  /** A pause of every path holds for the button too. */
  pauseMessage(mono = this.monotonic()) {
    const left = this.pauseLeft(mono);
    if (left <= 0) {
      return undefined;
    }
    switch (this.pause?.kind) {
      case 'rate':
        return T.rateLimited(age(left));
      case 'forbidden':
        return T.forbidden(age(left));
      default:
        return undefined;
    }
  }

  async testConnection() {
    if (!this.client.hasCredentials) {
      return T.noCredentials;
    }
    if (this.blocked === 'refused') {
      // A refused refresh token is spent: trying again would not help.
      return T.refused;
    }
    const mono = this.monotonic();
    const paused = this.pauseMessage(mono);
    if (paused) {
      return paused;
    }
    if (this.lastTestAt !== undefined && mono - this.lastTestAt < TIMINGS.testCooldown) {
      const last = this.lastMessage;
      return last ? join(T.test.cooldown, last) : T.test.cooldown;
    }
    if (this.running) {
      return T.busy;
    }
    this.lastTestAt = mono;
    // One read per click, never sooner than the interval after the last one;
    // a rejected token request is tried again.
    this.blocked = undefined;
    this.blockStatus = undefined;
    if (this.pause?.kind === 'backoff') {
      this.pause = undefined;
    }
    const due = this.dueAt(mono);
    if (mono < due) {
      // Never a read sooner than the interval: the next one is already on its way.
      this.schedule();
      const soon = T.test.tooSoon(Math.round((due - mono) / 1000));
      const last = this.lastMessage;
      return last ? join(soon, last) : soon;
    }
    await this.tick({ quick: true, force: true });
    return this.lastMessage ?? T.noCredentials;
  }
}
