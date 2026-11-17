/*
  競艇ツール用の中継(Cloudflare Workers)  版: 2026-11-17a(★★の判定とプッシュ通知を追加)
  スマホのブラウザからはボートレース公式サイトを直接読み込めない(ブラウザの安全のための制限)ため、
  この中継を通して、出走表・直前情報・オッズのページを取ってくる。

  ・取りに行けるのは www.boatrace.jp と、オリジナル展示を出している各場の公式サイトだけ(他のサイトには使えない)
  ・KEY を知っている人だけが使える
  ・同じページは15秒だけ使い回す(公式サイトに負担をかけないため)
  ・パソコンのブラウザのふりをして取る(スマホのふりをすると、中身が後から読み込まれるスマホ版に転送されてしまうため)
  ・鍵の間違いは 401、公式サイト側のエラーは 502 で返す(どちらのせいか区別できるように)
*/
const KEY = "__KYOTEI_KEY__";
const ALLOW = ["www.boatrace.jp",
  // オリジナル展示(一周・まわり足・直線)を取るための各場公式サイト。robots.txt で対象ページは禁止されていない(2026/10/25確認)
  "www.kiryu-kyotei.com", "www.boatrace-tamagawa.com", "www.boatrace-biwako.jp", "www.heiwajima.gr.jp",
  "www.boatrace-hamanako.jp", "www.boatrace-tokoname.jp", "www.boatrace-mikuni.jp", "www.boatrace-amagasaki.jp", "www.n14.jp",
  "www.boatrace-shimonoseki.jp", "www.wmb.jp", "www.boatrace-ashiya.com", "www.boatrace-karatsu.jp",
  // BOATCAST(ボートレース振興会の公式動画サービス)。全場のオリジナル展示を小さなテキストで出している(2026/11/01追加)
  "race.boatcast.jp"];
const VERSION = "2026-11-17a";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ja,en-US;q=0.7,en;q=0.3",
  "Referer": "https://www.boatrace.jp/owpc/pc/race/index",
};

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(tick(env)); },   // 1分ごとの起動(Cron トリガー)
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Expose-Headers": "X-Upstream-Status, X-Final-Url, X-Proxy-Version",
      "Cache-Control": "no-store",
      "X-Proxy-Version": VERSION,
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const u = new URL(request.url);
    if (u.searchParams.get("key") !== KEY) return new Response("bad key", { status: 401, headers: cors });
    if (u.searchParams.has("ping")) return new Response("ok " + VERSION, { headers: cors });
    { const a = await api(request, env, u, cors); if (a) return a; }   // ★★のプッシュ通知まわり(通知の宛先の登録・下ごしらえデータの受け取り・状況)
    let target;
    try { target = new URL(u.searchParams.get("url") || ""); } catch (e) { return new Response("bad url", { status: 400, headers: cors }); }
    if (target.protocol !== "https:" || !ALLOW.includes(target.hostname)) return new Response("not allowed", { status: 403, headers: cors });

    let r, body = "", lastErr = "";
    for (let i = 0; i < 3; i++) {            // 公式サイトが一時的に断ったときのために2回までやり直す(断られた結果は使い回さない)
      try {
        // 2回目以降は、ページごとに残っている「断られた」状態を避けるため、意味のない印(_=時刻)を付けて別のURLとして取る
        const t2 = new URL(target.toString());
        if (i > 0) t2.searchParams.set("_", String(Date.now()));
        const hd = target.hostname === "www.boatrace.jp" ? HEADERS : { ...HEADERS, "Referer": target.origin + "/" };
        r = await fetch(t2.toString(), { headers: hd, redirect: "follow", cf: { cacheTtlByStatus: { "200-299": 15, "300-599": 0 }, cacheEverything: true } });
        body = await r.text();
        if (r.ok) break;
      } catch (e) { lastErr = String(e); }
      await new Promise(res => setTimeout(res, 800 * (i + 1)));
    }
    const h = { ...cors, "Content-Type": "text/html; charset=utf-8" };
    if (!r) return new Response("upstream error " + lastErr, { status: 502, headers: { ...h, "X-Upstream-Status": "0" } });
    h["X-Upstream-Status"] = String(r.status);
    h["X-Final-Url"] = r.url || "";
    if (!r.ok) return new Response("upstream " + r.status, { status: 502, headers: h });
    return new Response(body, { status: 200, headers: h });
  },
};

/* ───────── ★★の判定とプッシュ通知(2026-11-17) ─────────
   パソコンの kyotei_star_live.py と同じ計算を、この中継(Cloudflare)の上で1分ごとに行う。
   ・毎朝、パソコンが「今日のレースぶんの下ごしらえデータ」を送ってくる(?digest=)。保存先は KV(名前 KV で結びつける)
   ・締切 AT 分前になったレースについて、オリジナル展示 → 直前情報 → 3連単オッズ を取り、★★が出たらプッシュ通知を送る
   ・1レースにつき、取りに行くのは1分に1回まで。直前情報やオリ展がまだなら、締切3分前まで試し直す(パソコン版と同じ) */
const AT = 10;            // 締切の何分前から判定するか
const MAX_PER_TICK = 2;   // 1回の起動で見るレースの数(取りに行く回数と計算時間を抑える)
const SUBJECT = "https://gorisan5530007.github.io/gamblekusosystem/";   // 通知の送り主の連絡先(プッシュ通知の決まりで必要。個人の情報は入れない)

const SITES = {
  1: ["https://www.kiryu-kyotei.com/modules/yosou/cyokuzen.php?day={d}&race={r}&if=1&kind=2", "half"],
  5: ["https://www.boatrace-tamagawa.com/modules/yosou/oriten.php?day={d}&race={r}&jo=05&if=1", "full"],
  11: ["https://www.boatrace-biwako.jp/modules/yosou/cyokuzen.php?day={d}&race={r}&if=1&kind=2", "full"],
  4: ["https://www.heiwajima.gr.jp/asp/kyogi/04/pc/yoso05{r2}.htm", "full"],
  6: ["https://www.boatrace-hamanako.jp/modules/yosou/group-cyokuzen.php?day={d}&race={r}&if=1&kind=2", "full"],
  8: ["https://www.boatrace-tokoname.jp/modules/yosou/group-cyokuzen.php?day={d}&race={r}&if=1&kind=2", "full"],
  10: ["https://www.boatrace-mikuni.jp/modules/yosou/group-cyokuzen.php?day={d}&race={r}&if=1&kind=2", "full"],
  13: ["https://www.boatrace-amagasaki.jp/modules/yosou/group-cyokuzen.php?day={d}&race={r}&if=1&kind=2", "full"],
  14: ["https://www.n14.jp/modules/yosou/group-cyokuzen.php?day={d}&race={r}&if=1&kind=2", "full"],
  19: ["https://www.boatrace-shimonoseki.jp/modules/yosou/group-cyokuzen.php?day={d}&race={r}&if=1&kind=2", "full"],
  20: ["https://www.wmb.jp/modules/yosou/group-cyokuzen.php?day={d}&race={r}&if=1&kind=2", "full"],
  21: ["https://www.boatrace-ashiya.com/modules/yosou/group-cyokuzen.php?day={d}&race={r}&if=1&kind=2", "full"],
  23: ["https://www.boatrace-karatsu.jp/modules/yosou/group-cyokuzen.php?day={d}&race={r}&if=1&kind=2", "full"],
};
const VEN = {1:"桐生",2:"戸田",3:"江戸川",4:"平和島",5:"多摩川",6:"浜名湖",7:"蒲郡",8:"常滑",9:"津",10:"三国",11:"びわこ",12:"住之江",13:"尼崎",14:"鳴門",15:"丸亀",16:"児島",17:"宮島",18:"徳山",19:"下関",20:"若松",21:"芦屋",22:"福岡",23:"唐津",24:"大村"};

/* ── ページの読み取り(パソコン版の HTMLParser と同じ拾い方を、正規表現で) ── */
const ENT = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", yen: "¥" };
const unent = s => s.indexOf("&") < 0 ? s : s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, k) => k[0] === "#" ? String.fromCodePoint(k[1] === "x" || k[1] === "X" ? parseInt(k.slice(2), 16) : +k.slice(1)) : (ENT[k.toLowerCase()] ?? m));
/* ページを前から順に見て、tr・td・th・br・img・a のタグと、その間の文字だけを拾う(計算時間を抑えるため、正規表現で全体をなめない) */
const WANT = { tr: 1, td: 2, th: 2, br: 3, img: 4, a: 5 };   // 2 = td と th(オッズの表だけ、どちらかを見分ける)
function scan(html, from, to, onOpen, onClose, onText) {
  let p = from;
  while (p < to) {
    const lt = html.indexOf("<", p); if (lt < 0 || lt >= to) { onText(html.slice(p, to)); break; }
    if (lt > p) onText(html.slice(p, lt));
    if (html.charCodeAt(lt + 1) === 33 && html.startsWith("<!--", lt)) { const e = html.indexOf("-->", lt + 4); p = e < 0 ? to : e + 3; continue; }   // コメント
    const close = html.charCodeAt(lt + 1) === 47; let i = lt + (close ? 2 : 1), c = html.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) { onText("<"); p = lt + 1; continue; }   // タグではない「<」
    const s0 = i; while ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)) c = html.charCodeAt(++i);
    const gt = html.indexOf(">", i); if (gt < 0) break;
    if (i - s0 <= 3) { const tag = html.slice(s0, i).toLowerCase(), w = WANT[tag]; if (w) { if (close) onClose(w); else onOpen(w, w >= 4 ? html.slice(i, gt) : tag); } }
    p = gt + 1;
  }
}
const tblRange = (html, k0, k1) => { const a = k0 < 0 ? -1 : html.lastIndexOf("<table", k0), b = k1 < 0 ? -1 : html.indexOf("</table>", k1); return [a < 0 ? 0 : a, b < 0 ? html.length : b + 8]; };

/* 各場公式サイトのオリジナル展示(kyotei_oriten.Rows + parse) */
function oriRows(html) {
  const rows = []; let cur = null, cell = null;
  const [a, b] = tblRange(html, html.indexOf("<tr"), html.lastIndexOf("</tr"));
  scan(html, a, b,
    (w) => { if (w === 1) cur = []; else if (w === 2 && cur) cell = []; else if (w === 3 && cell) cell.push(" "); },
    (w) => { if (w === 2 && cur && cell) { cur.push(unent(cell.join("")).replace(/\s+/g, "")); cell = null; } else if (w === 1 && cur) { if (cur.length) rows.push(cur); cur = null; } },
    (t) => { if (cell) cell.push(t); });
  return rows;
}
const num = s => { if (s == null) return null; const t = String(s).trim(); if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null; return parseFloat(t); };
function parseOri(html, kind) {
  const [lo, hi] = kind === "half" ? [15, 22] : [33, 45];
  const inr = (v, a, b) => v !== null && a <= v && v <= b, dash = x => x === "-" || x === "－" || x === "";
  const out = {};
  for (const c of oriRows(html)) {
    if (!c.length || !/^[1-6]$/.test(c[0])) continue;
    const lane = +c[0]; if (out[lane]) continue;
    let m = /(?:[AB][12])?(\d{4})/.exec(c.length > 1 ? c[1] : ""); if (!m && c.length > 2) m = /(?:[AB][12])?(\d{4})/.exec(c[2]);
    const toban = m ? m[1] : null;
    for (let i = 2; i < c.length - 2; i++) {
      const a = num(c[i]), b = num(c[i + 1]), d = num(c[i + 2]);
      if (!((inr(a, lo, hi) || dash(c[i])) && (inr(b, 3, 9) || dash(c[i + 1])) && (inr(d, 5, 10) || dash(c[i + 2])))) continue;
      if ([a, b, d].filter(v => v !== null).length < 2) continue;
      const pre = num(c[i - 1]), post = i + 3 < c.length ? num(c[i + 3]) : null;
      const ex = inr(pre, 6.2, 7.6) ? pre : (inr(post, 6.2, 7.6) ? post : null);
      if (ex === null) continue;
      out[lane] = [toban, ex, a, b, d]; break;
    }
    if (out[lane]) continue;
    for (let i = 2; i < c.length - 2; i++) {
      const ex = num(c[i]), a = num(c[i + 1]), b = num(c[i + 2]);
      if (inr(ex, 6.2, 7.6) && inr(a, lo, hi) && (inr(b, 3, 15) || dash(c[i + 2]))) { out[lane] = [toban, ex, a, b, null]; break; }
    }
  }
  return out;
}

/* 直前情報(kyotei_before._Doc + parse_before のうち、判定に使う 展示タイム・スタート展示 だけ) */
function parseBefore(html) {
  const rows = []; let cur = [], buf = [], incell = false;
  const [a, b] = tblRange(html, html.indexOf("toban="), html.lastIndexOf("img_boat2_"));   // 選手の表からスタート展示の表まで
  scan(html, a, b,
    (w, at) => { if (w === 2) { incell = true; buf = []; } else if (w === 1) cur = [];
      else if (w === 4 && incell) { const s = /src\s*=\s*["']?[^"'>]*img_boat2_(\d)\.png/.exec(at); if (s) buf.push(`[boat:${s[1]}]`); }
      else if (w === 5 && incell) { const s = /href\s*=\s*["']?[^"'>]*toban=(\d{4})/.exec(at); if (s) buf.push(`[toban:${s[1]}]`); } },
    (w) => { if (w === 2 && incell) { cur.push(unent(buf.join("")).split(/\s+/).filter(Boolean).join(" ")); incell = false; } else if (w === 1) { if (cur.length) rows.push(cur); cur = []; } },
    (t) => { if (incell) buf.push(t); });
  const boats = {}, order = [];
  for (const cells of rows) {
    const joined = cells.join("\t");
    const t = /\[toban:(\d{4})\]/.exec(joined);
    if (t && cells.length && /^[1-6]$/.test(cells[0].trim())) {
      const lane = +cells[0].trim(), rest = cells.slice(1);
      const nums = rest.filter(x => /^-?\d\.\d\d?$/.test(x)).map(parseFloat);
      const exh = nums.find(x => 5.5 <= x && x <= 8.5);
      boats[lane] = { toban: t[1], exh: exh === undefined ? null : exh, ex_course: null, ex_st: null };
      continue;
    }
    const b = /\[boat:(\d)\]/.exec(joined);
    if (b) {
      let st = null; const ms = /(F?\s*\.\d{2}|L)/.exec(joined.replace(`[boat:${b[1]}]`, ""));
      if (ms) { const s = ms[1].replace(/ /g, ""); st = s === "L" ? 1.0 : s[0] === "F" ? -parseFloat("0" + s.slice(1)) : parseFloat("0" + s); }
      order.push([+b[1], st]);
    }
  }
  order.slice(0, 6).forEach(([bn, st], i) => { if (boats[bn]) { boats[bn].ex_course = i + 1; boats[bn].ex_st = st; } });
  return boats;
}

/* 3連単オッズ(kyotei_odds_watch.fetch_odds3t) */
function parseOdds(html) {
  const k = html.indexOf("oddsPoint"); if (k < 0) return null;
  const a = html.lastIndexOf("<table", k), b = html.indexOf("</table>", k); if (a < 0 || b < 0) return null;
  const trs = []; let cur = null, cell = null;
  scan(html, a, b,
    (w, tag) => { if (w === 1) { cur = []; trs.push(cur); cell = null; } else if (w === 2 && cur) { cell = { tag, t: "" }; cur.push(cell); } },
    (w) => { if (w === 2) cell = null; },
    (t) => { if (cell) cell.t += t; });
  for (const tr of trs) for (const c of tr) c.t = unent(c.t);
  if (!trs.length) return null;
  const head1 = trs[0].map(c => c.t.trim()).filter(t => /^[1-6]$/.test(t)); if (head1.length !== 6) return null;
  const cur2 = [null, null, null, null, null, null], odds = {};
  for (const tr of trs.slice(1)) {
    const cells = tr.filter(c => c.tag === "td"), n = cells.length, per = n === 18 ? 3 : n === 12 ? 2 : 0; if (!per) continue;
    for (let g = 0; g < 6; g++) {
      const ch = cells.slice(g * per, (g + 1) * per); let b2, b3, ov;
      if (per === 3) { b2 = ch[0].t.trim(); b3 = ch[1].t.trim(); ov = ch[2].t.trim(); cur2[g] = b2; } else { b3 = ch[0].t.trim(); ov = ch[1].t.trim(); b2 = cur2[g]; }
      if (b2 === null || !/^[1-6]$/.test(b2) || !/^[1-6]$/.test(b3)) continue;
      const v = num(ov.replace(/,/g, "")); if (v === null) continue;
      odds[`${head1[g]}-${b2}-${b3}`] = v;
    }
  }
  return Object.keys(odds).length >= 100 ? odds : null;
}

/* ── 判定(kyotei_star_live.judge)。M=その日の係数、x=そのレースの下ごしらえデータ ── */
function judge(M, x, odds, boats, ori) {
  const feats = M.feats, VSD = M.VSD[String(x.v)];
  if (!VSD || Object.keys(ori).length < 6 || Object.values(ori).filter(t => t[0] !== null).length < 6) return [null, "オリ展が6艇そろわない"];
  for (const l in boats) if (boats[l].exh === null || boats[l].exh === undefined) return [null, "直前情報がまだ出ていない"];
  const O = {}; for (const l in ori) { const t = ori[l]; O[l] = [t[0], t[1], t[2], t[3] !== null && t[3] !== undefined ? t[3] : ((boats[l] || {}).exh ?? null)]; }
  const ms = []; for (let j = 0; j < 4; j++) { const xs = Object.values(O).map(t => t[j]).filter(v => v !== null && v !== undefined); ms.push(xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null); }
  const z = (l, j) => (O[l] && O[l][j] !== null && O[l][j] !== undefined && ms[j] !== null && VSD[j]) ? (O[l][j] - ms[j]) / VSD[j] : null;
  const g = x.e.map(b => {
    const l = b.lane, bo = boats[l] || {}, exst = bo.ex_st;
    const f = { ...b.f, exst_vs_usual: (exst !== null && exst !== undefined && b.pu !== null && b.pu !== undefined) ? exst - b.pu : null, lap_z: z(l, 0), turn_z: z(l, 1), straight_z: z(l, 2), exhibition_z: z(l, 3) };
    let s = 0; feats.forEach((k, j) => { const v = f[k]; if (v !== null && v !== undefined) s += M.th[1 + j] * ((v - M.mu[j]) / M.sd[j]); });
    return Math.exp(s);
  });
  const inv = {}; let TI = 0; for (const c in odds) { inv[c] = 1 / odds[c]; TI += inv[c]; }
  const q = {}; let Q = 0; const [L2, L3] = M.L;
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) for (let m = 0; m < 6; m++) { if (i === j || j === m || i === m) continue; const c = `${i + 1}-${j + 1}-${m + 1}`; if (c in inv) { q[c] = inv[c] / TI * g[i] * Math.pow(g[j], L2) * Math.pow(g[m], L3); Q += q[c]; } }
  /* 強さ指数(オッズを使わない予想)。進入はスタート展示の並び(取れなければ枠なり) */
  let st = null;
  if (x.e.every(b => Array.isArray(b.rs))) { const sc = x.e.map(b => b.rs[((boats[b.lane] || {}).ex_course || b.lane) - 1]); const mx = Math.max(...sc); st = sc.map(s => Math.exp(s - mx)); }
  const tri = c => { const [i, j, m] = c.split("-").map(n => +n - 1), [a, b] = M.PL; let t1 = 0, t2 = 0, t3 = 0; st.forEach((v, k) => { t1 += v; if (k !== i) t2 += Math.pow(v, a); if (k !== i && k !== j) t3 += Math.pow(v, b); }); return (st[i] / t1) * (Math.pow(st[j], a) / t2) * (Math.pow(st[m], b) / t3); };
  const out = [];
  for (const c in q) { const pr = q[c] / Q, o = odds[c], ev = pr * o; if (ev >= 0.9 && 5 <= o && o < 20) { const rr = st ? tri(c) / (inv[c] / TI) : 0; out.push({ c, o, ev, pr, rr, k: rr >= (M.agree ?? 0.8) ? "★★" : "★" }); } }
  out.sort((a, b) => b.ev - a.ev);
  return [out, ""];
}

/* ── プッシュ通知(Web Push: 暗号化 RFC 8291 / 送り主の署名 RFC 8292) ── */
const enc = new TextEncoder();
const b64u = buf => { let s = ""; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const ub64 = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); const b = atob(s + "===".slice((s.length + 3) % 4)); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; };
const cat = (...xs) => { const n = xs.reduce((a, x) => a + x.length, 0), o = new Uint8Array(n); let p = 0; for (const x of xs) { o.set(x, p); p += x.length; } return o; };
async function hkdf(salt, ikm, info, len) { const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]); return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8)); }
async function vapidKeys(KV) {
  let v = await KV.get("vapid", "json");
  if (!v) { const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    v = { jwk: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)) }; await KV.put("vapid", JSON.stringify(v)); }
  return v;
}
async function encryptPush(sub, payload) {
  const uaPub = ub64(sub.keys.p256dh), auth = ub64(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ss = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, ss, cat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16), nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(enc.encode(payload), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, ct);   // 見出し(salt・レコード長4096・送り主の公開鍵) + 本文
}
async function vapidJwt(v, aud) {
  const key = await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" }))), body = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body));
  return head + "." + body + "." + b64u(sig);
}
async function sendPush(KV, title, body, tag) {
  const subs = (await KV.get("subs", "json")) || []; if (!subs.length) return { sent: 0, n: 0 };
  const v = await vapidKeys(KV), payload = JSON.stringify({ title, body, tag }), dead = []; let sent = 0; const errs = [];
  for (const s of subs) {
    try {
      const jwt = await vapidJwt(v, new URL(s.endpoint).origin);
      const r = await fetch(s.endpoint, { method: "POST", headers: { "Authorization": `vapid t=${jwt}, k=${v.pub}`, "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "TTL": "600", "Urgency": "high" }, body: await encryptPush(s, payload) });
      if (r.status === 404 || r.status === 410) dead.push(s.endpoint); else if (r.ok) sent++; else errs.push(r.status);
    } catch (e) { errs.push(String(e).slice(0, 60)); }
  }
  if (dead.length) await KV.put("subs", JSON.stringify(subs.filter(s => !dead.includes(s.endpoint))));   // もう届かない宛先は消す
  return { sent, n: subs.length, errs };
}

/* ── 取りに行く ── */
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "ja,en-US;q=0.7,en;q=0.3" };
async function getText(url, referer) {
  const r = await fetch(url, { headers: { ...UA, "Referer": referer }, redirect: "follow", cf: { cacheTtlByStatus: { "200-299": 15, "300-599": 0 }, cacheEverything: true } });
  if (!r.ok) throw new Error("取得 " + r.status);
  const buf = await r.arrayBuffer(), ct = r.headers.get("Content-Type") || "";
  let m = /charset=([\w-]+)/i.exec(ct); if (!m) m = /charset=["']?([\w-]+)/i.exec(new TextDecoder("latin1").decode(buf.slice(0, 3000)));
  try { return new TextDecoder(m ? m[1] : "utf-8").decode(buf); } catch (e) { return new TextDecoder("utf-8").decode(buf); }
}
const jst = () => { const d = new Date(Date.now() + 9 * 3600e3); return { ymd: d.toISOString().slice(0, 10).replace(/-/g, ""), min: d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60, hm: d.toISOString().slice(11, 16) }; };

async function runOne(M, x, ymd) {
  const nm = `${VEN[x.v] || x.v}${x.r}R`, r2 = String(x.r).padStart(2, "0"), jcd = String(x.v).padStart(2, "0");
  try {
    const site = SITES[x.v]; if (!site) return ["done", `${nm}: この場はオリ展なし`, null];
    const rows = parseOri(await getText(site[0].replace("{d}", ymd).replace("{r}", x.r).replace("{r2}", r2), new URL(site[0]).origin + "/"), site[1]);
    const tb = {}; x.e.forEach(b => tb[b.lane] = String(b.toban));
    const ls = Object.keys(rows);
    const ori = (ls.filter(l => rows[l][0] && tb[l] === rows[l][0]).length < Math.min(4, ls.length)) ? {} : Object.fromEntries(ls.map(l => [l, [rows[l][2], rows[l][3], rows[l][4], rows[l][1]]]));
    if (Object.values(ori).filter(t => t[0] !== null).length < 6) return ["retry", `${nm}: オリ展がまだ出ていない`, null];
    const ref = "https://www.boatrace.jp/owpc/pc/race/index";
    const boats = parseBefore(await getText(`https://www.boatrace.jp/owpc/pc/race/beforeinfo?rno=${x.r}&jcd=${jcd}&hd=${ymd}`, ref));
    const odds = parseOdds(await getText(`https://www.boatrace.jp/owpc/pc/race/odds3t?rno=${x.r}&jcd=${jcd}&hd=${ymd}`, ref));
    if (!odds) return ["retry", `${nm}: オッズを取れなかった`, null];
    const [res, why] = judge(M, x, odds, boats, ori);
    if (res === null) return ["retry", `${nm}: ${why}`, null];
    const s2 = res.filter(t => t.k === "★★");
    return ["done", `${nm}: ★★${s2.length}点` + (s2.length ? " " + s2.map(t => `${t.c}(${t.o.toFixed(1)}倍)`).join(" / ") : "") + `(★${res.length - s2.length}点)`, res];
  } catch (e) { return ["retry", `${nm}: エラー ${String(e.message || e).slice(0, 80)}`, null]; }
}

/* ── 1分ごとの仕事 ── */
let G = { ymd: "", idx: null, ven: {}, tries: {}, last: {} };   // 同じ起動の間だけ覚えておくもの(消えても、取り直すだけ)
async function tick(env) {
  const KV = env.KV; if (!KV) return "KVが結びついていません";
  const now = jst();
  if (G.ymd !== now.ymd || !G.idx) { G = { ymd: now.ymd, idx: await KV.get(`d:${now.ymd}:idx`, "json"), ven: {}, tries: {}, last: {} }; }
  const idx = G.idx; if (!idx) return "今日の下ごしらえデータがまだ届いていません";
  const due = idx.races.filter(([v, r, dl]) => dl - now.min <= AT && dl > now.min - 1); if (!due.length) return "待機中";
  const st = (await KV.get(`st:${now.ymd}`, "json")) || { done: {}, log: [], picks: [] };
  let changed = false, n = 0; const notes = [];
  /* まだ試していないレースを先に、次に締切の近い順(1回の起動で見る数に上限があるため、同じレースばかりにならないように) */
  const tr = ([v, r]) => G.tries[`${v}-${r}`] || 0;
  for (const [v, r, dl] of due.sort((a, b) => (tr(a) - tr(b)) || (a[2] - b[2]))) {
    const k = `${v}-${r}`; if (st.done[k]) continue;
    const dlS = `${String(Math.floor(dl / 60)).padStart(2, "0")}:${String(dl % 60).padStart(2, "0")}`;
    if (now.min > dl - 0.5) { st.done[k] = 1; st.log.push(`${VEN[v]}${r}R: 締切までに判定できなかった`); changed = true; continue; }
    if (Date.now() - (G.last[k] || 0) < 55000) continue;   // 同じレースを試し直すのは1分おき
    if (n >= MAX_PER_TICK) break; n++;
    G.last[k] = Date.now();
    if (!G.ven[v]) G.ven[v] = await KV.get(`d:${now.ymd}:${v}`, "json");
    const x = (G.ven[v] || []).find(q => q.r === r); if (!x) { st.done[k] = 1; changed = true; continue; }
    const [s, msg, res] = await runOne(idx.M, x, now.ymd);
    G.tries[k] = (G.tries[k] || 0) + 1;
    if (s === "done" || G.tries[k] >= 8 || dl - now.min < 3) {
      st.done[k] = 1; changed = true; st.log.push(`${now.hm} ${msg}`); st.log = st.log.slice(-200);
      if (res) for (const t of res) st.picks.push([now.hm, v, r, dlS, t.c, t.o, +t.ev.toFixed(3), +t.pr.toFixed(4), +t.rr.toFixed(3), t.k]);
      const s2 = (res || []).filter(t => t.k === "★★");
      if (s2.length) notes.push([`★★ ${VEN[v]} ${r}R(締切${dlS})`, s2.map(t => `${t.c}(${t.o.toFixed(1)}倍・期待値${t.ev.toFixed(2)})`).join(" / ") + " ※買う前にオッズを確かめてください", k]);
    }
  }
  if (changed) await KV.put(`st:${now.ymd}`, JSON.stringify(st), { expirationTtl: 3 * 86400 });   // 先に「済み」を残してから通知する(二重に送らないため)
  for (const [t, b, k] of notes) await sendPush(KV, t, b, k);
  return `見たレース ${n}`;
}

/* ── サイト・パソコンからの呼び出し(鍵の確認は呼び出し元で済んでいる) ── */
async function api(request, env, u, cors) {
  const KV = env.KV, J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
  const q = u.searchParams;
  if (!["vapid", "sub", "unsub", "pushtest", "digest", "status", "run", "tick"].some(k => q.has(k))) return null;   // ページの中継(これまでの使い方)はそのまま通す
  if (!KV) return J({ error: "KVが結びついていません(中継の設定で、KVの名前を KV にして結びつけてください)" }, 500);
  if (q.has("vapid")) return J({ pub: (await vapidKeys(KV)).pub });
  if (q.has("sub")) { const s = (await request.json()).sub; if (!s || !/^https:\/\//.test(s.endpoint || "") || !s.keys || !s.keys.p256dh || !s.keys.auth) return J({ error: "宛先の形が違います" }, 400);
    const subs = ((await KV.get("subs", "json")) || []).filter(x => x.endpoint !== s.endpoint); subs.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });
    await KV.put("subs", JSON.stringify(subs.slice(-10))); return J({ ok: true, n: Math.min(10, subs.length) }); }
  if (q.has("unsub")) { const ep = (await request.json()).endpoint; const subs = ((await KV.get("subs", "json")) || []).filter(x => x.endpoint !== ep); await KV.put("subs", JSON.stringify(subs)); return J({ ok: true, n: subs.length }); }
  if (q.has("pushtest")) return J(await sendPush(KV, "通知のテスト", "これが届けば、★★のプッシュ通知は大丈夫です", "test"));
  if (q.has("digest")) { const ymd = q.get("digest"), part = q.get("part"); if (!/^\d{8}$/.test(ymd) || !/^(idx|\d{1,2})$/.test(part || "")) return J({ error: "指定が違います" }, 400);
    const body = await request.text(); JSON.parse(body); await KV.put(`d:${ymd}:${part}`, body, { expirationTtl: 3 * 86400 }); if (G.ymd === ymd) G.idx = null; return J({ ok: true, bytes: body.length }); }
  if (q.has("status")) { const now = jst(), idx = await KV.get(`d:${now.ymd}:idx`, "json"), st = (await KV.get(`st:${now.ymd}`, "json")) || { done: {}, log: [], picks: [] };
    return J({ ymd: now.ymd, now: now.hm, races: idx ? idx.races.length : 0, asof: idx ? idx.M.asof : null, done: Object.keys(st.done).length, log: st.log.slice(-30), picks: st.picks, subs: ((await KV.get("subs", "json")) || []).length, at: AT }); }
  if (q.has("run")) { const now = jst(), [v, r] = q.get("run").split("-").map(Number), idx = await KV.get(`d:${now.ymd}:idx`, "json"); if (!idx) return J({ error: "今日の下ごしらえデータがありません" }, 404);
    const x = ((await KV.get(`d:${now.ymd}:${v}`, "json")) || []).find(t => t.r === r); if (!x) return J({ error: "そのレースはありません" }, 404);
    const [s, msg, res] = await runOne(idx.M, x, now.ymd); return J({ s, msg, res }); }   // その場で1レース判定してみる(通知は送らない)
  if (q.has("tick")) return J({ r: await tick(env) });
  return null;
}
