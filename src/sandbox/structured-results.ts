/**
 * Which tool results keep their `structuredContent` when they cross into the
 * Code Mode isolate, and how `help.help(server)` documents it.
 *
 * The relay and the coordinator forward a backend's `structuredContent` (MCP
 * structured tool output) as they forward its `content`. Code Mode passes it on
 * only for the servers listed here: most MCP servers repeat their whole result
 * in it (the filesystem server returns `{ content: <the text> }` for every tool,
 * the git server the object its text is printed from), so passing it for every
 * server would double what each call costs the agent. The memory server's
 * structured result is small metadata the text does not carry in a
 * machine-readable form: the source segments `memory.expand` takes.
 */

import { MEMORY_SERVER_NAME } from '../memory/memory-server-name.js';

/** Servers whose `structuredContent` Code Mode returns, with the note `help.help(server)` shows. */
const STRUCTURED_RESULT_NOTES: ReadonlyMap<string, string> = new Map([
  [
    MEMORY_SERVER_NAME,
    'Results: { content: [{ type: "text", text }], structuredContent? }. memory.recall also returns ' +
      'structuredContent { memories_used, total_matches, expanded, expanded_segment_ids, source_segment_ids }. ' +
      'A recalled fact taken from ingested text is marked [src:<id>] in the text; pass that id (or one from ' +
      'source_segment_ids) to memory.expand({ segment_id, query }) to read the passage it came from.',
  ],
]);

/** True when Code Mode returns `serverName`'s structuredContent to the agent. */
export function exposesStructuredContent(serverName: string): boolean {
  return STRUCTURED_RESULT_NOTES.has(serverName);
}

/** The result notes for the servers in `serverNames` that have one (for `HelpData.resultNotes`). */
export function structuredResultNotes(serverNames: Iterable<string>): Record<string, string> {
  const notes: Record<string, string> = {};
  for (const name of serverNames) {
    const note = STRUCTURED_RESULT_NOTES.get(name);
    if (note !== undefined) notes[name] = note;
  }
  return notes;
}
