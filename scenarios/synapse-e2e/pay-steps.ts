import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * PASS and FAIL are plain results. A step listed as pending (FWSS_PAY_PENDING) is expected to fail
 * against the candidate under test: its failure is PENDING, and its success is FIXED, which fails
 * the run until the step leaves the list. BLOCKED steps did not run because a step they need did
 * not pass.
 */
export type StepStatus = 'PASS' | 'FAIL' | 'PENDING' | 'FIXED' | 'BLOCKED'

export type StepResult = { name: string; phase: string; status: StepStatus; detail?: string; seconds: number }

/** Comma- or whitespace-separated step names, `#` comments to the end of a line; a trailing `*` matches a prefix. */
export function parsePending(value: string | undefined): string[] {
  return (value ?? '')
    .split('\n')
    .flatMap((line) => line.replace(/#.*/, '').split(/[\s,]+/))
    .filter((entry) => entry.length > 0)
}

export function isPending(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern))
}

export function failsRun(status: StepStatus): boolean {
  return status === 'FAIL' || status === 'FIXED'
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.split('\n').slice(0, 6).join('\n')
}

/**
 * Runs named steps and keeps going after a failure, so one run reports every
 * behavior. Results persist in `path`, so a later phase sees an earlier one's.
 */
export class StepRunner {
  readonly results: StepResult[]
  readonly phase: string
  readonly pending: string[]
  readonly path?: string
  private readonly now: () => number

  constructor(phase: string, pending: string[], path?: string, now: () => number = Date.now) {
    this.phase = phase
    this.pending = pending
    this.path = path
    this.now = now
    this.results = path != null && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
  }

  status(name: string): StepStatus | undefined {
    return this.results.findLast((result) => result.name === name)?.status
  }

  passed(name: string): boolean {
    const status = this.status(name)
    return status === 'PASS' || status === 'FIXED'
  }

  /** Runs `fn` unless a step in `needs` did not pass; returns its value, or undefined if it did not pass. */
  async run<T>(name: string, needs: string[], fn: () => Promise<T>): Promise<T | undefined> {
    const started = this.now()
    const missing = needs.filter((need) => !this.passed(need))
    if (missing.length > 0) {
      this.record({ name, status: 'BLOCKED', detail: `needs ${missing.join(', ')}`, started })
      return undefined
    }
    const pending = isPending(name, this.pending)
    console.log(`\n--- STEP ${name}${pending ? ' (pending)' : ''}`)
    try {
      const value = await fn()
      this.record({
        name,
        status: pending ? 'FIXED' : 'PASS',
        detail: pending ? 'passes now; remove it from FWSS_PAY_PENDING' : undefined,
        started,
      })
      return value
    } catch (error) {
      console.error(error)
      this.record({ name, status: pending ? 'PENDING' : 'FAIL', detail: message(error), started })
      return undefined
    }
  }

  private record({ name, status, detail, started }: { name: string; status: StepStatus; detail?: string; started: number }) {
    const result: StepResult = { name, phase: this.phase, status, seconds: Math.round((this.now() - started) / 1000) }
    if (detail != null) result.detail = detail
    this.results.push(result)
    console.log(`--- ${status} ${name}${detail ? `: ${detail.split('\n')[0]}` : ''}`)
    if (this.path != null) writeFileSync(this.path, `${JSON.stringify(this.results, null, 2)}\n`)
  }

  summary(): string {
    const mine = this.results.filter((result) => result.phase === this.phase)
    const counts = new Map<StepStatus, number>()
    for (const result of mine) counts.set(result.status, (counts.get(result.status) ?? 0) + 1)
    return [...counts].map(([status, count]) => `${status}=${count}`).join(' ')
  }

  failed(): boolean {
    return this.results.some((result) => result.phase === this.phase && failsRun(result.status))
  }
}
