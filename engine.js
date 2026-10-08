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
  function paceTable(vdot, goalPace) {
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
    t.GOAL = goalPace || t.HM;
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
      const N = (a, b) => Math.max(3, Math.round(li(a, b, x) * f));
      switch (v) {
        case '200s': n = N(8, 14); set = [run({ m: 200, p: 'REP', label: 'Fast' }), rec({ m: 200 })]; title = `${n} × 200m`; break;
        case '400s': n = N(6, 12); set = [run({ m: 400, p: 'I', label: 'Hard' }), rec({ s: 90 })]; title = `${n} × 400m`; break;
        case '800s': n = N(4, 7); set = [run({ m: 800, p: 'I', label: 'Hard' }), rec({ s: 120 })]; title = `${n} × 800m`; break;
        case '1k': n = N(4, 6); set = [run({ m: 1000, p: longP, label: 'Hard' }), rec({ s: 90 })]; title = `${n} × 1km`; break;
        case '1200s': n = N(3, 5); set = [run({ m: 1200, p: 'TEN', label: 'Hard' }), rec({ s: 120 })]; title = `${n} × 1.2km`; break;
        case 'mile': n = N(3, 5); set = [run({ m: 1600, p: 'TEN', label: 'Hard' }), rec({ s: 120 })]; title = `${n} × 1.6km`; break;
        default: {
          const ladder = lvl === 0 ? [400, 800, 400] : x > 0.5 && lvl >= 2 ? [400, 800, 1200, 1600, 1200, 800, 400] : [400, 800, 1200, 800, 400];
          return { type: 'intervals', title: 'Pyramid intervals', purpose: 'Builds VO₂max and pace judgement — each rep changes length, so you learn to adjust effort on the fly.',
            steps: [WU(), ...ladder.flatMap((m, i) => [run({ m, p: 'I', label: 'Hard' }), ...(i < ladder.length - 1 ? [rec({ s: 90 })] : [])]), CD()] };
        }
      }
      return { type: 'intervals', title: title + ' intervals', purpose: 'Raises your VO₂max and running economy so race pace feels easier. Keep every rep the same speed — the last should feel hard, not desperate.', steps: [WU(), { rep: n, steps: set }, CD()] };
    },
    tempo(o) {
      const { x, lvl, variant, k = 1 } = o, f = VOLX[lvl] * k;
      const v = ['continuous', 'cruise', 'split'][variant % 3];
      if (v === 'continuous') {
        const min = Math.max(10, Math.round(li(12, 30, x) * f));
        return { type: 'tempo', title: `${min} min tempo`, purpose: 'Lifts your lactate threshold — the speed you can hold before fatigue snowballs. “Comfortably hard”: you could say a few words, not chat.', steps: [WU(), run({ s: min * 60, p: 'T', label: 'Tempo' }), CD()] };
      }
      if (v === 'cruise') {
        const n = Math.max(3, Math.round(li(3, 6, x) * f));
        return { type: 'tempo', title: `${n} × 1.6km cruise intervals`, purpose: 'Threshold running broken into chunks with short jogs, so you can bank more quality time than a single tempo.', steps: [WU(), { rep: n, steps: [run({ m: 1600, p: 'T', label: 'Threshold' }), rec({ s: 60 })] }, CD()] };
      }
      const min = Math.max(6, Math.round(li(8, 15, x) * f));
      return { type: 'tempo', title: `2 × ${min} min tempo`, purpose: 'Two threshold blocks with a short break — great for building race-specific stamina.', steps: [WU(), { rep: 2, steps: [run({ s: min * 60, p: 'T', label: 'Tempo' }), rec({ s: 180 })] }, CD()] };
    },
    hills(o) {
      const { x, lvl, variant, k = 1 } = o, f = VOLX[lvl] * k;
      if (variant % 2 === 1 && x < 0.5) {
        const n = Math.max(6, Math.round(li(6, 10, x) * f));
        return { type: 'hills', title: `${n} × 20s hill sprints`, purpose: 'Short, punchy uphill sprints build power and strong form with very little fatigue.', steps: [WU(2000), { rep: n, steps: [run({ s: 20, p: 'HILL', label: 'Sprint uphill' }), rec({ s: 90, p: 'WALK', label: 'Walk back down' })] }, CD(1500)] };
      }
      const n = Math.max(4, Math.round(li(6, 12, x) * f));
      const s = Math.round(lerp(45, 90, x) / 15) * 15;
      return { type: 'hills', title: `${n} × ${s}s hill reps`, purpose: 'Strength work in disguise. Drive your arms, lift your knees and stay tall. Run by effort — the watch will lie on a hill.', steps: [WU(), { rep: n, steps: [run({ s, p: 'HILL', label: 'Hard uphill' }), rec({ s: Math.round(s * 1.4), label: 'Jog back down' })] }, CD()] };
    },
    fartlek(o) {
      const { x, lvl, variant, k = 1 } = o, f = VOLX[lvl] * k;
      const v = variant % 3;
      if (v === 0) {
        const n = Math.max(5, Math.round(li(6, 12, x) * f));
        return { type: 'fartlek', title: `${n} × 1 min on / 1 min off`, purpose: '“Speed play” — relaxed fast running that builds speed without the pressure of hitting exact splits.', steps: [WU(), { rep: n, steps: [run({ s: 60, p: 'TEN', label: 'On' }), rec({ s: 60, p: 'E', label: 'Off' })] }, CD()] };
      }
      if (v === 1) {
        const n = Math.max(4, Math.round(li(4, 8, x) * f));
        return { type: 'fartlek', title: `${n} × 2 min on / 1 min off`, purpose: 'Longer surges teach you to hold rhythm when tired — perfect bridge to tempo running.', steps: [WU(), { rep: n, steps: [run({ s: 120, p: 'TEN', label: 'On' }), rec({ s: 60 })] }, CD()] };
      }
      const sets = Math.max(2, Math.round(li(2, 3, x) * Math.min(1, f)));
      return { type: 'fartlek', title: `Mixed fartlek ×${sets}`, purpose: 'A playful mix of surge lengths — keeps the legs guessing and builds gear changes.', steps: [WU(), { rep: sets, steps: [run({ s: 30, p: 'FIVE', label: 'Fast' }), rec({ s: 30, p: 'E', label: 'Easy' }), run({ s: 60, p: 'TEN', label: 'Strong' }), rec({ s: 60, p: 'E', label: 'Easy' }), run({ s: 90, p: 'T', label: 'Steady-hard' }), rec({ s: 90, p: 'E', label: 'Easy' })] }, CD()] };
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
        const km = Math.max(5, Math.round(li(6, 16, x) * f));
        return { type: 'racepace', title: `${km} km at marathon pace`, purpose: 'Rehearse race day: lock into goal pace, practise fuelling and get used to the rhythm.', steps: [WU(2000), run({ m: km * 1000, p: 'GOAL', label: 'Marathon pace' }), CD()] };
      }
      if (goal === 'half') {
        const n = Math.max(2, Math.round(li(2, 4, x) * f));
        return { type: 'racepace', title: `${n} × 3km at half-marathon pace`, purpose: 'Bank time at goal pace so it feels familiar and controlled on race day.', steps: [WU(), { rep: n, steps: [run({ m: 3000, p: 'GOAL', label: 'Race pace' }), rec({ s: 120 })] }, CD()] };
      }
      if (goal === '10k') {
        const n = Math.max(3, Math.round(li(3, 5, x) * f));
        return { type: 'racepace', title: `${n} × 2km at 10K pace`, purpose: 'Race-specific reps to dial in goal pace and build confidence.', steps: [WU(), { rep: n, steps: [run({ m: 2000, p: 'GOAL', label: 'Race pace' }), rec({ s: 120 })] }, CD()] };
      }
      const n = Math.max(3, Math.round(li(4, 6, x) * f));
      return { type: 'racepace', title: `${n} × 1km at 5K pace`, purpose: 'Goal-pace reps — your body learns exactly what race pace feels like.', steps: [WU(), { rep: n, steps: [run({ m: 1000, p: 'GOAL', label: 'Race pace' }), rec({ s: 120 })] }, CD()] };
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
        const mpM = blocks * bk * 1000 + (blocks - 1) * 1000;
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
    timetrial() {
      return { type: 'race', title: '5K time trial', purpose: 'A benchmark effort to measure your progress. Log the time in Paces to update your fitness score.', steps: [WU(2000), run({ m: 5000, p: 'FIVE', label: 'Time trial — all out, evenly paced' }), CD()] };
    },
  };

  const STRENGTH = [
    { title: 'Runner core', mins: 20, items: [['Dead bug', '3 × 10 each side'], ['Side plank', '3 × 30s each side'], ['Bird dog', '3 × 10 each side'], ['Glute bridge', '3 × 15'], ['Plank shoulder taps', '3 × 20']] },
    { title: 'Glutes & hips', mins: 25, items: [['Single-leg glute bridge', '3 × 10 each'], ['Clamshells (band)', '3 × 15 each'], ['Lateral band walk', '3 × 12 steps each way'], ['Reverse lunge', '3 × 10 each'], ['Single-leg deadlift', '3 × 8 each']] },
    { title: 'Lower-body strength', mins: 30, items: [['Goblet / bodyweight squat', '4 × 10'], ['Bulgarian split squat', '3 × 8 each'], ['Calf raises (single leg)', '3 × 15 each'], ['Step-ups', '3 × 10 each'], ['Copenhagen plank', '3 × 20s each']] },
    { title: 'Mobility & plyo', mins: 20, items: [['Pogo hops', '3 × 20'], ['A-skips', '3 × 20m'], ['World’s greatest stretch', '2 × 5 each'], ['Hip 90/90 switches', '2 × 10'], ['Ankle wall rocks', '2 × 15 each']] },
  ];

  // ---------- plan generation ----------
  const PEAK_VOL = { start: [16, 18, 20, 22], fitness: [18, 28, 40, 55], '5k': [22, 32, 48, 62], '10k': [26, 40, 56, 72], half: [32, 46, 64, 85], marathon: [42, 56, 76, 100] };
  const PEAK_LONG = { start: [5, 5, 5, 5], fitness: [8, 11, 14, 16], '5k': [8, 11, 14, 16], '10k': [11, 14, 16, 19], half: [16, 18, 21, 23], marathon: [28, 30, 32, 33] };
  const DAYS_F = { 1: 0.4, 2: 0.6, 3: 0.78, 4: 0.9, 5: 1, 6: 1.08, 7: 1.12 };
  const DEFAULT_5K = [36 * 60, 29 * 60, 23 * 60, 19 * 60];

  function normalize(p) {
    const q = JSON.parse(JSON.stringify(p));
    q.lvl = Math.max(0, LEVELS.indexOf(q.level));
    q.days = [...new Set(q.days)].sort((a, b) => a - b);
    if (!q.days.length) q.days = [1, 3, 5];
    if (q.longDay == null || !q.days.includes(q.longDay)) q.longDay = q.days.includes(6) ? 6 : q.days.includes(5) ? 5 : q.days[q.days.length - 1];
    q.prefs = q.prefs || {};
    q.strength = q.strength || 0;
    return q;
  }

  function currentVdot(p) {
    if (p.recent && p.recent.m && p.recent.sec) return clamp(vdotFrom(p.recent.m, p.recent.sec), 20, 85);
    if (p.goal === 'start') return vdotFrom(5000, 42 * 60);
    return vdotFrom(5000, DEFAULT_5K[p.lvl]);
  }

  function planLength(p, startMon) {
    const G = GOALS[p.goal];
    if (p.raceDate && G.race) {
      const w = weeksBetween(startMon, parseDate(p.raceDate)) + 1;
      return w;
    }
    return clamp(p.weeks || G.weeks, G.min, G.max);
  }

  function chooseHard(runDays, longDay, q) {
    const others = runDays.filter(d => d !== longDay);
    q = Math.min(q, others.length);
    if (q <= 0) return [];
    const gap = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 7 - d); };
    let best = null, bestScore = -1;
    const combos = (arr, k, start = 0, acc = []) => {
      if (acc.length === k) { score(acc); return; }
      for (let i = start; i < arr.length; i++) combos(arr, k, i + 1, [...acc, arr[i]]);
    };
    function score(set) {
      const hard = [longDay, ...set];
      let mg = 9;
      for (let i = 0; i < hard.length; i++) for (let j = i + 1; j < hard.length; j++) mg = Math.min(mg, gap(hard[i], hard[j]));
      // prefer the day before long run to be easy, prefer Tue/Thu workouts
      const pref = set.reduce((s, d) => s + ([0.2, 1, 0.8, 0.9, 0.3, 0.4, 0.4][d]), 0);
      const sc = mg * 10 + pref - (set.includes((longDay + 6) % 7) ? 3 : 0);
      if (sc > bestScore) { bestScore = sc; best = set; }
    }
    combos(others, q);
    return best || [];
  }

  function generate(profile) {
    const P = normalize(profile);
    const G = GOALS[P.goal];
    const R = rng(hash(JSON.stringify([P.name, P.goal, P.level, P.startDate, P.days, P.raceDate])));
    const start = parseDate(P.startDate);
    const startMon = mondayOf(start);
    let W = planLength(P, startMon);
    const warnings = [];
    if (P.raceDate && G.race) {
      if (W < G.min) warnings.push(`Only ${W} week${W === 1 ? '' : 's'} until race day — we’ve built a compressed plan. ${G.min}+ weeks is ideal for a ${G.name.toLowerCase()}.`);
      if (W > 26) { warnings.push('Race is more than 26 weeks away — your plan starts with general base building until the full plan kicks in.'); }
      W = clamp(W, 1, 40);
    }
    const taper = W >= 6 ? G.taper : Math.min(G.taper, 1);
    const curV = currentVdot(P);
    const raceM = G.race ? RACES[G.race].m : null;
    // Goal fitness — capped at a realistic rate of improvement
    const maxGain = W * [0.45, 0.35, 0.28, 0.2][P.lvl];
    let goalV = curV + Math.min(maxGain, [3, 2.5, 2, 1.5][P.lvl]);
    let goalPace = null, goalSec = null, goalNote = null;
    if (raceM && P.goalSec) {
      const want = vdotFrom(raceM, P.goalSec);
      if (want > curV + maxGain) {
        goalV = curV + maxGain;
        goalNote = `Your goal of ${fmtTime(P.goalSec)} is ambitious for ${W} weeks. We’ll train you towards ${fmtTime(predict(goalV, raceM))} and adapt as you get fitter.`;
      } else goalV = Math.max(want, curV);
      goalSec = P.goalSec;
    }
    if (raceM) { goalSec = goalSec || predict(goalV, raceM); goalPace = Math.max(goalSec, predict(goalV, raceM)) / (raceM / 1000); }
    if (P.goal === 'start') goalPace = null;

    const nDays = P.days.length;
    const peakVol = PEAK_VOL[P.goal][P.lvl] * DAYS_F[nDays];
    const peakLongBase = PEAK_LONG[P.goal][P.lvl];
    const startVol = clamp(P.weeklyKm || peakVol * 0.55, nDays * 2.5, peakVol * 0.92);
    const startLong = clamp(P.longestKm || peakLongBase * 0.55, 3, peakLongBase * 0.92);
    const build = Math.max(1, W - taper - (G.race ? 0 : 0));
    const nBase = Math.max(1, Math.round(build * 0.35)), nBuildP = Math.max(1, Math.round(build * 0.4));
    const phaseOf = w => {
      if (G.race && w === W - 1) return 'Race';
      if (w >= W - taper) return 'Taper';
      if (P.goal === 'start') return w < W * 0.4 ? 'Base' : 'Build';
      if (w < nBase) return 'Base';
      if (w < nBase + nBuildP) return 'Build';
      return P.goal === 'fitness' ? 'Build' : 'Peak';
    };
    const weeks = [];
    const lastType = {};
    let variantCounter = {};
    let prevVol = startVol / 1.08, prevLong = startLong / 1.08;

    for (let w = 0; w < W; w++) {
      const phase = phaseOf(w);
      const x = build > 1 ? clamp(w / (build - 1), 0, 1) : 1;
      const cut = (w + 1) % 4 === 0 && w < W - taper - 1 && phase !== 'Taper' && phase !== 'Race';
      const v = lerp(curV, goalV, x);
      const pt = paceTable(v, goalPace);
      const mon = addDays(startMon, w * 7);

      // volume
      let vol = lerp(startVol, peakVol, x), lng = lerp(startLong, peakLongBase, x);
      vol = Math.min(vol, prevVol * 1.1 + 1.5); lng = Math.min(lng, prevLong * 1.12 + 1);
      if (!cut && phase !== 'Taper' && phase !== 'Race') { prevVol = vol; prevLong = lng; }
      const toRace = W - 1 - w; // 0 = race week
      if (phase === 'Taper') { const t = [0.6, 0.72, 0.82][toRace - 1] ?? 0.8; vol = prevVol * t; lng = prevLong * (t - 0.05); }
      if (cut) { vol *= 0.78; lng *= 0.72; }
      const maxLongMin = P.lvl === 0 ? 150 : 180;
      lng = Math.min(lng, (maxLongMin * 60) / pt.LR, nDays <= 2 ? vol * 0.6 : vol * 0.45 + 2);
      lng = r05(Math.max(lng, 3));

      // quality count
      let q = nDays <= 2 ? 1 : nDays === 3 ? (P.lvl === 3 ? 2 : 1) : (P.lvl === 0 ? 1 : (phase === 'Base' && P.lvl === 1 ? 1 : 2));
      if (cut || phase === 'Taper') q = Math.min(q, 1);
      if (P.goal === 'start') q = 0;

      const workouts = [];
      const add = (day, wk, extra = {}) => {
        const date = addDays(mon, day);
        const t = wk.type === 'strength' ? { m: 0, sec: wk.mins * 60 } : totals(wk.steps, pt);
        workouts.push({ id: fmtDate(date) + '-' + wk.type, day, date: fmtDate(date), week: w, km: Math.round(t.m / 100) / 10, sec: Math.round(t.sec), ...wk, ...extra });
      };
      const capFor = day => (day <= 4 && P.weekdayMax ? P.weekdayMax * 60 : Infinity);
      const fit = (builder, o, day) => { // shrink session until it fits the weekday time limit
        let wk = builder({ ...o, k: 1 });
        for (let k = 0.85; k >= 0.4 && totals(wk.steps, pt).sec > capFor(day); k -= 0.15) wk = builder({ ...o, k });
        return wk;
      };

      if (P.goal === 'start') {
        const stage = Math.round((w / Math.max(1, W - 1)) * 13);
        const sessions = P.days.slice(0, Math.min(4, nDays));
        sessions.forEach((d, i) => {
          if (w === W - 1 && d === sessions[sessions.length - 1]) add(d, { ...B.race({ goal: '5k', raceName: P.raceName || 'Your first 5K!' }) });
          else add(d, B.runwalk({ stage: Math.max(0, stage - (i === 1 ? 1 : 0)) }));
        });
      } else if (phase === 'Race') {
        const raceDay = P.raceDate ? dow(parseDate(P.raceDate)) : P.longDay;
        add(raceDay, B.race({ goal: P.goal, raceName: P.raceName }));
        const pre = P.days.filter(d => d < raceDay - 1);
        pre.forEach((d, i) => {
          const km = r05(clamp(vol * 0.14, 3, 8));
          if (i === 0 && pre.length >= 2 && P.goal !== 'start') add(d, fit(B.racepace, { x: 0, lvl: Math.max(0, P.lvl - 1), goal: P.goal }, d), { note: 'Race-week sharpener — short and sharp, then rest up.' });
          else add(d, B.easy({ km, strides: d === raceDay - 2 && P.lvl > 0 }));
        });
      } else {
        const hard = chooseHard(P.days, P.longDay, q);
        // long run variant
        let lv = 'steady';
        if ((phase === 'Build' || phase === 'Peak') && !cut) {
          const alt = w % 2 === 0;
          if (P.goal === 'marathon' && phase === 'Peak' && alt) lv = 'mp';
          else if (alt || (P.goal === 'half' && phase === 'Peak')) lv = 'ff';
        }
        if (P.goal === 'fitness' && w === W - 1) add(P.longDay, B.timetrial());
        else add(P.longDay, B.long({ km: lng, variant: lv, goal: P.goal, phase, lvl: P.lvl }));

        // quality sessions
        const pref = t => ({ love: 2.4, ok: 1, avoid: 0 }[P.prefs[t] || 'ok']);
        const terrain = { hilly: 1.6, mixed: 1, flat: 0.55 }[P.terrain || 'mixed'];
        const pools = {
          speed: { Base: { fartlek: 3, hills: 2.5, intervals: 0.8 }, Build: { intervals: 3, hills: 1.5, fartlek: 1.2 }, Peak: { intervals: 3, fartlek: 0.8, hills: 0.6 }, Taper: { intervals: 1, fartlek: 1.2 } },
          thresh: { Base: { progression: 2.5, tempo: 1.5 }, Build: { tempo: 3, progression: 1.3, racepace: P.goal === 'marathon' || P.goal === 'half' ? 1 : 0.3 }, Peak: { tempo: 2, racepace: P.goal === 'marathon' ? 4 : P.goal === 'half' ? 3 : 1.5, progression: 1 }, Taper: { racepace: 2, tempo: 1 } },
        };
        if (P.goal === '5k' && phase === 'Peak') pools.speed.Peak.intervals = 4;
        const pick = group => {
          const pool = pools[group][phase] || pools[group].Build;
          let items = Object.entries(pool).map(([t, wt]) => ({ v: t, w: wt * pref(t) * (t === 'hills' ? terrain : 1) * (lastType[group] === t ? 0.35 : 1) }));
          if (items.every(i => i.w === 0)) return null;
          return pickWeighted(items, R);
        };
        const groups = q === 1 ? [P.goal === '5k' || P.goal === 'fitness' || phase === 'Base' ? 'speed' : (w % 2 ? 'speed' : 'thresh')] : ['speed', 'thresh'];
        // order: put threshold first in week if long run is at the end
        hard.forEach((day, i) => {
          let g = groups[i] || 'speed';
          let t = pick(g) || pick(g === 'speed' ? 'thresh' : 'speed') || 'fartlek';
          lastType[g] = t;
          variantCounter[t] = (variantCounter[t] || 0) + 1;
          const wk = fit(B[t], { x, lvl: P.lvl, goal: P.goal, variant: variantCounter[t] - 1 + Math.floor(R() * 2) }, day);
          add(day, wk);
        });

        // easy / recovery fill
        const easyDays = P.days.filter(d => d !== P.longDay && !hard.includes(d));
        const used = workouts.reduce((s, x) => s + x.km, 0);
        const minEasy = [2.5, 4, 5, 6][P.lvl] + (phase === 'Taper' ? 0 : x * [1, 2, 3, 3][P.lvl]);
        let per = easyDays.length ? (vol - used) / easyDays.length : 0;
        per = clamp(per, minEasy, Math.max(minEasy, lng * 0.75));
        const stridesDay = (phase !== 'Taper' && P.prefs.strides !== 'avoid' && (P.lvl > 0 || P.prefs.strides === 'love')) ? easyDays.find(d => d !== (P.longDay + 6) % 7 && !hard.includes(d + 1)) ?? easyDays[0] : null;
        easyDays.forEach(d => {
          const afterHard = d === (P.longDay + 1) % 7 || hard.includes((d + 6) % 7);
          const recovery = afterHard && nDays >= 5 && P.lvl >= 1;
          let km = r05(recovery ? per * 0.75 : per);
          const cap = capFor(d);
          if (cap < Infinity) km = Math.min(km, r05((cap / (recovery ? pt.RC : pt.E)) * 1000 / 1000 * 0.95));
          km = Math.max(km, 2);
          add(d, recovery ? B.recovery({ km }) : B.easy({ km, strides: d === stridesDay, lvl: P.lvl }));
        });
      }

      // strength
      if (P.strength > 0 && phase !== 'Race') {
        const free = [0, 1, 2, 3, 4, 5, 6].filter(d => !P.days.includes(d) && d !== (P.longDay + 6) % 7);
        const easyRun = workouts.filter(x => x.type === 'easy' || x.type === 'recovery').map(x => x.day);
        const cands = [...free, ...easyRun];
        const chosen = [];
        for (const d of cands) { if (chosen.length >= P.strength) break; if (!chosen.some(c => Math.abs(c - d) < 2)) chosen.push(d); }
        for (const d of cands) { if (chosen.length >= P.strength) break; if (!chosen.includes(d)) chosen.push(d); }
        chosen.forEach((d, i) => {
          const s = STRENGTH[(w * P.strength + i) % STRENGTH.length];
          add(d, { type: 'strength', title: s.title, mins: s.mins, items: s.items, purpose: 'Strength work makes you more resilient and more economical. Controlled reps, good form — leave 2 reps in the tank.', steps: [] });
        });
      }
      // drop sessions before the chosen start date
      const kept = workouts.filter(x => x.date >= P.startDate).sort((a, b) => a.day - b.day || (a.type === 'strength') - (b.type === 'strength'));
      weeks.push({ index: w, phase, cut, start: fmtDate(mon), v, km: Math.round(kept.reduce((s, x) => s + x.km, 0) * 10) / 10, workouts: kept });
    }
    if (goalNote) warnings.push(goalNote);
    return {
      created: fmtDate(new Date()), profile: P, weeks, curV, goalV, goalPace, goalSec,
      raceDate: P.raceDate || (G.race ? fmtDate(addDays(startMon, (W - 1) * 7 + P.longDay)) : null),
      warnings,
    };
  }

  function fmtTime(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  function parseTime(str) {
    if (!str) return null;
    const parts = String(str).trim().split(':').map(Number);
    if (parts.some(isNaN)) return null;
    let s = 0; for (const p of parts) s = s * 60 + p;
    return s > 0 ? s : null;
  }

  return { DAYS, DAYS_LONG, RACES, GOALS, LEVELS, PACE_INFO, STRENGTH, vdotFrom, predict, paceTable, totals, flatten, stepMeters, stepSecs, generate, fmtTime, parseTime, parseDate, fmtDate, addDays, mondayOf, dow };
})();
if (typeof module !== 'undefined') module.exports = Engine;
/*ENGINE END*/
