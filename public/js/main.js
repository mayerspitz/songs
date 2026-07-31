'use strict';
import { store } from './store.js';
import { renderHome, renderLogin } from './views/home.js';
import { renderSongView } from './views/song.js';
import { toast } from './ui.js';

const root = document.getElementById('app');

async function route() {
  const hash = location.hash || '#/';
  if (!store.user) {
    renderLogin(root);
    return;
  }
  const songMatch = hash.match(/^#\/song\/([\w-]+)/);
  if (songMatch) {
    await renderSongView(root, songMatch[1]);
  } else {
    store.closeSong();
    await renderHome(root);
  }
}

window.addEventListener('hashchange', route);

(async () => {
  try {
    await store.init();
  } catch (e) {
    root.textContent = 'Cannot reach the server: ' + e.message;
    return;
  }
  await route();
})().catch(e => {
  console.error(e);
  toast(e.message, 'error');
});
