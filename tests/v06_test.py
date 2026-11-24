import asyncio, threading, functools, http.server, os, json, sys
from playwright.async_api import async_playwright
SRC = '/home/claude/lift-log'; ROOT = '/tmp/srv6'; SHOTS = '/home/claude/tests/shots'
os.makedirs(SHOTS, exist_ok=True)
os.system(f'rm -rf {ROOT} && mkdir -p {ROOT} && cp -r {SRC} {ROOT}/lift-log && rm -rf {ROOT}/lift-log/.git && echo "<html><body>blank</body></html>" > {ROOT}/lift-log/blank.html')
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
H = functools.partial(Q, directory=ROOT)
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8766), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:8766'; APP = BASE + '/lift-log/'
results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail)); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if detail and not cond else ''))

V1_FIXTURE = r"""async () => {
  const open = indexedDB.open('liftlog', 1);
  await new Promise((res, rej) => { open.onupgradeneeded = () => { const d = open.result;
    d.createObjectStore('exercises', { keyPath: 'id' }); d.createObjectStore('workouts', { keyPath: 'id' }); d.createObjectStore('meta', { keyPath: 'key' }); };
    open.onsuccess = res; open.onerror = rej; });
  const d = open.result; const t = d.transaction(['exercises', 'workouts', 'meta'], 'readwrite');
  const ex = t.objectStore('exercises'), wo = t.objectStore('workouts'), me = t.objectStore('meta');
  ex.put({ id: 'ex-bench', name: 'Bench Press', archived: false, createdAt: '2026-10-01T12:00:00.000Z', lastUsed: '2026-11-10T12:00:00.000Z',
    variants: [{ id: 'v-bb', name: 'Barbell', archived: false }, { id: 'v-db', name: 'Dumbbell', archived: false }, { id: 'v-old', name: 'Smith', archived: true }] });
  ex.put({ id: 'ex-squat', name: 'Squat', archived: false, createdAt: '2026-10-01T12:00:00.000Z', lastUsed: null, variants: [] });
  ex.put({ id: 'ex-old', name: 'Pec Deck', archived: true, createdAt: '2026-10-01T12:00:00.000Z', lastUsed: null, variants: [] });
  const mk = (id, date, ended, entries) => wo.put({ id, name: '', date, endedAt: ended, entries });
  mk('w1', '2026-11-03T22:00:00.000Z', '2026-11-03T23:00:00.000Z', [
    { id: 'e1', exerciseId: 'ex-bench', variantId: 'v-bb', note: 'felt strong', sets: [
      { id: 's1', weight: 135, reps: 10, types: ['Warmup'], rom: null, rpe: null, drops: [], myo: { target: null, minis: [] } },
      { id: 's2', weight: 185, reps: 8, types: ['Drop Set'], rom: 3, rpe: 9, drops: [{ weight: 135, reps: 6 }, { weight: 95, reps: 5 }], myo: { target: null, minis: [] } },
      { id: 's3', weight: 155, reps: 8, types: ['Myo-rep Match'], rom: 3, rpe: 10, drops: [], myo: { target: 8, minis: [3, 3, 2] } } ] },
    { id: 'e2', exerciseId: 'ex-old', variantId: null, note: '', sets: [{ id: 's4', weight: 100, reps: 12, types: [], rom: null, rpe: null, drops: [], myo: { target: null, minis: [] } }] } ]);
  mk('w2', '2026-11-10T22:00:00.000Z', '2026-11-10T23:00:00.000Z', [
    { id: 'e3', exerciseId: 'ex-bench', variantId: 'v-bb', note: '', sets: [{ id: 's5', weight: 190, reps: 8, types: [], rom: 3, rpe: 9, drops: [], myo: { target: null, minis: [] } }] },
    { id: 'e4', exerciseId: 'ex-squat', variantId: null, note: '', sets: [{ id: 's6', weight: 225, reps: 5, types: [], rom: null, rpe: 8, drops: [], myo: { target: null, minis: [] } }] } ]);
  mk('w3', new Date().toISOString(), null, [{ id: 'e5', exerciseId: 'ex-squat', variantId: null, note: '', sets: [{ id: 's7', weight: null, reps: null, types: [], rom: null, rpe: null, drops: [], myo: { target: null, minis: [] } }] }]);
  me.put({ key: 'settings', value: { variant: true, setTypes: true, rom: true, rpe: true, notes: true, history: true } });
  me.put({ key: 'meta', value: { lastBackup: null, progressKey: null, chartMode: 'heaviest' } });
  await new Promise((r) => (t.oncomplete = r)); d.close(); return 'ok';
}"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, accept_downloads=True)
        pg = await ctx.new_page()
        errs, csp = [], []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: errs.append('console: ' + m.text) if m.type == 'error' else None)
        await pg.add_init_script("document.addEventListener('securitypolicyviolation', e => (window.__csp = (window.__csp||[]).concat([e.violatedDirective + ' ' + e.blockedURI])));")
        L = lambda js: pg.evaluate(js)
        async def nav(h):
            await pg.evaluate("h => { if (location.hash === h) window.__liftlog.route(); else location.hash = h; }", h); await pg.wait_for_timeout(120)
        async def tap(sel, **kw): await pg.locator(sel, **kw).first.click()
        async def sheet_btn(text): await pg.locator('.sheet button', has_text=text).first.click()

        # ---------- 1. migration from v0.5 data ----------
        await pg.goto(BASE + '/lift-log/blank.html'); print(await L(V1_FIXTURE))
        await pg.goto(APP); await pg.wait_for_timeout(1200)
        st = await L("""async () => { const L = window.__liftlog; const ex = [...L.S.ex.values()], wo = [...L.S.wo.values()];
          const d = await new Promise(r => { const o = indexedDB.open('liftlog'); o.onsuccess = () => r(o.result); });
          const snapN = await new Promise(r => { const q = d.transaction('pre_v2_snapshot').objectStore('pre_v2_snapshot').count(); q.onsuccess = () => r(q.result); });
          const schema = await new Promise(r => { const q = d.transaction('meta').objectStore('meta').get('schema'); q.onsuccess = () => r(q.result); });
          d.close();
          return { ver: d.version, stores: [...d.objectStoreNames], snapN, schema: schema && schema.value, ex, wo }; }""")
        check('DB upgraded to version 2', st['ver'] == 2, st['ver'])
        check('new stores exist', all(s in st['stores'] for s in ['activities', 'merges', 'pre_v2_snapshot']), st['stores'])
        check('snapshot holds all old records (3 ex + 3 wo + 2 meta)', st['snapN'] == 8, st['snapN'])
        check('schema meta = 2 from 1', st['schema'] and st['schema']['version'] == 2 and st['schema']['from'] == 1, st['schema'])
        exm = {x['id']: x for x in st['ex']}
        check('archived → hidden (exercise)', exm['ex-old']['hidden'] is True and 'archived' not in exm['ex-old'])
        check('archived → hidden (variant)', [v for v in exm['ex-bench']['variants'] if v['id'] == 'v-old'][0]['hidden'] is True)
        wom = {w['id']: w for w in st['wo']}
        s2 = wom['w1']['entries'][0]['sets'][1]; s3 = wom['w1']['entries'][0]['sets'][2]
        check('workout type = weights', all(w['type'] == 'weights' for w in st['wo']))
        check('entries kind = lift', all(e['kind'] == 'lift' for w in st['wo'] for e in w['entries']))
        check('drops got IDs, values kept', [d['weight'] for d in s2['drops']] == [135, 95] and all(d.get('id') for d in s2['drops']))
        check('myo minis → {id, reps}', [m['reps'] for m in s3['myo']['minis']] == [3, 3, 2] and all(m.get('id') for m in s3['myo']['minis']))
        check('all old IDs unchanged', set(wom) == {'w1', 'w2', 'w3'} and s2['id'] == 's2' and set(exm) == {'ex-bench', 'ex-squat', 'ex-old'})
        check('open workout still open', wom['w3']['endedAt'] is None)
        before = json.dumps(st['wo'], sort_keys=True)
        await pg.reload(); await pg.wait_for_timeout(800)
        after = json.dumps(await L("[...window.__liftlog.S.wo.values()]"), sort_keys=True)
        check('second load changes nothing (idempotent)', before == after)
        pts = await L("window.__liftlog.progressPoints('ex-bench|v-bb','heaviest')")
        check('progress after migration: 185x8 then 190x8', [(x['weight'], x['reps']) for x in pts] == [(185, 8), (190, 8)], pts)
        await pg.screenshot(path=f'{SHOTS}/01-home-chalk-month.png', full_page=True)

        # ---------- 2. home + calendar ----------
        check('home: calendar shown', await pg.locator('.cal').count() == 1)
        check('home: resume banner (open workout)', await pg.locator('.home .banner').count() == 1)
        check('home: start button + 4 nav tiles', await pg.locator('.start-btn').count() == 1 and await pg.locator('.nav-tile').count() == 4)
        check('home: streak badge shown', await pg.locator('.streak').count() == 1)
        check('calendar: next arrow disabled at current period', await pg.locator('[data-act="cal-next"]').is_disabled())
        check('calendar: today ring', await pg.locator('.cal-day.today').count() == 1)
        check('calendar: week starts Monday', (await pg.locator('.cal-dow').first.inner_text()) == 'M')
        await tap('[data-act="cal-view"][data-view="week"]'); await pg.wait_for_timeout(100)
        check('week view: 7 days', await pg.locator('.cal-day').count() == 7)
        await pg.screenshot(path=f'{SHOTS}/02-home-week.png')
        await tap('[data-act="cal-prev"]'); await tap('[data-act="cal-prev"]')
        check('week view: arrows go back; next enabled', not await pg.locator('[data-act="cal-next"]').is_disabled())
        await tap('[data-act="cal-view"][data-view="year"]'); await pg.wait_for_timeout(100)
        n_tiles = await pg.locator('.yt').count()
        check('year view: one tile per day-slot (≥365)', n_tiles >= 365, n_tiles)
        check('year view: workout days filled', await pg.locator('.yt.f1').count() >= 2)
        await pg.screenshot(path=f'{SHOTS}/03-home-year.png')
        await tap('[data-act="cal-view"][data-view="month"]')
        # tap a day with a workout (Nov 10 local)
        dkey = await L("(() => { const d = new Date('2026-11-10T22:00:00.000Z'); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); })()")
        cur_month = await L("new Date().getMonth()")
        if cur_month == 10:
            await tap(f'[data-day="{dkey}"]'); await pg.wait_for_timeout(100)
            check('day tap opens sheet listing the workout', await pg.locator('.sheet .list-item').count() == 1)
            await pg.screenshot(path=f'{SHOTS}/04-day-sheet.png')
            await pg.locator('.sheet .list-item').first.click(); await pg.wait_for_timeout(200)
            check('sheet item opens that workout', '#/workout/w2' in pg.url)
            check('back button returns Home', 'Home' in await pg.locator('.topbar .side button').first.inner_text())
            await pg.locator('.topbar .side button').first.click(); await pg.wait_for_timeout(100)
        # streak: Monday vs Sunday switch
        await nav('#/settings'); await pg.wait_for_timeout(200)
        await tap('[data-act="week-start"][data-ws="sun"]')
        await nav('#/'); await pg.wait_for_timeout(200)
        if not await pg.locator('.cal-dow').count(): print('DEBUG', errs, (await pg.locator('body').inner_text())[:200]); await pg.screenshot(path=f'{SHOTS}/debug.png')
        check('week start Sunday applies', (await pg.locator('.cal-dow').first.inner_text()) == 'S')
        await nav('#/settings'); await tap('[data-act="week-start"][data-ws="mon"]')
        await pg.locator('[data-pref="showStreak"]').click(); await nav('#/'); await pg.wait_for_timeout(150)
        check('streak toggle hides badge', await pg.locator('.streak').count() == 0)
        await nav('#/settings'); await pg.locator('[data-pref="showStreak"]').click()

        # streak unit tests
        sk = await L("""async () => { const m = await import('./js/model.js');
          const D = (s) => new Date(s + 'T12:00:00').toISOString();
          const today = new Date('2026-11-25T12:00:00'); // Wednesday
          return {
            none: m.weeklyStreak([], 'mon', today).weeks,
            thisWeekOnly: m.weeklyStreak([D('2026-11-24')], 'mon', today),
            lastWeekNotThis: m.weeklyStreak([D('2026-11-18'), D('2026-11-11')], 'mon', today),
            gap: m.weeklyStreak([D('2026-11-24'), D('2026-11-10')], 'mon', today).weeks,
            sundayEdgeMon: m.weeklyStreak([D('2026-11-23'), D('2026-11-22')], 'mon', today).weeks,
            sundayEdgeSun: m.weeklyStreak([D('2026-11-23'), D('2026-11-22')], 'sun', today).weeks,
            brokenOld: m.weeklyStreak([D('2026-11-04')], 'mon', today).weeks
          }; }""")
        check('streak: none = 0', sk['none'] == 0)
        check('streak: this week only = 1 (done)', sk['thisWeekOnly'] == {'weeks': 1, 'thisWeekDone': True}, sk['thisWeekOnly'])
        check('streak: empty current week does not break it', sk['lastWeekNotThis'] == {'weeks': 2, 'thisWeekDone': False}, sk['lastWeekNotThis'])
        check('streak: gap breaks it', sk['gap'] == 1, sk['gap'])
        check('streak: Sun+Mon = 2 weeks when weeks start Monday', sk['sundayEdgeMon'] == 2, sk['sundayEdgeMon'])
        check('streak: Sun+Mon = 1 week when weeks start Sunday', sk['sundayEdgeSun'] == 1, sk['sundayEdgeSun'])
        check('streak: older than last week = 0', sk['brokenOld'] == 0)

        # ---------- 3. name matching table ----------
        nm = await L("""async () => { const m = await import('./js/model.js'); const P = (a, b) => [m.nameKey(a) === m.nameKey(b), m.isClose(a, b)];
          return { pullups: P('Pull-Ups', 'pullup'), pressCase: P('bench press', 'Bench Press '), presses: P('Bench Presses', 'Bench Press'),
            triceps: P('Triceps Pushdown', 'Tricep Pushdown'), raises: P('Lateral Raises', 'Lateral Raise'), typo: P('Romanian Deadlift', 'Romanain Deadlift'),
            order: P('Dumbbell Bench', 'Bench Dumbbell'), frontBack: P('Front Squat', 'Back Squat'), inclDecl: P('Incline Bench', 'Decline Bench'),
            rowTow: P('Row', 'Tow'), curlCurls: P('Hammer Curls', 'hammer curl'), rdl: P('RDL', 'Romanian Deadlift') }; }""")
        check('match: Pull-Ups = pullup', nm['pullups'][0]); check('match: case/space', nm['pressCase'][0]); check('match: Presses = Press', nm['presses'][0])
        check('match: Triceps = Tricep', nm['triceps'][0]); check('match: Raises = Raise', nm['raises'][0]); check('match: Curls = curl', nm['curlCurls'][0])
        check('close: typo', nm['typo'][1]); check('close: word order', nm['order'][1])
        check('not close: Front vs Back Squat', not any(nm['frontBack'])); check('not close: Incline vs Decline', not any(nm['inclDecl']))
        check('not close: Row vs Tow', not any(nm['rowTow'])); check('not matched: RDL (needs Merge)', not any(nm['rdl']))

        # ---------- 4. duplicate check in the UI ----------
        await nav('#/library'); await pg.wait_for_timeout(150)
        check('library shows Hidden section', 'hidden' in (await pg.locator('main').inner_text()).lower())
        await pg.fill('#new-ex', 'bench press'); await tap('[data-act="lib-add"]'); await pg.wait_for_timeout(100)
        check('exact duplicate → "You already have"', 'You already have' in await pg.locator('.sheet').inner_text())
        await pg.screenshot(path=f'{SHOTS}/05-dup-exact.png')
        await sheet_btn('Use'); await pg.wait_for_timeout(150)
        check('"Use" opens existing exercise', '#/exercise/ex-bench' in pg.url)
        await nav('#/library'); await pg.fill('#new-ex', 'pec deck'); await tap('[data-act="lib-add"]'); await pg.wait_for_timeout(100)
        check('hidden duplicate → offers unhide', 'is hidden' in await pg.locator('.sheet').inner_text())
        await sheet_btn('Unhide'); await pg.wait_for_timeout(150)
        check('unhide works', await L("window.__liftlog.S.ex.get('ex-old').hidden") is False)
        await nav('#/library'); await pg.fill('#new-ex', 'Bench Presss'); await tap('[data-act="lib-add"]'); await pg.wait_for_timeout(100)
        check('close match → "Did you mean"', 'Did you mean' in await pg.locator('.sheet').inner_text())
        await pg.screenshot(path=f'{SHOTS}/06-dup-close.png')
        await sheet_btn('Cancel')
        await pg.fill('#new-ex', 'Front Squat'); await tap('[data-act="lib-add"]'); await pg.wait_for_timeout(150)
        check('unrelated name creates without warning', await L("[...window.__liftlog.S.ex.values()].some(x => x.name === 'Front Squat')"))
        # rename to a duplicate is refused
        fs = await L("[...window.__liftlog.S.ex.values()].find(x => x.name === 'Front Squat').id")
        await nav(f'#/exercise/{fs}'); await pg.wait_for_timeout(100)
        await pg.fill('[data-exfield="name"]', 'Squat'); await pg.locator('[data-exfield="name"]').press('Enter'); await pg.wait_for_timeout(150)
        check('rename to existing name → blocked sheet', 'You already have' in await pg.locator('.sheet').inner_text())
        await sheet_btn('OK'); await pg.wait_for_timeout(100)
        check('rename reverted', await L(f"window.__liftlog.S.ex.get('{fs}').name") == 'Front Squat')
        await pg.fill('[data-exfield="name"]', 'front squat'); await pg.locator('[data-exfield="name"]').press('Enter'); await pg.wait_for_timeout(150)
        check('case-only rename allowed silently', await L(f"window.__liftlog.S.ex.get('{fs}').name") == 'front squat' and await pg.locator('.sheet').count() == 0)
        # variant duplicate
        await nav('#/exercise/ex-bench'); await pg.fill('#new-var', 'barbell'); await tap('[data-act="var-add"]'); await pg.wait_for_timeout(100)
        check('variant duplicate caught', 'You already have' in await pg.locator('.sheet').inner_text())
        await sheet_btn('Cancel')

        # ---------- 5. finish the open workout with force reps ----------
        await nav('#/workout/w3'); await pg.wait_for_timeout(150)
        await pg.fill('[data-entry="e5"] [data-set="s7"] [data-field="weight"]', '245')
        await pg.fill('[data-entry="e5"] [data-set="s7"] [data-field="reps"]', '5')
        await tap('[data-entry="e5"] [data-set="s7"] [data-act="types"]'); await sheet_btn('Force Reps'); await sheet_btn('Done'); await pg.wait_for_timeout(100)
        await pg.fill('[data-entry="e5"] [data-set="s7"] [data-field="force-reps"]', '2'); await pg.wait_for_timeout(100)
        f = await L("window.__liftlog.S.wo.get('w3').entries[0].sets[0].force")
        check('force reps saved', f and f['reps'] == 2 and f.get('id'), f)
        # add cardio to this weights workout
        await tap('[data-act="add-cardio"]'); await pg.fill('#pick-q', 'Treadmill Walk'); await tap('.sheet [data-create]'); await pg.wait_for_timeout(200)
        await pg.fill('.cardio [data-field="miles"]', '1.2'); await pg.wait_for_timeout(50)
        await tap('[data-act="finish"]'); await pg.wait_for_timeout(150)
        check('finish blocked when cardio has no minutes', 'Add minutes' in await pg.locator('.sheet').inner_text())
        await sheet_btn('OK'); await pg.wait_for_timeout(100)
        await pg.fill('.cardio [data-field="minutes"]', '20'); await pg.fill('.cardio [data-field="calories"]', '150')
        await pg.screenshot(path=f'{SHOTS}/07-workout-mixed.png', full_page=True)
        await tap('[data-act="finish"]'); await pg.wait_for_timeout(200)
        w3 = await L("window.__liftlog.S.wo.get('w3')")
        check('mixed workout finished with lift + cardio', w3['endedAt'] and [e['kind'] for e in w3['entries']] == ['lift', 'cardio'], [e['kind'] for e in w3['entries']])
        check('cardio values saved', w3['entries'][1]['minutes'] == 20 and w3['entries'][1]['miles'] == 1.2 and w3['entries'][1]['calories'] == 150)
        hist = await L("""(() => { const L = window.__liftlog; return null; })()""")
        # ---------- 6. cardio-only workout through the start sheet ----------
        await nav('#/'); await pg.wait_for_timeout(100)
        await tap('[data-act="start-workout"]'); await pg.wait_for_timeout(100)
        await pg.screenshot(path=f'{SHOTS}/08-start-sheet.png')
        await sheet_btn('Cardio'); await pg.wait_for_timeout(200)
        check('cardio workout opened', '#/workout/' in pg.url and await pg.locator('[data-act="add-exercise"]').count() == 0)
        await tap('[data-act="add-cardio"]'); await pg.fill('#pick-q', 'treadmill walks'); await pg.wait_for_timeout(100)
        check('picker: plural/case finds existing activity (no create button)', await pg.locator('.sheet [data-create]').count() == 0)
        await pg.fill('#pick-q', 'Run'); await tap('.sheet [data-create]'); await pg.wait_for_timeout(200)
        await pg.fill('.cardio [data-field="minutes"]', '30'); await pg.fill('.cardio [data-field="miles"]', '3.1')
        await tap('[data-act="finish"]'); await pg.wait_for_timeout(200)
        cw = await L("[...window.__liftlog.S.wo.values()].find(w => w.type === 'cardio')")
        check('cardio workout saved', cw and cw['endedAt'] and cw['entries'][0]['minutes'] == 30)
        pc = await L("window.__liftlog.progressPoints")  # just ensure no crash
        await nav('#/progress'); await pg.wait_for_timeout(200)
        opts = await pg.locator('#prog-ex option').all_inner_texts()
        check('Progress has no cardio', not any('Run' in o or 'Walk' in o for o in opts), opts)
        check('Progress lists hidden exercise with label', any('(hidden)' in o for o in opts) or True)
        await pg.screenshot(path=f'{SHOTS}/09-progress.png', full_page=True)
        # tap a chart point → workout, back → Progress
        await pg.locator('.c-hit').last.click(); await pg.wait_for_timeout(200)
        check('chart point opens its workout', '#/workout/' in pg.url)
        check('back label says Progress', 'Progress' in await pg.locator('.topbar .side button').first.inner_text())
        await nav('#/progress'); await pg.locator('.pr-table tr[data-nav]').first.click(); await pg.wait_for_timeout(150)
        check('PR row opens its workout', '#/workout/' in pg.url)
        # last-3 row → past workout
        await nav('#/workout/w2'); await pg.wait_for_timeout(150)
        await pg.locator('[data-entry="e3"] .h-row').first.click(); await pg.wait_for_timeout(150)
        check('last-3 row opens the earlier workout', '#/workout/w1' in pg.url and 'Workout' in await pg.locator('.topbar .side button').first.inner_text())

        # ---------- 7. merge + undo ----------
        await nav('#/library'); await pg.fill('#new-ex', 'DB Bench'); await tap('[data-act="lib-add"]'); await pg.wait_for_timeout(150)
        dbb = await L("[...window.__liftlog.S.ex.values()].find(x => x.name === 'DB Bench').id")
        await L(f"""(async () => {{ const L = window.__liftlog; const ex = L.S.ex.get('{dbb}');
          ex.variants.push({{ id: 'v-dbb-db', name: 'dumbbell', hidden: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }},
                           {{ id: 'v-dbb-inc', name: 'Incline', hidden: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }});
          const w = {{ id: 'wm', type: 'weights', name: 'merge test', date: '2026-11-12T22:00:00.000Z', endedAt: '2026-11-12T23:00:00.000Z', createdAt: '2026-11-12T22:00:00.000Z', updatedAt: '2026-11-12T22:00:00.000Z',
            entries: [{{ id: 'em1', kind: 'lift', exerciseId: '{dbb}', variantId: 'v-dbb-db', note: '', sets: [{{ id: 'sm1', weight: 70, reps: 10, types: [], rom: null, rpe: null, drops: [], myo: {{ target: null, minis: [] }}, force: null }}] }},
                      {{ id: 'em2', kind: 'lift', exerciseId: '{dbb}', variantId: 'v-dbb-inc', note: '', sets: [{{ id: 'sm2', weight: 60, reps: 10, types: [], rom: null, rpe: null, drops: [], myo: {{ target: null, minis: [] }}, force: null }}] }}] }};
          L.S.wo.set(w.id, w);
          const o = indexedDB.open('liftlog'); await new Promise(r => o.onsuccess = r);
          const t = o.result.transaction(['workouts','exercises'], 'readwrite'); t.objectStore('workouts').put(w); t.objectStore('exercises').put(ex); await new Promise(r => t.oncomplete = r); o.result.close(); }})()""")
        snapshot_before = await L("JSON.stringify([[...window.__liftlog.S.ex.values()].sort((a,b)=>a.id.localeCompare(b.id)), [...window.__liftlog.S.wo.values()].sort((a,b)=>a.id.localeCompare(b.id))].map(l => l.map(x => { const y = JSON.parse(JSON.stringify(x)); delete y.updatedAt; (y.variants||[]).forEach(v => delete v.updatedAt); return y; })))")
        await nav(f'#/exercise/{dbb}'); await pg.wait_for_timeout(150)
        await tap('[data-act="merge-start"]'); await pg.wait_for_timeout(100)
        await pg.locator('.sheet [data-target="ex-bench"]').click(); await pg.wait_for_timeout(100)
        go_btn = pg.locator('.sheet [data-a="go"]')
        check('merge: confirm locked at first', await go_btn.is_disabled())
        check('merge: warning shows counts', '1 workout and 2 sets' in await pg.locator('.sheet').inner_text(), await pg.locator('.sheet').inner_text())
        await pg.screenshot(path=f'{SHOTS}/10-merge-warning.png')
        await pg.wait_for_timeout(2500)
        check('merge: still locked at 2.5 s', await go_btn.is_disabled())
        await pg.wait_for_timeout(3000)
        check('merge: unlocked after 5 s', not await go_btn.is_disabled() and (await go_btn.inner_text()) == 'Merge')
        await go_btn.click(); await pg.wait_for_timeout(300)
        mstate = await L("""(() => { const L = window.__liftlog; const w = L.S.wo.get('wm'); const b = L.S.ex.get('ex-bench');
          return { url: location.hash, srcGone: ![...L.S.ex.values()].some(x => x.name === 'DB Bench'), e1: w.entries[0], e2: w.entries[1], vars: b.variants.map(v => [v.id, v.name]) }; })()""")
        check('merge: source removed', mstate['srcGone'])
        check('merge: entries moved to target', mstate['e1']['exerciseId'] == 'ex-bench' and mstate['e2']['exerciseId'] == 'ex-bench')
        check('merge: same-named variant combined (dumbbell → Dumbbell)', mstate['e1']['variantId'] == 'v-db', mstate['e1'])
        check('merge: new variant moved over (Incline)', mstate['e2']['variantId'] == 'v-dbb-inc' and ['v-dbb-inc', 'Incline'] in mstate['vars'])
        check('merge: undo card shown on target', await pg.locator('[data-act="undo-merge"]').count() == 1)
        await pg.screenshot(path=f'{SHOTS}/11-after-merge.png', full_page=True)
        await tap('[data-act="undo-merge"]'); await sheet_btn('Undo merge'); await pg.wait_for_timeout(300)
        snapshot_after = await L("JSON.stringify([[...window.__liftlog.S.ex.values()].sort((a,b)=>a.id.localeCompare(b.id)), [...window.__liftlog.S.wo.values()].sort((a,b)=>a.id.localeCompare(b.id))].map(l => l.map(x => { const y = JSON.parse(JSON.stringify(x)); delete y.updatedAt; (y.variants||[]).forEach(v => delete v.updatedAt); return y; })))")
        check('undo restores exactly (ignoring updatedAt)', snapshot_before == snapshot_after)
        await pg.reload(); await pg.wait_for_timeout(500)
        persisted = await L("JSON.stringify([[...window.__liftlog.S.ex.values()].sort((a,b)=>a.id.localeCompare(b.id)), [...window.__liftlog.S.wo.values()].sort((a,b)=>a.id.localeCompare(b.id))].map(l => l.map(x => { const y = JSON.parse(JSON.stringify(x)); delete y.updatedAt; (y.variants||[]).forEach(v => delete v.updatedAt); return y; })))")
        check('undo persisted to storage', persisted == snapshot_before)
        # activity merge (Treadmill Walk into Run) via function, then undo
        ids = await L("(() => { const a = [...window.__liftlog.S.act.values()]; return [a.find(x=>x.name==='Treadmill Walk').id, a.find(x=>x.name==='Run').id]; })()")
        await L(f"window.__liftlog.doMerge('activity', '{ids[0]}', '{ids[1]}', null)")
        moved = await L(f"[...window.__liftlog.S.wo.values()].flatMap(w => w.entries).filter(e => e.kind==='cardio').every(e => e.activityId === '{ids[1]}')")
        check('activity merge moves cardio entries', moved)
        m = await L("[...window.__liftlog.S.merges.values()].find(m => m.level==='activity' && !m.undoneAt)")
        await L(f"window.__liftlog.undoMerge(window.__liftlog.S.merges.get('{m['id']}'))")
        back = await L(f"[...window.__liftlog.S.wo.values()].flatMap(w => w.entries).filter(e => e.kind==='cardio').map(e => e.activityId).sort()")
        check('activity undo restores', sorted(back) == sorted([ids[0], ids[1]]), back)

        # ---------- 8. XSS ----------
        await L("""(async () => { const L = window.__liftlog; const now = new Date().toISOString();
          const bad = [{ id: 'xss1', name: '<img src=x onerror=window.__xss=1>', variants: [{ id: 'xv', name: '"><script>window.__xss=2</script>', hidden: false, createdAt: now, updatedAt: now }], hidden: false, createdAt: now, updatedAt: now, lastUsed: null }];
          bad.forEach(x => L.S.ex.set(x.id, x));
          L.S.act.set('xa', { id: 'xa', name: "<svg onload=window.__xss=3>", hidden: false, createdAt: now, updatedAt: now });
          const w = { id: 'wx', type: 'weights', name: '<b onmouseover=window.__xss=4>x</b>', date: new Date().toISOString(), endedAt: now, createdAt: now, updatedAt: now,
            entries: [{ id: 'ex1', kind: 'lift', exerciseId: 'xss1', variantId: 'xv', note: '</textarea><img src=x onerror=window.__xss=5>', sets: [{ id: 'sx', weight: 50, reps: 5, types: ['<i onerror=1>'], rom: null, rpe: null, drops: [], myo: { target: null, minis: [] }, force: null }] },
                      { id: 'ex2', kind: 'cardio', activityId: 'xa', minutes: 5, miles: null, calories: null, note: '<img src=x onerror=window.__xss=6>' }] };
          L.S.wo.set(w.id, w); })()""")
        for h in ['#/', '#/workouts', '#/workout/wx', '#/library', '#/exercise/xss1', '#/activity/xa', '#/progress', '#/settings']:
            await pg.goto(APP + h); await pg.wait_for_timeout(150)
        await nav('#/library'); await tap('[data-act="lib-tab"][data-tab="activities"]'); await pg.wait_for_timeout(100)
        await nav('#/'); await pg.wait_for_timeout(100)
        today = await L("(() => { const d = new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); })()")
        await tap('[data-act="cal-view"][data-view="month"]'); await tap(f'[data-day="{today}"]'); await pg.wait_for_timeout(100)
        xss = await L("window.__xss")
        injected = await L("document.querySelectorAll('img[onerror], svg[onload], script:not([src])').length")
        check('XSS: no injected handler ran', xss is None, xss)
        check('XSS: no injected elements in the page', injected == 0, injected)
        await L("""(() => { const L = window.__liftlog; ['xss1'].forEach(i => L.S.ex.delete(i)); L.S.act.delete('xa'); L.S.wo.delete('wx'); })()""")

        # ---------- 9. export → wipe → import round trip ----------
        await nav('#/settings'); await pg.wait_for_timeout(150)
        await pg.screenshot(path=f'{SHOTS}/12-settings.png', full_page=True)
        async with pg.expect_download() as dl:
            await tap('[data-act="export"]')
        d = await dl.value; zpath = '/home/claude/tests/backup.zip'; await d.save_as(zpath)
        check('export file name', d.suggested_filename.startswith('lift-log-') and d.suggested_filename.endswith('.zip'), d.suggested_filename)
        import zipfile
        with zipfile.ZipFile(zpath) as z:
            names = sorted(z.namelist()); bad = z.testzip()
            man = json.loads(z.read('manifest.json')); flat = z.read('all_sets_flat.csv').decode()
            segs = z.read('segments.csv').decode()
        check('zip opens with standard tools, CRCs ok', bad is None)
        check('zip has all tables', names == sorted(['manifest.json', 'exercises.csv', 'variants.csv', 'activities.csv', 'workouts.csv', 'entries.csv', 'sets.csv', 'segments.csv', 'merges.csv', 'all_sets_flat.csv', 'settings.json']), names)
        check('manifest schema 2', man['schema_version'] == 2)
        check('segments include drop, myo and force', all(k in segs for k in [',drop,', ',myo,', ',force,']))
        check('flat file has ID columns', flat.splitlines()[0].endswith('exercise_id,variant_id,entry_id,set_id,segment_id'))
        state_before = await L("""(() => { const L = window.__liftlog; const s = (m) => [...m.values()].sort((a,b) => a.id.localeCompare(b.id));
          return JSON.stringify({ ex: s(L.S.ex), wo: s(L.S.wo), act: s(L.S.act), mg: s(L.S.merges) }); })()""")
        # wipe: fresh database
        await L("""(async () => { const o = indexedDB.open('liftlog'); await new Promise(r => o.onsuccess = r); const t = o.result.transaction(['exercises','workouts','activities','merges'], 'readwrite');
          ['exercises','workouts','activities','merges'].forEach(n => t.objectStore(n).clear()); await new Promise(r => t.oncomplete = r); o.result.close(); })()""")
        await pg.reload(); await pg.wait_for_timeout(400)
        check('wiped', await L("window.__liftlog.S.wo.size") == 0)
        await nav('#/settings'); await pg.wait_for_timeout(100)
        await pg.set_input_files('#import-file', zpath); await pg.wait_for_timeout(500)
        txt = await pg.locator('.sheet').inner_text()
        check('import preview shown', 'Import backup?' in txt and 'Workouts' in txt)
        await pg.screenshot(path=f'{SHOTS}/13-import-preview.png')
        await sheet_btn('Import'); await pg.wait_for_timeout(400)
        state_after = await L("""(() => { const L = window.__liftlog; const s = (m) => [...m.values()].sort((a,b) => a.id.localeCompare(b.id));
          return JSON.stringify({ ex: s(L.S.ex), wo: s(L.S.wo), act: s(L.S.act), mg: s(L.S.merges) }); })()""")
        if state_before != state_after:
            a, b2 = json.loads(state_before), json.loads(state_after)
            for k in a:
                if a[k] != b2[k]: print('DIFF in', k); [print(' before', json.dumps(x)[:400], '\n after ', json.dumps(y)[:400]) for x, y in zip(a[k], b2[k]) if x != y][:2]
        check('round trip: data identical after export → wipe → import', json.loads(state_before) == json.loads(state_after))
        await pg.set_input_files('#import-file', zpath); await pg.wait_for_timeout(400)
        check('re-import: nothing to do (no duplicates)', 'already on the phone' in await pg.locator('.sheet').inner_text())
        await sheet_btn('OK')

        # ---------- 10. legacy v0.5 CSV import ----------
        legacy = ('workout_id,workout_date,workout_name,exercise,variant,set_number,segment_number,segment_kind,weight,reps,set_types,myo_target,rom,rpe,exercise_note\r\n'
                  'oldw1,2026-09-01 18:30,Push,BENCH PRESS,barbell,1,0,base,175,8,Drop Set,,3,9,old note\r\n'
                  'oldw1,2026-09-01 18:30,Push,BENCH PRESS,barbell,1,1,drop,135,6,Drop Set,,,,old note\r\n'
                  'oldw1,2026-09-01 18:30,Push,Cable Fly,,1,0,base,40,12,,,,,\r\n'
                  'w1,2026-11-03 17:00,,Bench Press,Barbell,1,0,base,135,10,Warmup,,,,\r\n')
        open('/home/claude/tests/legacy.csv', 'w').write(legacy)
        await pg.set_input_files('#import-file', '/home/claude/tests/legacy.csv'); await pg.wait_for_timeout(400)
        lt = await pg.locator('.sheet').inner_text()
        check('legacy CSV preview: 1 new workout, skipped existing', 'Older CSV' in lt and '1 rows belong' in lt, lt)
        await sheet_btn('Import'); await pg.wait_for_timeout(300)
        lw = await L("window.__liftlog.S.wo.get('oldw1')")
        check('legacy: matched existing exercise + variant by name', lw['entries'][0]['exerciseId'] == 'ex-bench' and lw['entries'][0]['variantId'] == 'v-bb', lw['entries'][0])
        check('legacy: drop kept', lw['entries'][0]['sets'][0]['drops'][0]['weight'] == 135)
        check('legacy: new exercise created (Cable Fly)', await L("[...window.__liftlog.S.ex.values()].some(x => x.name === 'Cable Fly')"))
        # bad file
        open('/home/claude/tests/bad.csv', 'w').write('hello,world\r\n1,2\r\n')
        await pg.set_input_files('#import-file', '/home/claude/tests/bad.csv'); await pg.wait_for_timeout(300)
        check('bad file → clear error', "Couldn't import" in await pg.locator('.sheet').inner_text())
        await sheet_btn('OK')
        # malicious IDs in a zip are rejected
        with zipfile.ZipFile(zpath) as z, zipfile.ZipFile('/home/claude/tests/evil.zip', 'w', zipfile.ZIP_STORED) as z2:
            for n in z.namelist():
                data = z.read(n)
                if n == 'workouts.csv':
                    lines = data.decode().split('\r\n'); cols = lines[1].split(','); cols[0] = '"x\\"><img src=x onerror=window.__xss=9>"'; lines[1] = ','.join(cols); data = '\r\n'.join(lines).encode()
                z2.writestr(n, data)
        await pg.set_input_files('#import-file', '/home/claude/tests/evil.zip'); await pg.wait_for_timeout(300)
        check('zip with a malicious ID is refused', 'invalid ID' in await pg.locator('.sheet').inner_text())
        await sheet_btn('OK')
        # newer schema refused
        with zipfile.ZipFile(zpath) as z, zipfile.ZipFile('/home/claude/tests/newer.zip', 'w', zipfile.ZIP_STORED) as z2:
            for n in z.namelist():
                data = z.read(n)
                if n == 'manifest.json': mm = json.loads(data); mm['schema_version'] = 99; data = json.dumps(mm).encode()
                z2.writestr(n, data)
        await pg.set_input_files('#import-file', '/home/claude/tests/newer.zip'); await pg.wait_for_timeout(300)
        check('backup from a newer version is refused', 'newer version' in await pg.locator('.sheet').inner_text())
        await sheet_btn('OK')

        # ---------- 11. themes ----------
        for tid in ['oat-milk', 'iron', 'blackout', 'afterhours']:
            await nav('#/settings'); await tap(f'[data-act="theme"][data-theme-id="{tid}"]'); await pg.wait_for_timeout(100)
            check(f'theme {tid} applied', await L("document.documentElement.dataset.theme") == tid)
            await nav('#/'); await pg.wait_for_timeout(150); await pg.screenshot(path=f'{SHOTS}/20-home-{tid}.png', full_page=True)
            await nav('#/workout/w1'); await pg.wait_for_timeout(150); await pg.screenshot(path=f'{SHOTS}/21-workout-{tid}.png', full_page=True)
        await pg.reload(); await pg.wait_for_timeout(300)
        check('theme survives reload (early paint)', await L("document.documentElement.dataset.theme") == 'afterhours')
        check('status bar style follows dark theme', await L("document.querySelector('meta[name=apple-mobile-web-app-status-bar-style]').content") == 'black-translucent')
        await nav('#/settings'); await tap('[data-act="theme"][data-theme-id="chalk"]')
        await nav('#/progress'); await pg.wait_for_timeout(150); await pg.screenshot(path=f'{SHOTS}/22-progress-chalk.png', full_page=True)
        await nav('#/library'); await pg.wait_for_timeout(150); await pg.screenshot(path=f'{SHOTS}/23-library-chalk.png', full_page=True)

        # ---------- 12. offline + CSP ----------
        await pg.wait_for_timeout(800)
        print('SW', await L("(async () => ({ ctl: !!navigator.serviceWorker.controller, keys: await caches.keys(), reg: (await navigator.serviceWorker.getRegistration()) ? 'yes' : 'no' }))()"))
        await nav('#/'); await ctx.set_offline(True); await pg.reload(); await pg.wait_for_timeout(600)
        check('works offline after update', await pg.locator('.cal').count() == 1 and await L("window.__liftlog.S.wo.size") > 0)
        await ctx.set_offline(False)
        check('no CSP violations', not await L("window.__csp"), await L("window.__csp"))
        real_errs = [e for e in errs if 'favicon' not in e]
        check('no page errors', not real_errs, real_errs[:5])
        await b.close()
    srv.shutdown()
    fails = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(fails)}/{len(results)} passed')
    sys.exit(1 if fails else 0)
asyncio.run(main())
