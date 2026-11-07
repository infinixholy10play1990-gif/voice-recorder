/*
 * wavpack.js — الدوال النقية لصفحة التسجيل: تحويل عيّنات عائمة لـ16-بت، وكتابة ملف WAV مع لائحة إثبات (JSON) مدموجة
 * بنفس الملف، ومستوى dBFS. بلا اعتماد على أي مكتبة، وبتتحمّل بالصفحة وبتتفحص بالمتصفّح بنفس الشكل.
 *
 * بنية الملف: RIFF/WAVE <- `fmt ` (PCM، أحادي، 16-بت) <- `data` <- `hsnj` (JSON UTF-8). أدوات القراءة القياسية
 * بتوقف عند `data` وما بتشوف `hsnj`، فالملف مقروء بأي مشغّل. اللائحة بالملف نفسه حتى ما تنفصل عن صوتها.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WavPack = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // 32767 مو 32768: التناظر حول الصفر (±1.0 ⟵ ±32767) — نفس اصطلاح معظم المسجّلات، والقص بيصير عند ±1.0 بالضبط
  var FULL_SCALE = 32767;
  // عيّنة بهالقيمة أو أعلى (بالمطلق) تُعدّ مقصوصة: 32700 = 99.8% من المدى — نفس عتبة أداة القياس بايثون
  var CLIP_LEVEL = 32700;

  function floatToInt16(float32) {
    var out = new Int16Array(float32.length);
    for (var i = 0; i < float32.length; i++) {
      var v = float32[i];
      if (v > 1) v = 1; else if (v < -1) v = -1;
      out[i] = Math.round(v * FULL_SCALE);
    }
    return out;
  }

  function dbfsRms(float32) {
    if (!float32.length) return -Infinity;
    var sum = 0;
    for (var i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
    var rms = Math.sqrt(sum / float32.length);
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  }

  function peakDbfs(float32) {
    var peak = 0;
    for (var i = 0; i < float32.length; i++) {
      var a = Math.abs(float32[i]);
      if (a > peak) peak = a;
    }
    return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  }

  function countClipped(int16) {
    var n = 0;
    for (var i = 0; i < int16.length; i++) if (Math.abs(int16[i]) >= CLIP_LEVEL) n++;
    return n;
  }

  function writeAscii(view, offset, text) {
    for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }

  /** int16: Int16Array أحادي. meta: كائن JSON. بيرجّع Uint8Array للملف كامل. */
  function encodeWav(int16, sampleRate, meta) {
    if (!(int16 instanceof Int16Array)) throw new Error("encodeWav: لازم Int16Array");
    if (!(sampleRate > 0) || Math.floor(sampleRate) !== sampleRate) throw new Error("encodeWav: معدّل عيّنات غير صالح");
    var json = new TextEncoder().encode(JSON.stringify(meta));
    var jsonPad = json.length % 2;                       // فقرات RIFF بتنحاذى على عدد زوجي
    var dataLen = int16.length * 2;
    var total = 12 + 8 + 16 + 8 + dataLen + 8 + json.length + jsonPad;
    var buf = new ArrayBuffer(total);
    var view = new DataView(buf);
    var p = 0;
    writeAscii(view, p, "RIFF"); view.setUint32(p + 4, total - 8, true); writeAscii(view, p + 8, "WAVE"); p += 12;
    writeAscii(view, p, "fmt "); view.setUint32(p + 4, 16, true);
    view.setUint16(p + 8, 1, true);                      // PCM
    view.setUint16(p + 10, 1, true);                     // أحادي
    view.setUint32(p + 12, sampleRate, true);
    view.setUint32(p + 16, sampleRate * 2, true);        // byte rate = rate × 1 × 2
    view.setUint16(p + 20, 2, true);                     // block align
    view.setUint16(p + 22, 16, true);                    // bits
    p += 24;
    writeAscii(view, p, "data"); view.setUint32(p + 4, dataLen, true); p += 8;
    for (var i = 0; i < int16.length; i++) view.setInt16(p + i * 2, int16[i], true);
    p += dataLen;
    writeAscii(view, p, "hsnj"); view.setUint32(p + 4, json.length, true); p += 8;
    new Uint8Array(buf, p, json.length).set(json);
    return new Uint8Array(buf);
  }

  return {
    FULL_SCALE: FULL_SCALE, CLIP_LEVEL: CLIP_LEVEL,
    floatToInt16: floatToInt16, dbfsRms: dbfsRms, peakDbfs: peakDbfs, countClipped: countClipped,
    encodeWav: encodeWav,
  };
});
