import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_LIMIT, contentLengthState, insertionExcess, readRemoteUpdate } from '../public/editor-state.js';

test('content limits match server UTF-16 length without changing the source', () => {
  const chinese = '中'.repeat(CONTENT_LIMIT - 2);
  assert.deepEqual(contentLengthState(chinese + '😀'), {length:CONTENT_LIMIT, remaining:0, excess:0});
  const draft = chinese + '😀好';
  assert.equal(contentLengthState(draft).excess, 1);
  assert.equal(draft.endsWith('😀好'), true);
  assert.deepEqual(contentLengthState(''), {length:0, remaining:CONTENT_LIMIT, excess:0});
});

test('paste accounts for the selection and normalized textarea line endings', () => {
  const full = 'a'.repeat(CONTENT_LIMIT);
  assert.equal(insertionExcess(full, CONTENT_LIMIT, CONTENT_LIMIT, '中'), 1);
  assert.equal(insertionExcess(full, 0, 3, '中😀'), 0);
  assert.equal(insertionExcess(full, 0, 1, '\r\n'), 0);
  assert.equal(insertionExcess(full, 0, 0, 'word'.repeat(100000)), 400000);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

function remoteReader() {
  const revision = deferred(), state = deferred();
  let allowed = true, localRevision = 1, revisionReads = 0, stateReads = 0;
  return {
    revision, state,
    set allowed(value) { allowed = value; },
    set localRevision(value) { localRevision = value; },
    get revisionReads() { return revisionReads; },
    get stateReads() { return stateReads; },
    read: () => readRemoteUpdate({
      getRevision:() => localRevision, canApply:() => allowed,
      readRevision:() => { revisionReads++; return revision.promise; },
      readState:() => { stateReads++; return state.promise; },
    }),
  };
}

test('idle polling reads only the revision until remote content changes', async () => {
  const reader = remoteReader(), result = reader.read();
  reader.revision.resolve({revision:1});
  assert.equal(await result, null);
  assert.equal(reader.revisionReads, 1);
  assert.equal(reader.stateReads, 0);
});

test('a protected editor does not start remote requests', async () => {
  const reader = remoteReader(); reader.allowed = false;
  assert.equal(await reader.read(), null);
  assert.equal(reader.revisionReads, 0);
  assert.equal(reader.stateReads, 0);
});

test('editing or selection begun during revision fetch prevents the full read', async () => {
  const reader = remoteReader(), result = reader.read();
  reader.allowed = false;
  reader.revision.resolve({revision:2});
  assert.equal(await result, null);
  assert.equal(reader.stateReads, 0);
});

test('editing or selection begun during full fetch prevents remote replacement', async () => {
  const reader = remoteReader(), result = reader.read();
  reader.revision.resolve({revision:2});
  await Promise.resolve();
  assert.equal(reader.stateReads, 1);
  reader.allowed = false;
  reader.state.resolve({revision:2, tasks:[]});
  assert.equal(await result, null);
});

test('a completed local save invalidates an outstanding remote response', async () => {
  const reader = remoteReader(), result = reader.read();
  reader.revision.resolve({revision:2});
  await Promise.resolve();
  reader.localRevision = 3;
  reader.state.resolve({revision:2, tasks:[]});
  assert.equal(await result, null);
});

test('unchanged reader accepts a newer state after both asynchronous checks', async () => {
  const reader = remoteReader(), result = reader.read();
  reader.revision.resolve({revision:2});
  await Promise.resolve();
  const state = {revision:3, tasks:[{id:'changed'}]};
  reader.state.resolve(state);
  assert.equal(await result, state);
});
