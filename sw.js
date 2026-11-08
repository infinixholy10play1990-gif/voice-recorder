/* sw.js — يخلّي الصفحة تشتغل بلا نت بعد أول فتحة. الشبكة أولاً (التحديثات بتوصل فوراً) والكاش احتياط بلا نت. */
var CACHE = "probe-3";
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
    fetch(event.request).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(event.request, copy); });
      return res;
    }).catch(function () { return caches.match(event.request); })
  );
});
