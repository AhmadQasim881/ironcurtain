/**
 * The annotation drift report shared by `annotate-tools --check` and
 * `compile-policy`: the effective tool annotations compared with the tools
 * the configured servers list right now (`live-tools.ts`), per server.
 *
 * The comparison itself is `trusted-process/schema-drift.ts`; this module
 * adds the server-level cases (a live server without an annotations entry,
 * a server that could not be reached) and renders the result as lines.
 */

import { toDisplayText } from '../terminal/display-sanitize.js';
import type { ServerInfo } from './annotation-overlay.js';
import type { LiveServerTools } from './live-tools.js';
import type { StoredToolAnnotationsFile } from './types.js';
import {
  annotateCommandFor,
  describeServerDrift,
  diffServerSchemas,
  hasServerDrift,
  serverDriftAffectsPolicy,
  type ServerSchemaDrift,
} from '../trusted-process/schema-drift.js';

export interface AnnotationCheckServer {
  readonly server: string;
  /**
   * - `ok`: the annotations describe exactly the live tools;
   * - `drift`: see `drift`;
   * - `unannotated-server`: the server is live but has no annotations entry
   *   (every call to it is denied).
   */
  readonly status: 'ok' | 'drift' | 'unannotated-server';
  readonly drift?: ServerSchemaDrift;
  /** The identity recorded when the entry was written, when known. */
  readonly annotatedServerInfo?: ServerInfo;
  /** The identity the live server reported, when it did. */
  readonly liveServerInfo?: ServerInfo;
  readonly toolCount: number;
}

export interface AnnotationCheckSkipped {
  readonly name: string;
  readonly reason: string;
}

export interface AnnotationCheckReport {
  /** One entry per connected server, in connection order. */
  readonly servers: readonly AnnotationCheckServer[];
  /** Servers that could not be reached; their annotations were not checked. */
  readonly skipped: readonly AnnotationCheckSkipped[];
  /** True when any connected server drifted or has no annotations entry. */
  readonly hasDrift: boolean;
  /**
   * True when some drift changes what policy evaluates: a live server or
   * tool without annotations, or a drifted tool where `affectsPolicy` holds
   * (not only schema text, `required` or stale annotations).
   */
  readonly affectsPolicy: boolean;
}

/** Compares the effective annotations with every connected server's live tools. */
export function buildAnnotationCheckReport(
  annotations: StoredToolAnnotationsFile,
  live: ReadonlyMap<string, LiveServerTools>,
  skipped: readonly AnnotationCheckSkipped[] = [],
): AnnotationCheckReport {
  const servers: AnnotationCheckServer[] = [];
  for (const [server, { tools, serverInfo }] of live) {
    const entry = Object.hasOwn(annotations.servers, server) ? annotations.servers[server] : undefined;
    const base = {
      server,
      toolCount: tools.length,
      ...(entry?.serverInfo ? { annotatedServerInfo: entry.serverInfo } : {}),
      ...(serverInfo ? { liveServerInfo: serverInfo } : {}),
    };
    if (!entry) {
      servers.push({ ...base, status: 'unannotated-server' });
      continue;
    }
    const drift = diffServerSchemas(server, entry.tools, tools);
    servers.push(hasServerDrift(drift) ? { ...base, status: 'drift', drift } : { ...base, status: 'ok' });
  }
  return {
    servers,
    skipped: [...skipped],
    hasDrift: servers.some((s) => s.status !== 'ok'),
    affectsPolicy: servers.some(
      (s) => s.status === 'unannotated-server' || (s.drift !== undefined && serverDriftAffectsPolicy(s.drift)),
    ),
  };
}

export interface ReportLine {
  readonly level: 'info' | 'warn';
  readonly text: string;
}

/** A server identity as display text (the live one is server-reported). */
function describeServerInfo(info: ServerInfo): string {
  return toDisplayText(`${info.name} ${info.version}`, { maxLength: 80 });
}

/** Renders a report as lines for stderr; callers color by `level`. */
export function formatAnnotationCheckReport(report: AnnotationCheckReport): ReportLine[] {
  const lines: ReportLine[] = [];
  for (const server of report.servers) {
    const name = JSON.stringify(server.server);
    const live = server.liveServerInfo ? ` (${describeServerInfo(server.liveServerInfo)})` : '';
    const annotatedFor =
      server.annotatedServerInfo &&
      server.liveServerInfo &&
      (server.annotatedServerInfo.name !== server.liveServerInfo.name ||
        server.annotatedServerInfo.version !== server.liveServerInfo.version)
        ? `; annotated for ${describeServerInfo(server.annotatedServerInfo)}`
        : '';
    switch (server.status) {
      case 'ok':
        lines.push({
          level: 'info',
          text: `${name}: ${server.toolCount} tool(s)${live}${annotatedFor}; annotations match the live tools`,
        });
        break;
      case 'unannotated-server':
        lines.push({
          level: 'warn',
          text:
            `${name}: ${server.toolCount} tool(s)${live}; no tool annotations, every call is denied. ` +
            `Run \`${annotateCommandFor(server.server)}\`.`,
        });
        break;
      case 'drift':
        lines.push({ level: 'warn', text: `${name}: ${server.toolCount} tool(s)${live}${annotatedFor}` });
        if (server.drift) {
          for (const line of describeServerDrift(server.drift)) lines.push({ level: 'warn', text: `  ${line}` });
        }
        break;
    }
  }
  for (const { name, reason } of report.skipped) {
    lines.push({
      level: 'info',
      text: `${JSON.stringify(name)}: not checked, the server could not be started: ${toDisplayText(reason, { maxLength: 300 })}`,
    });
  }
  return lines;
}
