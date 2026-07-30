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

/* Instagram rate-limits aggressively, so upstream fetches are throttled per
   isolate: at most one every TTL seconds, the last good value fills the gaps.
   (The Cache API is a no-op on workers.dev, hence plain memory.) */
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

export default {
  async fetch(request) {
    const q = new URL(request.url).searchParams;
    const jobs = [];
    const out = {};

    if (q.get("ig"))   jobs.push(throttled("ig:" + q.get("ig"), 30, () => instagram(q.get("ig"))).then(v => { if (v) out.instagram = v; }));
    if (q.get("fb"))   jobs.push(throttled("fb:" + q.get("fb"), 60, () => facebook(q.get("fb"))).then(v => { if (v) out.facebook = v; }));
    if (q.get("kick")) jobs.push(throttled("kk:" + q.get("kick"), 10, () => kick(q.get("kick"))).then(v => { if (v) out.kick = v; }));

    await Promise.all(jobs.map(p => p.catch(() => {})));
    if (q.get("debug")) out._dbg = dbg;
    return new Response(JSON.stringify(out), { headers: HEADERS });
  }
};

/* i.instagram.com answers 200 with the exact count where www.instagram.com
   401s ("wait a few minutes") — but only with a MOBILE Safari UA */
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

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
