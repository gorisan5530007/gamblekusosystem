/* 競艇デスクのプッシュ通知の受け口(2026-11-17)。中継から届いた通知を表示し、押されたらデスクを開く。ページの中身は何も保存しない */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: "競艇デスク", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "競艇デスク", { body: d.body || "", tag: d.tag || undefined, icon: "icon-192.png", badge: "icon-192.png", data: { url: "kyotei-analysis-desk.html" } }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "kyotei-analysis-desk.html", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => { for (const c of cs) if (c.url.split("#")[0].split("?")[0] === url && "focus" in c) return c.focus(); return self.clients.openWindow(url); }));
});
