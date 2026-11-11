/**
 * The one data-loading hook every console page shares.
 *
 * A page's three states are "loading / ready / error", and the difference
 * between this hook and a hand-rolled one is the `alive` flag: a page unmounted
 * while its request was in flight must not set state on a dead component, which
 * is the warning React logs and the state leak that follows it.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/hooks.js
 */

import { useCallback, useEffect, useState } from 'react'

export function useAsync(loader, deps) {
  const [state, setState] = useState({ status: 'loading', data: undefined, error: '' })
  const run = useCallback(() => {
    let alive = true
    setState(current => ({ ...current, status: 'loading' }))
    loader().then(data => { if (alive) setState({ status: 'ready', data, error: '' }) })
      .catch(error => { if (alive) setState({ status: 'error', data: undefined, error: String(error?.message ?? error) }) })
    return () => { alive = false }
  }, deps)
  useEffect(() => run(), [run])
  return { ...state, reload: run }
}
