import asyncio, threading, functools, http.server, os, shutil
from playwright.async_api import async_playwright
ROOT='/tmp/srvm'; shutil.rmtree(ROOT, ignore_errors=True); os.makedirs(ROOT); shutil.copytree('/tmp/site', ROOT+'/lift-log')
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
srv=http.server.ThreadingHTTPServer(('127.0.0.1',8768),functools.partial(Q,directory=ROOT)); threading.Thread(target=srv.serve_forever,daemon=True).start()
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); ctx=await b.new_context(); errs=[]
        live=await ctx.new_page(); live.on('pageerror',lambda e: errs.append(str(e)))
        await live.goto('http://127.0.0.1:8768/lift-log/'); await live.wait_for_timeout(1200)
        await live.evaluate("location.hash='#/workouts'"); await live.wait_for_timeout(200)
        await live.locator('[data-act="start-workout"]').click(); await live.wait_for_timeout(300)
        lv = await live.evaluate("async()=>(await indexedDB.databases()).find(d=>d.name==='liftlog').version")
        nwo = await live.evaluate("window.__liftlog.S.wo.size")
        print('live: DB version', lv, '| workouts', nwo)
        dev=await ctx.new_page(); dev.on('pageerror',lambda e: errs.append(str(e)))
        await dev.goto('http://127.0.0.1:8768/lift-log/dev/'); await dev.wait_for_timeout(1500); await dev.reload(); await dev.wait_for_timeout(800)
        r=await dev.evaluate("async()=>({env:document.documentElement.dataset.env, ver: window.__liftlog.APP_VERSION, cal: !!document.querySelector('.cal'), devWorkouts: window.__liftlog.S.wo.size, dbs:(await indexedDB.databases()).map(d=>d.name+':'+d.version).sort(), caches:(await caches.keys()).sort()})")
        print('DEV', r)
        await live.reload(); await live.wait_for_timeout(800)
        lv2 = await live.evaluate("async()=>(await indexedDB.databases()).find(d=>d.name==='liftlog').version")
        print('live DB still v1 after DEV ran:', lv2 == 1, '| live workouts', await live.evaluate("window.__liftlog.S.wo.size"), '| caches', await live.evaluate("async()=>(await caches.keys()).sort()"))
        print('errors', errs); await b.close()
asyncio.run(main()); srv.shutdown()
