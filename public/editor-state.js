// Match the server's JavaScript string-length limit, including surrogate pairs.
export const CONTENT_LIMIT = 200000;

export function contentLengthState(content = '') {
  const length = content.length;
  return { length, remaining: Math.max(0, CONTENT_LIMIT - length), excess: Math.max(0, length - CONTENT_LIMIT) };
}

export function insertionExcess(content, start, end, inserted) {
  const text = inserted.replace(/\r\n?/g, '\n');
  return Math.max(0, content.length - (end - start) + text.length - CONTENT_LIMIT);
}

// Both awaits are boundaries at which the user can begin editing, selecting or
// dragging. Discard stale reads rather than replacing the state underneath them.
export async function readRemoteUpdate({ getRevision, canApply, readRevision, readState }) {
  if (!canApply()) return null;
  const revision = getRevision();
  const latest = await readRevision();
  if (!canApply() || getRevision() !== revision || latest.revision <= revision) return null;
  const remote = await readState();
  if (!canApply() || getRevision() !== revision || remote.revision <= revision) return null;
  return remote;
}
