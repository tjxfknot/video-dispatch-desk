'use strict';

// Serializes short, foreground-focus-sensitive browser UI interactions across
// concurrent platform publishers (e.g. clicking cover editors, typing topics,
// submitting, or waking a receipt tab), while leaving long asynchronous waits
// (video upload/transcoding, platform quick-check, receipt polling) fully
// concurrent.
function createFocusCoordinator() {
  let active = null;
  const waiters = [];

  function abortError() {
    const error = new Error('前台焦点等待已取消，未继续操作。');
    error.code = 'FOCUS_WAIT_ABORTED';
    return error;
  }

  function release() {
    active = null;
    while (waiters.length > 0) {
      const next = waiters.shift();
      if (next.onAbort) {
        try { next.signal?.removeEventListener?.('abort', next.onAbort); } catch {}
      }
      active = next.owner;
      next.resolve();
      return;
    }
  }

  async function runExclusive(owner, fn, { signal } = {}) {
    if (typeof fn !== 'function') throw new Error('focusCoordinator.runExclusive 需要可执行函数。');
    if (signal?.aborted) throw abortError();
    if (!active) {
      active = String(owner || 'unknown');
    } else {
      await new Promise((resolve, reject) => {
        const entry = { owner: String(owner || 'unknown'), resolve, reject, signal, onAbort: null };
        if (signal && typeof signal.addEventListener === 'function') {
          entry.onAbort = () => {
            const idx = waiters.indexOf(entry);
            if (idx !== -1) waiters.splice(idx, 1);
            reject(abortError());
          };
          signal.addEventListener('abort', entry.onAbort, { once: true });
        }
        waiters.push(entry);
      });
    }
    try {
      if (signal?.aborted) throw abortError();
      return await fn();
    } finally {
      release();
    }
  }

  return {
    runExclusive,
    activeOwner: () => active,
    queueLength: () => waiters.length,
  };
}

module.exports = { createFocusCoordinator };
