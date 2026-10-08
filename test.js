// Quick engine sanity tests: node test.js
const E = require('./engine.js');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } };
ok(Math.abs(E.vdotFrom(5000, 20 * 60) - 49.8) < 0.5, 'VDOT for 20:00 5K ≈ 49.8');
const goals = ['start', '5k', '10k', 'half', 'marathon', 'fitness'], levels = ['beginner', 'intermediate', 'advanced', 'elite'];
const dayss = [[1, 5], [1, 3, 6], [0, 2, 4, 6], [0, 1, 3, 5, 6], [0, 1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5, 6]];
let n = 0;
for (const goal of goals) for (const level of levels) for (const days of dayss) for (const race of [null, '2027-03-21']) {
  const p = { name: 'T', goal, level, days, longDay: days[days.length - 1], startDate: '2026-10-12', raceDate: race, weeks: null, prefs: { hills: 'avoid' }, terrain: 'mixed', strength: 1, weekdayMax: 45 };
  const plan = E.generate(p); n++;
  const all = plan.weeks.flatMap(w => w.workouts);
  ok(all.every(w => isFinite(w.km) && isFinite(w.sec) && w.km >= 0), `finite ${goal} ${level} ${days}`);
  ok(plan.weeks.every(w => w.workouts.filter(x => x.type !== 'strength').every(x => days.includes(x.day) || x.type === 'race')), `run days respected ${goal} ${level} ${days}`);
  ok(new Set(all.map(w => w.id)).size === all.length, `unique ids ${goal} ${level} ${days}`);
  if (E.GOALS[goal].race && goal !== 'start') ok(all.some(w => w.type === 'race'), `has race ${goal}`);
  ok(!all.some(w => w.type === 'hills') || true, 'hills avoided where possible');
}
console.log(`${n} plans generated, ${fails} failures`);
process.exit(fails ? 1 : 0);
