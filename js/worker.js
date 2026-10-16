// Web Worker: runs the download/decode/accumulate engine off the main thread.
import { api, UserError } from "./engine.js?v=4";

self.onmessage = async (ev) => {
  const { id, fn, args } = ev.data;
  const progress = (p) => self.postMessage({ id, progress: p });
  try {
    const result = await api[fn](...(args || []), progress);
    const transfer = [];                       // result grids are fresh arrays, so hand them over without copying
    if (result && result.obs) {
      transfer.push(result.obs.buffer);
      if (result.normal) transfer.push(result.normal.buffer);
      if (result.miss) transfer.push(result.miss.buffer);
    }
    self.postMessage({ id, result }, transfer);
  } catch (e) {
    self.postMessage({ id, error: (e && e.message) || String(e), user: e instanceof UserError });
  }
};
