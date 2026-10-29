import { EventEmitter } from 'node:events';

/**
 * App-level events that have no single owner: the update check lives in `update.ts`, while the
 * scenarios that react to it are wired in `automation.ts`. A tiny bus keeps the two apart.
 */
export const appSignals = new EventEmitter();
