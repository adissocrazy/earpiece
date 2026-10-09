// One spoken clip from the microphone, for Talk and the Inbox's reply box. It stops by itself after
// a pause once you've spoken, or at maxMs; nothing said within nothingMs gives up. Plain script.
// recordClip() resolves to { done, stop, drop }; done resolves to { bytes, mime }, { silent: true }
// (nothing heard) or null (dropped). It rejects when the mic can't be opened.
globalThis.recordClip = async function recordClip({ onLevel = () => {}, quietMs = 1500, maxMs = 30_000, nothingMs = 6000 } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const type = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize);
  const began = Date.now();
  let spoke = 0;
  let heard = false;
  let dropped = false;
  let raf = 0;
  let finish;
  const done = new Promise((r) => (finish = r));
  const stop = () => recorder.state !== "inactive" && recorder.stop();
  recorder.onstop = async () => {
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    onLevel(0);
    if (dropped) return finish(null);
    if (!heard) return finish({ silent: true });
    const mime = recorder.mimeType || "audio/webm";
    finish({ bytes: new Uint8Array(await new Blob(chunks, { type: mime }).arrayBuffer()), mime });
  };
  recorder.start(250);
  const tick = () => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const level = Math.min(1, Math.sqrt(sum / buf.length) * 8);
    const now = Date.now();
    if (level > 0.12) (spoke = now), (heard = true);
    onLevel(level);
    if ((heard && now - spoke > quietMs) || now - began > maxMs || (!heard && now - began > nothingMs)) return stop();
    raf = requestAnimationFrame(tick);
  };
  tick();
  return { done, stop, drop: () => ((dropped = true), stop()) };
};
