/**
 * Interactive Signal onboarding wizard.
 *
 * Implements `ironcurtain setup-signal` with three modes:
 * - Full setup: Docker check, container start, registration,
 *   recipient identity verification, and config save.
 * - Re-trust (`--re-trust`): Re-verify a changed identity key without
 *   repeating the full registration flow.
 * - Image update (`--update-image`): pull the current signal-cli image,
 *   show its digest and, once confirmed, pin it in config.json. This is the
 *   only way the bridge image changes (see `signal-image.ts`); the full setup
 *   offers the same step when the configured image is not usable without it.
 *
 * Uses @clack/prompts for consistent terminal UI with other IronCurtain
 * interactive commands (config, first-start).
 */

import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import { createDockerManager } from '../docker/docker-manager.js';
import type { ContainerRuntime } from '../docker/types.js';
import { saveUserConfig, loadUserConfig, loadSavedSignalContainerConfig } from '../config/user-config.js';
import {
  createSignalContainerManager,
  type SignalContainerManager,
  type SignalContainerConfig,
} from './signal-container.js';
import { SIGNAL_DEFAULTS, resolveSignalConfig, getSignalDataDir } from './signal-config.js';
import {
  SIGNAL_IMAGE_DIGEST_PLACEHOLDER,
  SIGNAL_IMAGE_UPDATE_TAG,
  SIGNAL_BRIDGE_LOCAL_IMAGE,
  SIGNAL_BRIDGE_BUILD_COMMAND,
  discardSignalImageCandidate,
  hasSignalImageErrorCode,
  parseImageReference,
  pullSignalImageCandidate,
  tagNotRestoredMessage,
  type SignalImageCandidate,
} from './signal-image.js';
import { selectRecipientIdentity } from './recipient-identity.js';
import { checkDockerAvailable } from '../docker/docker-probe.js';
import type { SignalBridgeClient } from './signal-bridge-client.js';

function localImageBuildGuidance(): string {
  return (
    `Build the local authenticated Signal bridge by running "${SIGNAL_BRIDGE_BUILD_COMMAND}" in the IronCurtain ` +
    'source checkout, then retry. Alternatively, configure signal.container.image with a reviewed published authenticated image.'
  );
}

// ---- Cancel handling ------------------------------------------------

/** Checks if a prompt result was cancelled and exits cleanly. */
function handleCancel(value: unknown): void {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
}

// ---- Phone number validation ----------------------------------------

const E164_REGEX = /^\+\d{7,15}$/;

/** Validates a phone number in E.164 format. Returns error string or undefined. */
export function validatePhoneNumber(value: string | undefined): string | undefined {
  if (!value) return 'Phone number is required';
  if (!E164_REGEX.test(value)) {
    return 'Must be E.164 format: +<country code><number> (e.g., +15551234567)';
  }
  return undefined;
}

// ---- Docker validation ----------------------------------------------

// We deliberately skip docker.preflight() here: that also requires the
// signal-cli image to exist, but in this wizard we pull/build it ourselves
// afterwards. We only need to confirm the daemon is reachable.
async function validateDocker(): Promise<void> {
  const spinner = p.spinner();
  spinner.start('Checking Docker...');

  const status = await checkDockerAvailable();
  if (status.available) {
    spinner.stop('Docker is available');
    return;
  }

  spinner.stop('Docker is not available');
  p.log.error(
    `Docker is not available. Start Docker and try again.\n\n${status.detailedMessage}\n\n` +
      'Install Docker: https://docs.docker.com/get-docker/',
  );
  process.exit(1);
}

// ---- Container setup ------------------------------------------------

/**
 * The container settings for the wizard: the image and port saved in
 * config.json (an image pinned earlier, a custom port), else the defaults.
 */
function resolveContainerConfig(): SignalContainerConfig {
  const saved = loadSavedSignalContainerConfig();
  return {
    image: saved?.image ?? SIGNAL_DEFAULTS.image,
    port: saved?.port ?? SIGNAL_DEFAULTS.port,
    dataDir: getSignalDataDir(),
    containerName: SIGNAL_DEFAULTS.containerName,
  };
}

interface StartedContainer {
  readonly client: SignalBridgeClient;
  readonly manager: SignalContainerManager;
  /** The settings the container runs with (the image may have been pinned just now). */
  readonly containerConfig: SignalContainerConfig;
}

/**
 * Starts the container and waits for it to become healthy. When the
 * configured image cannot be used without an explicit pull (this build has
 * no reviewed digest, or a tag is not present locally), offers to pull the
 * current image and pin its digest, then starts from that.
 */
async function startContainer(docker: ContainerRuntime, initial: SignalContainerConfig): Promise<StartedContainer> {
  let containerConfig = initial;
  for (;;) {
    const manager = createSignalContainerManager(docker, containerConfig);
    const startSpinner = p.spinner();
    startSpinner.start('Starting signal-cli container...');
    let client: SignalBridgeClient;
    try {
      client = await manager.ensureRunning();
    } catch (err) {
      if (
        containerConfig.image === SIGNAL_BRIDGE_LOCAL_IMAGE &&
        hasSignalImageErrorCode(err, 'SIGNAL_IMAGE_NOT_PINNED')
      ) {
        startSpinner.stop('Local authenticated Signal bridge image is missing');
        p.log.error(localImageBuildGuidance());
        process.exit(1);
      }
      if (containerConfig === initial && hasSignalImageErrorCode(err, 'SIGNAL_IMAGE_NOT_PINNED')) {
        startSpinner.stop('The signal-cli image is not pinned yet');
        const pinned = await pinImageInteractively(docker, containerConfig.image);
        containerConfig = { ...containerConfig, image: pinned.reference };
        continue;
      }
      startSpinner.stop('Container start failed');
      reportContainerStartFailure(err, containerConfig);
      process.exit(1);
    }
    startSpinner.stop(`Container started on port ${containerConfig.port}`);

    const healthSpinner = p.spinner();
    healthSpinner.start('Waiting for signal-cli to become healthy...');
    try {
      await manager.waitForHealthy(client);
      healthSpinner.stop('Health check passed');
    } catch (err) {
      client.close();
      healthSpinner.stop('Health check failed');
      p.log.error(`signal-cli container did not become healthy: ${errorText(err)}`);
      process.exit(1);
    }

    return { client, manager, containerConfig };
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function reportContainerStartFailure(err: unknown, containerConfig: SignalContainerConfig): void {
  const message = errorText(err);
  if (message.includes('port') && message.includes('already')) {
    p.log.error(
      `Port ${containerConfig.port} is already in use.\n` +
        'Either stop the conflicting service or configure a different port\n' +
        'in ~/.ironcurtain/config.json under signal.container.port.',
    );
  } else {
    p.log.error(`Failed to start container: ${message}`);
  }
}

// ---- Image pinning --------------------------------------------------

/**
 * Pulls the current image for `currentImage` (its repository, at the tag it
 * names or `latest`) and shows its digest. Exits when the pull fails.
 */
async function pullCandidate(docker: ContainerRuntime, currentImage: string): Promise<SignalImageCandidate> {
  const reference = parseImageReference(currentImage);
  const spinner = p.spinner();
  spinner.start(
    `Pulling ${reference ? `${reference.repository}:${reference.tag ?? SIGNAL_IMAGE_UPDATE_TAG}` : currentImage}...`,
  );
  let candidate: SignalImageCandidate;
  try {
    candidate = await pullSignalImageCandidate(docker, currentImage);
  } catch (err) {
    spinner.stop('Pull failed');
    p.log.error(errorText(err));
    process.exit(1);
  }
  spinner.stop(`Pulled ${candidate.source}`);

  const current =
    reference?.digest === SIGNAL_IMAGE_DIGEST_PLACEHOLDER
      ? `${currentImage}\n                  (placeholder: no reviewed digest in this build)`
      : currentImage;
  p.note(
    `Pulled:           ${candidate.source}\n` +
      `Digest:           ${candidate.digest}\n` +
      `Image ID:         ${candidate.imageId}\n` +
      `Built:            ${candidate.created || 'unknown'}\n` +
      `Configured now:   ${current}\n\n` +
      'Compare the digest with the one the image publisher lists for this tag before you pin it.\n' +
      'The signal-cli container sees every message and every identity check, so it can approve escalations.',
    'signal-cli image',
  );
  return candidate;
}

/**
 * Asks whether to pin `candidate`. When the user declines or cancels, the
 * pull is undone first (a configured tag goes back to the image it named),
 * so declining leaves the bridge image as it was; returns false then.
 */
async function confirmCandidate(
  docker: ContainerRuntime,
  candidate: SignalImageCandidate,
  message: string,
): Promise<boolean> {
  const confirmed = await p.confirm({ message, initialValue: true });
  if (confirmed === true) return true;
  if (!(await discardSignalImageCandidate(docker, candidate))) p.log.error(tagNotRestoredMessage(candidate.source));
  handleCancel(confirmed);
  return false;
}

/**
 * The wizard's pin step: explains why, pulls the current image, shows its
 * digest and asks to pin it. Exits when the user declines (setup cannot go
 * on without an image).
 */
async function pinImageInteractively(docker: ContainerRuntime, currentImage: string): Promise<SignalImageCandidate> {
  p.log.warn(
    'IronCurtain runs the signal-cli bridge only from an image pinned by digest, and the configured image\n' +
      `(${currentImage}) cannot be used without pulling one first. The wizard can pull the current image\n` +
      'now, show its digest and pin it in ~/.ironcurtain/config.json.',
  );
  const candidate = await pullCandidate(docker, currentImage);
  if (!(await confirmCandidate(docker, candidate, `Pin ${candidate.reference} and use it?`))) {
    p.cancel('Setup cancelled: no pinned signal-cli image. Set signal.container.image to an image pinned by digest.');
    process.exit(0);
  }
  return candidate;
}

/**
 * `ironcurtain setup-signal --update-image`: pulls the current signal-cli
 * image, shows its digest and, once confirmed, records
 * `<repository>@<digest>` as `signal.container.image`. The container is
 * recreated from it the next time the bot or daemon starts it. Declining
 * changes nothing: a configured tag the pull moved is put back.
 */
export async function runUpdateImage(): Promise<void> {
  p.intro('Signal Bridge Image Update');

  const saved = loadSavedSignalContainerConfig();
  const currentImage = saved?.image ?? SIGNAL_DEFAULTS.image;
  if (currentImage === SIGNAL_BRIDGE_LOCAL_IMAGE) {
    p.log.info(localImageBuildGuidance());
    p.outro('Rebuild the local authenticated image to update it.');
    return;
  }
  if (parseImageReference(currentImage) === undefined) {
    p.log.error(
      `signal.container.image is not a valid image reference: ${JSON.stringify(currentImage)}. ` +
        'Fix or remove it in ~/.ironcurtain/config.json and try again.',
    );
    process.exit(1);
  }

  await validateDocker();
  const docker = createDockerManager();
  const candidate = await pullCandidate(docker, currentImage);

  if (parseImageReference(currentImage)?.digest === candidate.digest) {
    p.outro('Already pinned to this image. Nothing changed.');
    return;
  }

  if (!(await confirmCandidate(docker, candidate, `Pin ${candidate.reference}?`))) {
    p.cancel('Image not changed.');
    return;
  }

  saveUserConfig({ signal: { container: { ...saved, image: candidate.reference } } });
  p.outro(
    `Pinned ${candidate.reference}. Restart \`ironcurtain bot\` or the daemon to switch: ` +
      'the signal-cli container is recreated from the pinned image when it next starts.',
  );
}

// ---- Account discovery -----------------------------------------------

async function fetchAccounts(client: SignalBridgeClient): Promise<string[]> {
  try {
    const resp = await client.request('/v1/accounts');
    if (resp.status === 401 || resp.status === 403) {
      throw new Error('Signal bridge authentication failed');
    }
    if (!resp.ok) return [];
    const accounts = (await resp.json()) as string[];
    if (accounts.length > 0) return accounts;
  } catch (err) {
    if (err instanceof Error && err.message === 'Signal bridge authentication failed') throw err;
    // Fall through to local check
  }

  // Fallback: in json-rpc mode, signal-cli loads accounts at startup.
  // If registration happened after the container started, the REST API
  // won't know about the account until a restart. Check the host data
  // directory directly.
  return readAccountsFromDataDir();
}

/**
 * Reads accounts directly from signal-cli's accounts.json on the host.
 * This catches accounts the REST API doesn't see (json-rpc mode startup race).
 */
function readAccountsFromDataDir(): string[] {
  try {
    const accountsPath = resolve(getSignalDataDir(), 'data', 'accounts.json');
    const data = JSON.parse(readFileSync(accountsPath, 'utf-8')) as {
      accounts?: Array<{ number?: string }>;
    };
    return (data.accounts ?? []).map((a) => a.number).filter((n): n is string => !!n);
  } catch {
    return [];
  }
}

// ---- Registration flow ----------------------------------------------

/**
 * Registers a new phone number with Signal via the signal-cli REST API.
 * Handles the captcha and SMS verification code flow.
 */
export async function registerNewNumber(client: SignalBridgeClient): Promise<string> {
  const phoneNumber = await p.text({
    message: 'Enter the phone number to register (with country code):',
    placeholder: '+15551234567',
    validate: validatePhoneNumber,
  });
  handleCancel(phoneNumber);

  // Direct the user to the captcha page
  const captchaUrl = 'https://signalcaptchas.org/registration/generate.html';
  p.log.info(
    'To complete registration, Signal requires a captcha.\n' +
      'Open this URL in your browser:\n\n' +
      `  ${captchaUrl}\n\n` +
      'After completing the captcha, right-click the "Open Signal"\n' +
      'button and copy the link. It will start with signalcaptcha://\n' +
      'Paste the full link below.',
  );

  const captchaRaw = await p.text({
    message: 'Paste the captcha link:',
    validate: (v) => (v?.includes('signalcaptcha://') ? undefined : 'Must contain signalcaptcha://'),
  });
  handleCancel(captchaRaw);

  // Strip the signalcaptcha:// prefix - signal-cli expects just the token
  const captcha = (captchaRaw as string).replace(/^signalcaptcha:\/\//, '');

  // POST /v1/register/{number}
  const registerSpinner = p.spinner();
  registerSpinner.start(`Registering ${phoneNumber as string}...`);

  const registerResp = await client.request(`/v1/register/${encodeURIComponent(phoneNumber as string)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ captcha }),
  });
  if (!registerResp.ok) {
    registerSpinner.stop('Registration failed');
    if (registerResp.status === 400) {
      p.log.error('Captcha rejected by Signal. Please try again with a new captcha.');
    } else {
      p.log.error(`Registration failed: ${registerResp.status}`);
    }
    throw new Error(`Registration failed: ${registerResp.status}`);
  }
  registerSpinner.stop('Registration request sent');

  // SMS verification code
  const verifyCode = await p.text({
    message: 'Enter the verification code from SMS:',
    validate: (v) => (v && /^\d{3}-?\d{3}$/.test(v) ? undefined : 'Enter 6-digit code (e.g., 123-456)'),
  });
  handleCancel(verifyCode);

  const normalizedCode = (verifyCode as string).replace('-', '');

  // POST /v1/register/{number}/verify/{code}
  const verifySpinner = p.spinner();
  verifySpinner.start('Verifying...');

  const verifyResp = await client.request(
    `/v1/register/${encodeURIComponent(phoneNumber as string)}/verify/${normalizedCode}`,
    { method: 'POST' },
  );
  if (!verifyResp.ok) {
    verifySpinner.stop('Verification failed');
    p.log.error(`Verification failed: ${verifyResp.status}`);
    throw new Error(`Verification failed: ${verifyResp.status}`);
  }

  verifySpinner.stop('Phone number verified!');
  return phoneNumber as string;
}

// ---- Challenge-response identity verification -----------------------

/** The recipient's identity as captured by the challenge-response exchange. */
export interface CapturedIdentity {
  /** The identity key fingerprint (no whitespace), stored as `recipientIdentityKey`. */
  readonly identityKey: string;
  /**
   * The account UUID signal-cli lists for that key, when any, stored as
   * `recipientUuid` so the runtime check verifies this very record.
   */
  readonly uuid?: string;
}

/**
 * Sends a random challenge code to the recipient via Signal,
 * waits for the user to type it into the terminal, then
 * captures and returns the recipient's identity key.
 *
 * The identity key comes from signal-cli's identity endpoint
 * after a successful message exchange has occurred.
 */
export async function verifyRecipientIdentity(
  client: SignalBridgeClient,
  botNumber: string,
  recipientNumber: string,
): Promise<CapturedIdentity> {
  const challengeCode = String(randomInt(100000, 999999));

  // Send the challenge via Signal
  p.log.info('A 6-digit challenge code has been sent to your Signal app.');
  const sendResp = await client.request('/v2/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `IronCurtain identity verification.\nYour challenge code is: ${challengeCode}`,
      number: botNumber,
      recipients: [recipientNumber],
    }),
  });
  if (!sendResp.ok) {
    throw new Error(`Failed to send challenge message: ${sendResp.status}`);
  }

  // Prompt user to enter the code they received
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    const entered = await p.text({
      message: 'Enter the challenge code from your Signal app:',
      validate: (v) => (v && /^\d{6}$/.test(v) ? undefined : 'Enter the 6-digit code'),
    });
    handleCancel(entered);

    if (entered === challengeCode) {
      break;
    }

    attempts++;
    if (attempts >= maxAttempts) {
      throw new Error(
        'Challenge verification failed after 3 attempts. ' +
          'Ensure you are reading the code from the correct Signal conversation.',
      );
    }
    p.log.warn(`Incorrect code. ${maxAttempts - attempts} attempt(s) remaining.`);
  }

  // Capture the recipient's identity key from signal-cli
  return fetchIdentityKey(client, botNumber, recipientNumber);
}

/**
 * Fetches the recipient's identity key from signal-cli's trust store.
 * Retries once after a short delay if the key is not yet available
 * (signal-cli may need time to process the message exchange).
 *
 * The record is chosen by number (the newest one), exactly as the runtime
 * check chooses it for a configuration without a UUID; its UUID is captured
 * so that later checks verify this record (see `recipient-identity.ts`).
 */
async function fetchIdentityKey(
  client: SignalBridgeClient,
  botNumber: string,
  recipientNumber: string,
): Promise<CapturedIdentity> {
  const fetchKey = async (): Promise<CapturedIdentity | undefined> => {
    // The per-recipient endpoint (/v1/identities/{bot}/{recipient}) is not
    // available in all versions. Use the all-identities endpoint and filter.
    const resp = await client.request(`/v1/identities/${encodeURIComponent(botNumber)}`);
    if (!resp.ok) return undefined;

    // The fingerprint comes back without whitespace (signal-cli may list "05 a1 b2 ...").
    const selected = selectRecipientIdentity(await resp.json(), { number: recipientNumber });
    if (selected === undefined) return undefined;
    return { identityKey: selected.fingerprint, ...(selected.uuid !== undefined ? { uuid: selected.uuid } : {}) };
  };

  let identity = await fetchKey();
  if (!identity) {
    // Retry after a short delay - signal-cli may still be processing
    await new Promise((resolve) => setTimeout(resolve, 2000));
    identity = await fetchKey();
  }

  if (!identity) {
    throw new Error(
      'Identity key could not be retrieved. ' +
        'This may indicate signal-cli has not yet exchanged keys with the recipient.',
    );
  }

  p.log.success(
    `Identity verified! Signal identity key recorded.\n` +
      `  Fingerprint: ${identity.identityKey.substring(0, 20)}...` +
      (identity.uuid !== undefined ? `\n  Account UUID: ${identity.uuid}` : ''),
  );

  return identity;
}

// ---- Re-trust flow --------------------------------------------------

/**
 * Re-verifies a changed identity key without repeating full registration.
 * Used when the transport detects an identity key change at runtime.
 */
export async function runReTrust(): Promise<void> {
  p.intro('Signal Identity Re-verification');

  const userConfig = loadUserConfig();
  const signalConfig = resolveSignalConfig(userConfig);

  if (!signalConfig) {
    p.log.error('Signal is not configured. Run: ironcurtain setup-signal');
    process.exit(1);
  }

  const { botNumber, recipientNumber, recipientIdentityKey: previousKey } = signalConfig;

  p.note(
    `The Signal identity key for ${recipientNumber} has changed.\n` +
      'This can happen when:\n' +
      '  - You re-installed Signal\n' +
      '  - You switched to a new phone\n' +
      '  - Someone else has taken over the phone number\n\n' +
      'To re-establish trust, a new challenge code will be sent.',
    'Identity changed',
  );

  // Validate the bridge's security configuration even when it is running.
  const docker = createDockerManager();
  const containerManager = createSignalContainerManager(docker, signalConfig.container);
  const startSpinner = p.spinner();
  startSpinner.start('Starting signal-cli container...');
  let client: SignalBridgeClient | undefined;
  try {
    client = await containerManager.ensureRunning();
    await containerManager.waitForHealthy(client);
    startSpinner.stop('Container started');
  } catch (err) {
    client?.close();
    startSpinner.stop('Failed to start container');
    p.log.error(`Could not start signal-cli container: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  try {
    const identity = await verifyRecipientIdentity(client, botNumber, recipientNumber);
    const newKey = identity.identityKey;

    // Save the new identity key, with the UUID of its record. An absent UUID
    // removes the old one, which names the record of the previous key.
    saveUserConfig({
      signal: {
        botNumber,
        recipientNumber,
        recipientIdentityKey: newKey,
        recipientUuid: identity.uuid,
      },
    });

    p.note(
      `Previous key: ${previousKey.substring(0, 20)}...\n` + `New key:      ${newKey.substring(0, 20)}...`,
      'Key updated',
    );

    p.outro('Transport unlocked. Sessions will now accept messages.');
  } finally {
    client.close();
  }
}

// ---- Main setup wizard ----------------------------------------------

/**
 * Runs the interactive Signal setup wizard.
 *
 * Steps:
 * 1. Validate Docker availability
 * 2. Start the signal-cli container from the pinned image (offering to pin
 *    the current one when the configured image needs it)
 * 3. Register new number (or reuse existing account)
 * 4. Configure recipient number
 * 5. Challenge-response identity verification
 * 6. Capture and store identity key
 * 7. Save config
 */
export async function runSignalSetup(options?: { reTrust?: boolean; updateImage?: boolean }): Promise<void> {
  if (options?.reTrust) {
    await runReTrust();
    return;
  }
  if (options?.updateImage) {
    await runUpdateImage();
    return;
  }

  p.intro('Signal Transport Setup');

  p.note(
    'Signal lets you interact with IronCurtain sessions from your\n' +
      'phone. The communication channel is end-to-end encrypted and\n' +
      'securely paired between the bot and your phone.\n\n' +
      "You'll need:\n" +
      '  - Docker running on this machine\n' +
      '  - A dedicated phone number for the bot\n' +
      '  - Your own Signal phone number (to receive messages)',
    'What is this?',
  );

  const cont = await p.confirm({ message: 'Continue with setup?', initialValue: true });
  handleCancel(cont);
  if (!cont) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  // The final save refuses to replace a config.json it cannot parse (it holds
  // API keys and credentials), so stop now rather than after registering a number.
  try {
    loadUserConfig({ readOnly: true });
  } catch (err) {
    p.log.error(`Cannot update the IronCurtain config: ${err instanceof Error ? err.message : String(err)}`);
    p.log.info('Fix the config file (or move it aside) and re-run setup-signal.');
    process.exit(1);
  }

  // Step 1: Docker check
  await validateDocker();
  const docker = createDockerManager();

  // Step 2: Start the container from the pinned image (pinning one first if needed)
  const { client, manager, containerConfig } = await startContainer(docker, resolveContainerConfig());
  try {
    // Step 3: Check for existing accounts, then register
    let botNumber: string;

    const existingAccounts = await fetchAccounts(client);
    if (existingAccounts.length > 0) {
      const useExisting = await p.select({
        message: `Found existing account: ${existingAccounts.join(', ')}. What would you like to do?`,
        options: [
          { value: 'use', label: `Use ${existingAccounts[0]}`, hint: 'skip registration' },
          { value: 'register', label: 'Register a new phone number' },
        ],
      });
      handleCancel(useExisting);

      if (useExisting === 'use') {
        botNumber = existingAccounts[0];
        p.log.success(`Using existing account: ${botNumber}`);
      } else {
        botNumber = await registerNewNumber(client);
      }
    } else {
      botNumber = await registerNewNumber(client);
    }

    // In json-rpc mode, signal-cli loads accounts at startup. After registration
    // or when the account was found only in the data directory, restart the
    // container so the daemon picks up the account for subsequent API calls.
    const restartSpinner = p.spinner();
    restartSpinner.start('Restarting signal-cli to load account...');
    try {
      await docker.stop(containerConfig.containerName);
      await docker.start(containerConfig.containerName);
      await manager.waitForHealthy(client);
      restartSpinner.stop('signal-cli restarted');
    } catch (err) {
      restartSpinner.stop('Restart failed');
      p.log.error(`Failed to restart container: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    // Step 4: Recipient number
    const recipientNumber = await p.text({
      message: 'Enter YOUR Signal phone number (to receive agent messages):',
      placeholder: '+15559876543',
      validate: validatePhoneNumber,
    });
    handleCancel(recipientNumber);

    // Step 5: Challenge-response identity verification
    const identity = await verifyRecipientIdentity(client, botNumber, recipientNumber as string);

    // Step 6: Save config. The image is recorded only when it is not the
    // built-in default, so a later release's reviewed default pin applies to
    // this install; an image pinned by the user (or just now) is kept.
    saveUserConfig({
      signal: {
        botNumber,
        recipientNumber: recipientNumber as string,
        recipientIdentityKey: identity.identityKey,
        recipientUuid: identity.uuid,
        container: {
          ...(containerConfig.image !== SIGNAL_DEFAULTS.image ? { image: containerConfig.image } : {}),
          port: containerConfig.port,
        },
      },
    });

    // Summary
    p.note(
      `Bot number:       ${botNumber}\n` +
        `Your number:      ${recipientNumber as string}\n` +
        `Identity key:     ${identity.identityKey.substring(0, 20)}...\n` +
        `Image:            ${containerConfig.image}\n` +
        `Container:        ${containerConfig.containerName}\n` +
        `API port:         ${containerConfig.port}`,
      'Configuration saved',
    );

    p.outro('Setup complete. Run: ironcurtain bot');
  } finally {
    client.close();
  }
}
