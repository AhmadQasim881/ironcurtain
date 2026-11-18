/**
 * Per-lease emergency disk reserve.
 *
 * Revocation proves itself with durable records: lease rewrites, a lock
 * candidate, supervisor status. When a bundle has filled the host disk, those
 * writes fail with ENOSPC. Admission therefore preallocates a small reserve in
 * the owner-only lease directory, and every cleanup frees it before its first
 * lease write. The supervisor first stops and removes the bundle's exact
 * containers without any durable write (see `bundle-revocation.ts`) and only
 * then frees the reserve, so a bundle still filling the disk cannot take it:
 * the reserve buys the evidence, not the revocation itself.
 *
 * On APFS a local snapshot can delay reclaiming the freed blocks; the
 * write-free revocation step does not depend on them.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DOCKER_WORKLOAD_EMERGENCY_RESERVE_BYTES } from './watchdog-policy.js';

export const DOCKER_WORKLOAD_EMERGENCY_RESERVE_FILE = 'emergency-reserve.bin';
const WRITE_CHUNK_BYTES = 1024 * 1024;

/**
 * Allocate the reserve with written, incompressible bytes: a sparse hole or a
 * compressible run frees nothing when unlinked. Created exclusively, owner-only,
 * and fsynced so the blocks are really held.
 */
export function createDockerWorkloadEmergencyReserve(
  leaseDirectory: string,
  bytes: number = DOCKER_WORKLOAD_EMERGENCY_RESERVE_BYTES,
): string {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('emergency reserve size must be a positive integer');
  const path = join(leaseDirectory, DOCKER_WORKLOAD_EMERGENCY_RESERVE_FILE);
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let written = 0;
    while (written < bytes) {
      const chunk = randomBytes(Math.min(WRITE_CHUNK_BYTES, bytes - written));
      let offset = 0;
      while (offset < chunk.length) offset += writeSync(descriptor, chunk, offset);
      written += chunk.length;
    }
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    try {
      unlinkSync(path);
    } catch {
      // The creation failure below is the error that matters.
    }
    throw error;
  }
  closeSync(descriptor);
  return path;
}

/**
 * Free the reserve. Idempotent and never throws, because revocation must not
 * depend on it; it removes only a regular file at the exact reserve path.
 */
export function releaseDockerWorkloadEmergencyReserve(leaseDirectory: string): boolean {
  const path = join(leaseDirectory, DOCKER_WORKLOAD_EMERGENCY_RESERVE_FILE);
  try {
    if (!lstatSync(path).isFile()) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
