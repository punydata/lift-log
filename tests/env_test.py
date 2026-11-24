# Test: live and dev copies of the built site use separate databases and caches.
import asyncio, threading, functools, http.server, os, shutil
from playwright.async_api import async_playwright
ROOT = '/tmp/srv'
shutil.rmtree(ROOT, ignore_errors=True); os.makedirs(ROOT)
shutil.copytree('/tmp/site', ROOT + '/lift-log')
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
H.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
PROBE = """async()=>({env:document.documentElement.dataset.env, title:document.title,
  dbs:(await indexedDB.databases()).map(d=>d.name).sort(), caches:(await caches.keys()).sort(),
  sw:(navigator.serviceWorker.controller||{}).scriptURL||null, home:!!document.querySelector('.tile')})"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(); errs = []
        pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        # simulate an old v0.5.3 cache left over from before
        await pg.goto('http://127.0.0.1:8765/lift-log/'); await pg.evaluate("caches.open('v0.5.3')")
        await pg.reload(); await pg.wait_for_timeout(2000); await pg.reload(); await pg.wait_for_timeout(1000)
        print('LIVE', await pg.evaluate(PROBE))
        pg2 = await ctx.new_page(); pg2.on('pageerror', lambda e: errs.append(str(e)))
        await pg2.goto('http://127.0.0.1:8765/lift-log/dev/'); await pg2.wait_for_timeout(2000)
        await pg2.reload(); await pg2.wait_for_timeout(1000)
        print('DEV ', await pg2.evaluate(PROBE))
        await pg.reload(); await pg.wait_for_timeout(800)
        print('LIVE after dev', await pg.evaluate("async()=>(await caches.keys()).sort()"))
        # offline check
        await ctx.set_offline(True); await pg2.reload(); await pg2.wait_for_timeout(800)
        print('DEV offline home shown:', await pg2.evaluate("!!document.querySelector('.tile')"))
        await pg.reload(); await pg.wait_for_timeout(800)
        print('LIVE offline home shown:', await pg.evaluate("!!document.querySelector('.tile')"))
        print('errors:', errs); await b.close()
asyncio.run(main()); srv.shutdown()
