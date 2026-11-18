/**
 * Argument parsing for the mux `/new` command.
 *
 *   /new                                  open the spawn picker
 *   /new <persona>                        spawn a persona session
 *   /new --task-scoped <task ...>         open the picker; the session it
 *                                         spawns is task-scoped
 *   /new <persona> --task-scoped <task>   spawn a task-scoped persona session
 *
 * Everything after `--task-scoped` is the task text (the mux command line
 * is split on whitespace, so it is rejoined with single spaces). The child
 * `ironcurtain start --pty --task-scoped` compiles the task scope from it;
 * task scoping is never applied unless the flag is given.
 *
 * Anything else before the task is refused: a second word, or any option. A
 * misspelt or differently cased flag (`--task-scope`, `--Task-Scoped`,
 * `task-scoped`, an em dash from autocorrect) or a task typed without the
 * flag would otherwise be dropped as a stray word and spawn an unscoped
 * session the user did not ask for.
 */

/** The `--task-scoped` flag of `/new`. */
export const TASK_SCOPED_FLAG = '--task-scoped';

const NEW_USAGE = 'Usage: /new [persona] [--task-scoped <task description>]';

/**
 * A word that reads as an option: it starts with a hyphen or with a
 * typographic dash (U+2010 to U+2015, U+2212), which is how an autocorrected
 * `--` arrives. Persona names never start with one (`SLUG_PATTERN`).
 */
const OPTION_LIKE_WORD = /^[-\u2010-\u2015\u2212]/u;

/** Parsed `/new` arguments, or the message to show for invalid ones. */
export type NewCommandArgs = { readonly persona?: string; readonly taskScope?: string } | { readonly error: string };

/** Parses the arguments of `/new` (the words after the command). */
export function parseNewCommandArgs(args: readonly string[]): NewCommandArgs {
  const flagIndex = args.indexOf(TASK_SCOPED_FLAG);
  const leading = (flagIndex === -1 ? args : args.slice(0, flagIndex)).filter((word) => word !== '');
  // At most the persona name may precede the flag, and it is never an option.
  if (leading.length > 1 || leading.some((word) => OPTION_LIKE_WORD.test(word))) return { error: NEW_USAGE };
  const persona = leading.at(0);
  if (flagIndex === -1) return persona ? { persona } : {};
  const taskScope = args
    .slice(flagIndex + 1)
    .filter((word) => word !== '')
    .join(' ');
  if (taskScope === '') return { error: NEW_USAGE };
  return persona ? { persona, taskScope } : { taskScope };
}
