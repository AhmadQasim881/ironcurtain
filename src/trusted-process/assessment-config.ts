/**
 * Session setup for the outbound content assessment: turns the user's
 * `contentAssessment` settings into the coordinator's assessor options and
 * builds the model of the optional intelligibility check. Kept apart from
 * assessment.ts so the security pipeline does not depend on model
 * construction.
 */

import type { ResolvedUserConfig } from '../config/user-config.js';
import { createLanguageModel } from '../config/model-provider.js';
import * as logger from '../logger.js';
import type { ContentAssessorOptions } from './assessment.js';

/**
 * The assessor settings for a session from the user's config, or undefined
 * when the assessment is off (the default). With the intelligibility check
 * on, its model is built here; when that fails the session still starts,
 * with a warning, and every call that reaches the check escalates.
 */
export async function contentAssessorOptionsFromConfig(
  userConfig: ResolvedUserConfig,
): Promise<ContentAssessorOptions | undefined> {
  const settings = userConfig.contentAssessment;
  if (settings?.enabled !== true) return undefined;
  if (!settings.llmCheck) return { llmCheck: false };
  try {
    const model = await createLanguageModel(settings.llmModelId, userConfig, 'contentAssessment');
    return { llmCheck: true, model, modelId: settings.llmModelId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[content-assessment] Could not create the intelligibility check model (${settings.llmModelId}): ${message}. ` +
        'Every call that reaches the check escalates until the model works or contentAssessment.llmCheck is turned off.',
    );
    return { llmCheck: true, model: null, modelId: settings.llmModelId };
  }
}
