/*ENGINE START*/
/* Pacer training engine — pure functions, no DOM. Science notes:
   - Fitness score = Jack Daniels' VDOT (VO2 cost of running + %VO2max sustainable for duration).
   - Training paces derived from %VDOT (Easy 62-70%, Threshold 88%, Interval 97.5%) and race predictions.
   - Periodisation: Base -> Build -> Peak -> Taper, cutback week every 4th week, ~80/20 easy/hard split,
     weekly volume ramps <=10%, long run 25-40% of weekly volume, taper 1-3 weeks by distance. */
const Engine = (() => {
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const DAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const RACES = {
    '5k': { m: 5000, name: '5K' },
    '10k': { m: 10000, name: '10K' },
    half: { m: 21097.5, name: 'Half marathon' },
    marathon: { m: 42195, name: 'Marathon' },
  };
  const GOALS = {
    start: { name: 'Start running', race: '5k', weeks: 9, min: 6, max: 14, taper: 0 },
    '5k': { name: '5K', race: '5k', weeks: 8, min: 4, max: 20, taper: 1 },
    '10k': { name: '10K', race: '10k', weeks: 10, min: 5, max: 22, taper: 1 },
    half: { name: 'Half marathon', race: 'half', weeks: 12, min: 6, max: 24, taper: 2 },
    marathon: { name: 'Marathon', race: 'marathon', weeks: 16, min: 8, max: 26, taper: 3 },
    fitness: { name: 'Get fitter', race: null, weeks: 8, min: 4, max: 20, taper: 0 },
  };
  const LEVELS = ['beginner', 'intermediate', 'advanced', 'elite'];

  // ---------- VDOT maths ----------
  const vo2 = v => -4.6 + 0.182258 * v + 0.000104 * v * v; // v in m/min
  const pctMax = t => 0.8 + 0.1894393 * Math.exp(-0.012778 * t) + 0.2989558 * Math.exp(-0.1932605 * t); // t in min
  const vdotFrom = (m, sec) => { const t = sec / 60; return vo2(m / t) / pctMax(t); };
  const velFromVO2 = vo => { const a = 0.000104, b = 0.182258, c = -(4.6 + vo); return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a); };
  const paceAt = (vdot, f) => 60000 / velFromVO2(vdot * f); // sec per km
  function predict(vdot, m) {
    let lo = 60, hi = 60 * 60 * 12;
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (vdotFrom(m, mid) > vdot) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }
  function paceTable(vdot, goalPace, fb = 'HM') {
    const race = m => predict(vdot, m) / (m / 1000);
    const t = {
      E: paceAt(vdot, 0.66), Elo: paceAt(vdot, 0.70), Ehi: paceAt(vdot, 0.62),
      RC: paceAt(vdot, 0.60), LR: paceAt(vdot, 0.65),
      M: race(42195), HM: race(21097.5), TEN: race(10000), FIVE: race(5000),
      T: paceAt(vdot, 0.88), I: paceAt(vdot, 0.975), REP: race(1609.344),
      WALK: 600,
    };
    t.STR = t.REP - 8;
    t.HILL = t.T * 1.12; // uphill effort is slower on the clock
    t.GOAL = goalPace || t[fb];
    return t;
  }
  const PACE_INFO = {
    E: { name: 'Easy', zone: 2, desc: 'Conversational. You could chat in full sentences.' },
    RC: { name: 'Recovery', zone: 1, desc: 'Very relaxed jogging to absorb training.' },
    LR: { name: 'Long run', zone: 2, desc: 'Steady and easy — time on feet builds endurance.' },
    M: { name: 'Marathon', zone: 3, desc: 'Controlled, sustainable for hours.' },
    HM: { name: 'Half marathon', zone: 3, desc: 'Comfortably hard, rhythmic breathing.' },
    T: { name: 'Threshold', zone: 4, desc: '“Comfortably hard” — about 1 hour race effort.' },
    TEN: { name: '10K pace', zone: 4, desc: 'Hard but controlled.' },
    FIVE: { name: '5K pace', zone: 5, desc: 'Hard. Short sentences only.' },
    I: { name: 'Interval', zone: 5, desc: 'VO₂max effort, 3–5 min sustainable.' },
    REP: { name: 'Repetition', zone: 5, desc: 'Fast and smooth — mile race effort.' },
    STR: { name: 'Strides', zone: 5, desc: 'Fast, relaxed and tall. Not a sprint.' },
    HILL: { name: 'Hill effort', zone: 5, desc: 'Hard effort up the hill — run by feel, not pace.' },
    GOAL: { name: 'Goal race pace', zone: 4, desc: 'The pace you’re training to race at.' },
    WALK: { name: 'Walk', zone: 0, desc: 'Brisk walk.' },
  };

  // ---------- helpers ----------
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { let s = seed || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, x) => a + (b - a) * clamp(x, 0, 1);
  const li = (a, b, x) => Math.round(lerp(a, b, x));
  const r05 = km => Math.max(0, Math.round(km * 2) / 2);
  function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function fmtDate(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function addDays(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
  const dow = d => (d.getDay() + 6) % 7; // Mon=0
  const mondayOf = d => addDays(d, -dow(d));
  const weeksBetween = (a, b) => Math.round((mondayOf(b) - mondayOf(a)) / (7 * 864e5));
  function pickWeighted(items, R) {
    const tot = items.reduce((s, i) => s + i.w, 0);
    if (tot <= 0) return null;
    let r = R() * tot;
    for (const i of items) { r -= i.w; if (r <= 0) return i.v; }
    return items[items.length - 1].v;
  }

  // ---------- workout totals ----------
  function flatten(steps) {
    const out = [];
    for (const s of steps) {
      if (s.rep) for (let i = 0; i < s.rep; i++) for (const x of s.steps) out.push({ ...x, repIdx: i + 1, repOf: s.rep });
      else out.push(s);
    }
    return out;
  }
  function stepMeters(s, pt) { return s.m != null ? s.m : (s.s / pt[s.p]) * 1000; }
  function stepSecs(s, pt) { return s.s != null ? s.s : (s.m / 1000) * pt[s.p]; }
  function totals(steps, pt) {
    let m = 0, sec = 0;
    for (const s of flatten(steps)) { m += stepMeters(s, pt); sec += stepSecs(s, pt); }
    return { m, sec };
  }

  // ---------- workout builders ----------
  const WU = (m = 1500) => ({ k: 'wu', m, p: 'E', label: 'Warm up' });
  const CD = (m = 1000) => ({ k: 'cd', m, p: 'E', label: 'Cool down' });
  const run = (o) => ({ k: 'run', ...o });
  const rec = (o) => ({ k: 'rec', p: 'RC', label: 'Recovery jog', ...o });
  const VOLX = [0.65, 0.85, 1, 1.15];

  const B = {
    intervals(o) {
      const { x, lvl, goal, variant, k = 1 } = o, f = VOLX[lvl] * k;
      const short = goal === '5k' || goal === 'start' || goal === 'fitness';
      const list = short ? ['400s', '800s', '1k', 'pyramid', '200s'] : goal === '10k' ? ['800s', '1k', '1200s', 'pyramid', '400s'] : ['1k', 'mile', '800s', 'pyramid'];
      const v = list[variant % list.length];
      const longP = goal === 'half' || goal === 'marathon' ? 'TEN' : 'I';
      let n, set, title;
      const N = (a, b) => Math.max(k < 0.6 ? 2 : 3, Math.round(li(a, b, x) * f));
      switch (v) {
        case '200s': n = N(8, 14); set = [run({ m: 200, p: 'REP', label: 'Fast' }), rec({ m: 200 })]; title = `${n} × 200m`; break;
        case '400s': n = N(6, 12); set = [run({ m: 400, p: 'I', label: 'Hard' }), rec({ s: 90 })]; title = `${n} × 400m`; break;
        case '800s': n = N(4, 7); set = [run({ m: 800, p: 'I', label: 'Hard' }), rec({ s: 120 })]; title = `${n} × 800m`; break;
        case '1k': n = N(4, 6); set = [run({ m: 1000, p: longP, label: 'Hard' }), rec({ s: 90 })]; title = `${n} × 1km`; break;
        case '1200s': n = N(3, 5); set = [run({ m: 1200, p: 'TEN', label: 'Hard' }), rec({ s: 120 })]; title = `${n} × 1.2km`; break;
        case 'mile': n = N(3, 5); set = [run({ m: 1600, p: 'TEN', label: 'Hard' }), rec({ s: 120 })]; title = `${n} × 1.6km`; break;
        default: {
          const ladder = lvl === 0 || k < 0.7 ? [400, 800, 400] : x > 0.5 && lvl >= 2 ? [400, 800, 1200, 1600, 1200, 800, 400] : [400, 800, 1200, 800, 400];
          return { type: 'intervals', title: 'Pyramid intervals', purpose: 'Builds VO₂max and pace judgement — each rep changes length, so you learn to adjust effort on the fly.',
            steps: [WU(o.short ? 800 : 1500), ...ladder.flatMap((m, i) => [run({ m, p: 'I', label: 'Hard' }), ...(i < ladder.length - 1 ? [rec({ s: 90 })] : [])]), CD(o.short ? 500 : 1000)] };
        }
      }
      return { type: 'intervals', title: title + ' intervals', purpose: 'Raises your VO₂max and running economy so race pace feels easier. Keep every rep the same speed — the last should feel hard, not desperate.', steps: [WU(o.short ? 800 : 1500), { rep: n, steps: set }, CD(o.short ? 500 : 1000)] };
    },
    tempo(o) {
      const { x, lvl, variant, k = 1 } = o, f = VOLX[lvl] * k;
      const v = ['continuous', 'cruise', 'split'][variant % 3];
      if (v === 'continuous') {
        const min = Math.max(10, Math.round(li(12, 30, x) * f));
        return { type: 'tempo', title: `${min} min tempo`, purpose: 'Lifts your lactate threshold — the speed you can hold before fatigue snowballs. “Comfortably hard”: you could say a few words, not chat.', steps: [WU(o.short ? 800 : 1500), run({ s: min * 60, p: 'T', label: 'Tempo' }), CD(o.short ? 500 : 1000)] };
      }
      if (v === 'cruise') {
        const n = Math.max(3, Math.round(li(3, 6, x) * f));
        return { type: 'tempo', title: `${n} × 1.6km cruise intervals`, purpose: 'Threshold running broken into chunks with short jogs, so you can bank more quality time than a single tempo.', steps: [WU(o.short ? 800 : 1500), { rep: n, steps: [run({ m: 1600, p: 'T', label: 'Threshold' }), rec({ s: 60 })] }, CD(o.short ? 500 : 1000)] };
      }
      const min = Math.max(6, Math.round(li(8, 15, x) * f));
      return { type: 'tempo', title: `2 × ${min} min tempo`, purpose: 'Two threshold blocks with a short break — great for building race-specific stamina.', steps: [WU(o.short ? 800 : 1500), { rep: 2, steps: [run({ s: min * 60, p: 'T', label: 'Tempo' }), rec({ s: 180 })] }, CD(o.short ? 500 : 1000)] };
    },
    hills(o) {
      const { x, lvl, variant, k = 1 } = o, f = VOLX[lvl] * k;
      if (variant % 2 === 1 && x < 0.5) {
        const n = Math.max(6, Math.round(li(6, 10, x) * f));
        return { type: 'hills', title: `${n} × 20s hill sprints`, purpose: 'Short, punchy uphill sprints build power and strong form with very little fatigue.', steps: [WU(o.short ? 800 : 2000), { rep: n, steps: [run({ s: 20, p: 'HILL', label: 'Sprint uphill' }), rec({ s: 90, p: 'WALK', label: 'Walk back down' })] }, CD(o.short ? 500 : 1500)] };
      }
      const n = Math.max(4, Math.round(li(6, 12, x) * f));
      const s = Math.round(lerp(45, 90, x) / 15) * 15;
      return { type: 'hills', title: `${n} × ${s}s hill reps`, purpose: 'Strength work in disguise. Drive your arms, lift your knees and stay tall. Run by effort — the watch will lie on a hill.', steps: [WU(o.short ? 800 : 1500), { rep: n, steps: [run({ s, p: 'HILL', label: 'Hard uphill' }), rec({ s: Math.round(s * 1.4), label: 'Jog back down' })] }, CD(o.short ? 500 : 1000)] };
    },
    fartlek(o) {
      const { x, lvl, variant, k = 1 } = o, f = VOLX[lvl] * k;
      const v = variant % 3;
      if (v === 0) {
        const n = Math.max(5, Math.round(li(6, 12, x) * f));
        return { type: 'fartlek', title: `${n} × 1 min on / 1 min off`, purpose: '“Speed play” — relaxed fast running that builds speed without the pressure of hitting exact splits.', steps: [WU(o.short ? 800 : 1500), { rep: n, steps: [run({ s: 60, p: 'TEN', label: 'On' }), rec({ s: 60, p: 'E', label: 'Off' })] }, CD(o.short ? 500 : 1000)] };
      }
      if (v === 1) {
        const n = Math.max(4, Math.round(li(4, 8, x) * f));
        return { type: 'fartlek', title: `${n} × 2 min on / 1 min off`, purpose: 'Longer surges teach you to hold rhythm when tired — perfect bridge to tempo running.', steps: [WU(o.short ? 800 : 1500), { rep: n, steps: [run({ s: 120, p: 'TEN', label: 'On' }), rec({ s: 60 })] }, CD(o.short ? 500 : 1000)] };
      }
      const sets = Math.max(2, Math.round(li(2, 3, x) * Math.min(1, f)));
      return { type: 'fartlek', title: `Mixed fartlek ×${sets}`, purpose: 'A playful mix of surge lengths — keeps the legs guessing and builds gear changes.', steps: [WU(o.short ? 800 : 1500), { rep: sets, steps: [run({ s: 30, p: 'FIVE', label: 'Fast' }), rec({ s: 30, p: 'E', label: 'Easy' }), run({ s: 60, p: 'TEN', label: 'Strong' }), rec({ s: 60, p: 'E', label: 'Easy' }), run({ s: 90, p: 'T', label: 'Steady-hard' }), rec({ s: 90, p: 'E', label: 'Easy' })] }, CD(o.short ? 500 : 1000)] };
    },
    progression(o) {
      const { x, lvl, goal, k = 1 } = o;
      const dist = { start: 4, fitness: 5, '5k': 5, '10k': 7, half: 9, marathon: 11 }[goal] || 6;
      const km = Math.max(4, r05(lerp(dist * 0.8, dist * 1.3, x) * VOLX[lvl] * k));
      const third = Math.round((km * 1000) / 3 / 100) * 100;
      const last = lvl === 0 ? 'M' : 'T';
      return { type: 'progression', title: `${km} km progression run`, purpose: 'Start easy and finish strong. Teaches pacing discipline and running fast on tired legs.', steps: [run({ m: third, p: 'E', label: 'Easy' }), run({ m: third, p: lvl === 0 ? 'LR' : 'M', label: 'Steady' }), run({ m: Math.round(km * 1000 - third * 2), p: last, label: 'Strong finish' })] };
    },
    racepace(o) {
      const { x, lvl, goal, k = 1 } = o, f = VOLX[lvl] * k;
      if (goal === 'marathon') {
        const km = Math.max(4, Math.round(li(6, lvl <= 1 ? 10 : 16, x) * f));
        return { type: 'racepace', title: `${km} km at marathon pace`, purpose: 'Rehearse race day: lock into goal pace, practise fuelling and get used to the rhythm.', steps: [WU(o.short ? 800 : 2000), run({ m: km * 1000, p: 'GOAL', label: 'Marathon pace' }), CD(o.short ? 500 : 1000)] };
      }
      if (goal === 'half') {
        const n = Math.max(2, Math.round(li(2, 4, x) * f)), rm = f < 0.6 ? 2000 : 3000;
        return { type: 'racepace', title: `${n} × ${rm / 1000}km at half-marathon pace`, purpose: 'Bank time at goal pace so it feels familiar and controlled on race day.', steps: [WU(o.short ? 800 : 1500), { rep: n, steps: [run({ m: rm, p: 'GOAL', label: 'Race pace' }), rec({ s: 120 })] }, CD(o.short ? 500 : 1000)] };
      }
      if (goal === '10k') {
        const n = Math.max(f < 0.6 ? 2 : 3, Math.round(li(3, 5, x) * f));
        return { type: 'racepace', title: `${n} × 2km at 10K pace`, purpose: 'Race-specific reps to dial in goal pace and build confidence.', steps: [WU(o.short ? 800 : 1500), { rep: n, steps: [run({ m: 2000, p: 'GOAL', label: 'Race pace' }), rec({ s: 120 })] }, CD(o.short ? 500 : 1000)] };
      }
      const n = Math.max(3, Math.round(li(4, 6, x) * f));
      return { type: 'racepace', title: `${n} × 1km at 5K pace`, purpose: 'Goal-pace reps — your body learns exactly what race pace feels like.', steps: [WU(o.short ? 800 : 1500), { rep: n, steps: [run({ m: 1000, p: goal === '5k' ? 'GOAL' : 'FIVE', label: '5K pace' }), rec({ s: 120 })] }, CD(o.short ? 500 : 1000)] };
    },
    strides(o) {
      const n = o.lvl === 0 ? 4 : 6;
      return { rep: n, steps: [run({ s: 20, p: 'STR', label: 'Stride' }), rec({ s: 60, p: 'WALK', label: 'Walk / jog back' })] };
    },
    easy(o) {
      const steps = [run({ m: Math.round(o.km * 1000), p: 'E', label: 'Easy' })];
      if (o.strides) steps.push(B.strides(o));
      return { type: 'easy', title: `${o.km} km easy run${o.strides ? ' + strides' : ''}`, purpose: o.strides ? 'Aerobic base plus a few relaxed strides at the end to keep your legs quick.' : 'The foundation of everything. Keep it genuinely easy — slower than you think. Easy days make hard days possible.', steps };
    },
    recovery(o) {
      return { type: 'recovery', title: `${o.km} km recovery run`, purpose: 'Gentle movement to flush the legs after a hard day. If in doubt, go slower — or swap for a walk.', steps: [run({ m: Math.round(o.km * 1000), p: 'RC', label: 'Recovery' })] };
    },
    long(o) {
      const { km, variant, goal, phase, lvl } = o;
      const M = Math.round(km * 1000);
      if (variant === 'mp' && goal === 'marathon' && km >= 16) {
        const blocks = km >= 26 ? 3 : 2, bk = km >= 26 ? 5 : 4;
        const mpM = blocks * (bk + 1) * 1000;
        const ez = Math.max(2000, M - mpM);
        return { type: 'long', title: `${km} km long run with marathon pace`, purpose: 'The key marathon session: race-pace blocks on tired legs. Practise your race-day fuelling and kit.', steps: [run({ m: Math.round(ez * 0.6 / 100) * 100, p: 'LR', label: 'Easy' }), { rep: blocks, steps: [run({ m: bk * 1000, p: 'GOAL', label: 'Marathon pace' }), run({ m: 1000, p: 'E', label: 'Float' })] }, run({ m: Math.round(ez * 0.4 / 100) * 100, p: 'LR', label: 'Easy' })] };
      }
      if (variant === 'ff' && km >= 8) {
        const ff = Math.round(clamp(km * 0.2, 1.5, 5) * 2) / 2 * 1000;
        const p = goal === 'half' || goal === 'marathon' ? 'GOAL' : (lvl === 0 ? 'LR' : 'M');
        return { type: 'long', title: `${km} km long run, fast finish`, purpose: 'Run most of it easy, then finish strong. Teaches you to push when the legs are already tired — exactly what races demand.', steps: [run({ m: M - ff, p: 'LR', label: 'Easy' }), run({ m: ff, p, label: 'Fast finish' })] };
      }
      return { type: 'long', title: `${km} km long run`, purpose: phase === 'Base' ? 'Builds the aerobic engine: more capillaries, more mitochondria, stronger legs. Keep it conversational.' : 'Your most important run of the week for endurance. Easy effort, steady rhythm — practise drinking and fuelling on runs over 90 min.', steps: [run({ m: M, p: 'LR', label: 'Long & easy' })] };
    },
    runwalk(o) {
      const { stage } = o;
      const T = [[1, 1.5, 8], [1.5, 1.5, 8], [2, 1.5, 7], [3, 1.5, 6], [4, 1.5, 5], [5, 1.5, 4], [6, 1.5, 4], [8, 1.5, 3], [10, 1.5, 3], [12, 1, 2], [15, 1, 2], [20, 1, 1.5], [25, 0, 1], [30, 0, 1]];
      const [rn, wk, n] = T[clamp(stage, 0, T.length - 1)];
      const wuw = { k: 'wu', s: 300, p: 'WALK', label: 'Brisk walk' }, cdw = { k: 'cd', s: 300, p: 'WALK', label: 'Walk' };
      if (wk === 0) return { type: 'runwalk', title: `Run ${rn} minutes`, purpose: 'Continuous running! Go slow enough that you could chat. Pace does not matter — finishing does.', steps: [wuw, run({ s: rn * 60, p: 'E', label: 'Run easy' }), cdw] };
      const reps = Math.floor(n), extra = n - reps;
      const steps = [wuw, { rep: reps, steps: [run({ s: rn * 60, p: 'E', label: 'Run easy' }), { k: 'rec', s: wk * 60, p: 'WALK', label: 'Walk' }] }];
      if (extra > 0) steps.push(run({ s: Math.round(rn * 60 * extra), p: 'E', label: 'Run easy' }));
      steps.push(cdw);
      return { type: 'runwalk', title: `Run ${rn} min / walk ${wk} min ×${n}`, purpose: 'Run/walk builds your heart, lungs, bones and tendons gradually. Run slowly enough to talk — walking breaks are part of the plan, not a failure.', steps };
    },
    race(o) {
      const { goal, raceName } = o; const r = RACES[GOALS[goal].race];
      const pre = goal === 'marathon' ? [] : [{ k: 'wu', m: goal === 'half' ? 1000 : 1500, p: 'E', label: 'Warm up jog' }];
      return { type: 'race', title: raceName || `${r.name} race day`, purpose: 'This is what you trained for. Start controlled — the first few km should feel easy. Settle into goal pace, and save something for the final third. Trust the training!', steps: [...pre, run({ m: r.m, p: 'GOAL', label: 'Race!' })] };
    },
    timetrial(o = {}) {
      return { type: 'race', title: '5K time trial', purpose: 'A benchmark effort to measure your progress. Log the time in Paces to update your fitness score.', steps: [WU(o.short ? 800 : 2000), run({ m: 5000, p: 'FIVE', label: 'Time trial — all out, evenly paced' }), CD(o.short ? 500 : 1000)] };
    },
  };

  const STRENGTH = [
    { title: 'Runner core', mins: 20, items: [['Dead bug', '3 × 10 each side'], ['Side plank', '3 × 30s each side'], ['Bird dog', '3 × 10 each side'], ['Glute bridge', '3 × 15'], ['Plank shoulder taps', '3 × 20']] },
    { title: 'Glutes & hips', mins: 25, items: [['Single-leg glute bridge', '3 × 10 each'], ['Clamshells (band)', '3 × 15 each'], ['Lateral band walk', '3 × 12 steps each way'], ['Reverse lunge', '3 × 10 each'], ['Single-leg deadlift', '3 × 8 each']] },
    { title: 'Lower-body strength', mins: 30, items: [['Goblet / bodyweight squat', '4 × 10'], ['Bulgarian split squat', '3 × 8 each'], ['Calf raises (single leg)', '3 × 15 each'], ['Step-ups', '3 × 10 each'], ['Copenhagen plank', '3 × 20s each']] },
    { title: 'Mobility & plyo', mins: 20, items: [['Pogo hops', '3 × 20'], ['A-skips', '3 × 20m'], ['World’s greatest stretch', '2 × 5 each'], ['Hip 90/90 switches', '2 × 10'], ['Ankle wall rocks', '2 × 15 each']] },
  ];

  // ---------- plan generation ----------
  const PEAK_VOL = { start: [16, 18, 20, 22], fitness: [18, 28, 40, 55], '5k': [22, 32, 48, 62], '10k': [26, 40, 56, 72], half: [35, 48, 66, 85], marathon: [52, 66, 86, 110] };
  const PEAK_LONG = { start: [5, 5, 5, 5], fitness: [8, 11, 14, 16], '5k': [8, 11, 14, 16], '10k': [11, 14, 16, 19], half: [16, 18, 21, 23], marathon: [29, 30, 32, 33] };
  const LONG_FLOOR = { half: [15, 16, 17, 18], marathon: [28, 29, 30, 30] }; // minimum peak long run needed to race the distance well
  const DAYS_F = { 1: 0.4, 2: 0.6, 3: 0.78, 4: 0.9, 5: 1, 6: 1.08, 7: 1.12 };
  const LONG_SHARE = { 1: 1, 2: 0.6, 3: 0.45, 4: 0.38, 5: 0.34, 6: 0.31, 7: 0.29 };
  const TAPER_F = { marathon: [0.62, 0.78], half: [0.75], '10k': [0.78], '5k': [0.8] }; // index = weeks before race week - 1
  const DEFAULT_5K = [36 * 60, 29 * 60, 23 * 60, 19 * 60];
  const MAX_WEEKS = 30;

  function normalize(p) {
    const q = JSON.parse(JSON.stringify(p));
    if (!Object.prototype.hasOwnProperty.call(GOALS, q.goal)) q.goal = 'fitness';
    q.lvl = Math.max(0, LEVELS.indexOf(q.level));
    q.days = [...new Set((q.days || []).map(Number).filter(d => d >= 0 && d <= 6))].sort((a, b) => a - b);
    if (q.days.length < 2) q.days = [1, 3, 5];
    q.longDay = +q.longDay;
    if (!q.days.includes(q.longDay)) q.longDay = q.days.includes(6) ? 6 : q.days.includes(5) ? 5 : q.days[q.days.length - 1];
    q.prefs = q.prefs || {};
    q.strength = clamp(+q.strength || 0, 0, 3);
    q.weekdayMax = q.weekdayMax ? clamp(+q.weekdayMax, 20, 240) : null;
    if (!q.startDate || !/^\d{4}-\d\d-\d\d$/.test(q.startDate)) q.startDate = fmtDate(new Date());
    if (q.raceDate && (!/^\d{4}-\d\d-\d\d$/.test(q.raceDate) || q.raceDate <= q.startDate)) q.raceDate = null;
    return q;
  }

  function currentVdot(p) {
    if (p.recent && p.recent.m && p.recent.sec) return clamp(vdotFrom(p.recent.m, p.recent.sec), 20, 85);
    if (p.goal === 'start') return vdotFrom(5000, 42 * 60);
    return vdotFrom(5000, DEFAULT_5K[p.lvl]);
  }

  const gap = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 7 - d); };
  function combos(arr, k, cb, start = 0, acc = []) {
    if (acc.length === k) { cb(acc); return; }
    for (let i = start; i < arr.length; i++) combos(arr, k, cb, i + 1, [...acc, arr[i]]);
  }
  function chooseHard(runDays, longDay, q) {
    const others = runDays.filter(d => d !== longDay);
    q = Math.min(q, others.length);
    if (q <= 0) return { set: [], mg: 9 };
    let best = [], bestScore = -1, bestMg = 0;
    combos(others, q, set => {
      const hard = [longDay, ...set];
      let mg = 9;
      for (let i = 0; i < hard.length; i++) for (let j = i + 1; j < hard.length; j++) mg = Math.min(mg, gap(hard[i], hard[j]));
      const pref = set.reduce((s, d) => s + [0.2, 1, 0.8, 0.9, 0.3, 0.4, 0.4][d], 0);
      const sc = mg * 10 + pref - (set.includes((longDay + 6) % 7) ? 3 : 0);
      if (sc > bestScore) { bestScore = sc; best = set; bestMg = mg; }
    });
    return { set: best, mg: bestMg };
  }
  function chooseSpaced(days, n, anchor) { // pick n well-spaced days (for run/walk beginners)
    if (days.length <= n) return days.slice();
    let best = days.slice(0, n), bestScore = -1;
    combos(days, n, set => {
      let mg = 9;
      for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) mg = Math.min(mg, gap(set[i], set[j]));
      const sc = mg * 10 + (set.includes(anchor) ? 2 : 0);
      if (sc > bestScore) { bestScore = sc; best = set; }
    });
    return best;
  }

  function generate(profile) {
    const P = normalize(profile);
    const G = GOALS[P.goal];
    const R = rng(hash(JSON.stringify([P.name, P.goal, P.level, P.startDate, P.days, P.raceDate])));
    const warnings = [];
    const start = parseDate(P.startDate);
    let startMon = mondayOf(start);
    const isRace = !!G.race && P.goal !== 'start';
    let W, offset = 0;
    if (isRace && P.raceDate) {
      W = Math.max(1, weeksBetween(startMon, parseDate(P.raceDate)) + 1);
      if (W < G.min) warnings.push(`Only ${W} week${W === 1 ? '' : 's'} until race day — we’ve built a compressed plan. ${G.min}+ weeks is ideal for a ${G.name.toLowerCase()}.`);
      if (W > MAX_WEEKS) { offset = W - MAX_WEEKS; warnings.push(`Your race is ${W} weeks away. The first ${offset} week${offset === 1 ? ' is' : 's are'} steady base building, then the full ${MAX_WEEKS}-week plan kicks in.`); }
    } else W = clamp(P.weeks || G.weeks, G.min, G.max);
    if (P.goal === 'marathon' && P.days.length <= 3) warnings.push('Marathon training on 3 days a week is tough — your long run will be a big share of the week. 4+ days is recommended if you can.');
    if (P.weeklyKm != null && P.weeklyKm < 8 && (P.goal === 'half' || P.goal === 'marathon')) warnings.push('You’re running very little right now — we’ve started you gently. Consider a shorter goal first if this feels like a lot.');

    const Wm = W - offset; // weeks of the "real" plan
    const taper = isRace ? (Wm >= 2 ? Math.max(1, Math.min(G.taper, Wm - 2)) : 0) : 0;
    const curV = currentVdot(P);
    const raceM = G.race ? RACES[G.race].m : null;
    const maxGain = Wm * [0.45, 0.35, 0.28, 0.2][P.lvl];
    let goalV = curV + Math.min(maxGain, [3, 2.5, 2, 1.5][P.lvl]);
    let goalPace = null, goalSec = null, goalNote = null, userGoal = null;
    if (isRace && P.goalSec) {
      userGoal = P.goalSec;
      const want = vdotFrom(raceM, P.goalSec);
      if (want > curV + maxGain) {
        goalV = curV + maxGain;
        goalNote = `Your goal of ${fmtTime(P.goalSec)} is ambitious for ${Wm} weeks. We’ll train you towards ${fmtTime(predict(goalV, raceM))} and adapt as you get fitter.`;
      } else goalV = Math.max(want, curV);
    }
    if (isRace) { goalSec = predict(goalV, raceM); if (userGoal && userGoal >= goalSec) goalSec = userGoal; goalPace = goalSec / (raceM / 1000); }
    const goalFb = G.race === '5k' || !G.race ? 'FIVE' : G.race === '10k' ? 'TEN' : G.race === 'half' ? 'HM' : 'M';

    const nDays = P.days.length;
    const dayF = P.goal === 'marathon' || P.goal === 'half' ? 0.45 + 0.55 * DAYS_F[nDays] : DAYS_F[nDays];
    const peakVol = PEAK_VOL[P.goal][P.lvl] * dayF;
    const peakLong = PEAK_LONG[P.goal][P.lvl];
    const longFloor = LONG_FLOOR[P.goal] ? LONG_FLOOR[P.goal][P.lvl] : 0;
    const startVol = clamp(P.weeklyKm != null ? P.weeklyKm : peakVol * 0.55, nDays * 2.5, peakVol * 0.92);
    const startLong = clamp(P.longestKm != null ? P.longestKm : peakLong * 0.55, 3, peakLong * 0.92);
    const build = Math.max(1, Wm - taper - (isRace ? 1 : 0)); // weeks that ramp up
    const nBase = Math.max(1, Math.round(build * 0.35)), nBuildP = Math.max(1, Math.round(build * 0.4));
    const phaseOf = w => {
      if (w < offset) return 'Base';
      const i = w - offset;
      if (isRace && w === W - 1) return 'Race';
      if (isRace && w >= W - 1 - taper) return 'Taper';
      if (P.goal === 'start') return i < Wm * 0.4 ? 'Base' : 'Build';
      if (i < nBase) return 'Base';
      if (i < nBase + nBuildP) return 'Build';
      return P.goal === 'fitness' ? 'Build' : 'Peak';
    };
    const maxLongMin = P.goal === 'marathon' ? (P.lvl === 0 ? 225 : 200) : P.lvl === 0 ? 150 : 170;
    const raceDateStr = isRace ? (P.raceDate || fmtDate(addDays(startMon, (W - 1) * 7 + P.longDay))) : null;

    const weeks = [];
    const lastType = {};
    const variantCounter = {};
    let prevVol = startVol / 1.08, prevLong = startLong / 1.06, prevWeekKm = null, peakSeenVol = 0, peakSeenLong = 0;

    for (let w = 0; w < W; w++) {
      const phase = phaseOf(w);
      const i = Math.max(0, w - offset);
      const x = w < offset ? 0 : (build > 1 ? clamp(i / (build - 1), 0, 1) : 1);
      const cut = P.goal !== 'start' && (w + 1) % 4 === 0 && phase !== 'Taper' && phase !== 'Race' && w < W - 2;
      const v = lerp(curV, goalV, x);
      const pt = paceTable(v, goalPace, goalFb);
      const mon = addDays(startMon, w * 7);
      const toRace = W - 1 - w; // weeks before race week

      // ----- target volume & long run -----
      let vol = lerp(startVol, peakVol, x), lng = lerp(startLong, Math.max(peakLong, longFloor), x);
      vol = Math.min(vol, prevVol + Math.max(1.5, prevVol * 0.1));
      lng = Math.min(lng, prevLong + Math.max(1, Math.min(2, prevLong * 0.12)));
      if (phase === 'Taper') {
        const t = (TAPER_F[G.race] || [0.75])[toRace - 1] ?? 0.85;
        vol = peakSeenVol * t; lng = peakSeenLong * (toRace === 1 ? (G.race === 'marathon' ? 0.5 : 0.65) : 0.7);
      } else if (phase !== 'Race' && !cut) { prevVol = vol; prevLong = lng; }
      if (cut) { vol *= 0.8; lng *= 0.75; }
      const floorNow = phase === 'Peak' || phase === 'Build' ? lerp(0, longFloor, x) : 0;
      lng = Math.min(lng, (maxLongMin * 60) / pt.LR, Math.max(vol * LONG_SHARE[nDays] + 1, cut ? 0 : floorNow));
      lng = r05(Math.max(lng, 3));
      if (phase !== 'Taper' && phase !== 'Race') { peakSeenVol = Math.max(peakSeenVol, vol); peakSeenLong = Math.max(peakSeenLong, lng); }

      // ----- quality count -----
      let q = nDays <= 2 ? 1 : nDays === 3 ? (P.lvl === 3 ? 2 : 1) : (P.lvl === 0 ? 1 : (phase === 'Base' && P.lvl === 1 ? 1 : 2));
      if (cut || phase === 'Taper') q = Math.min(q, 1);
      if (w < offset) q = Math.min(q, 1);
      if (P.goal === 'start') q = 0;

      const workouts = [];
      const add = (day, wk, extra = {}) => {
        const date = addDays(mon, day);
        const t = wk.type === 'strength' ? { m: 0, sec: wk.mins * 60 } : totals(wk.steps, pt);
        const o = { id: fmtDate(date) + '-' + wk.type, day, date: fmtDate(date), week: w, km: Math.round(t.m / 100) / 10, sec: Math.round(t.sec), ...wk, ...extra };
        if (workouts.some(z => z.id === o.id)) o.id += '-' + workouts.length;
        workouts.push(o); return o;
      };
      const capFor = day => (day <= 4 && day !== P.longDay && P.weekdayMax ? P.weekdayMax * 60 : Infinity);
      const sizeK = phase === 'Taper' ? 0.65 : cut ? 0.8 : 1;
      const fit = (builder, o, day) => { // shrink session until it fits the weekday time limit
        let wk;
        for (const short of [false, true]) for (const k of [1, 0.85, 0.7, 0.55, 0.4]) {
          wk = builder({ ...o, k: k * (o.k0 || 1), short });
          if (totals(wk.steps, pt).sec <= capFor(day)) return wk;
        }
        // still too long for the time limit: fall back to a session type that fits
        for (const alt of [B.fartlek, B.hills, B.tempo]) {
          const a = alt({ ...o, variant: 0, k: 0.4, short: true });
          if (totals(a.steps, pt).sec <= capFor(day)) return a;
        }
        return wk;
      };

      if (P.goal === 'start') {
        const stage = Math.min(13, Math.round(w * 13 / Math.max(8, W - 1)));
        const sessions = chooseSpaced(P.days, Math.min(3, nDays), P.longDay);
        sessions.forEach((d, j) => {
          if (w === W - 1 && j === sessions.length - 1) add(d, { ...B.race({ goal: '5k', raceName: P.raceName || 'Your first 5K!' }) });
          else add(d, B.runwalk({ stage: Math.max(0, stage - (j === 1 ? 1 : 0)) }));
        });
      } else if (phase === 'Race') {
        const raceDay = dow(parseDate(raceDateStr));
        add(raceDay, B.race({ goal: P.goal, raceName: P.raceName }));
        const pre = P.days.filter(d => d < raceDay - 1);
        pre.forEach((d, j) => {
          const km = r05(clamp(vol * 0.14, 3, 8));
          if (j === 0 && pre.length >= 2 && raceDay - d >= 3) add(d, fit(B.racepace, { x: 0, lvl: Math.max(0, P.lvl - 1), goal: P.goal, k0: 0.6 }, d), { note: 'Race-week sharpener — short and sharp, then rest up.' });
          else add(d, B.easy({ km: Math.min(km, capFor(d) < Infinity ? Math.floor(capFor(d) / pt.E * 2) / 2 : km), strides: d === raceDay - 2 && P.lvl > 0, lvl: P.lvl }));
        });
      } else {
        let hard = chooseHard(P.days, P.longDay, q);
        while (q > 1 && hard.mg < 2) { q--; hard = chooseHard(P.days, P.longDay, q); }
        hard = hard.set;
        // long run variant (keep it steady when the week already has 2 hard sessions on ≤4 days)
        let lv = 'steady';
        if ((phase === 'Build' || phase === 'Peak') && !cut && w >= offset) {
          const alt = i % 2 === 0;
          if (P.goal === 'marathon' && phase === 'Peak' && alt) lv = 'mp';
          else if (alt || (P.goal === 'half' && phase === 'Peak')) lv = 'ff';
          if (nDays <= 4 && hard.length >= 2) lv = 'steady';
        }
        if (P.goal === 'fitness' && w === W - 1) add(P.longDay, B.timetrial({}));
        else add(P.longDay, B.long({ km: lng, variant: lv, goal: P.goal, phase, lvl: P.lvl }));

        // quality sessions
        const pref = t => ({ love: 2.4, ok: 1, avoid: 0 }[P.prefs[t] || 'ok']);
        const terrain = { hilly: 1.6, mixed: 1, flat: 0.55 }[P.terrain || 'mixed'];
        const pools = {
          speed: { Base: { fartlek: 3, hills: 2.5, intervals: 0.8 }, Build: { intervals: 3, hills: 1.5, fartlek: 1.2 }, Peak: { intervals: 3, fartlek: 0.8, hills: 0.6 }, Taper: { intervals: 1, fartlek: 1.2 } },
          thresh: { Base: { progression: 2.5, tempo: 1.5 }, Build: { tempo: 3, progression: 1.3, racepace: P.goal === 'marathon' || P.goal === 'half' ? 1 : 0.3 }, Peak: { tempo: 2, racepace: lv === 'mp' ? 0 : P.goal === 'marathon' ? 4 : P.goal === 'half' ? 3 : 1.5, progression: 1 }, Taper: { racepace: 2, tempo: 1 } },
        };
        if (P.goal === '5k' && phase === 'Peak') pools.speed.Peak.intervals = 4;
        if (P.goal === 'fitness') { pools.thresh.Build.racepace = 0; pools.thresh.Peak.racepace = 0; }
        const pick = group => {
          const pool = pools[group][phase] || pools[group].Build;
          const items = Object.entries(pool).map(([t, wt]) => ({ v: t, w: wt * pref(t) * (t === 'hills' ? terrain : 1) * (lastType[group] === t ? 0.35 : 1) }));
          if (items.every(it => it.w === 0)) return null;
          return pickWeighted(items, R);
        };
        const single = phase === 'Base' ? 'speed' : (i % 2 ? 'speed' : 'thresh');
        const groups = hard.length === 1 ? [single] : ['speed', 'thresh'];
        const qual = [];
        hard.forEach((day, j) => {
          const g = groups[j] || 'speed';
          const t = pick(g) || pick(g === 'speed' ? 'thresh' : 'speed');
          if (!t) { qual.push(null); return; } // everything avoided — becomes an easy run with strides
          lastType[g] = t;
          variantCounter[t] = (variantCounter[t] || 0) + 1;
          qual.push({ day, t, o: { x: phase === 'Taper' ? 0.5 : x, lvl: P.lvl, goal: P.goal, variant: variantCounter[t] - 1 + Math.floor(R() * 2), k0: sizeK } });
        });
        // keep quality from swallowing the week: shrink if long + quality > 85% of target
        const qKm = () => qual.reduce((s, z) => s + (z ? totals(fit(B[z.t], z.o, z.day).steps, pt).m / 1000 : 0), 0);
        for (let guard = 0; guard < 3 && qual.some(Boolean) && lng + qKm() > vol * 0.85; guard++) qual.forEach(z => { if (z) z.o.k0 = (z.o.k0 || 1) * 0.8; });
        const easyFromQ = [];
        qual.forEach((z, j) => { if (z) add(z.day, fit(B[z.t], z.o, z.day)); else easyFromQ.push(hard[j]); });

        // easy / recovery fill
        const easyDays = [...P.days.filter(d => d !== P.longDay && !hard.includes(d)), ...easyFromQ].sort((a, b) => a - b);
        const used = workouts.reduce((s, z) => s + z.km, 0);
        const minEasy = [2.5, 4, 5, 6][P.lvl] + (phase === 'Taper' ? 0 : x * [1, 2, 3, 3][P.lvl]);
        const dayBeforeLong = (P.longDay + 6) % 7;
        let budget = Math.max(0, vol - used);
        const share = easyDays.map(d => (d === dayBeforeLong ? 0.6 : 1));
        const shareSum = share.reduce((a, b) => a + b, 0) || 1;
        const stridesDay = (phase !== 'Taper' && P.prefs.strides !== 'avoid' && (P.lvl > 0 || P.prefs.strides === 'love')) ? (easyDays.find(d => d !== dayBeforeLong && !hard.includes(d + 1)) ?? easyDays[0]) : null;
        easyDays.forEach((d, j) => {
          const afterHard = d === (P.longDay + 1) % 7 || hard.includes((d + 6) % 7);
          const recovery = afterHard && nDays >= 5 && P.lvl >= 1;
          let km = budget * share[j] / shareSum;
          km = clamp(km, minEasy * (d === dayBeforeLong ? 0.7 : 1), Math.max(minEasy, lng * (d === dayBeforeLong ? 0.5 : 0.75)));
          if (recovery) km *= 0.75;
          const strides = d === stridesDay || easyFromQ.includes(d);
          const cap = capFor(d);
          if (cap < Infinity) km = Math.min(km, ((cap - (strides ? 480 : 0)) / (recovery ? pt.RC : pt.E)) * 0.97);
          km = Math.max(2, Math.floor(km * 2) / 2);
          add(d, recovery ? B.recovery({ km }) : B.easy({ km, strides, lvl: P.lvl }));
        });
        // cap week-on-week growth (and make sure taper weeks actually drop)
        const total = workouts.reduce((s, z) => s + z.km, 0);
        const limit = prevWeekKm == null ? Infinity : phase === 'Taper' ? prevWeekKm * 0.95 : prevWeekKm * 1.12 + 1;
        if (total > limit) {
          const easies = workouts.filter(z => z.type === 'easy' || z.type === 'recovery');
          const ez = easies.reduce((s, z) => s + z.km, 0);
          const f = ez ? clamp((ez - (total - limit)) / ez, 0.5, 1) : 1;
          easies.forEach(z => {
            const km = Math.max(Math.min(z.km, 3), Math.floor(z.km * f * 2) / 2);
            const nw = z.type === 'recovery' ? B.recovery({ km }) : B.easy({ km, strides: z.title.includes('strides'), lvl: P.lvl });
            const t = totals(nw.steps, pt); Object.assign(z, nw, { km: Math.round(t.m / 100) / 10, sec: Math.round(t.sec) });
          });
        }
      }

      // strength
      if (P.strength > 0 && phase !== 'Race') {
        const free = [0, 1, 2, 3, 4, 5, 6].filter(d => !P.days.includes(d) && d !== (P.longDay + 6) % 7);
        const easyRun = workouts.filter(z => z.type === 'easy' || z.type === 'recovery' || z.type === 'runwalk').map(z => z.day);
        const cands = [...free, ...easyRun];
        const chosen = [];
        for (const d of cands) { if (chosen.length >= P.strength) break; if (!chosen.some(c => gap(c, d) < 2)) chosen.push(d); }
        for (const d of cands) { if (chosen.length >= P.strength) break; if (!chosen.includes(d)) chosen.push(d); }
        chosen.forEach((d, j) => {
          const s = STRENGTH[(w * P.strength + j) % STRENGTH.length];
          add(d, { type: 'strength', title: s.title, mins: s.mins, items: s.items, purpose: 'Strength work makes you more resilient and more economical. Controlled reps, good form — leave 2 reps in the tank.', steps: [] });
        });
      }
      const kept = workouts.filter(z => z.date >= P.startDate).sort((a, b) => a.day - b.day || (a.type === 'strength') - (b.type === 'strength'));
      const trainKm = Math.round(kept.filter(z => z.type !== 'race').reduce((s, z) => s + z.km, 0) * 10) / 10;
      if (phase !== 'Race' && !cut) prevWeekKm = trainKm;
      weeks.push({ index: w, phase, cut, start: fmtDate(mon), v, pt, km: trainKm, workouts: kept });
    }

    // ----- race-proximity pass: whatever the weekday, the final days before a race are calm -----
    if (raceDateStr) {
      const rd = parseDate(raceDateStr);
      for (const wk of weeks) {
        const pt = wk.pt;
        wk.workouts = wk.workouts.flatMap(z => {
          if (z.type === 'race') return [z];
          const daysOut = Math.round((rd - parseDate(z.date)) / 864e5);
          if (daysOut < 0) return [];
          if (daysOut > 6) return [z];
          if (z.type === 'strength') return daysOut >= 4 ? [z] : [];
          const mk = nw => { const t = totals(nw.steps, pt); return { ...z, ...nw, km: Math.round(t.m / 100) / 10, sec: Math.round(t.sec), id: z.date + '-' + nw.type }; };
          if (daysOut <= 1) return P.lvl >= 2 && daysOut === 1 ? [mk({ ...B.easy({ km: 3, strides: true, lvl: P.lvl }), title: '3 km shakeout + strides', purpose: 'A short shakeout to stay loose. Easy, then a few strides — that’s it.' })] : [];
          if (daysOut === 2) return [mk(B.easy({ km: r05(clamp(z.km * 0.6, 3, 5)), strides: P.lvl > 0, lvl: P.lvl }))];
          if (z.type === 'long') return [mk(B.easy({ km: r05(Math.min(z.km, G.race === 'marathon' || G.race === 'half' ? 10 : 8)), lvl: P.lvl }))];
          if (QUAL.has(z.type) && daysOut <= 4) return [mk({ ...B.racepace({ x: 0, lvl: Math.max(0, P.lvl - 1), goal: P.goal, k: 0.5, short: true }), note: 'Race-week sharpener — short and sharp, then rest up.' })];
          if (z.type === 'easy' || z.type === 'recovery') return [mk(B.easy({ km: r05(Math.min(z.km, 8)), lvl: P.lvl }))];
          return [z];
        });
        // de-dupe ids after rewrites
        const seen = new Set(); wk.workouts.forEach((z, j) => { if (seen.has(z.id)) z.id += '-' + j; seen.add(z.id); });
        wk.km = Math.round(wk.workouts.filter(z => z.type !== 'race').reduce((s, z) => s + z.km, 0) * 10) / 10;
      }
    }
    weeks.forEach(wk => delete wk.pt);
    if (goalNote) warnings.push(goalNote);
    const raceW = weeks.flatMap(z => z.workouts).find(z => z.type === 'race');
    return {
      created: fmtDate(new Date()), profile: P, weeks, curV, goalV, goalPace, goalSec, userGoal, goalFb,
      raceDate: raceW ? raceW.date : null, warnings,
    };
  }
  const QUAL = new Set(['tempo', 'intervals', 'hills', 'fartlek', 'progression', 'racepace']);

  function fmtTime(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  function parseTime(str) {
    if (!str) return null;
    str = String(str).trim().replace(/[.]/g, ':');
    if (!/^\d{1,3}(:[0-5]?\d){0,2}$/.test(str)) return null;
    const parts = str.split(':').map(Number);
    if (parts.length === 1) return parts[0] > 0 ? parts[0] * 60 : null;
    let s = 0; for (const p of parts) s = s * 60 + p;
    return s > 0 ? s : null;
  }

  return { DAYS, DAYS_LONG, RACES, GOALS, LEVELS, PACE_INFO, STRENGTH, vdotFrom, predict, paceTable, totals, flatten, stepMeters, stepSecs, generate, fmtTime, parseTime, parseDate, fmtDate, addDays, mondayOf, dow };
})();
if (typeof module !== 'undefined') module.exports = Engine;
/*ENGINE END*/
