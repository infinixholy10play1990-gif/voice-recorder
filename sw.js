/* sw.js — يخلّي الصفحة تشتغل بلا نت بعد أول فتحة. كاش بسيط: المخزَّن أولاً والشبكة احتياط. لتحديث الصفحة: غيّر اسم CACHE. */
var CACHE = "probe-1";
var FILES = ["./", "index.html", "wavpack.js"];

self.addEventListener("install", function (event) {
  event.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then(function (hit) { return hit || fetch(event.request); })
  );
});
