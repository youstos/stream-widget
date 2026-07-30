/* Follower-count proxy for the OBS widget.
   Deploy on Cloudflare Workers, then append ?proxy=<worker-url> to the widget URL.

   Browsers cannot set the User-Agent header and public CORS proxies send their own,
   which Instagram rejects with "useragent mismatch". A Worker can send a real browser
   UA, so this is the only path to a true real-time Instagram number.

   Call it as:  https://<your-worker>.workers.dev/?ig=robomeij&fb=61563196905451&kick=robomeij
   Replies with: {"instagram":1004741,"facebook":64116,"kick":140}
   Any platform that fails is simply left out of the response. */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const HEADERS = {
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
  "content-type": "application/json"
};

/* Upstream calls are throttled to at most one every TTL seconds per isolate,
   and the last good value answers in between. */
const mem = {};
const dbg = {};

async function throttled(key, ttl, fn) {
  const s = mem[key] || (mem[key] = {});
  const now = Date.now();
  if (!s.at || now - s.at > ttl * 1000) {
    s.at = now;                       // claim the slot before awaiting
    try { const v = await fn(); if (v) s.val = v; } catch (e) {}
  }
  return s.val || null;
}

/* Same, but the last good value is also shared through KV, so a freshly
   spawned isolate answers with the fleet's newest number instead of nothing.
   Writes are throttled to one per 2 minutes to stay far inside the free
   plan's 1000 writes/day; between writes each isolate's own memory is newer
   anyway. Only Instagram needs this: it is the one source whose upstream
   fails in waves, which is what made isolates drift apart. */
async function sharedThrottled(env, key, ttl, fn) {
  const s = mem[key] || (mem[key] = {});
  const now = Date.now();

  let kv = null;
  if (env && env.COUNTS) {
    try { kv = JSON.parse(await env.COUNTS.get(key)); } catch (e) {}
  }

  /* Backing off after failures matters here: Instagram's rejection waves are
     fed by request volume, so hammering through one only prolongs it. */
  const wait = Math.min(ttl * Math.pow(2, s.failN || 0), 180) * 1000;
  if (!s.at || now - s.at > wait) {
    s.at = now;
    try {
      const v = await fn();
      if (v) {
        s.failN = 0; s.val = v; s.okAt = now;
        if (env && env.COUNTS && (!kv || now - kv.at > 120000)) {
          kv = { val: v, at: now };
          await env.COUNTS.put(key, JSON.stringify(kv));
        }
      } else s.failN = (s.failN || 0) + 1;
    } catch (e) { s.failN = (s.failN || 0) + 1; }
  }

  if (kv && (!s.okAt || kv.at > s.okAt) && kv.val > (s.val || 0)) return kv.val;
  return s.val || (kv && kv.val) || null;
}

export default {
  async fetch(request, env) {
    const q = new URL(request.url).searchParams;
    const jobs = [];
    const out = {};

    if (q.get("ig"))   jobs.push(sharedThrottled(env, "ig:" + q.get("ig"), 15, () => instagram(q.get("ig"))).then(v => { if (v) out.instagram = v; }));
    if (q.get("fb"))   jobs.push(throttled("fb:" + q.get("fb"), 20, () => facebook(q.get("fb"))).then(v => { if (v) out.facebook = v; }));
    if (q.get("kick")) jobs.push(throttled("kk:" + q.get("kick"), 5, () => kick(q.get("kick"))).then(v => { if (v) out.kick = v; }));

    await Promise.all(jobs.map(p => p.catch(() => {})));
    if (q.get("debug")) out._dbg = dbg;
    return new Response(JSON.stringify(out), { headers: HEADERS });
  }
};

/* i.instagram.com answers 200 with the exact count where www.instagram.com
   401s ("wait a few minutes") — but only with a MOBILE Safari UA */
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/* One clean attempt per throttle window. The cf edge-cache layer that used to
   sit here was dropped along with the uncached retry: failed replies get
   cached like successes (cacheTtlByStatus is Enterprise-only), so the cache
   mostly served poisoned 401s while the retry doubled the request volume —
   KV is now the sharing layer instead. */
async function instagram(user) {
  const r = await fetch(
    "https://i.instagram.com/api/v1/users/web_profile_info/?username=" + encodeURIComponent(user),
    { headers: { "x-ig-app-id": "936619743392459", "user-agent": MOBILE_UA, "accept": "*/*" } }
  );
  dbg.ig = { status: r.status, at: new Date().toISOString() };
  if (!r.ok) return null;
  const j = await r.json();
  return j && j.data && j.data.user ? j.data.user.edge_followed_by.count : null;
}

/* The public Page Plugin renders the exact follower total and needs no token */
async function facebook(id) {
  const target = "https://www.facebook.com/plugins/page.php?href=" +
    encodeURIComponent("https://www.facebook.com/profile.php?id=" + id) +
    "&tabs&width=340&height=130&small_header=false&adapt_container_width=true&hide_cover=false&show_facepile=true";
  const r = await fetch(target, { headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" } });
  if (!r.ok) return null;
  const m = (await r.text()).match(/([\d][\d,]{2,})\s*(?:followers|people follow)/i);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
}

async function kick(slug) {
  const r = await fetch("https://kick.com/api/v2/channels/" + encodeURIComponent(slug),
    { headers: { "user-agent": UA, "accept": "application/json" } });
  if (!r.ok) return null;
  const j = await r.json();
  return Number(j.followers_count) || null;
}
