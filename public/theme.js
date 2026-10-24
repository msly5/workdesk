// Run before the stylesheets so the first paint uses the saved appearance.
(() => {
  const key = 'workdesk.theme';
  const valid = value => ['system', 'light', 'dark'].includes(value);
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try {
    const stored = localStorage.getItem(key);
    if (valid(stored)) preference = stored;
  } catch { /* Appearance still works when browser storage is unavailable. */ }

  function apply() {
    const theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#191c24' : '#7367df');
    const control = document.querySelector('#theme-select');
    if (control) control.value = preference;
  }

  apply();
  media.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    preference = valid(event.newValue) ? event.newValue : 'system';
    apply();
  });
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.querySelector('#theme-select')?.addEventListener('change', event => {
      const next = event.currentTarget.value;
      if (!valid(next)) return;
      preference = next;
      try { localStorage.setItem(key, preference); } catch { /* Keep the session preference. */ }
      apply();
    });
  }, { once: true });
})();
