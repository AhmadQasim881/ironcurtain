/**
 * Edit distance for typo suggestions ("did you mean ...?").
 *
 * A dependency-free leaf, so config validation and the CLI can share it.
 */

/**
 * Optimal string alignment distance between `a` and `b`: the number of
 * single-character insertions, deletions, substitutions and transpositions of
 * two adjacent characters needed to turn one into the other, where no
 * substring is edited twice. So `edit("anthropc", "anthropic") === 1` and
 * `edit("opneai", "openai") === 1`. Compares UTF-16 code units, which is
 * enough for the ASCII identifiers it is used on.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Three rolling rows: the two previous ones (for transpositions) and the current.
  let previousPrevious: number[] = new Array<number>(b.length + 1).fill(0);
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = new Array<number>(b.length + 1).fill(0);
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, previousPrevious[j - 2] + 1);
      }
      current[j] = best;
    }
    previousPrevious = previous;
    previous = current;
  }
  return previous[b.length];
}

/**
 * The candidate closest to `input` within `maxDistance` edits, or undefined.
 * Ties go to the earlier candidate; an exact match is returned as is.
 */
export function closestMatch<T extends string>(
  input: string,
  candidates: Iterable<T>,
  maxDistance: number,
): T | undefined {
  let best: T | undefined;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates) {
    const distance = editDistance(input, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
