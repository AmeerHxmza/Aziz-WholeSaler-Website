'use client';
import { useEffect } from 'react';

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(async () => {
      await navigator.serviceWorker.ready;
      const persistent = await navigator.storage?.persist?.();
      window.dispatchEvent(new CustomEvent('aziz-storage-status', { detail: { ready: true, persistent: Boolean(persistent) } }));
    }).catch(error => {
      console.error('Offline installation failed', error);
      window.dispatchEvent(new CustomEvent('aziz-storage-status', { detail: { ready: false, persistent: false } }));
    });
  }, []);
  return null;
}
