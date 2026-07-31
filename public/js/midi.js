'use strict';
// Minimal Standard MIDI File parser -> [{beat, dur, midi, ch, vel}] with beat = quarter notes.

export function parseMidi(arrayBuffer) {
  const d = new DataView(arrayBuffer);
  let pos = 0;
  const u32 = () => { const v = d.getUint32(pos); pos += 4; return v; };
  const u16 = () => { const v = d.getUint16(pos); pos += 2; return v; };
  const u8 = () => d.getUint8(pos++);
  const varint = () => {
    let v = 0;
    for (;;) { const b = u8(); v = (v << 7) | (b & 0x7f); if (!(b & 0x80)) return v; }
  };
  if (u32() !== 0x4d546864) throw new Error('Not a MIDI file');
  const hlen = u32(); const format = u16(); const ntrks = u16(); const division = u16();
  pos += hlen - 6;
  if (division & 0x8000) throw new Error('SMPTE time not supported');
  const notes = [];
  const tempoMap = [{ tick: 0, usPerQ: 500000 }];
  for (let tr = 0; tr < ntrks; tr++) {
    if (pos >= d.byteLength) break;
    if (u32() !== 0x4d54726b) break;
    const len = u32();
    const end = pos + len;
    let tick = 0, running = 0;
    const open = {}; // ch:midi -> {tick, vel}
    while (pos < end) {
      tick += varint();
      let status = u8();
      if (status < 0x80) { pos--; status = running; } else running = status;
      const type = status & 0xf0, ch = status & 0x0f;
      if (type === 0x90 || type === 0x80) {
        const midi = u8(), vel = u8();
        const key = ch + ':' + midi;
        if (type === 0x90 && vel > 0) open[key] = { tick, vel };
        else if (open[key]) {
          notes.push({ startTick: open[key].tick, endTick: tick, midi, ch, vel: open[key].vel / 127 });
          delete open[key];
        }
      } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) { pos += 2; }
      else if (type === 0xc0 || type === 0xd0) { pos += 1; }
      else if (status === 0xff) {
        const meta = u8(); const mlen = varint();
        if (meta === 0x51 && mlen === 3) {
          tempoMap.push({ tick, usPerQ: (u8() << 16) | (u8() << 8) | u8() });
        } else pos += mlen;
      } else if (status === 0xf0 || status === 0xf7) { pos += varint(); }
      else break;
    }
    pos = end;
  }
  void format;
  // beats are quarter notes: tick/division
  const out = notes.map(n => ({
    beat: Math.round((n.startTick / division) * 1000) / 1000,
    dur: Math.max(0.05, Math.round(((n.endTick - n.startTick) / division) * 1000) / 1000),
    midi: n.midi, ch: n.ch, vel: n.vel,
  })).sort((a, b) => a.beat - b.beat);
  const bpmGuess = tempoMap.length > 1 ? Math.round(60000000 / tempoMap[1].usPerQ) : null;
  return { notes: out, bpmGuess, totalBeats: out.length ? Math.max(...out.map(n => n.beat + n.dur)) : 0 };
}
