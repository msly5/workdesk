import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createApp} from '../server.mjs';

const script = await readFile(new URL('../public/theme.js', import.meta.url), 'utf8');

function browser({stored, dark = false, blocked = false} = {}) {
  const events = {}, windowEvents = {}, selectEvents = {}, mediaEvents = {};
  const storage = new Map(stored === undefined ? [] : [['workdesk.theme', stored]]);
  const root = {dataset:{}, style:{}};
  const meta = {setAttribute(key, value) {this[key] = value;}};
  const select = {value:'system', addEventListener(name, callback) {selectEvents[name] = callback;}};
  let ready = false;
  const media = {matches:dark, addEventListener(name, callback) {mediaEvents[name] = callback;}};
  vm.runInNewContext(script, {
    document:{
      documentElement:root,
      querySelector(selector) {return selector.startsWith('meta') ? meta : ready ? select : null;},
      addEventListener(name, callback) {events[name] = callback;}
    },
    window:{matchMedia(query) {assert.equal(query, '(prefers-color-scheme: dark)'); return media;}, addEventListener(name, callback) {windowEvents[name] = callback;}},
    localStorage:{getItem(key) {if (blocked) throw new Error('Blocked'); return storage.get(key) ?? null;}, setItem(key, value) {if (blocked) throw new Error('Blocked'); storage.set(key, value);}}
  });
  return {
    root, meta, select, storage,
    ready() {ready = true; events.DOMContentLoaded();},
    choose(value) {select.value = value; selectEvents.change({currentTarget:select});},
    system(value) {media.matches = value; mediaEvents.change();},
    external(key, newValue) {windowEvents.storage({key, newValue});}
  };
}

test('appearance applies before DOM ready and follows live system changes by default', () => {
  const app = browser({dark:true});
  assert.equal(app.root.dataset.theme, 'dark');
  assert.equal(app.root.style.colorScheme, 'dark');
  assert.equal(app.meta.content, '#191c24');
  app.ready();
  assert.equal(app.select.value, 'system');
  app.system(false);
  assert.equal(app.root.dataset.theme, 'light');
  assert.equal(app.meta.content, '#7367df');
  app.system(true);
  assert.equal(app.root.dataset.theme, 'dark');
  assert.equal(app.select.value, 'system');
});

test('manual appearance persists across reloads, overrides system, and can return to automatic', () => {
  const app = browser({dark:false}); app.ready(); app.choose('dark');
  assert.equal(app.root.dataset.theme, 'dark');
  assert.equal(app.storage.get('workdesk.theme'), 'dark');
  app.system(true); app.system(false);
  assert.equal(app.root.dataset.theme, 'dark');
  const reopened = browser({stored:app.storage.get('workdesk.theme'), dark:false});
  assert.equal(reopened.root.dataset.theme, 'dark');
  app.choose('light'); app.system(true);
  assert.equal(app.root.dataset.theme, 'light');
  app.choose('system');
  assert.equal(app.root.dataset.theme, 'dark');
  assert.equal(app.root.dataset.themePreference, 'system');
  assert.equal(app.storage.get('workdesk.theme'), 'system');
});

test('invalid or unavailable storage falls back to system while manual session switching works', () => {
  for (const options of [{stored:'invalid'}, {blocked:true}]) {
    const app = browser({...options, dark:true}); app.ready();
    assert.equal(app.select.value, 'system');
    assert.equal(app.root.dataset.theme, 'dark');
    app.choose('light'); app.system(true);
    assert.equal(app.root.dataset.theme, 'light');
    app.choose('invalid');
    assert.equal(app.root.dataset.theme, 'light');
  }
});

test('other tabs and clearing preferences update the appearance without a reload', () => {
  const app = browser({stored:'light', dark:true}); app.ready();
  app.external('workdesk.language', 'en');
  assert.equal(app.root.dataset.theme, 'light');
  app.external('workdesk.theme', 'dark');
  assert.equal(app.root.dataset.theme, 'dark'); assert.equal(app.select.value, 'dark');
  app.external('workdesk.theme', null);
  assert.equal(app.root.dataset.themePreference, 'system'); assert.equal(app.select.value, 'system');
  app.external('workdesk.theme', 'light');
  app.external(null, null);
  assert.equal(app.root.dataset.theme, 'dark');
});

test('settings contains appearance and language controls, and its assets are served under the application CSP', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workdesk-theme-test-'));
  const server = await createApp({dataDir:dir});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {await new Promise(resolve => server.close(resolve)); await rm(dir, {recursive:true, force:true});});
  const base = 'http://127.0.0.1:'+server.address().port;
  for (const asset of ['theme.js','theme.css','organization.css']) {
    const response = await fetch(base+'/'+asset);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  }
  const html = await (await fetch(base)).text();
  assert.ok(html.indexOf('src="/theme.js"') < html.indexOf('href="/styles.css"'));
  const sidebar=html.match(/<aside[^>]+id="sidebar"[\s\S]*?<\/aside>/)?.[0];
  const settings=html.match(/<section[^>]+id="settings-page"[\s\S]*?<\/section>/)?.[0];
  assert.ok(sidebar);assert.ok(settings);
  assert.match(sidebar,/id="open-settings"/);
  for (const id of ['theme-select','language-select']) {
    assert.ok(settings.includes('id="'+id+'"'));
    assert.ok(!sidebar.includes('id="'+id+'"'));
    assert.equal(html.split('id="'+id+'"').length-1,1);
  }
});
