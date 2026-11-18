/**
 * The package version, as the server reports it to MCP clients. Read from the
 * package's package.json (one directory up from both src/ and dist/) so it cannot
 * drift from the version the package is published as.
 */

import { readFileSync } from 'node:fs';

function readPackageVersion(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string') {
    return pkg.version;
  }
  throw new Error('The memory server package.json has no version');
}

export const SERVER_VERSION: string = readPackageVersion();
