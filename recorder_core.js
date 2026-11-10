/*
 * recorder_core.js — المنطق النقي لصفحة التسجيل الكاملة (بلا واجهة، بلا مايك): قراءة ملف الكلام، مدة السكتة، كاشف الوقف
 * التلقائي، تقطيع العيّنات، وكتابة ملف ZIP. كل جزء منه مفحوص بمقارنة مع تنفيذ مرجعي مستقل على نفس المدخلات
 * (بمتصفّح حقيقي، خارج هالملف).
 *
 * ⚠️ ثوابت الكاشف (150 هرتز، +8 ديسيبل فوق أرضية الغرفة، 5 مقاطع بداية كلام، مئين 10 للأرضية، سكتة 1.2 و2.5 ث، إبقاء 0.8 ث)
 * مقيسة على مايك لابتوب بمعدّل 44100. الصفحة بتشغّل نفس الأرقام بمعدّل الجوال الأصلي (غالباً 48000)، وصحتها على
 * تسجيلات جوال حقيقية بتنقاس بشكل منفصل، مو مفترضة.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RecorderCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------- ثوابت (نفس قيم الأصل)
  var REFERENCE_RATE = 44100;            // معدّل القياس الأصلي
  var REFERENCE_CHUNK = 1024;            // مقطع الكاشف الأصلي: 23.2 مللي ث
  var COUNTDOWN_SECONDS = 3;
  var MAX_DURATION_SECONDS = 120;        // سقف أمان — نفس الأصل
  var ENTER_CLICK_TRIM_CHUNKS = 2;       // قصّ نقرة الضغط عند الوقف اليدوي — نفس الأصل
  var SILENCE_SIMPLE_SECONDS = 1.2;
  var SILENCE_COMPOUND_SECONDS = 2.5;
  var DETECT_HIGHPASS_HZ = 150.0;
  var DETECT_ABOVE_FLOOR_DB = 8.0;       // قيمة مايك اللابتوب (المرجع) — الفحوص بتقارن عليه
  // ⚠️ الجوال 🧪: +8 على مايك الجوال الخام (أرضية ≈ −72 dBFS، ونَفَس وهمسات الغرفة بتطلع فوقها) خلّى الوقف يتأخر أو ما يصير
  // بـ13 من 16 (8 تسجيلات جوال حقيقية × سكتتين، 2026-11-10). المسح: +16 ⟵ 2 متأخر؛ +18 لـ+26 ⟵
  // 15 سليم وصفر قطع؛ +28 ⟵ أول قطع (ضيّع 0.53 ث). اختيار 18 = أصغر قيمة بلا تأخير، وبعيدة 10 dB عن أول قطع (الضرر الحقيقي هو القطع،
  // التأخير بس سكوت زيادة بآخر المقطع). ⚠️ مقيس على 8 تسجيلات بس — بينعاد بأول جلسة حقيقية.
  var PHONE_DETECT_ABOVE_FLOOR_DB = 18.0;
  var COUNTDOWN_FLOOR_PERCENTILE = 10;
  var SPEECH_START_CHUNKS = 5;
  var REARM_CHUNKS = 1;
  var SILENCE_TAIL_KEEP_SECONDS = 0.8;
  var COMPOUND_MARKS = /[.:؟?!…؛]/;
  var EDGE_MARKS = " .…:؟?!؛،,";
  var CUE_LINE = /^\s*([A-Za-z][A-Za-z0-9_.]*)\s*\|\s*(.*)$/;

  // ---------------------------------------------------------------- ملف الكلام
  /** سطر غير فاضٍ = جملة، واسم نقطة اختياري `p01.axis | الجملة`. فشل صريح لملف فاضٍ أو مخلوط أو بأسماء مكرَّرة. */
  function parseScript(text) {
    // رموز تحكّم غير مرئية: بايثون (strip) وجافاسكربت (trim) بيختلفوا بقصّها (‎\x1c-\x1f و\x85 و BOM)، فالنص كان رح يطلع
    // مختلف بين الجوال واللابتوب. رفض صريح بدل فرق صامت بيترفض بالاستيراد بعد ما تنسجّل الجلسة كلها.
    var bad = /[\x00-\x08\x0e-\x1f\x7f-\x9f﻿]/.exec(String(text));
    if (bad) {
      throw new Error("ملف الكلام فيه رمز تحكّم غير مرئي (U+" + bad[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0") +
                      ") — احفظه من جديد UTF-8 بلا BOM");
    }
    var lines = String(text).split(/\r\n|\n|\r/).map(function (l) { return l.trim(); }).filter(function (l) { return l; });
    if (!lines.length) throw new Error("ملف الكلام فاضٍ أو بلا أي سطر غير فارغ");
    var parsed = lines.map(function (line) {
      var m = CUE_LINE.exec(line);
      if (m) {
        var t = m[2].trim();
        if (!t) throw new Error("سطر مسمّى بلا جملة: «" + m[1] + "»");
        return { name: m[1], text: t };
      }
      return { name: null, text: line };
    });
    var named = parsed.filter(function (p) { return p.name !== null; });
    if (named.length && named.length !== parsed.length) {
      var firstUnnamed = parsed.filter(function (p) { return p.name === null; })[0].text;
      throw new Error("ملف الكلام مخلوط: " + named.length + " سطر مسمّى و" + (parsed.length - named.length) +
                      " بلا اسم (أولها «" + firstUnnamed + "») — إما كل الأسطر مسمّاة أو ولا واحد");
    }
    var seen = {};
    named.forEach(function (p) {
      if (seen[p.name]) throw new Error("أسماء نقاط مكرَّرة بالملف: " + p.name);
      seen[p.name] = true;
    });
    return parsed.map(function (p, i) { return { index: i + 1, name: p.name, text: p.text }; });
  }

  /** مدة السكتة المطلوبة لنص: مركّبة (علامة فاصلة جوّا النص) أو بسيطة. */
  function silenceSecondsForText(text) {
    var body = String(text).trim();
    var a = 0, b = body.length;
    while (a < b && EDGE_MARKS.indexOf(body.charAt(a)) >= 0) a++;
    while (b > a && EDGE_MARKS.indexOf(body.charAt(b - 1)) >= 0) b--;
    return COMPOUND_MARKS.test(body.slice(a, b)) ? SILENCE_COMPOUND_SECONDS : SILENCE_SIMPLE_SECONDS;
  }

  // ---------------------------------------------------------------- مستوى المقطع
  function chunkSizeFor(rate) {
    return Math.round(REFERENCE_CHUNK / REFERENCE_RATE * rate);
  }

  var windowCache = {};
  /** نافذة هان (نفس np.hanning)، ومعاملات الترشيح فوق 150 هرتز لحجم مقطع ومعدّل معيّنين. */
  function levelSetup(n, rate) {
    var key = n + "@" + rate;
    if (windowCache[key]) return windowCache[key];
    var hann = new Float64Array(n);
    var sumSq = 0;
    for (var i = 0; i < n; i++) {
      hann[i] = n > 1 ? 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) : 1;
      sumSq += hann[i] * hann[i];
    }
    // نفس np.fft.rfftfreq(n, 1/rate): k * (1 / (n * d))
    var d = 1.0 / rate, val = 1.0 / (n * d);
    var kmin = 0;
    while (kmin * val < DETECT_HIGHPASS_HZ) kmin++;
    var cosT = [], sinT = [];                                    // جداول لأول kmin حزمة (الحزم المحذوفة تحت 150 هرتز)
    for (var k = 0; k < kmin; k++) {
      var c = new Float64Array(n), s = new Float64Array(n);
      for (var j = 0; j < n; j++) { var ang = 2 * Math.PI * ((k * j) % n) / n; c[j] = Math.cos(ang); s[j] = Math.sin(ang); }
      cosT.push(c); sinT.push(s);
    }
    var setup = { n: n, hann: hann, norm: 2.0 / (n * sumSq), kmin: kmin, cosT: cosT, sinT: sinT };
    windowCache[key] = setup;
    return setup;
  }

  /**
   * مستوى مقطع (n عيّنة بوحدات int16) فوق 150 هرتز بالـdB.
   * بدل FFT بحجم عشوائي: مجموع الطاقة أحادي الجانب = (n·Σ(xw)² + |X0|² + [n زوجي]|X(n/2)|²)/2 (بارسيفال)، ومنه بنطرح طاقة
   * الحزم تحت 150 هرتز (عددها 3–4) محسوبة مباشرة — نفس الرقم تماماً بلا مكتبة FFT. مفحوص مقابل numpy.
   */
  function chunkLevelDb(samples, rate) {
    var n = samples.length;
    var st = levelSetup(n, rate);
    var xw = new Float64Array(n);
    var energy = 0, alt = 0;
    for (var i = 0; i < n; i++) {
      var v = samples[i] * st.hann[i];
      xw[i] = v; energy += v * v;
      alt += (i % 2 === 0 ? v : -v);
    }
    var x0 = 0;
    for (var i2 = 0; i2 < n; i2++) x0 += xw[i2];
    var oneSided = (n * energy + x0 * x0 + (n % 2 === 0 ? alt * alt : 0)) / 2;
    var low = 0;
    for (var k = 0; k < st.kmin; k++) {
      var re = 0, im = 0, c = st.cosT[k], s = st.sinT[k];
      for (var j = 0; j < n; j++) { re += xw[j] * c[j]; im -= xw[j] * s[j]; }
      low += re * re + im * im;
    }
    var power = (oneSided - low) * st.norm;
    if (power < 0) power = 0;                                    // ضجيج حسابي عند الصمت الرقمي
    return 10.0 * Math.log10(power + 1e-9);
  }

  /** np.percentile (استيفاء خطي). */
  function percentile(values, q) {
    var v = values.slice().sort(function (a, b) { return a - b; });
    var pos = (q / 100) * (v.length - 1);
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    return v[lo] + (v[hi] - v[lo]) * (pos - lo);
  }

  /** أرضية الغرفة من مقاطع العدّ التنازلي: فشل صريح لصفر مقاطع، ولمايك مكتوم (صفر مطلق بكل العدّ). */
  function countdownFloorDb(chunks, rate) {
    if (!chunks.length) throw new Error("الوقف التلقائي بدّه عدّ تنازلي يقيس فيه أرضية الغرفة — وصل صفر مقاطع");
    var allZero = chunks.every(function (c) {
      for (var i = 0; i < c.length; i++) if (c[i] !== 0) return false;
      return true;
    });
    if (allZero) {
      var e = new Error("المايك ما عم يلتقط شي (صفر مطلق بكل العدّ التنازلي) — تأكّد إنو مو مكتوم وإنو هو المايك الصح");
      e.name = "MicrophoneSilent"; throw e;
    }
    return percentile(chunks.map(function (c) { return chunkLevelDb(c, rate); }), COUNTDOWN_FLOOR_PERCENTILE);
  }

  // ---------------------------------------------------------------- الكاشف
  /** كاشف السكتة بعد الكلام: feed(مستوى مقطع) ⟵ true لحظة ما تكمل السكتة بعد الكلام. */
  function SilenceDetector(floorDb, silenceSeconds, chunkSeconds, rearmChunks, aboveFloorDb) {
    if (!(silenceSeconds > 0)) throw new Error("SilenceDetector: مدة السكتة لازم تكون موجبة، وصل " + silenceSeconds);
    this.thresholdDb = floorDb + (aboveFloorDb === undefined ? DETECT_ABOVE_FLOOR_DB : aboveFloorDb);
    this.silenceChunks = Math.ceil(silenceSeconds / chunkSeconds - 1e-9);
    this.rearmChunks = rearmChunks === undefined ? REARM_CHUNKS : rearmChunks;
    this.started = false;
    this.chunksSeen = 0;
    this.lastSpeechChunk = null;           // فهرس (من 1) لآخر مقطع انعدّ كلام
    this._above = 0;
    this._silent = 0;
  }
  SilenceDetector.prototype.feed = function (levelDb) {
    this.chunksSeen++;
    if (levelDb > this.thresholdDb) {
      this._above++;
      if (this._above >= SPEECH_START_CHUNKS) this.started = true;
      if (this._above >= this.rearmChunks) {
        this._silent = 0;
        this.lastSpeechChunk = this.chunksSeen;
        return false;
      }
    } else {
      this._above = 0;
    }
    if (!this.started) return false;
    this._silent++;
    return this._silent >= this.silenceChunks;
  };

  /** عدد المقاطع المحتفظ فيها بعد آخر كلام (`SILENCE_TAIL_KEEP_CHUNKS`). */
  function tailKeepChunks(chunkSeconds) {
    return Math.ceil(SILENCE_TAIL_KEEP_SECONDS / chunkSeconds - 1e-9);
  }

  /** `trim_trailing_silence`: عدد العيّنات المحتفظ فيها بعد وقف بالسكتة. */
  function trimmedSampleCountAfterSilence(lastSpeechChunk, chunkSize, rate) {
    if (lastSpeechChunk === null || lastSpeechChunk === undefined) {
      throw new Error("trim: ما في آخر كلام معروف — الوقف بالسكتة بيفترض كلام انحكى");
    }
    return (lastSpeechChunk + tailKeepChunks(chunkSize / rate)) * chunkSize;
  }

  /** `_trim_enter_click`: عدد العيّنات بعد الوقف اليدوي (نقرة الضغط). */
  function trimmedSampleCountAfterManualStop(totalChunks, chunkSize) {
    return Math.max(0, totalChunks - ENTER_CLICK_TRIM_CHUNKS) * chunkSize;
  }

  /** يجمّع كتل عيّنات (float32 بأي حجم) ويطلّع مقاطع int16 بحجم ثابت. مصدر التقريب الوحيد: floatToInt16 (نفس ملف الحفظ). */
  function Chunker(chunkSize, toInt16) {
    this.size = chunkSize;
    this.toInt16 = toInt16;
    this.buf = new Int16Array(chunkSize);
    this.n = 0;
  }
  Chunker.prototype.push = function (floatBlock) {
    var ints = this.toInt16(floatBlock), out = [], p = 0;
    while (p < ints.length) {
      var take = Math.min(this.size - this.n, ints.length - p);
      this.buf.set(ints.subarray(p, p + take), this.n);
      this.n += take; p += take;
      if (this.n === this.size) { out.push(this.buf.slice(0)); this.n = 0; }
    }
    return out;
  };

  // ---------------------------------------------------------------- محرك المحاولة الواحدة
  /**
   * محاولة تسجيل وحدة بلا عتاد: بيستقبل كتل عيّنات (float32 من المايك، بأي حجم) ويدير العدّ التنازلي
   * (أرضية الغرفة) ثم التسجيل ثم قرار الوقف. الصفحة والاختبارات بيستعملوا نفس الصنف بالضبط.
   * toInt16: دالة التحويل المعتمدة للحفظ (WavPack.floatToInt16) حتى يكون الكاشف شايف نفس الأرقام يلي بتنكتب.
   */
  function ClipEngine(rate, silenceSeconds, toInt16, options) {
    options = options || {};
    this.rate = rate;
    this.silenceSeconds = silenceSeconds;                       // null ⟵ بلا وقف تلقائي (وقف يدوي بس)
    this.chunkSize = chunkSizeFor(rate);
    this.chunkSeconds = this.chunkSize / rate;
    this.countdownChunks = Math.round((options.countdownSeconds === undefined ? COUNTDOWN_SECONDS : options.countdownSeconds) / this.chunkSeconds);
    this.maxChunks = Math.floor(rate / this.chunkSize * (options.maxDuration || MAX_DURATION_SECONDS));
    this.aboveFloorDb = options.aboveFloorDb === undefined ? DETECT_ABOVE_FLOOR_DB : options.aboveFloorDb;
    if (silenceSeconds !== null && this.countdownChunks <= 0) throw new Error("الوقف التلقائي بدّه عدّ تنازلي يقيس فيه أرضية الغرفة");
    this.chunker = new Chunker(this.chunkSize, toInt16);
    this.countdown = [];
    this.frames = [];
    this.detector = null;
    this.floorDb = null;
    this.stopReason = null;                                      // "silence" | "max" | null
    this.error = null;                                           // MicrophoneSilent وأخواتها — المحاولة بتنلغي
    this.chunksSeen = 0;
  }
  Object.defineProperty(ClipEngine.prototype, "phase", {
    get: function () { return this.error ? "error" : this.stopReason ? "stopped" : this.countdown.length < this.countdownChunks ? "countdown" : "recording"; },
  });
  /** بيرجّع true لمّا المحاولة تخلص (وقف تلقائي، سقف، أو خطأ). الكتل بعد الانتهاء بتنتجاهل. */
  ClipEngine.prototype.push = function (floatBlock) {
    if (this.stopReason || this.error) return true;
    var chunks = this.chunker.push(floatBlock);
    for (var i = 0; i < chunks.length; i++) {
      var chunk = chunks[i];
      this.chunksSeen++;
      if (this.countdown.length < this.countdownChunks) {
        this.countdown.push(chunk);
        if (this.countdown.length === this.countdownChunks && this.silenceSeconds !== null) {
          try {
            this.floorDb = countdownFloorDb(this.countdown, this.rate);
          } catch (e) { this.error = e; return true; }
          this.detector = new SilenceDetector(this.floorDb, this.silenceSeconds, this.chunkSeconds, REARM_CHUNKS, this.aboveFloorDb);
        }
        continue;
      }
      this.frames.push(chunk);
      if (this.detector && this.detector.feed(chunkLevelDb(chunk, this.rate))) { this.stopReason = "silence"; return true; }
      if (this.frames.length >= this.maxChunks) { this.stopReason = "max"; return true; }
    }
    return false;
  };
  /** نهاية المحاولة: manual = المستخدم وقّف. بيرجّع {samples:Int16Array, reason, floorDb} أو بيرمي خطأ صريح لتسجيل فاضٍ. */
  ClipEngine.prototype.finish = function (manual) {
    if (this.error) throw this.error;
    var reason = this.stopReason || (manual ? "manual" : null);
    if (!reason) throw new Error("finish: المحاولة ما انتهت بعد");
    var keep;
    if (reason === "silence") keep = trimmedSampleCountAfterSilence(this.detector.lastSpeechChunk, this.chunkSize, this.rate);
    else if (reason === "manual") keep = trimmedSampleCountAfterManualStop(this.frames.length, this.chunkSize);
    else keep = this.frames.length * this.chunkSize;
    keep = Math.min(keep, this.frames.length * this.chunkSize);
    if (keep <= 0) throw new Error("تسجيل فاضٍ أو قصير جداً (صفر بيانات بعد القصّ)");
    var out = new Int16Array(keep);
    var pos = 0;
    for (var i = 0; i < this.frames.length && pos < keep; i++) {
      var part = this.frames[i].subarray(0, Math.min(this.frames[i].length, keep - pos));
      out.set(part, pos); pos += part.length;
    }
    return { samples: out, reason: reason, floorDb: this.floorDb, lastSpeechChunk: this.detector ? this.detector.lastSpeechChunk : null };
  };

  // ---------------------------------------------------------------- ZIP (بلا ضغط)
  var crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(date) {
    var y = Math.max(1980, date.getFullYear());
    var time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    var day = ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time: time & 0xFFFF, date: day & 0xFFFF };
  }

  /** entries: [{name, data: Uint8Array}] — ZIP بطريقة التخزين (store)، أسماء UTF-8. بيرجّع Uint8Array. */
  function buildZip(entries, date) {
    var stamp = dosDateTime(date || new Date());
    var enc = new TextEncoder();
    var parts = [], central = [], offset = 0;
    entries.forEach(function (e) {
      var name = enc.encode(e.name);
      var crc = crc32(e.data);
      var local = new Uint8Array(30 + name.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true); lv.setUint16(10, stamp.time, true); lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, e.data.length, true); lv.setUint32(22, e.data.length, true);
      lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
      local.set(name, 30);
      var cd = new Uint8Array(46 + name.length);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true); cv.setUint16(12, stamp.time, true); cv.setUint16(14, stamp.date, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, e.data.length, true); cv.setUint32(24, e.data.length, true);
      cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
      cd.set(name, 46);
      parts.push(local, e.data);
      central.push(cd);
      offset += local.length + e.data.length;
    });
    var cdSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    var all = parts.concat(central, [end]);
    var total = all.reduce(function (s, p) { return s + p.length; }, 0);
    var out = new Uint8Array(total), pos = 0;
    all.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }

  return {
    REFERENCE_RATE: REFERENCE_RATE, REFERENCE_CHUNK: REFERENCE_CHUNK, COUNTDOWN_SECONDS: COUNTDOWN_SECONDS,
    MAX_DURATION_SECONDS: MAX_DURATION_SECONDS, ENTER_CLICK_TRIM_CHUNKS: ENTER_CLICK_TRIM_CHUNKS,
    SILENCE_SIMPLE_SECONDS: SILENCE_SIMPLE_SECONDS, SILENCE_COMPOUND_SECONDS: SILENCE_COMPOUND_SECONDS,
    DETECT_ABOVE_FLOOR_DB: DETECT_ABOVE_FLOOR_DB, PHONE_DETECT_ABOVE_FLOOR_DB: PHONE_DETECT_ABOVE_FLOOR_DB, SPEECH_START_CHUNKS: SPEECH_START_CHUNKS,
    parseScript: parseScript, silenceSecondsForText: silenceSecondsForText,
    chunkSizeFor: chunkSizeFor, chunkLevelDb: chunkLevelDb, percentile: percentile, countdownFloorDb: countdownFloorDb,
    SilenceDetector: SilenceDetector, tailKeepChunks: tailKeepChunks,
    trimmedSampleCountAfterSilence: trimmedSampleCountAfterSilence,
    trimmedSampleCountAfterManualStop: trimmedSampleCountAfterManualStop,
    Chunker: Chunker, ClipEngine: ClipEngine, crc32: crc32, buildZip: buildZip,
  };
});
