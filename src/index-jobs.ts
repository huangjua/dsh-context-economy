import { Worker } from 'node:worker_threads'

/** One worker per refresh, reused across batches and always awaited on termination. */
export class IndexJobs {
  // Electron host flags (e.g. --expose-internals) must not reach standalone workers.
  private readonly worker = new Worker(new URL('./index-worker.js', import.meta.url), { execArgv: [] })
  private closing: Promise<number> | undefined
  private failure: Error | undefined

  constructor() {
    // Keep an error listener even between requests; never reuse an exited worker silently.
    this.worker.on('error', (error) => { this.failure = error })
    this.worker.on('exit', (code) => { this.failure ??= new Error(`index worker exited (${code})`) })
  }

  run<T>(kind: string, payload: unknown, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    if (this.failure || this.closing) return Promise.reject(this.failure ?? new Error('index worker closed'))
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.worker.off('message', message)
        this.worker.off('error', error)
        this.worker.off('exit', exited)
        signal.removeEventListener('abort', aborted)
      }
      const message = (m: { value: T; error?: string }) => {
        cleanup()
        if (m.error) reject(new Error(m.error))
        else resolve(m.value)
      }
      const error = (e: Error) => { cleanup(); reject(e) }
      const exited = (code: number) => error(new Error(`index worker exited (${code})`))
      const aborted = () => { cleanup(); reject(signal.reason) }
      this.worker.once('message', message)
      this.worker.once('error', error)
      this.worker.once('exit', exited)
      signal.addEventListener('abort', aborted, { once: true })
      try { this.worker.postMessage({ kind, payload }) } catch (e) { error(e as Error) }
    })
  }

  async close(): Promise<void> {
    this.closing ??= this.worker.terminate()
    await this.closing
  }
}
