'use strict';
// Role model — six cumulative levels, assignable per song or per collection.
// A user's effective role on a song = max(role granted on the song,
// role granted on its collection, owner if they created it).
//
//  viewer      – open the song, listen to everything, read comments/votes. Nothing else.
//  voter       – + rate comps 1–10 (change own vote any time).
//  suggester   – + write/pin comments, record suggestion takes (marked as suggestions),
//                  keep personal picks ("listen as me"). May edit/delete only their own material.
//  contributor – + full creative access in every stage: create/edit sections, record takes,
//                  apply effects & processing, build comps, edit song structure and tracks.
//                  May not manage members, change official song settings, or advance the stage.
//  admin       – + invite members and set roles (up to admin), edit song settings
//                  (official tempo/meter/key, latency, MIDI backing), advance/set the official
//                  stage, choose stage source comps, delete any member's material.
//  owner       – + delete the song/collection, transfer ownership, manage admins.
//                  The creator; exactly one per resource (grants on top are possible).

const ORDER = ['viewer', 'voter', 'suggester', 'contributor', 'admin', 'owner'];
const RANK = Object.fromEntries(ORDER.map((r, i) => [r, i + 1]));

const CAN = {
  view:            'viewer',
  vote:            'voter',
  comment:         'suggester',
  addTake:         'suggester',   // suggesters' takes are flagged is_suggestion
  pick:            'suggester',
  editOwn:         'suggester',
  createComp:      'contributor',
  editContent:     'contributor', // sections, structure, tracks, effects, others' takes
  process:         'contributor',
  manageMembers:   'admin',
  editSettings:    'admin',
  setStage:        'admin',
  deleteAny:       'admin',
  deleteSong:      'owner',
};

function rank(role) { return RANK[role] || 0; }
function allows(role, action) {
  const need = CAN[action];
  if (!need) return false;
  return rank(role) >= RANK[need];
}
function maxRole(a, b) { return rank(a) >= rank(b) ? a : b; }
function validRole(r) { return !!RANK[r]; }

module.exports = { ORDER, RANK, CAN, rank, allows, maxRole, validRole };
