/**
 * Case- and Unicode-folded path comparison for DENY-side checks.
 *
 * On case-insensitive or normalization-insensitive volumes (the macOS
 * default, Windows DrvFs mounts under WSL, casefold ext4/tmpfs directories)
 * differently spelled paths can name the same directory. A guard that
 * rejects a path only by its exact spelling can then be bypassed with a
 * variant spelling such as `~/.IronCurtain`. Folding both sides of a
 * denylist comparison closes that gap, and a spurious match can only make
 * the guard reject more.
 *
 * Never use these helpers for ALLOW-side checks (sandbox containment,
 * trusted-root allowlists, managed-workspace exemptions): on a case-sensitive
 * volume a separately created, differently cased directory would then be
 * treated as trusted.
 */

/**
 * Folds a path for denylist comparison: NFC normalization plus a
 * round-trip through upper and lower case, which approximates Unicode
 * case folding (for example `ſ` and `s`, or the Kelvin sign and `k`, fold
 * to the same string).
 */
export function foldPathForDenylist(path: string): string {
  return path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

/**
 * Returns true when `child` is equal to or nested inside `parent` after
 * folding both. Both inputs must be absolute, normalized paths.
 */
export function isEqualOrInsideFolded(child: string, parent: string): boolean {
  const foldedChild = foldPathForDenylist(child);
  const foldedParent = foldPathForDenylist(parent);
  if (foldedChild === foldedParent) return true;
  const prefix = foldedParent.endsWith('/') ? foldedParent : `${foldedParent}/`;
  return foldedChild.startsWith(prefix);
}
