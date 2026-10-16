/** Sessions a restart interrupted that wait for their run to start again. Their rows say "streaming" but no stream is active yet. */
export const pendingResume = new Set<string>();
