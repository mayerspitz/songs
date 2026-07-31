'use strict';
import { api } from '../api.js';
import { store } from '../store.js';
import { h, clear, toast, modal, confirmDlg, avatar, menu, icon } from '../ui.js';

const STAGE_NAMES = { 1: 'Hum', 2: 'Song', 3: 'Arrange' };

export async function renderHome(root) {
  const data = await api.get('/api/home');
  const usersById = Object.fromEntries((data.users || []).map(u => [u.id, u]));

  const songCard = s => h('div.card.song-card', {
    onclick: () => { location.hash = `#/song/${s.id}`; },
  },
    h('div.row.between', {},
      h('div.song-card-name', {}, s.name),
      h(`span.stage-badge.st${s.stage}`, {}, STAGE_NAMES[s.stage])),
    h('div.row.between.dim.small', {},
      h('span', {}, `${s.takeCount} take${s.takeCount === 1 ? '' : 's'}`,
        s.bpm ? ` · ${Math.round(s.bpm)} BPM` : ' · tempo not set'),
      avatar(usersById[s.owner_id], 20)));

  const createSong = async (collectionId) => {
    const name = h('input.input', { placeholder: 'Song name', value: '' });
    const bpmIn = h('input.input', { placeholder: 'BPM (leave empty to auto-detect)', type: 'number', min: 30, max: 300 });
    const m = modal('New song', h('div.col.gap', {},
      name,
      bpmIn,
      h('p.dim.small', {}, 'Leave BPM empty and Tempo Sense will detect it from your humming as you record.'),
      h('div.row.end', {}, h('button.btn.primary', {
        onclick: async () => {
          try {
            const s = await api.post('/api/songs', {
              name: name.value || 'New song',
              collectionId: collectionId || undefined,
              bpm: bpmIn.value ? Number(bpmIn.value) : undefined,
            });
            m.close();
            location.hash = `#/song/${s.id}`;
          } catch (e) { toast(e.message, 'error'); }
        },
      }, 'Create'))));
    name.focus();
  };

  const collectionBlock = col => {
    const songs = data.songs.filter(s => s.collection_id === col.id);
    return h('div.collection-block', {},
      h('div.row.between', {},
        h('div.collection-name', {}, col.name),
        h('div.row.gap-s', {},
          h('button.btn.small', { onclick: () => createSong(col.id) }, '+ Song'),
          h('button.icon-btn', {
            title: 'Collection menu',
            onclick: e => menu(e.currentTarget, [
              { label: 'Invite members', action: () => inviteDialog('collection', col.id, col.name) },
              { label: 'Rename', action: () => renameCollection(col) },
              '-',
              { label: 'Delete collection', danger: true, action: async () => {
                  if (await confirmDlg('Delete collection', `Delete "${col.name}"? Songs inside are kept (moved out of the collection).`)) {
                    await api.del(`/api/collections/${col.id}`); renderHome(root);
                  }
                } },
            ]),
          }, icon('more')))),
      h('div.cards', {}, songs.length ? songs.map(songCard) : h('div.dim.small.pad-s', {}, 'No songs yet')));
  };

  const renameCollection = col => {
    const inp = h('input.input', { value: col.name });
    const m = modal('Rename collection', h('div.col.gap', {}, inp,
      h('div.row.end', {}, h('button.btn.primary', {
        onclick: async () => { await api.patch(`/api/collections/${col.id}`, { name: inp.value }); m.close(); renderHome(root); },
      }, 'Save'))));
    inp.focus();
  };

  const inviteDialog = async (rtype, rid, label) => {
    const { members } = await api.get(`/api/members/${rtype}/${rid}`).catch(() => ({ members: [] }));
    const email = h('input.input', { placeholder: 'email@example.com', type: 'email' });
    const role = h('select.input', {},
      ['viewer', 'voter', 'suggester', 'contributor', 'admin'].map(r => h('option', { value: r, selected: r === 'contributor' }, r)));
    const list = h('div.col.gap-s', {}, members.map(mm => h('div.row.between.small', {},
      h('span', {}, mm.email), h('span.dim', {}, mm.role))));
    const m = modal(`Invite to ${label}`, h('div.col.gap', {},
      h('p.dim.small', {}, 'Invited people sign in with Google using this email and get access with the role you choose.'),
      h('div.row.gap-s', {}, email, role),
      h('div.row.end', {}, h('button.btn.primary', {
        onclick: async () => {
          try {
            await api.post(`/api/members/${rtype}/${rid}`, { email: email.value, role: role.value });
            toast('Invited ' + email.value);
            m.close();
          } catch (e) { toast(e.message, 'error'); }
        },
      }, 'Invite')),
      members.length ? h('div', {}, h('div.small.dim', {}, 'Members'), list) : null));
    email.focus();
  };

  const looseSongs = data.songs.filter(s => !s.collection_id);

  clear(root,
    h('div.topbar', {},
      h('div.brand', {}, h('span.brand-mark', {}, icon('wave', { size: 20 })), 'Humlab'),
      h('div.row.gap-s', {},
        avatar(store.user, 28),
        h('button.btn.small', {
          onclick: async () => { await fetch('/auth/logout', { method: 'POST' }); location.reload(); },
        }, 'Sign out'))),
    h('div.page', {},
      h('div.row.between.wrap', {},
        h('h1.page-title', {}, 'Your songs'),
        h('div.row.gap-s', {},
          h('button.btn', {
            onclick: async () => {
              const inp = h('input.input', { placeholder: 'Collection name' });
              const m = modal('New collection', h('div.col.gap', {}, inp,
                h('div.row.end', {}, h('button.btn.primary', {
                  onclick: async () => { await api.post('/api/collections', { name: inp.value || 'Collection' }); m.close(); renderHome(root); },
                }, 'Create'))));
              inp.focus();
            },
          }, '+ Collection'),
          h('button.btn.primary', { onclick: () => createSong(null) }, '+ Compose song'))),
      data.collections.map(collectionBlock),
      h('div.collection-block', {},
        data.collections.length ? h('div.collection-name', {}, 'Other songs') : null,
        h('div.cards', {},
          looseSongs.length ? looseSongs.map(songCard)
            : (data.collections.length ? h('div.dim.small.pad-s', {}, 'No standalone songs')
              : h('div.empty-hero', {},
                h('div.empty-emoji', {}, icon('mic', { size: 42 })),
                h('p', {}, 'Hum it before you build it.'),
                h('p.dim.small', {}, 'Create a song, record humming takes into sections, invite friends to pick favorites and vote — then arrange the winner.')))))));
  return root;
}

export function renderLogin(root) {
  const devForm = store.config.devLogin
    ? h('div.col.gap-s.dev-login', {},
      h('div.small.dim', {}, 'Dev login (local only)'),
      h('form.row.gap-s', {
        onsubmit: async e => {
          e.preventDefault();
          const email = e.target.querySelector('input').value;
          if (!email) return;
          await fetch('/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, name: email.split('@')[0] }) });
          location.reload();
        },
      },
        h('input.input', { placeholder: 'email', type: 'email' }),
        h('button.btn', {}, 'Enter')))
    : null;
  clear(root,
    h('div.login-hero', {},
      h('div.login-card', {},
        h('div.brand.big', {}, h('span.brand-mark', {}, icon('wave', { size: 34 })), 'Humlab'),
        h('p.tagline', {}, 'Compose songs by humming. Takes, comps, votes — then arrange the winner, together.'),
        store.config.google
          ? h('a.btn.google-btn', { href: '/auth/google' },
            h('span.g-mark', {}, 'G'), 'Continue with Google')
          : h('p.dim.small', {}, 'Google sign-in is not configured yet. Set GOOGLE_AUTH_CLIENT_ID / GOOGLE_AUTH_CLIENT_SECRET.'),
        devForm)));
}
