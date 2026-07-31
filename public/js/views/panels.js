'use strict';
import { api } from '../api.js';
import { store } from '../store.js';
import { engine } from '../audio.js';
import { h, clear, toast, busy, confirmDlg, avatar, menu, fmtScore, fmtBeat } from '../ui.js';

export function panelTabs() {
  const tabs = [['comps', compLabel()], ['comments', '💬'], ['members', '👥']];
  return tabs.map(([id, label]) =>
    h(`button.panel-tab${store.ui.panel === id ? '.active' : ''}`, {
      onclick: () => { store.ui.panel = id; store.emit(); },
    }, label));
}

function compLabel() {
  return { 1: '◉ Comps', 2: '◉ Song comps', 3: '◉ Mixes' }[store.ui.stageView] || '◉ Comps';
}

export function renderPanel(el, ctx) {
  const p = store.ui.panel;
  if (p === 'comments') return renderComments(el);
  if (p === 'members') return renderMembers(el);
  return renderComps(el, ctx);
}

// ---------- comps + votes ----------

function renderComps(el, ctx) {
  const stage = store.ui.stageView;
  const comps = store.compsFor(stage).filter(c => !c.name.startsWith('(export)'));
  const noun = { 1: 'comp', 2: 'Song comp', 3: 'Mix' }[stage];

  const saveFromListen = async () => {
    const name = prompt(`Name this ${noun} (a compiled full version everyone can hear & vote on):`,
      `${store.user.name.split(' ')[0]}'s ${noun} ${comps.length + 1}`);
    if (!name) return;
    const payload = {};
    if (stage === 1) {
      payload.selections = {};
      for (const sec of store.song.sections) payload.selections[sec.id] = ctx ? listenLane(ctx, 1, sec.id) : [];
    } else if (stage === 2) {
      payload.sourceCompId = ctx.s2SourceCompId();
      payload.structure = ctx.currentStructure();
      payload.takeIds = listenLane(ctx, 2, 'perf');
      payload.backingGain = store.ui.s2BackingGain != null ? store.ui.s2BackingGain : 0.5;
    } else {
      payload.sourceCompId = store.song.song.stage3_source_comp;
      payload.selections = {};
      for (const tr of store.song.tracks) payload.selections[tr.id] = listenLane(ctx, 3, tr.id);
    }
    try {
      await api.post(`/api/songs/${store.songId}/comps`, { stage, name, payload });
      await store.refreshSong(true);
      toast(`${noun} saved — voting is open`);
    } catch (e) { toast(e.message, 'error'); }
  };

  const compCard = c => {
    const votes = store.votesFor(c.id);
    const avg = votes.length ? votes.reduce((a, v) => a + v.score, 0) / votes.length : null;
    const mine = votes.find(v => v.user_id === store.user.id);
    const author = store.usersById()[c.author_id];
    const isListening = store.ui.listen.type === 'comp' && store.ui.listen.id === c.id;
    return h('div.comp-card', {},
      h('div.row.between.gap-s', {},
        h('div.row.gap-s.min0', {},
          avatar(author, 20),
          h('div.min0', {},
            h('div.comp-name.ellip', {}, c.name),
            h('div.small.dim', {}, votes.length ? `${fmtScore(avg)} ★ · ${votes.length} vote${votes.length > 1 ? 's' : ''}` : 'no votes yet'))),
        h('div.row.gap-xs', {},
          h(`button.icon-btn${isListening ? '.accent' : ''}`, {
            title: 'Listen to this comp (schedules its takes live)',
            onclick: () => {
              store.ui.listen = isListening ? { type: 'mine', id: null } : { type: 'comp', id: c.id };
              if (stage === 2) store.ui.s2CompId = isListening ? null : c.id;
              store.emit();
            },
          }, '🎧'),
          h('button.icon-btn', {
            title: 'Play server-rendered mix', onclick: () => {
              engine.auditionUrl(`/api/comps/${c.id}/render`);
            },
          }, '▶'),
          h('button.icon-btn', {
            onclick: e => menu(e.currentTarget, [
              { label: 'Download WAV', action: () => window.open(`/api/comps/${c.id}/render?format=wav`, '_blank') },
              stage === 1 ? { label: 'Load into my picks', action: () => loadIntoPicks(c) } : null,
              stage === 1 && store.can('setStage') ? {
                label: 'Arrange → use in Song stage', action: async () => {
                  await api.patch(`/api/songs/${store.songId}`, { stage2SourceComp: c.id, stage: Math.max(2, store.song.song.stage) });
                  store.ui.stageView = 2;
                  await store.refreshSong(true);
                  toast('Moved to Song stage with this comp');
                },
              } : null,
              stage === 2 && store.can('setStage') ? {
                label: 'Use in Arrange stage', action: async () => {
                  await api.patch(`/api/songs/${store.songId}`, { stage3SourceComp: c.id, stage: 3 });
                  store.ui.stageView = 3;
                  await store.refreshSong(true);
                  toast('Moved to Arrange stage with this comp');
                },
              } : null,
              (c.author_id === store.user.id ? store.can('createComp') : store.can('deleteAny')) ? {
                label: 'Delete', danger: true, action: async () => {
                  if (await confirmDlg('Delete', `Delete "${c.name}" and its votes?`)) {
                    await api.del(`/api/comps/${c.id}`); store.refreshSong(true);
                  }
                },
              } : null,
            ]),
          }, '⋯'))),
      store.can('vote') ? h('div.vote-row', {},
        h('input.vote-slider', {
          type: 'range', min: 1, max: 10, step: 1, value: mine ? mine.score : 5,
          oninput: e => { e.target.closest('.vote-row').querySelector('.vote-val').textContent = e.target.value; },
          onchange: async e => {
            try { await api.put(`/api/comps/${c.id}/vote`, { score: Number(e.target.value) }); await store.refreshSong(true); }
            catch (err) { toast(err.message, 'error'); }
          },
        }),
        h('span.vote-val', {}, mine ? mine.score : '—'),
        mine ? h('button.icon-btn.small', {
          title: 'Remove my vote',
          onclick: async () => { await api.del(`/api/comps/${c.id}/vote`); store.refreshSong(true); },
        }, '✕') : null,
        h('div.vote-chips', {}, votes.map(v => {
          const u = store.usersById()[v.user_id];
          return h('span.vote-chip', { title: `${u?.name}: ${v.score}`, style: { background: u?.color || '#888' } }, v.score);
        }))) : null);
  };

  clear(el,
    h('div.panel-section', {},
      h('p.small.dim', {},
        stage === 1 ? 'A comp is a compiled full version: one (or more) takes chosen per section. Everyone votes 1–10; the winner moves to the Song stage.'
          : stage === 2 ? 'A Song comp = structure + chosen performance runs over the winning Hum comp. Vote 1–10; the winner feeds the Arrange stage.'
            : 'A Mix picks takes per instrument track. Vote 1–10 to converge on the final arrangement.'),
      store.can('createComp')
        ? h('button.btn.primary.wide', { onclick: saveFromListen }, `＋ Save current listen as ${noun}`)
        : h('p.small.dim', {}, 'Contributors can create comps. You can listen and vote.'),
      comps.length
        ? comps.map(compCard)
        : h('div.dim.small.pad-s', {}, `No ${noun}s yet.`)));
}

function listenLane(ctx, stage, laneId) {
  // mirror of song.js listen logic via ctx to avoid circular import
  return ctxListen(stage, laneId);
}
function ctxListen(stage, laneId) {
  const ui = store.ui;
  const mode = ui.listen;
  if (mode.type === 'comp') {
    const comp = store.comp(mode.id);
    if (comp && comp.stage === stage) {
      if (stage === 2) return comp.payload.takeIds || [];
      return (comp.payload.selections && comp.payload.selections[laneId]) || [];
    }
    return [];
  }
  const userId = mode.type === 'user' ? mode.id : store.user.id;
  const picked = store.picksOf(userId, stage, laneId);
  if (picked.length) return picked;
  const laneType = stage === 1 ? 'section' : stage === 2 ? 'perf' : 'track';
  const ts = store.takesFor(stage, laneType, laneId).filter(t => !t.isSuggestion && !t.muted);
  return ts.length ? [ts[ts.length - 1].id] : [];
}

async function loadIntoPicks(comp) {
  for (const [laneId, takeIds] of Object.entries(comp.payload.selections || {})) {
    await api.put(`/api/songs/${store.songId}/picks`, { stage: comp.stage, laneId, takeIds });
  }
  store.ui.listen = { type: 'mine', id: null };
  await store.refreshSong(true);
  toast('Loaded into your picks');
}

// ---------- comments ----------

function renderComments(el) {
  const stage = store.ui.stageView;
  const comments = (store.song.comments || []).filter(c => c.stage === stage);
  const focus = store.ui.focusComment;
  const input = h('textarea.input.comment-input', { placeholder: store.ui.pinMode ? 'Comment to pin at the next timeline click…' : 'Write a comment… (toggle 📍 to pin at a beat)', rows: 2 });

  const send = async (beat = null) => {
    const text = input.value.trim();
    if (!text) return;
    try {
      await api.post(`/api/songs/${store.songId}/comments`, {
        stage, text, beat,
        takeId: store.ui.selectedTakeId || undefined,
      });
      input.value = '';
      await store.refreshSong(true);
    } catch (e) { toast(e.message, 'error'); }
  };

  const item = c => {
    const author = store.usersById()[c.author_id];
    const take = c.take_id ? store.take(c.take_id) : null;
    return h(`div.comment${c.resolved ? '.resolved' : ''}${focus === c.id ? '.focus' : ''}`, {},
      h('div.row.gap-s', {},
        avatar(author, 20),
        h('div.min0.grow', {},
          h('div.row.gap-s.small', {},
            h('b', {}, author?.name || '—'),
            c.beat != null ? h('span.pin-chip', {
              title: 'Jump to beat',
              onclick: () => { store.ui.playhead = c.beat; store.emit(); },
            }, `📍 ${fmtBeat(c.beat, store.bpb())}`) : null,
            take ? h('span.pin-chip', {
              onclick: () => { store.ui.selectedTakeId = take.id; store.emit(); },
            }, `🎤 ${take.name}`) : null,
            h('span.dim', {}, new Date(c.created_at).toLocaleDateString())),
          h('div.comment-text', {}, c.text))),
      h('div.row.gap-xs.comment-actions', {},
        (c.author_id === store.user.id || store.can('editContent')) ? h('button.icon-btn.small', {
          title: c.resolved ? 'Reopen' : 'Resolve',
          onclick: async () => { await api.patch(`/api/comments/${c.id}`, { resolved: !c.resolved }); store.refreshSong(true); },
        }, c.resolved ? '↺' : '✓') : null,
        (c.author_id === store.user.id || store.can('deleteAny')) ? h('button.icon-btn.small', {
          onclick: async () => { await api.del(`/api/comments/${c.id}`); store.refreshSong(true); },
        }, '🗑') : null));
  };

  clear(el,
    h('div.panel-section', {},
      store.can('comment')
        ? h('div.col.gap-s', {}, input,
          h('div.row.gap-s.end', {},
            store.ui.selectedTakeId ? h('span.small.dim', {}, 'attaches to selected take') : null,
            h('button.btn.small', { onclick: () => send(store.ui.playhead || 0), title: 'Pin at playhead' }, '📍 at playhead'),
            h('button.btn.small.primary', { onclick: () => send(null) }, 'Send')))
        : h('p.small.dim', {}, 'Suggesters and up can comment.'),
      comments.length ? comments.slice().reverse().map(item) : h('div.dim.small.pad-s', {}, 'No comments on this stage yet.')));
  if (focus) {
    setTimeout(() => {
      const f = el.querySelector('.comment.focus');
      if (f) f.scrollIntoView({ block: 'center', behavior: 'smooth' });
      store.ui.focusComment = null;
    }, 60);
  }
}

// ---------- members ----------

const ROLE_DESC = {
  viewer: 'Listen & read only',
  voter: '+ vote 1–10 on comps',
  suggester: '+ comment, record suggestion takes, keep picks',
  contributor: '+ full creative access in all stages (sections, takes, effects, comps, structure, tracks)',
  admin: '+ invite/manage members, song settings, official tempo & stage, delete anything',
  owner: 'Everything, incl. deleting the song',
};

function renderMembers(el) {
  const members = store.song.members || [];
  const canManage = store.can('manageMembers');
  const email = h('input.input.small', { placeholder: 'email@example.com', type: 'email' });
  const role = h('select.input.small', {},
    ['viewer', 'voter', 'suggester', 'contributor', 'admin'].map(r =>
      h('option', { value: r, selected: r === 'suggester', title: ROLE_DESC[r] }, r)));

  const row = m => {
    const u = m.user_id ? store.usersById()[m.user_id] : null;
    return h('div.member-row', {},
      avatar(u || { name: m.email, color: '#556' }, 24),
      h('div.min0.grow', {},
        h('div.ellip.small', {}, u ? u.name : m.email),
        h('div.dim.tiny', {}, m.resource_type === 'collection' ? 'via collection' : (u ? m.email : 'invited — not signed in yet'))),
      canManage && m.resource_type === 'song'
        ? h('select.input.tiny', {
          value: m.role,
          onchange: async e => {
            try { await api.patch(`/api/member/${m.id}`, { role: e.target.value }); await store.refreshSong(true); }
            catch (err) { toast(err.message, 'error'); store.refreshSong(true); }
          },
        }, ['viewer', 'voter', 'suggester', 'contributor', 'admin'].map(r => h('option', { value: r, selected: r === m.role }, r)))
        : h('span.tag', { title: ROLE_DESC[m.role] }, m.role),
      canManage && m.resource_type === 'song' ? h('button.icon-btn.small', {
        onclick: async () => {
          if (await confirmDlg('Remove member', `Remove ${m.email} from this song?`, 'Remove')) {
            await api.del(`/api/member/${m.id}`); store.refreshSong(true);
          }
        },
      }, '✕') : null);
  };

  const owner = store.usersById()[store.song.song.owner_id];

  clear(el,
    h('div.panel-section', {},
      canManage ? h('div.col.gap-s.invite-box', {},
        h('div.small.dim', {}, 'Invite by email — they sign in with Google and see this song.'),
        h('div.row.gap-xs', {}, email, role),
        h('div.tiny.dim.role-desc', {}, ROLE_DESC[role.value] || ''),
        h('div.row.end', {}, h('button.btn.small.primary', {
          onclick: async () => {
            try {
              await api.post(`/api/members/song/${store.songId}`, { email: email.value, role: role.value });
              email.value = '';
              await store.refreshSong(true);
              toast('Invited');
            } catch (e) { toast(e.message, 'error'); }
          },
        }, 'Invite'))) : null,
      h('div.member-row', {},
        avatar(owner, 24),
        h('div.min0.grow', {}, h('div.ellip.small', {}, owner?.name || '—'), h('div.dim.tiny', {}, owner?.email)),
        h('span.tag', { title: ROLE_DESC.owner }, 'owner')),
      members.map(row),
      h('details.role-legend', {},
        h('summary.small.dim', {}, 'What can each role do?'),
        Object.entries(ROLE_DESC).map(([r, d]) => h('div.tiny', {}, h('b', {}, r), ' — ', d)))));
  role.addEventListener('change', () => {
    el.querySelector('.role-desc').textContent = ROLE_DESC[role.value] || '';
  });
}
