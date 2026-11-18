import type { IronCurtainConfig, MCPServerConfig } from '../config/types.js';
import type { ToolCallRequest, ToolCallResult } from '../types/mcp.js';
import {
  loadGeneratedPolicy,
  extractServerDomainAllowlists,
  checkConstitutionFreshness,
  checkAnnotationFreshness,
  getPackageGeneratedDir,
} from '../config/index.js';
import { warnOnAnnotationOverlay } from '../config/tool-annotations-overlay.js';
import { createLanguageModel } from '../config/model-provider.js';
import type { MCPClientManager } from './mcp-client-manager.js';
import { MCPClientManager as McpClientManagerImpl } from './mcp-client-manager.js';
import type { McpRoot } from './mcp-client-manager.js';
import { backendCallTimeoutMsFromConfig, escalationTimeoutMsFromConfig } from './call-timeouts.js';
import * as logger from '../logger.js';
import { extractPolicyRoots, toMcpRoots } from './policy-roots.js';
import { loadTaskScopePolicy } from './task-scope.js';
import { buildTrustedServerSet } from '../memory/memory-annotations.js';
import { ToolCallCoordinator, type EscalationPromptFn } from './tool-call-coordinator.js';
import { collectAuditRedactionSecrets } from './audit-secrets.js';
import { contentAssessorOptionsFromConfig } from './assessment-config.js';
import {
  planServerSandboxing,
  formatOsSandboxNotice,
  writeOsSandboxNotice,
  type OsSandboxAvailability,
  type OsSandboxPlan,
} from './sandbox-integration.js';
import { effectiveSandboxPolicy } from '../config/sandbox-policy.js';
import { missingPassthroughEnvVars } from './child-env.js';
import { isGitBackend } from './git-backend-env.js';
import type { ProxiedTool } from './tool-call-pipeline.js';

/** Re-export for backward compatibility with callers that import from here. */
export type { EscalationPromptFn };
export type { EscalationResult } from './tool-call-coordinator.js';

/**
 * In-process mode spawns every backend directly through `MCPClientManager`;
 * it never wraps a server in sandbox-runtime. For servers that ask for an
 * OS sandbox it is therefore always unavailable here, whatever the host
 * supports, and the availability policy decides whether they start.
 */
const IN_PROCESS_OS_SANDBOX: OsSandboxAvailability = {
  available: false,
  platformSupported: true,
  problems: ['in-process MCP connections are not wrapped by sandbox-runtime'],
  warnings: [],
};

export interface TrustedProcessOptions {
  /**
   * In-process escalation callback (integration tests). When set, the
   * coordinator invokes this instead of consulting the file-IPC
   * escalation directory.
   */
  onEscalation?: EscalationPromptFn;
}

/**
 * In-process trusted process. Wraps `ToolCallCoordinator` for callers
 * (integration tests) that want a pre-wired object with a single
 * `handleToolCall` entry point. Sessions never use it: Code Mode goes
 * through the Sandbox's coordinator and its MCP relays.
 *
 * Both this in-process path and Code Mode share the same coordinator
 * implementation for policy evaluation and audit logging.
 *
 * Lifecycle: `new TrustedProcess(config)` + `await initialize()`. The
 * coordinator is constructed during `initialize()` (not the constructor)
 * so the auto-approve model can be built first and threaded into
 * construction-time invariants, rather than being attached after the
 * fact.
 */
export class TrustedProcess {
  private coordinator: ToolCallCoordinator | null = null;
  private mcpManager: MCPClientManager;
  private mcpRoots: McpRoot[] = [];
  private readonly options: TrustedProcessOptions;

  constructor(
    private config: IronCurtainConfig,
    options?: TrustedProcessOptions,
  ) {
    this.options = options ?? {};
    // In-process mode uses its own MCPClientManager so each `connect`
    // call spawns a real backend directly (no router subprocess). The
    // coordinator wraps it for the policy gate.
    this.mcpManager = new McpClientManagerImpl();
  }

  /** Internal accessor: throws if used before `initialize()`. */
  private requireCoordinator(): ToolCallCoordinator {
    if (!this.coordinator) {
      throw new Error('TrustedProcess used before initialize() -- call initialize() first.');
    }
    return this.coordinator;
  }

  /**
   * Sets the most recent user message for auto-approval context.
   * Called by the session layer before each agent turn.
   */
  setLastUserMessage(message: string): void {
    this.requireCoordinator().setLastUserMessage(message);
  }

  async initialize(): Promise<void> {
    const { compiledPolicy, toolAnnotations, toolAnnotationsOverlay, dynamicLists } = loadGeneratedPolicy({
      policyDir: this.config.generatedDir,
      toolAnnotationsDir: this.config.toolAnnotationsDir ?? this.config.generatedDir,
      fallbackDir: getPackageGeneratedDir(),
    });
    checkConstitutionFreshness(compiledPolicy, this.config.constitutionPath);
    checkAnnotationFreshness(toolAnnotations, this.config.mcpServers);
    warnOnAnnotationOverlay(toolAnnotationsOverlay);

    // `--task-scoped`: same task-scope loading as the sandbox path; a scope
    // that cannot be loaded fails initialization.
    const taskScope =
      this.config.taskPolicyDir === undefined ? undefined : loadTaskScopePolicy(this.config.taskPolicyDir);

    const serverDomainAllowlists = extractServerDomainAllowlists(this.config.mcpServers);
    const trustedServers = buildTrustedServerSet(this.config.mcpServers);

    // Build the auto-approve model BEFORE constructing the coordinator
    // so it can be passed in as a construction-time invariant.
    const autoApproveModel = await this.buildAutoApproveModel();
    const contentAssessment = await contentAssessorOptionsFromConfig(this.config.userConfig);

    // Per-server sandbox disposition for audit annotation. Nothing is
    // sandboxed in this mode, so no audit entry may claim `sandboxed: true`;
    // servers that ask for a sandbox are refused under "enforce" and stamped
    // `platform-unavailable` under "warn".
    const osSandboxPlan = planServerSandboxing(
      this.config.mcpServers,
      this.config.allowedDirectory,
      IN_PROCESS_OS_SANDBOX,
      effectiveSandboxPolicy(this.config),
    );
    const notice = formatOsSandboxNotice(osSandboxPlan);
    if (notice !== undefined) {
      logger.warn(`[sandbox] ${notice}`);
      writeOsSandboxNotice(notice);
    }
    const resolvedSandboxConfigs = new Map(osSandboxPlan.resolved);

    this.coordinator = new ToolCallCoordinator({
      compiledPolicy,
      toolAnnotations,
      ...(taskScope ? { taskScope: taskScope.policy } : {}),
      protectedPaths: this.config.protectedPaths,
      allowedDirectory: this.config.allowedDirectory,
      // Same source as the sandbox path: a read-only workspace config
      // confines changes to its writable directories here too.
      readOnlyWorkspace: this.config.readOnlyWorkspace,
      serverDomainAllowlists,
      dynamicLists,
      trustedServers,
      auditLogPath: this.config.auditLogPath,
      auditRedact: this.config.userConfig.auditRedaction.enabled,
      auditRedactSecrets: collectAuditRedactionSecrets(this.config.userConfig),
      escalationDir: this.config.escalationDir,
      // Same source as the sandbox path: the session mode that gates the
      // auto-approver's trust in user-context.json comes from the config.
      isPtySession: this.config.isPtySession === true,
      escalationTimeoutMs: escalationTimeoutMsFromConfig(this.config),
      backendCallTimeoutMs: backendCallTimeoutMsFromConfig(this.config),
      mcpManager: this.mcpManager,
      onEscalation: this.options.onEscalation,
      autoApproveModel,
      contentAssessment,
      resolvedSandboxConfigs,
      taintEscalation: this.config.userConfig.taintEscalation,
    });

    const policyRoots = extractPolicyRoots(compiledPolicy, this.config.allowedDirectory);
    this.mcpRoots = toMcpRoots(policyRoots);

    await this.connectMcpServers(osSandboxPlan);
  }

  /**
   * Creates the auto-approve language model when enabled in user config.
   * Returns `null` when auto-approve is disabled or model construction
   * fails (non-fatal: the session continues with manual escalation).
   */
  private async buildAutoApproveModel() {
    const autoApproveConfig = this.config.userConfig.autoApprove;
    if (!autoApproveConfig.enabled) return null;
    try {
      return await createLanguageModel(autoApproveConfig.modelId, this.config.userConfig, 'autoApprove');
    } catch {
      logger.warn('[auto-approve] Failed to create model; auto-approve disabled');
      return null;
    }
  }

  /**
   * Connects to every configured MCP server and registers its tools
   * with the coordinator. Unavailable servers are logged and skipped, and
   * servers the OS-sandbox plan refuses are never spawned.
   */
  private async connectMcpServers(osSandboxPlan: OsSandboxPlan): Promise<void> {
    const coordinator = this.requireCoordinator();
    const failedServers: string[] = [];
    const refused = new Set(osSandboxPlan.refused);
    for (const [name, serverConfig] of Object.entries(this.config.mcpServers)) {
      if (refused.has(name)) {
        logger.warn(`Skipping MCP server '${name}': it requires an OS sandbox and sandboxPolicy is "enforce"`);
        failedServers.push(name);
        continue;
      }
      // The server's stored credentials (config.json serverCredentials) are
      // injected into its environment below, so a `-e NAME` variable that
      // exists only there counts as present, as it does for the relay and
      // for `ironcurtain doctor`.
      const credentials = this.config.userConfig.serverCredentials[name] as Record<string, string> | undefined;
      const missingVars = missingPassthroughEnvVars(serverConfig.args, {
        env: process.env,
        configEnv: serverConfig.env,
        credentials,
      });
      if (missingVars.length > 0) {
        logger.warn(`Skipping MCP server '${name}': missing environment variable(s) ${missingVars.join(', ')}`);
        failedServers.push(name);
        continue;
      }
      logger.info(`Connecting to MCP server: ${name}...`);
      try {
        // Direct spawn (no relay): the manager gives the server the
        // allowlisted environment plus this `env` block, so the credentials
        // ride along with its configured variables.
        const spawnConfig: MCPServerConfig = credentials
          ? { ...serverConfig, env: { ...serverConfig.env, ...credentials } }
          : serverConfig;
        await this.mcpManager.connect(name, spawnConfig, this.mcpRoots, { sshAgent: isGitBackend(name) });
        logger.info(`Connected to MCP server: ${name}`);

        // Publish this server's tools to the coordinator so the policy
        // gate can route calls through it. Share the manager's live
        // `ClientState` so `addRootsToClient` mutates the same roots
        // array the manager returns from its `roots/list` handler.
        const tools = await this.mcpManager.listTools(name);
        const clientState = this.mcpManager.getClientState(name);
        if (clientState) {
          const proxiedTools: ProxiedTool[] = tools.map((t) => ({
            serverName: name,
            name: t.name,
            description: t.description,
            inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
          }));
          coordinator.registerTools(name, proxiedTools, clientState);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Failed to connect to MCP server '${name}': ${msg} — skipping`);
        failedServers.push(name);
      }
    }
    if (failedServers.length > 0) {
      logger.warn(`Unavailable MCP servers: ${failedServers.join(', ')}. Their tools will not be available.`);
    }
  }

  async listTools(serverName: string) {
    return this.mcpManager.listTools(serverName);
  }

  /**
   * Handles a tool call through the coordinator's policy pipeline.
   * Mirrors the legacy TrustedProcess.handleToolCall signature.
   */
  async handleToolCall(request: ToolCallRequest): Promise<ToolCallResult> {
    return this.requireCoordinator().handleStructuredToolCall(request);
  }

  async shutdown(): Promise<void> {
    // We injected our own MCPClientManager into the coordinator, so
    // the coordinator will NOT close it. Do that here, then close the
    // coordinator (which flushes the audit log).
    await this.mcpManager.closeAll();
    if (this.coordinator) {
      await this.coordinator.close();
    }
  }
}
