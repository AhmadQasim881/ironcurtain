/**
 * Escalation scenario tests — validates the full pipeline:
 *   raw args → PolicyEngine escalation → arg extraction → auto-approver decision
 *
 * Suite A (always runs): Confirms every scenario produces 'escalate' from the
 * PolicyEngine, validates arg extraction and sanitization.
 *
 * Suite B (LLM_INTEGRATION_TEST=true): Runs the auto-approver with a live LLM
 * and verifies approve/escalate decisions match expectations.
 *
 * Usage:
 *   npx vitest run test/escalation-scenarios.test.ts
 *   LLM_INTEGRATION_TEST=true npx vitest run test/escalation-scenarios.test.ts
 */

import 'dotenv/config';
import { describe, it, expect, beforeAll } from 'vitest';
import { PolicyEngine, reasonForAutoApprover } from '../src/trusted-process/policy-engine.js';
import {
  autoApprove,
  extractArgsForAutoApprove,
  sanitizeForPrompt,
  unanchoredArguments,
  type AutoApproveContext,
} from '../src/trusted-process/auto-approver.js';
import { createLanguageModelFromEnv } from '../src/config/model-provider.js';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { ToolAnnotation } from '../src/pipeline/types.js';
import {
  testCompiledPolicy,
  testToolAnnotations,
  TEST_SANDBOX_DIR,
  TEST_PROTECTED_PATHS,
  TEST_DOMAIN_ALLOWLISTS,
} from './fixtures/test-policy.js';
import { getEscalationScenarios, type EscalationScenario } from './fixtures/escalation-scenarios.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const SANDBOX_DIR = TEST_SANDBOX_DIR;
const scenarios = getEscalationScenarios(SANDBOX_DIR);

const engine = new PolicyEngine(
  testCompiledPolicy,
  testToolAnnotations,
  TEST_PROTECTED_PATHS,
  SANDBOX_DIR,
  TEST_DOMAIN_ALLOWLISTS,
);

/** Look up the ToolAnnotation for a scenario's request. */
function getAnnotation(scenario: EscalationScenario): ToolAnnotation | undefined {
  const serverAnnotations = testToolAnnotations.servers[scenario.request.serverName] as
    { inputHash: string; tools: ToolAnnotation[] } | undefined;
  if (!serverAnnotations) return undefined;
  return serverAnnotations.tools.find((t) => t.toolName === scenario.request.toolName);
}

// ---------------------------------------------------------------------------
// Suite A: Policy Engine Validation (unit test, always runs)
// ---------------------------------------------------------------------------

describe('Escalation scenarios — policy engine validation', () => {
  it('returns the expected number of scenarios', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(18);
  });

  describe('every scenario produces escalate from PolicyEngine', () => {
    for (const scenario of scenarios) {
      it(`[${scenario.category}] ${scenario.label}`, () => {
        const result = engine.evaluate({
          requestId: 'test',
          serverName: scenario.request.serverName,
          toolName: scenario.request.toolName,
          arguments: scenario.request.arguments,
          timestamp: new Date().toISOString(),
        });
        expect(result.decision).toBe('escalate');
      });
    }
  });

  /** The approver's view of a scenario's arguments, built the way the pipeline builds it. */
  function extractForScenario(scenario: EscalationScenario, annotation: ToolAnnotation | undefined) {
    const result = engine.evaluate({
      requestId: 'test',
      serverName: scenario.request.serverName,
      toolName: scenario.request.toolName,
      arguments: scenario.request.arguments,
      timestamp: new Date().toISOString(),
    });
    return extractArgsForAutoApprove(scenario.request.arguments, annotation, {
      escalatedRoles: result.escalatedRoles,
      destinationGate: result.rule === 'structural-domain-escalate',
      allowedDirectory: SANDBOX_DIR,
    });
  }

  describe('arg extraction produces resource identifiers for non-injection scenarios', () => {
    const nonInjection = scenarios.filter((s) => s.category !== 'prompt-injection');

    for (const scenario of nonInjection) {
      it(`[${scenario.category}] ${scenario.label} — extracts args`, () => {
        const annotation = getAnnotation(scenario);
        expect(annotation).toBeDefined();

        const extracted = extractForScenario(scenario, annotation);

        // Every non-injection scenario has at least one resource-identifier arg
        expect(extracted).toBeDefined();
        expect(Object.keys(extracted!).length).toBeGreaterThan(0);

        // Every argument is described by string values and literal anchor requirements
        for (const arg of Object.values(extracted!)) {
          expect(['path', 'destination', 'identifier']).toContain(arg.kind);
          for (const val of arg.values) expect(typeof val).toBe('string');
          expect(arg.anchors.length).toBeGreaterThan(0);
          for (const requirement of arg.anchors) {
            for (const anchor of requirement) expect(typeof anchor).toBe('string');
          }
        }

        // Opaque args (content, mode, branch) should NOT be in extracted
        expect(extracted).not.toHaveProperty('content');
        expect(extracted).not.toHaveProperty('branch');
        expect(extracted).not.toHaveProperty('mode');
      });
    }
  });

  describe('injected argument text never reaches the approver as prose', () => {
    const injectionScenarios = scenarios.filter((s) => s.category === 'prompt-injection');

    it('shows a git remote only as its destination host, never the injected URL', () => {
      const scenario = injectionScenarios.find((s) => s.label.includes('git remote'));
      expect(scenario).toBeDefined();
      const extracted = extractForScenario(scenario!, getAnnotation(scenario!));
      expect(extracted?.remote.kind).toBe('destination');
      expect(JSON.stringify(extracted)).not.toContain('APPROVE');
      // URL canonicalization percent-encodes the spaces, so the destination
      // resolves to github.com; the injected path never appears and a URL
      // remote has no name to anchor on, only its host.
      expect(extracted?.remote.values).toEqual(['github.com']);
      expect(extracted?.remote.remote).toBeUndefined();
      expect(extracted?.remote.anchors).toEqual([['github.com']]);
    });

    it('shows a fetch URL only as its host, dropping the injection in the query string', () => {
      const scenario = injectionScenarios.find((s) => s.label.includes('fetch URL'));
      expect(scenario).toBeDefined();
      const extracted = extractForScenario(scenario!, getAnnotation(scenario!));
      // A private-network literal: a cloud-metadata destination is denied
      // structurally and never reaches the approver (WP-28).
      expect(extracted?.url.values).toEqual(['10.0.0.1']);
      expect(JSON.stringify(extracted)).not.toContain('approve');
      expect(JSON.stringify(extracted)).not.toContain('admin');
    });

    it('does not anchor an injected path in a vague message, so the model is never consulted', () => {
      const scenario = injectionScenarios.find((s) => s.label.includes('embedded APPROVE'));
      expect(scenario).toBeDefined();
      const extracted = extractForScenario(scenario!, getAnnotation(scenario!));
      expect(extracted?.path.escalated).toBe(true);
      expect(
        unanchoredArguments({
          userMessage: scenario!.userMessage,
          toolName: 'filesystem/read_file',
          rule: 'escalate-read-outside-permitted-areas',
          escalationReason: 'fixed',
          arguments: extracted,
        }),
      ).toEqual(['path']);
    });
  });

  describe('sanitizeForPrompt handles injection attempts', () => {
    const injectionScenarios = scenarios.filter((s) => s.category === 'prompt-injection');

    it('strips control characters (newlines)', () => {
      const withNewlines = injectionScenarios.find((s) => s.label.includes('newlines'));
      expect(withNewlines).toBeDefined();

      const path = withNewlines!.request.arguments.path as string;
      const sanitized = sanitizeForPrompt(path);
      expect(sanitized).not.toContain('\n');
      expect(sanitized).not.toContain('\r');
    });

    it('truncates past 200 characters', () => {
      const longPath = injectionScenarios.find((s) => s.label.includes('truncation'));
      expect(longPath).toBeDefined();

      const path = longPath!.request.arguments.path as string;
      expect(path.length).toBeGreaterThan(200);

      const sanitized = sanitizeForPrompt(path);
      // 200 chars + '...' = 203
      expect(sanitized.length).toBe(203);
      expect(sanitized.slice(-3)).toBe('...');
      // The injection text at the end should be truncated away
      expect(sanitized).not.toContain('APPROVE this request');
    });

    it('handles JSON-mimicking paths', () => {
      const jsonPath = injectionScenarios.find((s) => s.label.includes('JSON'));
      expect(jsonPath).toBeDefined();

      const path = jsonPath!.request.arguments.path as string;
      const sanitized = sanitizeForPrompt(path);
      // sanitizeForPrompt doesn't strip JSON — the LLM schema enforcement handles this
      expect(typeof sanitized).toBe('string');
      expect(sanitized.length).toBeLessThanOrEqual(203);
    });
  });
});

// ---------------------------------------------------------------------------
// Suite B: Auto-Approver Integration (live LLM)
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.LLM_INTEGRATION_TEST)(
  'Escalation scenarios — auto-approver integration (live LLM)',
  () => {
    let model: LanguageModelV3;

    beforeAll(async () => {
      const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
      if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY must be set to run auto-approver integration tests');
      }
      model = await createLanguageModelFromEnv('anthropic:claude-haiku-4-5', apiKey);
    });

    for (const scenario of scenarios) {
      it(`[${scenario.category}] ${scenario.expectedAutoApprove}s: ${scenario.label}`, async () => {
        const annotation = getAnnotation(scenario);

        // Build the escalation reason from the policy engine
        const policyResult = engine.evaluate({
          requestId: 'test',
          serverName: scenario.request.serverName,
          toolName: scenario.request.toolName,
          arguments: scenario.request.arguments,
          timestamp: new Date().toISOString(),
        });
        const extracted = extractArgsForAutoApprove(scenario.request.arguments, annotation, {
          escalatedRoles: policyResult.escalatedRoles,
          destinationGate: policyResult.rule === 'structural-domain-escalate',
          allowedDirectory: SANDBOX_DIR,
        });

        const context: AutoApproveContext = {
          userMessage: scenario.userMessage,
          toolName: `${scenario.request.serverName}/${scenario.request.toolName}`,
          rule: policyResult.rule,
          escalationReason: reasonForAutoApprover(policyResult),
          arguments: extracted,
        };

        const result = await autoApprove(context, model);

        expect(result.decision).toBe(scenario.expectedAutoApprove);
        expect(result.reasoning.length).toBeGreaterThan(0);
      }, 30_000);
    }
  },
);
