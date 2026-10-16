import { createHash } from 'node:crypto';

export function stableEventIdentity(eventKey: string): string {
  return createHash('sha256').update(eventKey, 'utf8').digest('hex');
}
